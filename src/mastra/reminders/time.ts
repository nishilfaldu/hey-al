import { Temporal } from '@js-temporal/polyfill';

export type ReminderTimeInput = {
  localDateTime?: string;
  delayMinutes?: number;
  timezone?: string;
};

export function validateTimezone(timezone: string) {
  // Require a named zone; numeric offsets cannot express daylight-saving rules.
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timezone) && timezone !== 'UTC') {
    throw new Error('Use an IANA timezone such as America/Los_Angeles.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw new Error('That timezone is not recognized. Please confirm your timezone.'); }
  return timezone;
}

export function resolveReminderTime(input: ReminderTimeInput, savedTimezone?: string | null, now = new Date()) {
  const timezone = validateTimezone(input.timezone ?? savedTimezone ?? '');
  if ((input.localDateTime !== undefined) === (input.delayMinutes !== undefined)) {
    throw new Error('Provide either a complete local date and time or a delay in minutes.');
  }
  let zoned: Temporal.ZonedDateTime;
  if (input.delayMinutes !== undefined) {
    if (!Number.isFinite(input.delayMinutes) || input.delayMinutes <= 0 || input.delayMinutes > 525600) {
      throw new Error('The delay must be greater than zero and at most one year.');
    }
    zoned = Temporal.Instant.fromEpochMilliseconds(now.getTime() + Math.round(input.delayMinutes * 60000)).toZonedDateTimeISO(timezone);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(input.localDateTime!)) {
      throw new Error('Provide the full local date and time, including the year, as YYYY-MM-DDTHH:mm.');
    }
    try {
      zoned = Temporal.PlainDateTime.from(input.localDateTime!, { overflow: 'reject' })
        .toZonedDateTime(timezone, { disambiguation: 'reject' });
    } catch {
      throw new Error('That local time is invalid or ambiguous, possibly because of daylight saving. Ask for another time.');
    }
  }
  const dueAt = new Date(Number(zoned.epochMilliseconds));
  if (dueAt.getTime() <= now.getTime()) throw new Error('That time has already passed. Ask for a future date and time.');
  return { dueAt, timezone, localDateTime: zoned.toPlainDateTime().toString({ smallestUnit: 'second' }), confirmation: formatReminderTime(dueAt, timezone) };
}

export function formatReminderTime(dueAt: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(dueAt);
}
