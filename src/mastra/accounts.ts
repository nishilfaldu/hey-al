import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { storage } from './storage';

const deriveKey = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
export const SESSION_SECONDS = 90 * 24 * 60 * 60;
export const credentialsSchema = z.object({
  email: z.email().max(254).transform(value => value.trim().toLowerCase()),
  password: z.string().min(8).max(128),
});
export type Account = { id: string; email: string; memory_version: number };
export const resourceFor = (account: Account) => `al:${account.id}:${account.memory_version}`;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt);
  return `scrypt:65536:8:1:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, cost, blockSize, parallel, salt, expected] = encoded.split(':');
  if (algorithm !== 'scrypt' || cost !== '65536' || blockSize !== '8' || parallel !== '1' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(expected ?? '')) return false;
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

let tablesReady: Promise<void> | undefined;
export function ensureAppTables() {
  tablesReady ??= (async () => {
    const client = await storage.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(72819431)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS al_accounts (
          id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
          memory_version integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS al_sessions (
          token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES al_accounts(id) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL
        );
        CREATE TABLE IF NOT EXISTS al_login_limits (
          key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS al_calls (
          thread_id text PRIMARY KEY, resource_id text NOT NULL,
          started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(), summarized_at timestamptz,
          summary text, purged boolean NOT NULL DEFAULT false
        );
        CREATE INDEX IF NOT EXISTS al_calls_resource_idx ON al_calls(resource_id, started_at DESC);
        CREATE TABLE IF NOT EXISTS al_memory_cleanup (
          resource_id text PRIMARY KEY, requested_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  })().catch(error => { tablesReady = undefined; throw error; });
  return tablesReady;
}

export class AccountError extends Error {
  constructor(message: string, public status: 400 | 401 | 429) { super(message); }
}

async function limitAttempts(key: string) {
  const result = await storage.pool.query<{ attempts: number }>(`
    INSERT INTO al_login_limits(key, attempts) VALUES ($1, 1)
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN al_login_limits.window_start < now() - interval '15 minutes' THEN 1 ELSE al_login_limits.attempts + 1 END,
      window_start = CASE WHEN al_login_limits.window_start < now() - interval '15 minutes' THEN now() ELSE al_login_limits.window_start END
    RETURNING attempts`, [tokenHash(key)]);
  if (result.rows[0].attempts > 10) throw new AccountError('Too many attempts. Please try again in fifteen minutes.', 429);
}

export async function createOrSignIn(input: unknown, ip: string) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new AccountError('Enter a valid email and a password with 8 to 128 characters.', 400);
  const { email, password } = parsed.data;
  await ensureAppTables();
  await limitAttempts(`email:${email}`);
  await limitAttempts(`ip:${ip}`);
  const existing = await storage.pool.query<Account & { password_hash: string }>('SELECT * FROM al_accounts WHERE email = $1', [email]);
  let account = existing.rows[0];
  if (!account) {
    const passwordHash = await hashPassword(password);
    const created = await storage.pool.query<Account & { password_hash: string }>(`
      INSERT INTO al_accounts(id, email, password_hash) VALUES ($1, $2, $3)
      ON CONFLICT (email) DO NOTHING RETURNING *`, [randomUUID(), email, passwordHash]);
    // A simultaneous request may have created the email; its password still needs verification.
    account = created.rows[0] ?? (await storage.pool.query<Account & { password_hash: string }>('SELECT * FROM al_accounts WHERE email = $1', [email])).rows[0];
    if (!created.rows[0] && !await verifyPassword(password, account.password_hash)) throw new AccountError('That password did not match. Please try again.', 401);
  } else if (!await verifyPassword(password, account.password_hash)) {
    throw new AccountError('That password did not match. Please try again.', 401);
  }
  const token = randomBytes(32).toString('hex');
  await storage.pool.query('INSERT INTO al_sessions(token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), account.id, new Date(Date.now() + SESSION_SECONDS * 1000)]);
  return { token, user: { id: account.id, email: account.email } };
}

export async function getAccount(token?: string): Promise<Account | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  await ensureAppTables();
  const result = await storage.pool.query<Account>(`
    SELECT a.id, a.email, a.memory_version FROM al_accounts a
    JOIN al_sessions s ON s.account_id = a.id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash(token)]);
  return result.rows[0] ?? null;
}

export async function signOut(token?: string) {
  if (!token) return;
  await ensureAppTables();
  await storage.pool.query('DELETE FROM al_sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export async function isCurrentResource(resourceId: string) {
  const match = /^al:([a-f0-9-]{36}):(\d+)$/.exec(resourceId);
  if (!match) return false;
  await ensureAppTables();
  const result = await storage.pool.query('SELECT 1 FROM al_accounts WHERE id = $1 AND memory_version = $2', [match[1], Number(match[2])]);
  return result.rowCount === 1;
}
