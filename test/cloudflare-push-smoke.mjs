import { mock } from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { makeFakeSupabase } = require("./fakeSupabase.js");

const fake = makeFakeSupabase({
  expenses: [{
    id: "expense-existing",
    description: "Original expense",
    amount: 100,
    updated_at: "2026-11-25T12:00:00.000Z"
  }]
});

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fake }
});

const { onRequest } = await import("../functions/push.js");

const env = {
  SYNC_KEY: "local-test-key",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "local-placeholder"
};

async function call(method, body, key) {
  if (arguments.length < 3) key = "local-test-key";
  const headers = {};
  if (key !== undefined) headers.Authorization = `Bearer ${key}`;

  if (body !== undefined) headers["Content-Type"] = "application/json";

  return onRequest({
    request: new Request("https://example.test/push", {
      method,
      headers,
      body: body === undefined
        ? undefined
        : typeof body === "string" ? body : JSON.stringify(body)
    }),
    env
  });
}

// 1. Authentication
const missingAuth = await call("POST", { tables: {} }, undefined);
assert.equal(missingAuth.status, 401);

const wrongAuth = await call("POST", { tables: {} }, "wrong-key");
assert.equal(wrongAuth.status, 401);

// 2. Method restriction
const wrongMethod = await call("GET");
assert.equal(wrongMethod.status, 405);

// 3. Invalid JSON
const invalidJson = await call("POST", "{invalid-json");
assert.equal(invalidJson.status, 400);

// 4. Invalid tables payload
const invalidTables = await call("POST", { tables: [] });
assert.equal(invalidTables.status, 400);

// 5. Valid new expense
const newExpense = {
  id: "expense-new",
  description: "Local test expense",
  amount: 250,
  updated_at: "2026-11-25T13:00:00.000Z"
};

const validResponse = await call("POST", {
  tables: { expenses: [newExpense] }
});

assert.equal(validResponse.status, 200);
const validResult = await validResponse.json();

assert.ok(validResult.accepted.expenses.includes("expense-new"));
assert.ok(validResult.synced.expenses.includes("expense-new"));
assert.equal(
  fake._db.expenses.find(r => r.id === "expense-new").amount,
  250
);

// 6. Older update must not overwrite newer data
const staleResponse = await call("POST", {
  tables: {
    expenses: [{
      id: "expense-existing",
      description: "Stale replacement",
      amount: 1,
      updated_at: "2026-11-25T11:00:00.000Z"
    }]
  }
});

assert.equal(staleResponse.status, 200);
const staleResult = await staleResponse.json();

assert.ok(staleResult.synced.expenses.includes("expense-existing"));
assert.equal(
  fake._db.expenses.find(r => r.id === "expense-existing").amount,
  100
);
assert.equal(
  fake._db.expenses.find(r => r.id === "expense-existing").description,
  "Original expense"
);

console.log("Cloudflare push tests passed.");
console.log("Missing key rejected:", missingAuth.status === 401);
console.log("Wrong key rejected:", wrongAuth.status === 401);
console.log("GET rejected:", wrongMethod.status === 405);
console.log("Invalid JSON rejected:", invalidJson.status === 400);
console.log("Invalid tables rejected:", invalidTables.status === 400);
console.log("New expense accepted:", validResult.accepted.expenses.includes("expense-new"));
console.log("Older update prevented:", fake._db.expenses.find(r => r.id === "expense-existing").amount === 100);
console.log("Database used: in-memory test only.");
