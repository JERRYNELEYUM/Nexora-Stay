export function checkSyncKey(request, env) {
  const expected = env && env.SYNC_KEY;

  if (!expected) {
    return {
      ok: false,
      status: 500,
      reason: "Server is missing the SYNC_KEY environment secret.",
    };
  }

  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const provided = match ? match[1] : "";

  if (!provided || provided !== expected) {
    return {
      ok: false,
      status: 401,
      reason: "Invalid or missing sync key.",
    };
  }

  return { ok: true };
}
