// The browser receives a room-scoped participant token; LiveKit credentials stay in Mastra.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "This call must start from this app." }, { status: 403 });
  }

  try {
    const endpoint = new URL("/voice/livekit/connection-details", process.env.MASTRA_URL || "http://localhost:4111");
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "support" }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) {
      return Response.json({ error: "Couldn't start the call. Check the voice credentials on the Mastra server, then try again." }, { status: 502 });
    }
    const details = await upstream.json();
    const fields = ["serverUrl", "participantToken", "roomName", "participantName"] as const;
    if (!details || !fields.every((field) => typeof details[field] === "string" && details[field].length > 0)) {
      return Response.json({ error: "The voice server returned incomplete connection details. Try again." }, { status: 502 });
    }
    return Response.json(Object.fromEntries(fields.map((field) => [field, details[field]])), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Can't reach the voice server. Start Mastra and try again." }, { status: 503 });
  }
}
