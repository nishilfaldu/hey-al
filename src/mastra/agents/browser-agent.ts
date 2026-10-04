import { Agent } from '@mastra/core/agent'
import { AgentBrowser } from '@mastra/agent-browser'

const browser = new AgentBrowser({
  headless: false,
})

export const browserAgent = new Agent({
  id: 'browser-agent',
  name: 'Browser Agent',
  model: 'openai/gpt-5.6-sol',
  browser,
  instructions: `You are a web automation assistant.

When interacting with pages:
1. Use browser_snapshot to get the current page state and element refs
2. Use the refs (like @e1, @e2) to target elements for clicks and typing
3. After actions, take another snapshot to verify the result`,
})