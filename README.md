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

2. Fill in `.env`:

   - `OPENAI_API_KEY`: from [OpenAI](https://platform.openai.com/api-keys)
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: from your [LiveKit Cloud project](https://cloud.livekit.io) (Settings → API keys). Speech-to-text and text-to-speech also run on this key.
   - `DATABASE_URL`: the pooled connection string from your [Neon project](https://console.neon.tech) (Connect). Mastra creates its tables on first start.

   Then download the voice models once:

   ```sh
   pnpm exec livekit-agents download-files
   ```

3. Run these in **three separate terminals** and leave them running:

   ```sh
   pnpm run dev        # Terminal 1: Mastra server and Studio (http://localhost:4111)
   pnpm run voice:dev  # Terminal 2: voice worker; LiveKit sends each call here
   pnpm run web:dev    # Terminal 3: web app (http://localhost:3000)
   ```

4. Open [http://localhost:3000](http://localhost:3000), click **Talk to Al**, and allow microphone access.

To test without the web app, open [Mastra Studio](http://localhost:4111), select **Al**, and click **Start voice call**. Restart the voice worker after changing agent or tool code. For browser automation, install Chromium with `npx playwright install chromium`.
