import { cookieHeader, mastraEndpoint, sameOrigin, sessionToken } from '../../../lib/session';

export async function GET(request: Request) {
  const token = sessionToken(request);
  if (!token) return Response.json({ user: null }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const upstream = await fetch(mastraEndpoint('/al/session'), {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) throw new Error('Session unavailable');
    const { user } = await upstream.json();
    return Response.json({ user }, { headers: { 'Cache-Control': 'no-store', ...(!user ? { 'Set-Cookie': cookieHeader(request, '', 0) } : {}) } });
  } catch { return Response.json({ error: 'Could not check your sign-in. Please try again.' }, { status: 503 }); }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Please sign in from this app.' }, { status: 403 });
  try {
    const raw = await request.text();
    if (raw.length > 2048) return Response.json({ error: 'Request too large.' }, { status: 400 });
    const upstream = await fetch(mastraEndpoint('/al/session'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local' },
      body: raw, cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    const data = await upstream.json();
    if (!upstream.ok) return Response.json({ error: data.error || 'Could not sign in.' }, { status: upstream.status });
    if (!/^[a-f0-9]{64}$/.test(data.token) || !data.user?.id || !Number.isSafeInteger(data.expiresIn)) throw new Error('Invalid session response');
    return Response.json({ user: data.user }, { headers: { 'Set-Cookie': cookieHeader(request, data.token, data.expiresIn), 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Could not sign in right now. Please try again in a moment.' }, { status: 503 }); }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Please sign out from this app.' }, { status: 403 });
  const token = sessionToken(request);
  try {
    if (token) {
      const upstream = await fetch(mastraEndpoint('/al/session'), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (!upstream.ok) throw new Error('Could not revoke session');
    }
    return Response.json({ signedOut: true }, { headers: { 'Set-Cookie': cookieHeader(request, '', 0), 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Could not sign out. Please try again.' }, { status: 503 }); }
}
