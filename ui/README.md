# hey-al UI

A simple voice interface for the Mastra + LiveKit agent.

From the repository root, run `pnpm install`, then start `pnpm run dev`, `pnpm run voice:dev`, and `pnpm run ui:dev` in separate terminals. Open http://localhost:3000 and click **Start talking**.

The UI uses the Mastra server at `http://localhost:4111`. To change this, set `MASTRA_URL` in `ui/.env.local`. LiveKit and model credentials belong in the root `.env` or `.env.local`.

Run `pnpm run ui:build` for a production build or `pnpm --filter ui lint` to lint the UI.
