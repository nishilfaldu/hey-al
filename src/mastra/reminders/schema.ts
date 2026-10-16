// Application tables share the account migration transaction and advisory lock.
export const reminderSchemaSql = `
  ALTER TABLE al_accounts ADD COLUMN IF NOT EXISTS reminder_timezone text;
  CREATE TABLE IF NOT EXISTS al_voice_sessions (
    id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES al_accounts(id) ON DELETE CASCADE,
    auth_session_hash text NOT NULL, thread_id text NOT NULL, resource_id text NOT NULL,
    room_name text, state text NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'active', 'superseded', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz,
    heartbeat_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS al_voice_active_account_idx
    ON al_voice_sessions(account_id) WHERE state = 'active';
  CREATE TABLE IF NOT EXISTS al_reminders (
    id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES al_accounts(id) ON DELETE CASCADE,
    message text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
    due_at timestamptz NOT NULL, timezone text NOT NULL, local_date_time text NOT NULL,
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'queued', 'completed', 'canceled')),
    version integer NOT NULL DEFAULT 1, creation_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, creation_key)
  );
  CREATE INDEX IF NOT EXISTS al_reminders_due_idx ON al_reminders(due_at) WHERE status = 'scheduled';
  CREATE INDEX IF NOT EXISTS al_reminders_account_idx ON al_reminders(account_id, due_at);
  CREATE TABLE IF NOT EXISTS al_reminder_deliveries (
    id uuid PRIMARY KEY, reminder_id uuid NOT NULL REFERENCES al_reminders(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES al_accounts(id) ON DELETE CASCADE,
    reminder_version integer NOT NULL,
    status text NOT NULL DEFAULT 'ready'
      CHECK (status IN ('ready', 'leased', 'speaking', 'spoken', 'interrupted', 'uncertain', 'failed', 'canceled')),
    attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid, lease_until timestamptz, voice_session_id uuid,
    started_at timestamptz, completed_at timestamptz, error_code text,
    UNIQUE (reminder_id, reminder_version)
  );
  CREATE INDEX IF NOT EXISTS al_reminder_ready_idx ON al_reminder_deliveries(account_id, next_attempt_at)
    WHERE status IN ('ready', 'leased', 'speaking');
`;
