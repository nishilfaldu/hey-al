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

3. Run these in **three separate terminals** and leave all running:

   ```sh
   pnpm run dev        # Terminal 1: Mastra server and Studio (http://localhost:4111)
   pnpm run voice:dev  # Terminal 2: voice worker; LiveKit sends each call here
   pnpm run ui:dev     # Terminal 3: voice UI (http://localhost:3000)
   ```

4. Open [the voice UI](http://localhost:3000), enter an email and password (at least eight characters), then click **Continue**. A new email creates an account; an existing email signs in with its password. Click **Start talking** and allow microphone access. Use the chat icon to see the conversation.

You can also test Al and inspect traces in [Mastra Studio](http://localhost:4111).

Voice calls with persistent account memory start through the signed-in UI. Studio's text chats remain useful for agent experiments; its voice button and the LiveKit Launch Console do not supply the app's account session.

Restart the voice worker after changing agent or tool code. For browser automation, install Chromium with `npx playwright install chromium`.

## Accounts and memory

The UI remembers a sign-in for 90 days with an HttpOnly, SameSite cookie. Passwords are salted and hashed with scrypt; only hashes of session tokens are stored in Neon. Sign-out revokes the session. There is no verification email, password recovery, profile picker, or shared-device flow.

The Mastra backend validates the session and generates the voice call's identifiers. Each account has a separate resource-scoped structured profile; every call gets a fresh thread. Al reads memory; Mastra's background Observer adds and corrects profile facts using `observation.manageWorkingMemory`, with primary-agent profile tools disabled (`workingMemory.agentManaged: false`). LiveKit's non-awaited `onTurnComplete` calls Mastra's `buffer()` without a reply writer, allowing short turns to be observed while Al stays free. Quick turns are coalesced, with another pass when a turn arrives during extraction. Native `bufferOnIdle` is disabled because its attached event writer can stall after the spoken stream closes in the installed framework versions. Normal async buffering still compresses long calls using `openai/gpt-5-mini`. Al follows corrections from the current conversation immediately, before the profile catches up. Recent summaries are supplied to Al; `recall_calls` can search older dated summaries without a vector database.

Observation/reflection model failures use two retries and then allow the voice turn to continue, keeping pending input for a later attempt. Mastra can still perform a blocking observation/reflection if background buffering falls behind its thresholds; this setup minimizes memory-related pauses rather than guaranteeing zero delay. Memory reads and explicit recall tools also take database time.

The Observer uses Mastra's inline JSON extractor lane, with Zod validation before any profile write. This avoids the installed framework's generic OpenAI schema and secondary structured-stream compatibility issues. It reads recent original user statements to keep observation commentary out of literal profile values. Both the Observer and call-end extractor declare which fields changed, so default empty arrays cannot wipe unrelated preferences. Only those validated changes merge into the latest profile, with a current-resource check before writing. The background runtime shares Neon data with Al but has its own execution state. Extraction stays on Mastra's background Observer.

At hang-up, the worker drains its pending background memory work, then Mastra's `summarizeThread()` saves a compact dated summary even for short calls. A validated extractor provides a final check of the lasting profile. The post-turn hook marks durable retry work before buffering; neither extraction nor call-end finalization is part of Al's spoken response. A server maintenance loop runs every minute and retries unfinished summaries/extractions, including calls abandoned by a worker crash. Seven days after a call starts, it deletes the thread's messages and observational memory while retaining the profile and derived summary. The server must be running for cleanup; after downtime it catches up on the next maintenance pass. If summarization remains unavailable at the retention deadline, the transcript is still deleted and a warning is logged. Summaries are lossy and are not a guarantee that every detail is retained.

Ask Al what it remembers, correct a preference, or ask it to forget. For a narrow forget request, Al explains that earlier conversation history will also be cleared and asks for confirmation; unrelated profile fields can remain. The forget tool prepares the retained profile, immediately rotates the account's memory resource, and commits a deletion job to `al_memory_cleanup` in Neon. Bulk deletion runs in the background and retries on the maintenance loop if interrupted or failed. Al acknowledges that it has stopped using the information and ends the call so its old context cannot be reused; it does not claim deletion is finished. Start a new call to continue. Al can also forget everything without a second confirmation when explicitly asked. Late writes from an old Observer remain under the invalidated resource and are swept by maintenance.

Trace exports retain timings and numeric usage but omit conversation payloads; local trace spans expire after seven days. Keep the Mastra backend/Studio private and expose only the Next.js UI when hosting this demo: Studio and Mastra's built-in APIs are developer interfaces, not the account-facing app. No audio recordings are stored by this application.

Run `pnpm test` for Postgres-backed account/memory integration checks (uses isolated test accounts in the configured database), `pnpm --filter ui test` for the browser-facing routes, and `pnpm --filter ui lint` for UI lint. To opt into a real-model recall check, run `AL_LLM_SMOKE=1 pnpm test`; it calls OpenAI using fictional test data. Stop the Mastra dev server before `pnpm run build`; `pnpm run ui:build` builds the UI.
