import { fileURLToPath } from 'node:url'
import { createLiveKitWorker, runLiveKitWorker } from '@mastra/livekit/worker'
import { mastra } from './index'

export default createLiveKitWorker({
  mastra,
  agent: 'support',
  stt: 'deepgram/nova-3',
  tts: 'cartesia/sonic-3',
  turnDetection: 'multilingual',
  greeting: 'Hi! How can I help you today?',
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runLiveKitWorker({ entry: import.meta.url, agentName: 'mastra-voice' })
}