import { Memory } from '@mastra/memory';
import { z } from 'zod';
import { storage } from '../storage';

export const profileSchema = z.object({
  preferredName: z.string().max(100).nullable().optional(),
  formOfAddress: z.string().max(100).nullable().optional(),
  language: z.string().max(100).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  communicationPreferences: z.array(z.string().max(300)).max(10).optional(),
  interests: z.array(z.string().max(200)).max(15).optional(),
  routines: z.array(z.string().max(300)).max(15).optional(),
  importantPeople: z.array(z.object({ name: z.string().max(100), relationship: z.string().max(100) })).max(15).optional(),
  goals: z.array(z.string().max(300)).max(10).optional(),
});

export const alMemory = new Memory({
  storage,
  options: {
    generateTitle: false,
    semanticRecall: false,
    workingMemory: { enabled: true, scope: 'resource', schema: profileSchema },
    observationalMemory: {
      model: 'openai/gpt-5-mini',
      retrieval: true,
      observation: { messageTokens: 30_000 },
      reflection: { observationTokens: 40_000 },
    },
  },
});
