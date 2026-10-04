import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { forgetMemories, readCallSummaries } from '../memory/call-memory';
import { profileSchema } from '../memory/al-memory';

export const recallCallsTool = createTool({
  id: 'recall_calls',
  description: 'Look up dated summaries of the current person\'s earlier calls, including calls whose seven-day transcripts were deleted. Use when they refer to previous conversations. An empty query returns recent calls.',
  inputSchema: z.object({ query: z.string().max(200).optional() }),
  execute: async ({ query }, { agent }) => {
    if (!agent?.resourceId) throw new Error('No user memory on this call.');
    return { calls: await readCallSummaries(agent.resourceId, query) };
  },
});

export const forgetMemoryTool = createTool({
  id: 'forget_memory',
  description: 'Use only when the person explicitly asks to forget information. Provide the complete working-memory profile with the requested facts removed; use {} to forget everything. To prevent resurfacing, also clears all earlier call history and summaries. Tell the person that earlier conversations will be cleared and confirm if they only requested a narrow deletion. After success, explain that they should start a new call and call endCall.',
  inputSchema: z.object({ keepProfile: profileSchema.describe('Complete profile containing only unrelated facts to retain. Never include the fact requested for deletion.') }),
  execute: async ({ keepProfile }, { agent }) => {
    if (!agent?.resourceId) throw new Error('No user memory on this call.');
    return forgetMemories(agent.resourceId, keepProfile);
  },
});
