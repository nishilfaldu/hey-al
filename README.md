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

3. Run these in **two separate terminals** and leave both running:

   Terminal 1:

   ```sh
   pnpm run dev
   ```

   Terminal 2:

   ```sh
   pnpm run voice:dev
   ```

4. Open [Mastra Studio](http://localhost:4111), select **Support**, click **Start voice call**, and allow microphone access.

Optional: use your LiveKit project's **Agents → Launch Console** to test with agent name `mastra-voice`.

Restart the voice worker after changing agent or tool code. For browser automation, install Chromium with `npx playwright install chromium`.
