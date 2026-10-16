import { setTimeout as delay } from 'node:timers/promises';
import type { voice } from '@livekit/agents';
import type * as Reminders from './store';
import type { Delivery, VoiceIdentity } from './store';

type Speech = Pick<voice.SpeechHandle, 'waitForPlayout' | 'interrupted' | 'exception' | 'interrupt' | 'chatItems'>;
export type ReminderSession = {
  readonly agentState: string;
  readonly userState: string;
  say(text: string, options: { allowInterruptions: boolean; addToChatCtx: boolean }): Speech;
  readonly history?: Pick<voice.AgentSession['history'], 'items'>;
};
export type DeliveryStore = Pick<typeof Reminders,
  'activateVoiceSession' | 'heartbeatVoiceSession' | 'closeVoiceSession' |
  'claimDelivery' | 'maintainDelivery' | 'finishDelivery'>;
export type VoiceDeliveryController = { stop(): Promise<void> };

// A single consumer per call. The database, rather than this controller, owns
// routing and delivery leases across the API/worker/job processes.
export async function startVoiceDelivery(options: {
  identity: VoiceIdentity;
  roomName: string;
  session: ReminderSession;
  persist: (delivery: Delivery, items: Speech['chatItems'], outcome: 'spoken' | 'interrupted' | 'uncertain' | 'retry') => Promise<void>;
  store?: DeliveryStore;
  pollMs?: number;
  heartbeatMs?: number;
  onPlaybackStarted?: (listener: () => void) => () => void;
}): Promise<VoiceDeliveryController> {
  const { identity, session } = options;
  const store = options.store ?? await import('./store');
  await store.activateVoiceSession(identity, options.roomName);
  const abort = new AbortController();
  let stopped = false;
  let current: Delivery | null = null;
  let speech: Speech | undefined;
  let playbackStarted = false;
  let authorizationLost = false;
  let heartbeatRunning = false;
  let heartbeatTask: Promise<void> = Promise.resolve();
  const quiet = () => session.userState !== 'speaking' && ['idle', 'listening'].includes(session.agentState);
  const pause = () => delay(options.pollMs ?? 2000, undefined, { signal: abort.signal }).catch(() => {});
  const interrupt = () => {
    try { speech?.interrupt(true); } catch { /* A closing session may already have released the handle. */ }
  };
  const unsubscribePlayback = options.onPlaybackStarted?.(() => { if (speech) playbackStarted = true; });

  const heartbeat = setInterval(() => {
    if (stopped || heartbeatRunning) return;
    heartbeatRunning = true;
    heartbeatTask = (async () => {
      try {
        await store.heartbeatVoiceSession(identity);
        const delivery = current;
        if (delivery && !await store.maintainDelivery(identity, delivery) && current?.id === delivery.id) interrupt();
      } catch {
        // On loss of authorization/lease certainty, stop audio. Recovery of an
        // expired speaking lease records uncertainty instead of replaying it.
        authorizationLost = true;
        stopped = true;
        abort.abort();
        interrupt();
        console.warn('Al reminder session stopped: authorization or heartbeat unavailable.');
      } finally { heartbeatRunning = false; }
    })();
  }, options.heartbeatMs ?? 5000);
  heartbeat.unref();

  const loop = (async () => {
    while (!stopped) {
      try {
        if (!quiet()) { await pause(); continue; }
        current = await store.claimDelivery(identity);
        if (!current) { await pause(); continue; }
        // A normal turn may have started while the database claim was in flight.
        // Keep the lease alive, then revalidate immediately before output.
        while (!stopped && !quiet()) await pause();
        if (stopped) {
          await store.finishDelivery(current, 'retry');
          break;
        }
        if (!await store.maintainDelivery(identity, current, true)) { current = null; continue; }
        if (stopped || !quiet()) {
          await store.finishDelivery(current, 'retry');
          current = null;
          continue;
        }
        const overdue = Date.now() - current.due_at.getTime() > 120000;
        const spokenText = `${overdue ? 'Earlier reminder' : 'Reminder'}: ${current.message}`;
        const priorItems = new Set(session.history?.items.map(item => item.id));
        speech = session.say(spokenText, {
          allowInterruptions: true, addToChatCtx: true,
        });
        let outcome: 'spoken' | 'interrupted' | 'uncertain' | 'retry';
        try {
          await speech.waitForPlayout();
          outcome = authorizationLost || stopped ? 'uncertain'
            : speech.interrupted ? 'interrupted'
              : speech.exception() ? (playbackStarted || speech.chatItems.length ? 'uncertain' : 'retry') : 'spoken';
        } catch {
          outcome = playbackStarted || speech.chatItems.length ? 'uncertain' : 'retry';
        }
        // Memory errors cannot turn already-played audio into a retry.
        // LiveKit 1.9.1 say() commits to session.history, but unlike generated
        // replies does not populate SpeechHandle.chatItems. Scope the fallback
        // to this utterance; never re-save unrelated normal turns.
        const items = speech.chatItems.length ? speech.chatItems : (session.history?.items ?? []).filter(item =>
          !priorItems.has(item.id) && item.type === 'message' && item.role === 'assistant' &&
          item.textContent && (spokenText.startsWith(item.textContent) || item.textContent.startsWith(spokenText)));
        try { await options.persist(current, items, outcome); }
        catch { console.warn('Al reminder transcript could not be saved.', { id: current.id }); }
        await store.finishDelivery(current, outcome);
        console.info('Al reminder delivery:', { id: current.id, outcome });
      } catch {
        if (current) {
          try { await store.finishDelivery(current, speech ? 'uncertain' : 'retry'); } catch { /* Lease recovery handles database outages. */ }
        }
        console.warn('Al reminder poll failed; pending database work will retry.');
      } finally { current = null; speech = undefined; playbackStarted = false; }
      await pause();
    }
  })();

  let stopping: Promise<void> | undefined;
  return { stop: () => stopping ??= (async () => {
    stopped = true;
    abort.abort();
    clearInterval(heartbeat);
    unsubscribePlayback?.();
    interrupt();
    await heartbeatTask;
    await loop;
    await store.closeVoiceSession(identity.sessionId);
  })() };
}
