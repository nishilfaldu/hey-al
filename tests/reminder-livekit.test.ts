import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

// Uses the running local API/worker and real LiveKit audio, with a headless
// participant rather than a microphone. Explicit opt-in: inference incurs usage.
test('local scheduler delivers real LiveKit audio and persists proactive reminder context', {
  skip: process.env.AL_REMINDER_LIVEKIT_SMOKE !== '1', timeout: 120000,
}, async t => {
  const require = createRequire(import.meta.resolve('@livekit/agents'));
  const rtc = await import(pathToFileURL(require.resolve('@livekit/rtc-node')).href);
  const { storage } = await import('../src/mastra/storage');
  const { alMemory } = await import('../src/mastra/memory/al-memory');
  const { createReminder } = await import('../src/mastra/reminders/store');
  await storage.init();
  const email = `reminder-livekit-${randomUUID()}@example.test`;
  const room = new rtc.Room();
  const readers: Array<{ cancel(): Promise<void> }> = [];
  let voice: { sessionId: string; threadId: string; resourceId: string } | undefined;
  t.after(async () => {
    await room.disconnect();
    await Promise.allSettled(readers.map(reader => reader.cancel()));
    // Let worker finalization drain before removing this test's account/memory.
    await delay(3000);
    await storage.pool.query('DELETE FROM al_accounts WHERE email = $1', [email]);
    if (voice) {
      await alMemory.deleteThread(voice.threadId);
      await storage.pool.query('DELETE FROM al_calls WHERE thread_id = $1', [voice.threadId]);
      const memoryStore = await storage.getStore('memory');
      await memoryStore?.updateResource({ resourceId: voice.resourceId, workingMemory: '{}' });
    }
    await storage.close();
    await rtc.dispose();
  });
  const texts: string[] = [];
  let audioFrames = 0;
  room.registerTextStreamHandler('lk.transcription', async (reader: { readAll(): Promise<string> }) => {
    texts.push(await reader.readAll());
  });
  room.on(rtc.RoomEvent.TrackSubscribed, (track: { kind: number }) => {
    if (track.kind !== rtc.TrackKind.KIND_AUDIO) return;
    const reader = new rtc.AudioStream(track).getReader();
    readers.push(reader);
    void (async () => { while (!(await reader.read()).done) audioFrames++; })().catch(() => {});
  });
  const endpoint = process.env.MASTRA_URL ?? 'http://localhost:4111';
  const signin = await fetch(`${endpoint}/al/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'reminder-livekit-password' }),
  });
  assert.equal(signin.status, 200);
  const { token, user } = await signin.json();
  const connection = await fetch(`${endpoint}/voice/livekit/connection-details`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
  });
  assert.equal(connection.status, 200);
  const details = await connection.json();
  await room.connect(details.serverUrl, details.participantToken);
  const waitFor = async (condition: () => Promise<boolean>, timeout = 75000) => {
    const deadline = Date.now() + timeout;
    while (!await condition()) {
      assert.ok(Date.now() < deadline, 'Timed out waiting for real voice delivery.');
      await delay(500);
    }
  };
  await waitFor(async () => {
    const result = await storage.pool.query(`SELECT id, thread_id, resource_id FROM al_voice_sessions WHERE account_id = $1 AND state = 'active'`, [user.id]);
    if (!result.rows[0]) return false;
    const row = result.rows[0];
    voice = { sessionId: row.id, threadId: row.thread_id, resourceId: row.resource_id };
    return true;
  }, 30000);
  const reminder = await createReminder(voice!, { message: 'Water the plants', delayMinutes: 0.1, timezone: 'America/Los_Angeles' }, randomUUID());
  // Do not queue manually: this verifies the real minute scheduler in the API.
  await waitFor(async () => (await storage.pool.query('SELECT status FROM al_reminders WHERE id = $1', [reminder.id])).rows[0]?.status === 'completed');
  assert.ok(audioFrames > 0, 'received real audio frames');
  assert.equal(texts.filter(text => /Reminder: Water the plants/i.test(text)).length, 1);
  const memoryStore = await storage.getStore('memory');
  const saved = await memoryStore?.listMessages({ threadId: voice!.threadId, resourceId: voice!.resourceId, perPage: 50, includeTotal: false });
  assert.ok(saved?.messages.some(message => JSON.stringify(message.content).includes('Water the plants')), 'proactive utterance is persisted for future turns');
  const priorCount = texts.length;
  await room.localParticipant!.sendText('What reminder did you just give me?', { topic: 'lk.chat' });
  await waitFor(async () => texts.slice(priorCount).some(text => /water.*plants/i.test(text)), 30000);
  console.info('LiveKit reminder smoke passed:', { audioFrames, deliveryCount: 1 });
});
