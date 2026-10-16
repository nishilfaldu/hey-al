import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveReminderTime } from '../src/mastra/reminders/time';

const now = new Date('2026-10-04T12:00:00Z');
test('local reminder dates resolve to UTC with a separately retained named timezone', () => {
  const time = resolveReminderTime({ localDateTime: '2026-10-25T09:00', timezone: 'America/Los_Angeles' }, null, now);
  assert.equal(time.dueAt.toISOString(), '2026-10-25T16:00:00.000Z');
  assert.equal(time.timezone, 'America/Los_Angeles');
  assert.match(time.confirmation, /9:00 AM PDT/);
  const winter = resolveReminderTime({ localDateTime: '2026-12-25T09:00' }, 'America/Los_Angeles', now);
  assert.equal(winter.dueAt.toISOString(), '2026-12-25T17:00:00.000Z');
});
test('relative delays use a fresh clock and the saved confirmed timezone', () => {
  assert.equal(resolveReminderTime({ delayMinutes: 2 }, 'America/Los_Angeles', now).dueAt.toISOString(), '2026-10-04T12:02:00.000Z');
  assert.equal(resolveReminderTime({ delayMinutes: 0.5 }, 'UTC', now).dueAt.toISOString(), '2026-10-04T12:00:30.000Z');
});
test('missing details, invalid/past dates, offsets and DST ambiguity require clarification', () => {
  assert.throws(() => resolveReminderTime({ delayMinutes: 2 }, null, now), /IANA timezone/);
  assert.throws(() => resolveReminderTime({ timezone: 'UTC' }, null, now), /either/);
  assert.throws(() => resolveReminderTime({ delayMinutes: 1, localDateTime: '2026-10-25T09:00', timezone: 'UTC' }, null, now), /either/);
  assert.throws(() => resolveReminderTime({ localDateTime: '2026-10-04T09:00', timezone: 'UTC' }, null, now), /passed/);
  assert.throws(() => resolveReminderTime({ localDateTime: '2026-02-30T09:00', timezone: 'UTC' }, null, now), /invalid/);
  assert.throws(() => resolveReminderTime({ delayMinutes: 2, timezone: '+05:30' }, null, now), /IANA/);
  assert.throws(() => resolveReminderTime({ delayMinutes: 2, timezone: 'America/Missing' }, null, now), /not recognized/);
  assert.throws(() => resolveReminderTime({ localDateTime: '2026-11-01T01:30', timezone: 'America/Los_Angeles' }, null, now), /ambiguous/);
  assert.throws(() => resolveReminderTime({ localDateTime: '2026-03-08T02:30', timezone: 'America/Los_Angeles' }, null, new Date('2026-01-01')), /invalid/);
});
