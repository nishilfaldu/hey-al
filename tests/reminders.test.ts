import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('durable reminders, authenticated routing, leases and cancellation in Postgres', { skip: !process.env.DATABASE_URL, timeout: 120000 }, async t => {
  const { storage } = await import('../src/mastra/storage');
  const accounts = await import('../src/mastra/accounts');
  const store = await import('../src/mastra/reminders/store');
  await accounts.ensureAppTables();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const emails = [0, 1].map(() => `reminder-check-${randomUUID()}@example.test`);
  const signins = await Promise.all(emails.map(email => accounts.createOrSignIn({ email, password: 'reminder-check-password' }, `test-${randomUUID()}`)));
  t.after(async () => {
    clearInterval(heartbeat);
    await storage.pool.query('DELETE FROM al_calls WHERE resource_id = ANY($1)', [signins.map(login => `al:${login.user.id}:0`)]);
    await storage.pool.query('DELETE FROM al_accounts WHERE email = ANY($1)', [emails]);
    await storage.close();
  });
  const newCall = async (index: number) => {
    const identity = await store.createPendingVoiceSession(signins[index].token, `reminder-thread-${randomUUID()}`);
    await store.activateVoiceSession(identity, `room-${randomUUID()}`);
    return identity;
  };
  let a = await newCall(0);
  const b = await newCall(1);
  heartbeat = setInterval(() => {
    void store.heartbeatVoiceSession(a).catch(() => {});
    void store.heartbeatVoiceSession(b).catch(() => {});
  }, 5000);
  heartbeat.unref();
  // Test scanners must never claim other accounts' real reminders.
  const queue = () => store.queueDueReminders(100, signins[0].user.id);
  const due = async (id: string) => {
    await storage.pool.query(`UPDATE al_reminders SET due_at = now() - interval '1 second' WHERE id = $1`, [id]);
    await queue();
  };
  const create = (message = 'Go to the doctor') => store.createReminder(a, { message, delayMinutes: 2, timezone: 'America/Los_Angeles' }, randomUUID());

  await t.test('missing timezone rejects; confirmed zone persists; tool retries reuse the saved row', async () => {
    await assert.rejects(store.createReminder(a, { message: 'Doctor', delayMinutes: 2 }, randomUUID()), /timezone/);
    const key = randomUUID();
    const first = await store.createReminder(a, { message: 'Doctor', delayMinutes: 2, timezone: 'America/Los_Angeles' }, key);
    const repeated = await store.createReminder(a, { message: 'Doctor', delayMinutes: 2 }, key);
    assert.equal(first.id, repeated.id);
    assert.equal((await store.getReminderContext(a)).timezone, 'America/Los_Angeles');
    assert.equal((await store.listReminders(b)).length, 0);
    await assert.rejects(store.changeReminder(b, first.id), /not found/);
    await assert.rejects(store.getReminderContext({ ...a, resourceId: b.resourceId }), /authorized/);
    await store.changeReminder(a, first.id);
  });
  await t.test('overdue scan and competing runs/claims produce one delivery and completed playback', async () => {
    const reminder = await create();
    await due(reminder.id);
    await Promise.all([queue(), queue()]);
    const rows = await storage.pool.query('SELECT * FROM al_reminder_deliveries WHERE reminder_id = $1', [reminder.id]);
    assert.equal(rows.rowCount, 1);
    const claims = await Promise.all([store.claimDelivery(a), store.claimDelivery(a)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const delivery = claims.find(Boolean)!;
    assert.equal(await store.maintainDelivery(a, delivery, true), true);
    assert.equal(await store.finishDelivery(delivery, 'spoken'), true);
    assert.equal(await store.finishDelivery(delivery, 'spoken'), false);
    assert.equal((await store.listReminders(a)).find(row => row.id === reminder.id)?.status, 'completed');
    assert.equal(await store.claimDelivery(b), null);
  });
  await t.test('rescheduling invalidates a claimed old version; cancellation prevents playback', async () => {
    const reminder = await create();
    await due(reminder.id);
    const claimed = (await store.claimDelivery(a))!;
    await assert.rejects(store.changeReminder(a, reminder.id, { localDateTime: '2026-02-30T09:00' }), /invalid/);
    assert.equal(await store.maintainDelivery(a, claimed), true, 'invalid updates roll back delivery invalidation');
    const updated = await store.changeReminder(a, reminder.id, { delayMinutes: 5 });
    assert.equal(updated.reminder.version, 2);
    assert.equal(await store.maintainDelivery(a, claimed, true), false);
    assert.equal(await store.finishDelivery(claimed, 'spoken'), false);
    await due(reminder.id);
    const next = (await store.claimDelivery(a))!;
    await store.maintainDelivery(a, next, true);
    assert.equal((await store.changeReminder(a, reminder.id)).speechInProgress, true);
    assert.equal(await store.maintainDelivery(a, next), false);
    assert.equal(await store.finishDelivery(next, 'spoken'), false);
  });
  await t.test('worker crashes reclaim unstarted work but do not replay possibly heard speech', async () => {
    const reminder = await create();
    await due(reminder.id);
    const first = (await store.claimDelivery(a))!;
    await storage.pool.query(`UPDATE al_reminder_deliveries SET lease_until = now() - interval '1 second' WHERE id = $1`, [first.id]);
    const reclaimed = (await store.claimDelivery(a))!;
    assert.equal(reclaimed.id, first.id);
    assert.notEqual(reclaimed.lease_token, first.lease_token);
    assert.equal(await store.finishDelivery(first, 'spoken'), false);
    await store.maintainDelivery(a, reclaimed, true);
    await storage.pool.query(`UPDATE al_reminder_deliveries SET lease_until = now() - interval '1 second' WHERE id = $1`, [first.id]);
    assert.equal(await store.claimDelivery(a), null);
    const saved = (await store.listReminders(a)).find(row => row.id === reminder.id)!;
    assert.equal(saved.delivery_status, 'uncertain');
    await store.changeReminder(a, reminder.id);
  });
  await t.test('interruption remains visible; failures have bounded retries', async () => {
    const reminder = await create();
    await due(reminder.id);
    const delivery = (await store.claimDelivery(a))!;
    await store.maintainDelivery(a, delivery, true);
    await store.finishDelivery(delivery, 'interrupted');
    assert.equal(await store.claimDelivery(a), null);
    assert.equal((await store.listReminders(a)).find(row => row.id === reminder.id)?.delivery_status, 'interrupted');
    await store.changeReminder(a, reminder.id);
    const failing = await create('Retry check');
    await due(failing.id);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claim = (await store.claimDelivery(a))!;
      assert.equal(claim.attempts, attempt);
      await store.finishDelivery(claim, 'retry');
      await storage.pool.query('UPDATE al_reminder_deliveries SET next_attempt_at = now() WHERE id = $1', [claim.id]);
    }
    assert.equal(await store.claimDelivery(a), null);
    assert.equal((await store.listReminders(a)).find(row => row.id === failing.id)?.delivery_status, 'failed');
    await store.changeReminder(a, failing.id);
  });
  await t.test('newest call receives reminders; stale cleanup cannot remove it; no-call backlog survives', async () => {
    const old = a;
    a = await newCall(0);
    await assert.rejects(store.claimDelivery(old), /authorized/);
    await store.closeVoiceSession(old.sessionId);
    await store.heartbeatVoiceSession(a);
    const reminder = await create();
    await store.closeVoiceSession(a.sessionId);
    await due(reminder.id);
    await assert.rejects(store.claimDelivery(a), /authorized/);
    a = await newCall(0);
    const claim = (await store.claimDelivery(a))!;
    assert.equal(claim.reminder_id, reminder.id);
    await store.finishDelivery(claim, 'spoken');
  });
  await t.test('memory rotation preserves reminder ownership but revokes the old call, as does logout', async () => {
    const reminder = await create();
    await storage.pool.query('UPDATE al_accounts SET memory_version = memory_version + 1 WHERE id = $1', [signins[0].user.id]);
    await assert.rejects(store.getReminderContext(a), /authorized/);
    a = await newCall(0);
    assert.ok((await store.listReminders(a)).some(row => row.id === reminder.id));
    await accounts.signOut(signins[0].token);
    await assert.rejects(store.claimDelivery(a), /authorized/);
    await storage.pool.query(`UPDATE al_sessions SET expires_at = now() WHERE account_id = $1`, [signins[1].user.id]);
    await assert.rejects(store.claimDelivery(b), /authorized/);
  });
});
