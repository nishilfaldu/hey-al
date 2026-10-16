import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { llm } from '@livekit/agents';
import { startVoiceDelivery, type DeliveryStore, type ReminderSession } from '../src/mastra/reminders/voice-delivery';
import type { Delivery } from '../src/mastra/reminders/store';

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the voice controller.');
    await delay(5);
  }
}
function harness(mode: 'normal' | 'interrupted' | 'tts-error' | 'hang' = 'normal') {
  const identity = { sessionId: randomUUID(), threadId: 'test-thread', resourceId: 'test-resource' };
  const delivery: Delivery = { id: randomUUID(), reminder_id: randomUUID(), reminder_version: 1,
    message: 'Go to the doctor', due_at: new Date(), timezone: 'UTC', lease_token: randomUUID(), attempts: 1 };
  const spoken: string[] = [];
  const outcomes: string[] = [];
  let claimed = false;
  let valid = true;
  let interrupted = mode === 'interrupted';
  let released = false;
  let resolveSpeech: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { resolveSpeech = resolve; });
  const session: ReminderSession & { agentState: string; userState: string } = {
    agentState: 'listening', userState: 'listening',
    history: { items: [] },
    say: text => {
      spoken.push(text);
      // Match the SDK's say() behavior: history is populated; chatItems stays empty.
      if (mode === 'normal') session.history!.items.push({
        id: 'committed-reminder', type: 'message', role: 'assistant', textContent: text,
      } as unknown as llm.ChatMessage);
      return {
        waitForPlayout: async () => { if (mode === 'hang') await waiting; },
        get interrupted() { return interrupted; },
        exception: () => mode === 'tts-error' ? new Error('TTS unavailable') : undefined,
        interrupt: () => { interrupted = true; resolveSpeech?.(); return undefined as never; },
        chatItems: [],
      };
    },
  };
  const store: DeliveryStore = {
    activateVoiceSession: async () => ({ ...identity, accountId: randomUUID(), timezone: 'UTC' }),
    heartbeatVoiceSession: async () => { if (!valid) throw new Error('Revoked'); },
    closeVoiceSession: async () => { released = true; },
    claimDelivery: async () => {
      if (claimed) return null;
      claimed = true;
      return delivery;
    },
    maintainDelivery: async () => valid,
    finishDelivery: async (_delivery, outcome) => { outcomes.push(outcome); return true; },
  };
  return { identity, session, store, spoken, outcomes, released: () => released, revoke: () => { valid = false; } };
}

test('reminder waits through user speech and a normal reply, then plays once', async t => {
  const h = harness();
  h.session.userState = 'speaking';
  const persisted: string[] = [];
  const controller = await startVoiceDelivery({ ...h, roomName: 'room', pollMs: 5, heartbeatMs: 20,
    persist: async (_delivery, items) => { persisted.push(...items.map(item => item.id)); } });
  t.after(() => controller.stop());
  await delay(25);
  assert.equal(h.spoken.length, 0);
  h.session.userState = 'listening';
  h.session.agentState = 'thinking';
  await delay(25);
  assert.equal(h.spoken.length, 0);
  h.session.agentState = 'listening';
  await until(() => h.outcomes.length === 1);
  assert.deepEqual(h.spoken, ['Reminder: Go to the doctor']);
  assert.deepEqual(h.outcomes, ['spoken']);
  assert.deepEqual(persisted, ['committed-reminder']);
  await controller.stop();
  assert.equal(h.released(), true);
});
test('interrupted speech stays interrupted and is not automatically replayed', async t => {
  const h = harness('interrupted');
  const controller = await startVoiceDelivery({ ...h, roomName: 'room', pollMs: 5, persist: async () => {} });
  t.after(() => controller.stop());
  await until(() => h.outcomes.length === 1);
  await delay(25);
  assert.deepEqual(h.outcomes, ['interrupted']);
  assert.equal(h.spoken.length, 1);
});
test('a TTS failure before playback is retryable', async t => {
  const h = harness('tts-error');
  const controller = await startVoiceDelivery({ ...h, roomName: 'room', pollMs: 5, persist: async () => {} });
  t.after(() => controller.stop());
  await until(() => h.outcomes.length === 1);
  assert.deepEqual(h.outcomes, ['retry']);
});
test('revoked authorization interrupts running speech and records uncertainty', async t => {
  const h = harness('hang');
  const controller = await startVoiceDelivery({ ...h, roomName: 'room', pollMs: 5, heartbeatMs: 10, persist: async () => {} });
  t.after(() => controller.stop());
  await until(() => h.spoken.length === 1);
  h.revoke();
  await until(() => h.outcomes.length === 1);
  assert.deepEqual(h.outcomes, ['uncertain']);
});
test('transcript persistence failure cannot replay successfully completed audio', async t => {
  const h = harness();
  const controller = await startVoiceDelivery({ ...h, roomName: 'room', pollMs: 5, persist: async () => { throw new Error('Memory unavailable'); } });
  t.after(() => controller.stop());
  await until(() => h.outcomes.length === 1);
  assert.deepEqual(h.outcomes, ['spoken']);
});
test('a canceled claim is revalidated before any speech starts', async t => {
  const h = harness();
  h.store.maintainDelivery = async () => false;
  const controller = await startVoiceDelivery({ ...h, roomName: 'room', pollMs: 5, persist: async () => {} });
  t.after(() => controller.stop());
  await delay(25);
  assert.equal(h.spoken.length, 0);
});
