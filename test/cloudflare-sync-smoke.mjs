import { mock } from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { makeFakeSupabase } = require("./fakeSupabase.js");

const fake = makeFakeSupabase({
  hotel_settings: [{ id: "default", name: "Test Hotel" }],
  staff: [{
    id: "staff-1",
    name: "Test Staff",
    role: "admin",
    active: true,
    updated_at: "2026-11-25T10:00:00.000Z",
    pin: "1234"
  }]
});

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fake }
});

const { onRequest } = await import("../functions/sync.js");

function request(url, key) {
  const headers = {};
  if (key !== undefined) headers.Authorization = `Bearer ${key}`;

  return onRequest({
    request: new Request(url, { method: "GET", headers }),
    env: {
      SYNC_KEY: "local-test-key",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "local-placeholder"
    }
  });
}

// 1. Missing authentication
const missingAuth = await request("https://example.test/sync");
assert.equal(missingAuth.status, 401);

// 2. Incorrect authentication
const wrongAuth = await request("https://example.test/sync", "wrong-key");
assert.equal(wrongAuth.status, 401);

// 3. Authenticated read-only ping
fake._log.length = 0;
const pingResponse = await request(
  "https://example.test/sync?ping=1",
  "local-test-key"
);

assert.equal(pingResponse.status, 200);
const ping = await pingResponse.json();

assert.equal(ping.ok, true);
assert.equal(ping.connected, true);
assert.deepEqual(ping.problems, []);
assert.equal(Object.hasOwn(ping, "hotel"), false);
assert.equal(Object.hasOwn(ping, "staff"), false);
assert.ok(fake._log.length > 0);
assert.ok(fake._log.every(entry => entry.mode === "select"));

// 4. Normal sync and staff PIN protection
const syncResponse = await request(
  "https://example.test/sync",
  "local-test-key"
);

assert.equal(syncResponse.status, 200);
const result = await syncResponse.json();

assert.equal(result.hotel.name, "Test Hotel");
assert.equal(result.staff.length, 1);
assert.equal(result.staff[0].name, "Test Staff");
assert.equal(Object.hasOwn(result.staff[0], "pin"), false);

console.log("Cloudflare sync security tests passed.");
console.log("Missing key rejected:", missingAuth.status === 401);
console.log("Wrong key rejected:", wrongAuth.status === 401);
console.log("Ping connectivity:", ping.connected);
console.log("Ping returned no hotel or staff records.");
console.log("Ping database operations were read-only.");
console.log("Staff PIN excluded:", !Object.hasOwn(result.staff[0], "pin"));
console.log("Database used: in-memory test only.");
