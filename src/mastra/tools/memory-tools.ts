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
  description: 'Use only when the person explicitly asks to forget information. Set forgetAll true to forget everything; keepProfile is ignored in that case. For a narrow deletion, set forgetAll false and provide the complete working-memory profile with the requested facts removed. Immediately invalidates old memory and queues deletion of all earlier call history and summaries in the background. Tell the person that earlier conversations will be cleared and confirm if they only requested a narrow deletion. After success, say you have stopped using that information, explain that they should start a new call and call endCall. Do not claim background deletion has completed.',
  inputSchema: z.object({
    forgetAll: z.boolean().describe('True when the person explicitly asks to forget everything. This clears the entire profile regardless of keepProfile.'),
    keepProfile: profileSchema.optional().describe('For narrow deletion only: complete profile containing unrelated facts to retain. Ignored when forgetAll is true.'),
  }),
  execute: async ({ forgetAll, keepProfile }, { agent }) => {
    if (!agent?.resourceId) throw new Error('No user memory on this call.');
    if (!forgetAll && keepProfile === undefined) throw new Error('Provide the unrelated profile facts to retain for a narrow deletion.');
    return forgetMemories(agent.resourceId, forgetAll ? {} : keepProfile);
  },
});
