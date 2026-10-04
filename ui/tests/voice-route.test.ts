import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../app/api/voice/route";

const request = (origin = "http://localhost:3000") => new Request("http://localhost:3000/api/voice", { method: "POST", headers: { origin } });
const details = { serverUrl: "wss://voice.example.test", roomName: "test-room", participantName: "test-user", participantToken: "room-scoped-token" };

test("forwards to the configured Mastra endpoint and exposes only connection details", async (t) => {
  const previousUrl = process.env.MASTRA_URL;
  process.env.MASTRA_URL = "http://mastra.example.test:4111";
  t.after(() => { if (previousUrl === undefined) delete process.env.MASTRA_URL; else process.env.MASTRA_URL = previousUrl; });
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.toString(), "http://mastra.example.test:4111/voice/livekit/connection-details");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body as string), { agentId: "support" });
    return Response.json({ ...details, internalConfig: "must-stay-on-server" });
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), details);
});

test("rejects requests from another origin before fetching a token", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  assert.equal((await POST(request("https://another.example.test"))).status, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("reports upstream failure without forwarding the server's private error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "private upstream detail" }, { status: 500 }));
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private upstream detail/);
});

test("rejects incomplete or null connection details", async (t) => {
  for (const payload of [null, { ...details, participantToken: "" }]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    assert.equal((await POST(request())).status, 502);
    fetchMock.mock.restore();
  }
});

test("handles an unavailable Mastra server with an actionable error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connection refused"); });
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Start Mastra/);
});
