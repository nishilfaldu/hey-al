import { randomUUID } from 'node:crypto';
import { Extractor } from '@mastra/memory';
import { ensureAppTables, isCurrentResource } from '../accounts';
import { storage } from '../storage';
import { alMemory, profileSchema } from './al-memory';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
type Call = { thread_id: string; resource_id: string; started_at: Date; updated_at: Date; summary: string | null; summarized_at: Date | null; purged: boolean };

export async function startCall(resourceId: string) {
  await ensureAppTables();
  const threadId = `al-call-${randomUUID()}`;
  await storage.pool.query('INSERT INTO al_calls(thread_id, resource_id) VALUES ($1, $2)', [threadId, resourceId]);
  return threadId;
}

export async function markCallUpdated(threadId: string, resourceId: string, ended = false) {
  if (!await isCurrentResource(resourceId)) return;
  await storage.pool.query(`UPDATE al_calls SET updated_at = now(), ended_at = CASE WHEN $3 THEN now() ELSE ended_at END
    WHERE thread_id = $1 AND resource_id = $2 AND NOT purged`, [threadId, resourceId, ended]);
}

export async function readCallSummaries(resourceId: string, query = '', limit = 5) {
  if (!await isCurrentResource(resourceId)) return [];
  const result = await storage.pool.query<{ date: Date; summary: string }>(`
    SELECT started_at AS date, summary FROM al_calls
    WHERE resource_id = $1 AND summary IS NOT NULL
      AND ($2 = '' OR to_tsvector('simple', summary) @@ plainto_tsquery('simple', $2))
    ORDER BY started_at DESC LIMIT $3`, [resourceId, query, Math.min(limit, 10)]);
  return result.rows;
}

export async function summarizeCall(threadId: string) {
  await ensureAppTables();
  const client = await storage.pool.connect();
  try {
    // The server's retry loop and worker shutdown may run concurrently. One owns this call.
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [threadId]);
    if (!lock.rows[0].locked) return;
    try {
      const result = await client.query<Call>('SELECT * FROM al_calls WHERE thread_id = $1', [threadId]);
      const call = result.rows[0];
      if (!call || call.purged || !await isCurrentResource(call.resource_id)) return;
      if (call.summarized_at && call.summarized_at >= call.updated_at) return;
      const thread = await alMemory.getThreadById({ threadId, resourceId: call.resource_id });
      if (!thread) {
        // A cancelled connection never created a transcript. A later committed turn
        // marks the call dirty again, so this does not suppress future summarization.
        await client.query("UPDATE al_calls SET summarized_at = $2, summary = '' WHERE thread_id = $1", [threadId, call.updated_at]);
        return;
      }
      // Unlike OM.observe(), summarizeThread does not require crossing a token threshold.
      const previousProfile = await alMemory.getWorkingMemory({ threadId, resourceId: call.resource_id });
      const distilled = await alMemory.summarizeThread({
        threadId, resourceId: call.resource_id, model: 'openai/gpt-5-mini',
        maxInputTokens: 120_000,
        abortSignal: AbortSignal.timeout(45_000),
        instructions: `This call happened on ${call.started_at.toISOString()}. Preserve explicitly shared preferences, people, routines, ongoing goals, decisions, and dated plans. Keep corrections and uncertainties. Distinguish the person's statements from Al's suggestions and actions. Never infer diagnoses or authorization. Do not preserve information the person asked to forget. Produce a compact summary, not a transcript.`,
        extract: [new Extractor({
          name: 'profile-updates', schema: profileSchema,
          instructions: `Extract small, lasting profile updates from explicit user statements in this call. The previous profile is ${previousProfile ?? '{}'}. Include only added or corrected fields; arrays must contain their complete updated contents. Keep temporary plans and dated events in the summary, not the profile. Do not infer traits, diagnoses, relationships, or preferences. Never include facts the person asked to forget. Return {} if nothing changed.`,
          metadataKeyPath: false,
        })],
      });
      if (distilled.extractionFailures?.length) throw new Error('Profile extraction failed; retry before expiry.');
      const updates = profileSchema.parse(distilled.extracted['profile-updates']);
      // A forget operation during summarization invalidates this resource. Never resurrect it.
      if (!await isCurrentResource(call.resource_id)) return;
      if (Object.keys(updates).length) {
        const latest = JSON.parse(await alMemory.getWorkingMemory({ threadId, resourceId: call.resource_id }) ?? '{}');
        await alMemory.updateWorkingMemory({ threadId, resourceId: call.resource_id, workingMemory: JSON.stringify(profileSchema.parse({ ...latest, ...updates })) });
      }
      const [, accountId, version] = call.resource_id.split(':');
      await client.query(`UPDATE al_calls SET summary = $2, summarized_at = $3 WHERE thread_id = $1 AND resource_id = $4
        AND EXISTS (SELECT 1 FROM al_accounts WHERE id = $5 AND memory_version = $6)`,
        [threadId, distilled.summary, call.updated_at, call.resource_id, accountId, Number(version)]);
    } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [threadId]); }
  } finally { client.release(); }
}

