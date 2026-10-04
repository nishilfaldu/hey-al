export const SESSION_COOKIE = 'al_session';

export function sessionToken(request: Request) {
  const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  return (!origin || origin === new URL(request.url).origin) && request.headers.get('sec-fetch-site') !== 'cross-site';
}

export function mastraEndpoint(path: string) {
  return new URL(path, process.env.MASTRA_URL || 'http://localhost:4111');
}

export function cookieHeader(request: Request, token: string, maxAge: number) {
  const secure = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
