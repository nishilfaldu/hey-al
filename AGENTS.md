# AGENTS.md

## CRITICAL: Load `mastra` skill first

Load the `mastra` skill BEFORE any Mastra work. Never rely on cached knowledge — APIs change between versions.

## Rules

- Register all agents, tools, workflows, and scorers in `src/mastra/index.ts`
- Use the `dev` and `build` scripts from `package.json` instead of running `mastra dev` / `mastra build` directly

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)

## Cursor Cloud specific instructions

- Put `/usr/local/bin` first on `PATH`. Cloud Agent images also ship Node 22 earlier on `PATH`. This app expects Node 24.11+ and pnpm 11.3.0 (`ui/package.json` `packageManager`).
- Postgres 16 is local. Database `hey_al` uses peer auth as the `ubuntu` role. When `DATABASE_URL` is empty, set it to `postgresql:///hey_al?host=/var/run/postgresql`. Do not replace a non-empty `DATABASE_URL`.
- Dev servers: `pnpm run dev` (Mastra Studio, http://localhost:4111) and `pnpm run ui:dev` (voice UI, http://localhost:3000). On Cloud Agent boot these are already started, along with Postgres.
- `pnpm run voice:dev` exits until `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are set. Spoken replies also need `OPENAI_API_KEY`.
- Checks: `pnpm --filter ui test`, `pnpm --filter ui lint`, and `pnpm exec tsc --noEmit` from the repo root and from `ui`.
