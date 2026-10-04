import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';
import { liveKitConnectionRoute } from '@mastra/livekit'
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { agent } from './agents/agent';
import { al } from './agents/al';
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';

// LiveKit sends a call only to a worker registered under this name ("explicit dispatch").
// The connection route below asks for it, and voice-worker.ts registers with it.
export const AL_AGENT_NAME = 'al';

export const mastra = new Mastra({
  server: {
    // POST /voice/livekit/connection-details: gives a client a LiveKit room token and
    // sends Al's voice worker into that room. Studio's voice call uses it.
    apiRoutes: [liveKitConnectionRoute({ agentName: AL_AGENT_NAME })],
  },
  agents: { agent, al },
  tools: { startScheduleTool, stopScheduleTool },
  // Neon Postgres holds everything: threads, workflow state, and traces. Mastra creates its
  // tables on startup. The voice worker is a separate process that imports this file too, so the
  // store must accept writes from two processes; a local single-writer file (DuckDB) cannot.
  // Docs: https://mastra.ai/integrations/databases/neon
  storage: new PostgresStore({
    id: 'neon-storage',
    connectionString: process.env.DATABASE_URL!,
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
