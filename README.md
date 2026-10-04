# hey-al

A personal voice agent built with Mastra and LiveKit.

Requires Node.js 24.11+ and pnpm 11+.

1. Clone and install:

   ```sh
   git clone https://github.com/nishilfaldu/hey-al.git
   cd hey-al
   pnpm install
   cp .env.example .env
   ```

2. Fill in `.env` with your OpenAI API key and credentials from your [LiveKit Cloud project](https://cloud.livekit.io), then download the voice models:

   ```sh
   pnpm exec livekit-agents download-files
   ```

3. Run these in **three separate terminals** and leave all running:

   Terminal 1:

   ```sh
   pnpm run dev
   ```

   Terminal 2:

   ```sh
   pnpm run voice:dev
   ```

   Terminal 3:

   ```sh
   pnpm run ui:dev
   ```

4. Open [the voice UI](http://localhost:3000), click **Start talking**, and allow microphone access. Use the chat icon to see the conversation.

Open [Mastra Studio](http://localhost:4111) to inspect agents, tools, and traces.

Optional: use your LiveKit project's **Agents → Launch Console** to test with agent name `mastra-voice`.

Restart the voice worker after changing its voice settings. Mastra reloads agent and tool changes automatically. For browser automation, install Chromium with `npx playwright install chromium`.
