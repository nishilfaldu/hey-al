import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

// Opt-in because this calls the actual model. No LiveKit room or microphone needed.
test('Al clarifies, saves, lists, reschedules and cancels through real model tool calls', {
  skip: process.env.AL_REMINDER_LLM_SMOKE !== '1', timeout: 120000,
}, async t => {
  const { storage } = await import('../src/mastra/storage');
  const accounts = await import('../src/mastra/accounts');
  const reminders = await import('../src/mastra/reminders/store');
  const { alMemory } = await import('../src/mastra/memory/al-memory');
  const { al } = await import('../src/mastra/agents/al');
  const { RequestContext } = await import('@mastra/core/request-context');
  await storage.init();
  const email = `reminder-model-${randomUUID()}@example.test`;
  const signin = await accounts.createOrSignIn({ email, password: 'reminder-model-password' }, `test-${randomUUID()}`);
  const threadId = `reminder-model-thread-${randomUUID()}`;
  const voice = await reminders.createPendingVoiceSession(signin.token, threadId);
  await reminders.activateVoiceSession(voice, 'model-smoke-room');
  const context = new RequestContext([
    ['alVoiceSessionId', voice.sessionId], ['alThreadId', threadId], ['alResourceId', voice.resourceId],
  ]);
  const heartbeat = setInterval(() => { void reminders.heartbeatVoiceSession(voice).catch(() => {}); }, 5000);
  t.after(async () => {
    clearInterval(heartbeat);
    await alMemory.settled();
    await alMemory.deleteThread(threadId);
    await storage.pool.query('DELETE FROM al_accounts WHERE email = $1', [email]);
    await storage.close();
  });
  const reply = async (text: string) => {
    const stream = await al.stream(text, { memory: { thread: threadId, resource: voice.resourceId }, requestContext: context, maxSteps: 5 });
    for await (const _chunk of stream.fullStream) { /* Exercise the voice streaming path. */ }
    return stream.getFullOutput();
  };
  const missing = await reply('Remind me to water the plants in two minutes.');
  assert.equal((await reminders.listReminders(voice)).length, 0, 'must clarify the unknown timezone');
  assert.match(missing.text, /time.?zone|where.*(?:live|located)|which.*time/i);
  const created = await reply('My timezone is America/Los_Angeles. Use that for reminders and save the reminder for two minutes from now.');
  assert.ok(created.toolCalls.some(call => call.payload.toolName === 'create_reminder'), JSON.stringify({ text: created.text, toolCalls: created.toolCalls.map(call => call.payload.toolName), steps: created.steps?.length }));
  const saved = await reminders.listReminders(voice);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].timezone, 'America/Los_Angeles');
  const listed = await reply('What reminders do I have?');
  assert.ok(listed.toolCalls.some(call => call.payload.toolName === 'list_reminders'));
  const updated = await reply('Change the plant reminder to five minutes from now.');
  assert.ok(updated.toolCalls.some(call => call.payload.toolName === 'update_reminder'));
  assert.equal((await reminders.listReminders(voice))[0].version, 2);
  const canceled = await reply('Cancel the plant reminder.');
  assert.ok(canceled.toolCalls.some(call => call.payload.toolName === 'cancel_reminder'));
  assert.equal((await reminders.listReminders(voice))[0].status, 'canceled');
});
