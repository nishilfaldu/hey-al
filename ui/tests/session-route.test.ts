import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET, POST, DELETE } from '../app/api/session/route';

const token = 'b'.repeat(64);
const user = { id: 'account-1', email: 'al-test@example.test' };
const request = (method: string, origin = 'https://al.example.test') => new Request('https://al.example.test/api/session', {
  method, headers: { origin, cookie: `al_session=${token}` },
  ...(method === 'POST' ? { body: JSON.stringify({ email: user.email, password: 'test-password' }) } : {}),
});

test('creates a secure HttpOnly session and never exposes the backend token in JSON', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    assert.deepEqual(JSON.parse(init.body as string), { email: user.email, password: 'test-password' });
    return Response.json({ user, token, expiresIn: 7_776_000 });
  });
  const response = await POST(request('POST'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user });
  assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax; Max-Age=7776000; Secure/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('session lookup forwards only the opaque token and clears an expired cookie', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return Response.json({ user: null });
  });
  const response = await GET(request('GET'));
  assert.deepEqual(await response.json(), { user: null });
  assert.match(response.headers.get('set-cookie')!, /Max-Age=0/);
});

test('cross-origin sign-in and sign-out do not reach the backend', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  assert.equal((await POST(request('POST', 'https://another.example.test'))).status, 403);
  assert.equal((await DELETE(request('DELETE', 'https://another.example.test'))).status, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('wrong-password and rate-limit errors preserve their status', async t => {
  for (const status of [401, 429]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Try again.' }, { status }));
    assert.equal((await POST(request('POST'))).status, status);
    mock.mock.restore();
  }
});

test('sign-out revokes the server session before clearing the cookie', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    assert.equal(init.method, 'DELETE');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return Response.json({ signedOut: true });
  });
  assert.match((await DELETE(request('DELETE'))).headers.get('set-cookie')!, /Max-Age=0/);
});

test('backend failures do not overwrite an existing session cookie', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const response = await GET(request('GET'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
});
