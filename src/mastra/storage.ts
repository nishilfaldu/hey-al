import { PostgresStore } from '@mastra/pg';

// One pool per process; both the server and voice worker use the same Neon database.
export const storage = new PostgresStore({
  id: 'neon-storage',
  connectionString: process.env.DATABASE_URL!,
  retention: { observability: { spans: { maxAge: '7d' } } },
});
