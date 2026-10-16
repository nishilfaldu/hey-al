import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { queueDueReminders } from '../reminders/store';

const inputSchema = z.object({});
const outputSchema = z.object({ queuedCount: z.number() });
const queueStep = createStep({
  id: 'queue-due-reminders', inputSchema, outputSchema,
  execute: async () => {
    let queuedCount = 0;
    // Bounded work per run; any remaining overdue rows stay eligible for the next tick.
    for (let batch = 0; batch < 5; batch++) {
      const count = await queueDueReminders();
      queuedCount += count;
      if (count < 100) break;
    }
    return { queuedCount };
  },
});

export const dispatchReminders = createWorkflow({
  id: 'dispatch-reminders', inputSchema, outputSchema,
  schedule: { cron: '* * * * *', timezone: 'UTC', inputData: {} },
}).then(queueStep).commit();
