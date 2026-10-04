// The voice worker: a separate long-running process that LiveKit sends each new call to.
// LiveKit handles the audio (hearing, turn-taking, interruptions); this worker asks the
// Mastra agent for each reply. Run it with `pnpm run voice:dev` next to `pnpm run dev`.
// Docs: https://mastra.ai/integrations/voice/livekit
import { fileURLToPath } from 'node:url'
import { createLiveKitWorker, runLiveKitWorker } from '@mastra/livekit/worker'
import { AL_AGENT_NAME, mastra } from './index'

export default createLiveKitWorker({
  mastra,
  agent: 'al',
  // Speech-to-text and text-to-speech run on LiveKit Inference, so the LiveKit key covers them.
  stt: 'deepgram/nova-3',
  // Saath picked Inworld over Cartesia after a listening test: half the price, similar time to first audio.
  tts: 'inworld/inworld-tts-2',
  // A small local model that reads the transcript to decide when the person has finished a sentence.
  turnDetection: 'multilingual',
  configuration: {
    greeting: { text: 'Hello, this is Al. How can I help?' },
    // Watch for the agent's endCall tool, let the goodbye finish playing, then hang up.
    endCall: {},
  },
})

// The worker starts child processes that import this file again; only the top-level run starts the CLI.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runLiveKitWorker({ entry: import.meta.url, agentName: AL_AGENT_NAME })
}
