'use client';

// The voice page: one button to start a call with Al, and a bubble that shows what Al is doing.
// Follows LiveKit's React quickstart: https://docs.livekit.io/transport/sdk-platforms/react/
import { RoomAudioRenderer, SessionProvider, useAgent, useSession } from '@livekit/components-react';
import { TokenSource } from 'livekit-client';

// The Mastra server's connection route (see src/mastra/index.ts). It returns a LiveKit room
// token and sends Al's voice worker into that room, so the page needs no server of its own.
const tokenSource = TokenSource.endpoint(
  `${process.env.NEXT_PUBLIC_MASTRA_URL ?? 'http://localhost:4111'}/voice/livekit/connection-details`,
);

// What the person reads under the bubble, for each state that LiveKit reports for the agent.
const LABELS: Partial<Record<string, string>> = {
  connecting: 'Connecting…',
  'pre-connect-buffering': 'Connecting…',
  initializing: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  failed: 'Al is not available right now.',
};

export default function Home() {
  // A session is one call: start() fetches a token, joins the room, and turns on the microphone.
  // No agentName option: the Mastra route picks the agent (AL_AGENT_NAME in src/mastra/index.ts)
  // and ignores the client's choice, so naming it here would only add a second source of truth.
  const session = useSession(tokenSource);

  return (
    <SessionProvider session={session}>
      <main className="flex min-h-screen flex-col items-center justify-center gap-10 p-6">
        <Bubble />
        {session.isConnected ? (
          <button className="big-button" onClick={() => session.end()}>
            End call
          </button>
        ) : (
          // The click also lets the browser play Al's audio (browsers block sound until a user gesture).
          <button className="big-button" onClick={() => session.start({ tracks: { microphone: { enabled: true } } })}>
            Talk to Al
          </button>
        )}
        {/* Plays Al's voice. */}
        <RoomAudioRenderer />
      </main>
    </SessionProvider>
  );
}

function Bubble() {
  // state: disconnected, connecting, initializing, listening, thinking, speaking, or failed.
  const { state } = useAgent();
  return (
    <>
      <div className="bubble" data-state={state} aria-hidden />
      <p className="text-2xl" aria-live="polite">
        {LABELS[state] ?? ''}
      </p>
    </>
  );
}
