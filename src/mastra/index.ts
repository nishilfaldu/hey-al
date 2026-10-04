import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { liveKitConnectionRoute } from '@mastra/livekit'
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { agent } from './agents/agent';
import { Agent } from '@mastra/core/agent'
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';

const supportAgent = new Agent({
  id: 'support',
  name: 'Support',
  instructions: 'You are a friendly phone support agent. Keep replies short and conversational.',
  model: 'openai/gpt-5-mini',
})

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: {
    apiRoutes: [liveKitConnectionRoute({ agentName: 'mastra-voice' })],
  },
  agents: { agent, supportAgent },
  tools: { startScheduleTool, stopScheduleTool },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
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
