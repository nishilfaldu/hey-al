import { randomUUID } from 'node:crypto';
import { liveKitConnectionRoute } from '@mastra/livekit';
import { registerApiRoute, type MiddlewareHandler } from '@mastra/core/server';
import { AccountError, createOrSignIn, getAccount, resourceFor, SESSION_SECONDS, signOut } from './accounts';
import { startCall, startMemoryMaintenance } from './memory/call-memory';

const bearer = (header?: string) => header?.startsWith('Bearer ') ? header.slice(7) : undefined;

export const accountRoutes = [
  registerApiRoute('/al/session', {
    method: 'POST', requiresAuth: false,
    handler: async c => {
      try {
        if (Number(c.req.header('content-length') ?? 0) > 2048) return c.json({ error: 'Request too large.' }, 400);
        const input = await c.req.json().catch(() => null);
        const result = await createOrSignIn(input, c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local');
        return c.json({ ...result, expiresIn: SESSION_SECONDS }, 200, { 'Cache-Control': 'no-store' });
      } catch (error) {
        if (error instanceof AccountError) return c.json({ error: error.message }, error.status);
        console.error('Al account sign-in failed.');
        return c.json({ error: 'Could not sign in. Please try again.' }, 503);
      }
    },
  }),
  registerApiRoute('/al/session', {
    method: 'GET', requiresAuth: false,
    createHandler: async () => {
      startMemoryMaintenance();
      return async c => {
        const account = await getAccount(bearer(c.req.header('authorization')));
        return c.json({ user: account ? { id: account.id, email: account.email } : null }, 200, { 'Cache-Control': 'no-store' });
      };
    },
  }),
  registerApiRoute('/al/session', {
    method: 'DELETE', requiresAuth: false,
    handler: async c => { await signOut(bearer(c.req.header('authorization'))); return c.json({ signedOut: true }); },
  }),
];

export function authenticatedVoiceRoute(agentName: string) {
  const route = liveKitConnectionRoute({
    agentName,
    participantIdentity: () => `caller-${randomUUID()}`,
    metadata: async ({ context }) => {
      const account = await getAccount(bearer(context.req.header('authorization')));
      if (!account) throw new Error('Please sign in to start talking.');
      const resourceId = resourceFor(account);
      const threadId = await startCall(resourceId);
      // Ignore all client-supplied agent, resource, thread and request-context fields.
      return { agentId: 'al', threadId, resourceId, requestContext: { alResourceId: resourceId } };
    },
  });
  const requireAccount: MiddlewareHandler = async (c, next) => {
    if (!await getAccount(bearer(c.req.header('authorization')))) return c.json({ error: 'Please sign in to start talking.' }, 401);
    await next();
  };
  return { ...route, middleware: requireAccount };
}