async function eraseResource(resourceId: string) {
  // Always page from zero as deletion changes the result set.
  while (true) {
    const { threads } = await alMemory.listThreads({ filter: { resourceId }, page: 0, perPage: 100 });
    if (!threads.length) break;
    for (const thread of threads) await alMemory.deleteThread(thread.id);
  }
  const memoryStore = await storage.getStore('memory');
  // An in-flight turn can save messages after its thread was deleted. Sweep the
  // registered call IDs too, including absent threads, to remove those late writes.
  const calls = await storage.pool.query<{ thread_id: string }>('SELECT thread_id FROM al_calls WHERE resource_id = $1', [resourceId]);
  for (const { thread_id } of calls.rows) {
    await alMemory.deleteThread(thread_id);
    await memoryStore?.clearObservationalMemory(thread_id, resourceId);
  }
  const resource = await memoryStore?.getResourceById({ resourceId });
  if (resource) await memoryStore!.updateResource({ resourceId, workingMemory: '{}' });
  // Keep a tombstone so maintenance can remove late writes from an in-flight old call.
  await storage.pool.query('UPDATE al_calls SET summary = NULL, summarized_at = now(), purged = true WHERE resource_id = $1', [resourceId]);
}

export async function forgetMemories(resourceId: string, keepProfile: unknown) {
  const retained = profileSchema.parse(keepProfile);
  const match = /^al:([a-f0-9-]{36}):(\d+)$/.exec(resourceId);
  if (!match) throw new Error('This call has no account memory.');
  const result = await storage.pool.query<{ memory_version: number }>(`
    UPDATE al_accounts SET memory_version = memory_version + 1
    WHERE id = $1 AND memory_version = $2 RETURNING memory_version`, [match[1], Number(match[2])]);
  if (!result.rows[0]) throw new Error('This call uses an old memory profile. Please start a new call.');
  const newResource = `al:${match[1]}:${result.rows[0].memory_version}`;
  await alMemory.updateWorkingMemory({ threadId: 'profile', resourceId: newResource, workingMemory: JSON.stringify(retained) });
  await eraseResource(resourceId);
  return { forgotten: true, restartCall: true, message: 'The requested facts were removed. Earlier conversation history was cleared too. End this call and ask the person to start a new call with the updated memory.' };
}

let running = false;
export async function maintainCallMemory() {
  if (running) return;
  running = true;
  try {
    await ensureAppTables();
    const pending = await storage.pool.query<Call>(`
      SELECT * FROM al_calls WHERE NOT purged AND (summarized_at IS NULL OR summarized_at < updated_at)
        AND (ended_at IS NOT NULL OR updated_at < now() - interval '5 minutes')
      ORDER BY started_at ASC LIMIT 20`);
    for (const call of pending.rows) {
      try { await summarizeCall(call.thread_id); }
      catch { console.warn('Al call summarization failed; will retry.', { threadId: call.thread_id }); }
    }
    const expired = await storage.pool.query<Call>("SELECT * FROM al_calls WHERE NOT purged AND started_at < now() - interval '7 days' LIMIT 100");
    for (const call of expired.rows) {
      if (!call.summary) console.warn('Al transcript reached its retention deadline without a summary.', { threadId: call.thread_id });
      await alMemory.deleteThread(call.thread_id);
      await storage.pool.query('UPDATE al_calls SET purged = true WHERE thread_id = $1', [call.thread_id]);
    }
    // Clean up stale generations even if a worker re-saved a turn after a forget tool ran.
    const resources = await storage.pool.query<{ resource_id: string }>('SELECT DISTINCT resource_id FROM al_calls');
    for (const { resource_id } of resources.rows) if (!await isCurrentResource(resource_id)) await eraseResource(resource_id);
    await storage.pool.query("DELETE FROM al_sessions WHERE expires_at < now(); DELETE FROM al_login_limits WHERE window_start < now() - interval '1 day'");
    await storage.prune({ maxBatches: 2 });
  } finally { running = false; }
}

let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
export function startMemoryMaintenance() {
  // Only the Mastra server calls this. The voice worker summarizes its own call at shutdown.
  if (maintenanceTimer) return;
  const tick = () => { void maintainCallMemory().catch(() => console.warn('Al memory maintenance failed; will retry.')); };
  maintenanceTimer = setInterval(tick, 60_000);
  maintenanceTimer.unref();
  tick();
}
