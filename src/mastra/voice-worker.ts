// The voice worker: a separate long-running process that LiveKit sends each new call to.
// LiveKit handles the audio (hearing, turn-taking, interruptions); this worker asks the
// Mastra agent for each reply. Run it with `pnpm run voice:dev` next to `pnpm run dev`.
// Docs: https://mastra.ai/integrations/voice/livekit
import { fileURLToPath } from 'node:url'
import { createLiveKitWorker, runLiveKitWorker } from '@mastra/livekit/worker'
import { AL_AGENT_NAME, mastra } from './index'
import { isCurrentResource } from './accounts'
import { bufferCallMemory, markCallUpdated, settleCallMemory, summarizeCall } from './memory/call-memory'
import { alMemory } from './memory/al-memory'

export default createLiveKitWorker({
  mastra,
  agent: 'al',
  // Speech-to-text and text-to-speech run on LiveKit Inference, so the LiveKit key covers them.
  stt: 'deepgram/nova-3',
  // Saath picked Inworld over Cartesia after a listening test: half the price, similar time to first audio.
  tts: 'inworld/inworld-tts-2',
  // A small local model that reads the transcript to decide when the person has finished a sentence.
  turnDetection: 'multilingual',
  // Only account-scoped dispatches can read/write Al's persistent memory.
  memory: ({ metadata }) => metadata.threadId && metadata.resourceId
    ? { thread: metadata.threadId, resource: metadata.resourceId } : false,
  onTurnComplete: async ({ memory }) => {
    // LiveKit does not await this hook. Observe committed turns without binding
    // background memory events to a reply stream that has already closed.
    if (memory && memory.resource) await bufferCallMemory(memory.thread, memory.resource)
  },
  onCallEnd: async ({ memory }) => {
    if (!memory || !memory.resource) return
    if (!await isCurrentResource(memory.resource)) {
      // A forget operation may have deleted this thread while the final reply was saving.
      await alMemory.deleteThread(memory.thread)
      return
    }
    // Drain idle Observer extraction before the final summary/profile check.
    // This happens after hang-up, outside the spoken reply path.
    await settleCallMemory(memory.thread)
    await alMemory.settled()
    await markCallUpdated(memory.thread, memory.resource, true)
    await summarizeCall(memory.thread)
  },
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
