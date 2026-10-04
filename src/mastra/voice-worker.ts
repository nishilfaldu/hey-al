import { fileURLToPath } from 'node:url'
import { Mastra } from '@mastra/core/mastra'
import { createLiveKitWorker, createRemoteAgentReplyGenerator, runLiveKitWorker } from '@mastra/livekit/worker'

export default createLiveKitWorker({
  // The server owns agents and storage; each voice job only handles the call.
  mastra: new Mastra({}),
  generate: createRemoteAgentReplyGenerator({
    baseUrl: process.env.MASTRA_URL || 'http://localhost:4111',
    agentId: 'supportAgent',
  }),
  stt: 'deepgram/nova-3',
  tts: 'cartesia/sonic-3',
  turnDetection: 'multilingual',
  greeting: 'Hi! How can I help you today?',
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runLiveKitWorker({ entry: import.meta.url, agentName: 'mastra-voice' })
}
