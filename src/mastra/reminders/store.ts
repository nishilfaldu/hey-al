import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensureAppTables, getAccount, resourceFor, tokenHash } from '../accounts';
import { storage } from '../storage';
import { resolveReminderTime, type ReminderTimeInput } from './time';

export type VoiceIdentity = { sessionId: string; threadId: string; resourceId: string };
export type VoiceContext = VoiceIdentity & { accountId: string; timezone: string | null };
export type Reminder = {
  id: string; account_id: string; message: string; due_at: Date; timezone: string;
  local_date_time: string; status: string; version: number; delivery_status?: string | null;
};
export type Delivery = {
  id: string; reminder_id: string; reminder_version: number; message: string; due_at: Date;
  timezone: string; lease_token: string; attempts: number;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  await ensureAppTables();
  const client = await storage.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// The dispatch ID is a capability created by the backend, bound to this call and
// to a still-valid sign-in. Memory rotation and sign-out invalidate it immediately.
async function authorize(client: PoolClient, identity: VoiceIdentity, allowPending = false, lock = true): Promise<VoiceContext> {
  if (!uuid.test(identity.sessionId)) throw new Error('Start a signed-in voice call to use reminders.');
  const result = await client.query<{ account_id: string; reminder_timezone: string | null }>(`
    SELECT v.account_id, a.reminder_timezone FROM al_voice_sessions v
    JOIN al_accounts a ON a.id = v.account_id
    JOIN al_sessions s ON s.token_hash = v.auth_session_hash AND s.account_id = a.id
    WHERE v.id = $1 AND v.thread_id = $2 AND v.resource_id = $3
      AND v.resource_id = 'al:' || a.id::text || ':' || a.memory_version::text
      AND s.expires_at > now() AND v.expires_at > now()
      AND (v.state = 'active' OR ($4 AND v.state = 'pending'))
    ${lock ? 'FOR UPDATE OF a' : ''}`, [identity.sessionId, identity.threadId, identity.resourceId, allowPending]);
  if (!result.rows[0]) throw new Error('This voice call is no longer authorized. Start a new signed-in call.');
  return { ...identity, accountId: result.rows[0].account_id, timezone: result.rows[0].reminder_timezone };
}

export async function getReminderContext(identity: VoiceIdentity) {
  return transaction(client => authorize(client, identity, true, false));
}

export async function createPendingVoiceSession(token: string, threadId: string) {
  const account = await getAccount(token);
  if (!account) throw new Error('Please sign in to start talking.');
  const identity = { sessionId: randomUUID(), threadId, resourceId: resourceFor(account) };
  await storage.pool.query(`INSERT INTO al_voice_sessions(id, account_id, auth_session_hash, thread_id, resource_id, expires_at)
    VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')`,
  [identity.sessionId, account.id, tokenHash(token), identity.threadId, identity.resourceId]);
  return { ...identity, accountId: account.id };
}

export async function activateVoiceSession(identity: VoiceIdentity, roomName: string) {
  return transaction(async client => {
    const context = await authorize(client, identity, true);
    // Serialize activation against other tabs, while preserving unrelated calls' memory.
    await client.query(`UPDATE al_voice_sessions SET state = 'superseded' WHERE account_id = $1 AND state = 'active' AND id <> $2`, [context.accountId, identity.sessionId]);
    await client.query(`UPDATE al_voice_sessions SET state = 'active', room_name = $2,
      activated_at = COALESCE(activated_at, now()), heartbeat_at = now(), expires_at = now() + interval '30 seconds'
      WHERE id = $1`, [identity.sessionId, roomName]);
    return context;
  });
}

export async function heartbeatVoiceSession(identity: VoiceIdentity) {
  return transaction(async client => {
    await authorize(client, identity);
    await client.query(`UPDATE al_voice_sessions SET heartbeat_at = now(), expires_at = now() + interval '30 seconds' WHERE id = $1`, [identity.sessionId]);
  });
}

export async function closeVoiceSession(sessionId: string) {
  if (!uuid.test(sessionId)) return;
  await ensureAppTables();
  await storage.pool.query(`UPDATE al_voice_sessions SET state = 'closed', expires_at = now() WHERE id = $1`, [sessionId]);
}

export async function createReminder(identity: VoiceIdentity, input: ReminderTimeInput & { message: string }, creationKey: string) {
  if (!input.message.trim() || input.message.length > 500) throw new Error('Use a reminder message of 1 to 500 characters.');
  if (!creationKey || creationKey.length > 500) throw new Error('A stable originating tool-call ID is required.');
  return transaction(async client => {
    const context = await authorize(client, identity);
    const previous = await client.query<Reminder>('SELECT * FROM al_reminders WHERE account_id = $1 AND creation_key = $2', [context.accountId, creationKey]);
    if (previous.rows[0]) return previous.rows[0];
    const time = resolveReminderTime(input, context.timezone);
    const result = await client.query<Reminder>(`INSERT INTO al_reminders(id, account_id, message, due_at, timezone, local_date_time, creation_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [randomUUID(), context.accountId, input.message.trim(), time.dueAt, time.timezone, time.localDateTime, creationKey]);
    if (input.timezone) await client.query('UPDATE al_accounts SET reminder_timezone = $2 WHERE id = $1', [context.accountId, time.timezone]);
    return result.rows[0];
  });
}

export async function listReminders(identity: VoiceIdentity, status?: string, limit = 20) {
  return transaction(async client => {
    const context = await authorize(client, identity);
    const result = await client.query<Reminder>(`SELECT r.*, d.status AS delivery_status FROM al_reminders r
      LEFT JOIN al_reminder_deliveries d ON d.reminder_id = r.id AND d.reminder_version = r.version
      WHERE r.account_id = $1 AND ($2::text IS NULL OR r.status = $2)
      ORDER BY r.due_at LIMIT $3`, [context.accountId, status ?? null, Math.max(1, Math.min(50, limit))]);
    return result.rows;
  });
}

export async function changeReminder(identity: VoiceIdentity, id: string, replacement?: ReminderTimeInput & { message?: string }) {
  if (!uuid.test(id)) throw new Error('Select a reminder ID returned by list_reminders.');
  return transaction(async client => {
    const context = await authorize(client, identity);
    const result = await client.query<Reminder>('SELECT * FROM al_reminders WHERE id = $1 AND account_id = $2 FOR UPDATE', [id, context.accountId]);
    const reminder = result.rows[0];
    if (!reminder) throw new Error('Reminder not found for this account.');
    if (reminder.status === 'completed') throw new Error('This reminder has already played. Create a new reminder instead.');
    if (reminder.status === 'canceled' && !replacement) return { reminder, speechInProgress: false };
    const deliveries = await client.query(`SELECT status FROM al_reminder_deliveries WHERE reminder_id = $1 FOR UPDATE`, [id]);
    const speechInProgress = deliveries.rows.some(row => row.status === 'speaking');
    await client.query(`UPDATE al_reminder_deliveries SET status = 'canceled', lease_until = NULL
      WHERE reminder_id = $1 AND status IN ('ready', 'leased', 'speaking', 'interrupted', 'uncertain', 'failed')`, [id]);
    const time = replacement ? resolveReminderTime(replacement, context.timezone) : null;
    const message = replacement?.message?.trim() ?? reminder.message;
    if (!message || message.length > 500) throw new Error('Use a reminder message of 1 to 500 characters.');
    const changed = await client.query<Reminder>(`UPDATE al_reminders SET status = $3, version = version + 1,
      due_at = COALESCE($4, due_at), timezone = COALESCE($5, timezone), local_date_time = COALESCE($6, local_date_time),
      message = $7, updated_at = now() WHERE id = $1 AND account_id = $2 RETURNING *`,
    [id, context.accountId, replacement ? 'scheduled' : 'canceled', time?.dueAt, time?.timezone, time?.localDateTime, message]);
    if (replacement?.timezone) await client.query('UPDATE al_accounts SET reminder_timezone = $2 WHERE id = $1', [context.accountId, time!.timezone]);
    return { reminder: changed.rows[0], speechInProgress };
  });
}

export async function queueDueReminders(batchSize = 100, accountId?: string) {
  return transaction(async client => {
    const due = await client.query<Reminder>(`SELECT * FROM al_reminders WHERE status = 'scheduled' AND due_at <= now()
      AND ($2::uuid IS NULL OR account_id = $2)
      ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [Math.min(100, Math.max(1, batchSize)), accountId ?? null]);
    for (const reminder of due.rows) {
      await client.query(`INSERT INTO al_reminder_deliveries(id, reminder_id, account_id, reminder_version)
        VALUES ($1, $2, $3, $4) ON CONFLICT (reminder_id, reminder_version) DO NOTHING`,
      [randomUUID(), reminder.id, reminder.account_id, reminder.version]);
      await client.query(`UPDATE al_reminders SET status = 'queued', updated_at = now() WHERE id = $1`, [reminder.id]);
    }
    return due.rowCount ?? 0;
  });
}

export async function claimDelivery(identity: VoiceIdentity): Promise<Delivery | null> {
  return transaction(async client => {
    const context = await authorize(client, identity);
    // Never replay a speech that may have played before a crash. Unstarted claims are retryable.
    await client.query(`UPDATE al_reminder_deliveries SET
      status = CASE WHEN status = 'speaking' THEN 'uncertain' WHEN attempts >= 4 THEN 'failed' ELSE 'ready' END,
      lease_token = NULL, lease_until = NULL, error_code = 'lease_expired'
      WHERE account_id = $1 AND status IN ('leased', 'speaking') AND lease_until <= now()`, [context.accountId]);
    const result = await client.query<Delivery>(`SELECT d.id, d.reminder_id, d.reminder_version, d.attempts,
      r.message, r.due_at, r.timezone FROM al_reminder_deliveries d JOIN al_reminders r ON r.id = d.reminder_id
      WHERE d.account_id = $1 AND d.status = 'ready' AND d.next_attempt_at <= now()
        AND r.status = 'queued' AND r.version = d.reminder_version
      ORDER BY r.due_at LIMIT 1 FOR UPDATE OF r, d SKIP LOCKED`, [context.accountId]);
    if (!result.rows[0]) return null;
    const delivery = result.rows[0];
    const leaseToken = randomUUID();
    await client.query(`UPDATE al_reminder_deliveries SET status = 'leased', attempts = attempts + 1,
      voice_session_id = $2, lease_token = $3, lease_until = now() + interval '30 seconds' WHERE id = $1`,
    [delivery.id, identity.sessionId, leaseToken]);
    return { ...delivery, lease_token: leaseToken, attempts: delivery.attempts + 1 };
  });
}

export async function maintainDelivery(identity: VoiceIdentity, delivery: Delivery, start = false) {
  return transaction(async client => {
    await authorize(client, identity);
    const result = await client.query(`UPDATE al_reminder_deliveries d SET
      status = CASE WHEN $4 THEN 'speaking' ELSE d.status END,
      started_at = CASE WHEN $4 THEN now() ELSE d.started_at END,
      lease_until = now() + interval '30 seconds'
      FROM al_reminders r WHERE d.id = $1 AND d.lease_token = $2 AND d.voice_session_id = $3
        AND d.lease_until > now() AND d.status IN ('leased', 'speaking')
        AND r.id = d.reminder_id AND r.version = d.reminder_version AND r.status = 'queued'
      RETURNING d.id`, [delivery.id, delivery.lease_token, identity.sessionId, start]);
    return result.rowCount === 1;
  });
}

export async function finishDelivery(delivery: Delivery, outcome: 'spoken' | 'interrupted' | 'uncertain' | 'retry') {
  return transaction(async client => {
    // Lock the reminder first, just as cancellation/update do.
    const parent = await client.query<Reminder>(`SELECT r.* FROM al_reminders r
      JOIN al_reminder_deliveries d ON d.reminder_id = r.id WHERE d.id = $1 FOR UPDATE OF r`, [delivery.id]);
    if (parent.rows[0]?.version !== delivery.reminder_version || parent.rows[0]?.status !== 'queued') return false;
    const backoffSeconds = [1, 5, 30][delivery.attempts - 1];
    const status = outcome === 'retry' ? (backoffSeconds === undefined ? 'failed' : 'ready') : outcome;
    const result = await client.query(`UPDATE al_reminder_deliveries SET status = $3,
      next_attempt_at = now() + make_interval(secs => $4), completed_at = CASE WHEN $3 = 'spoken' THEN now() ELSE NULL END,
      started_at = CASE WHEN $3 = 'ready' THEN NULL ELSE started_at END,
      lease_token = NULL, lease_until = NULL, error_code = CASE WHEN $3 IN ('ready', 'failed') THEN 'speech_unavailable' ELSE NULL END
      WHERE id = $1 AND lease_token = $2 AND status IN ('leased', 'speaking') AND lease_until > now() RETURNING id`,
    [delivery.id, delivery.lease_token, status, backoffSeconds ?? 0]);
    if (result.rowCount !== 1) return false;
    if (outcome === 'spoken') await client.query(`UPDATE al_reminders SET status = 'completed', updated_at = now() WHERE id = $1`, [delivery.reminder_id]);
    return true;
  });
}
