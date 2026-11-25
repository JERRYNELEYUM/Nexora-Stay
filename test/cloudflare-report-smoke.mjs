import { mock } from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { makeFakeSupabase } = require("./fakeSupabase.js");

const fake = makeFakeSupabase({
  invoice_payments: [
    {
      id: "payment-1",
      invoice_id: "invoice-1",
      amount: 500,
      method: "cash",
      paid_at: "2026-11-25T10:00:00.000Z"
    },
    {
      id: "payment-2",
      invoice_id: "invoice-2",
      amount: 900,
      method: "card",
      paid_at: "2026-11-25T11:00:00.000Z"
    }
  ],
  invoices: [
    {
      id: "invoice-1",
      number: "INV-001",
      booking_id: "booking-1",
      voided: false
    },
    {
      id: "invoice-2",
      number: "INV-002",
      booking_id: "booking-2",
      voided: true
    }
  ],
  bookings: [
    {
      id: "booking-1",
      room_id: "room-1",
      guest_id: "guest-1",
      status: "checked-in",
      check_in: "2026-11-25T08:00:00.000Z",
      check_out: "2026-11-26T08:00:00.000Z",
      stay_type: "overnight"
    },
    {
      id: "booking-2",
      room_id: "room-2",
      guest_id: "guest-2",
      status: "checked-out",
      check_in: "2026-11-25T09:00:00.000Z",
      check_out: "2026-11-25T15:00:00.000Z",
      stay_type: "overnight"
    }
  ],
  rooms: [
    { id: "room-1", number: "101" },
    { id: "room-2", number: "102" }
  ],
  guests: [
    { id: "guest-1", name: "Test Guest One" },
    { id: "guest-2", name: "Test Guest Two" }
  ],
  expenses: [
    {
      id: "expense-1",
      date: "2026-11-25",
      description: "Cleaning supplies",
      category: "Supplies",
      amount: 100,
      voided: false,
      created_at: "2026-11-25T12:00:00.000Z"
    },
    {
      id: "expense-2",
      date: "2026-11-25",
      description: "Voided expense",
      category: "Supplies",
      amount: 50,
      voided: true,
      voided_at: "2026-11-25T13:00:00.000Z",
      voided_by: "Test Admin",
      void_reason: "Test correction"
    }
  ],
  salary_payments: [
    {
      id: "salary-1",
      employee_id: "employee-1",
      date: "2026-11-25",
      month: "November",
      amount_paid: 200,
      voided: false
    },
    {
      id: "salary-2",
      employee_id: "employee-1",
      date: "2026-11-25",
      month: "November",
      amount_paid: 40,
      voided: true
    }
  ],
  employees: [
    { id: "employee-1", name: "Test Employee" }
  ],
  deposits: [
    {
      id: "deposit-1",
      date: "2026-11-25",
      destination: "Bank",
      amount: 75,
      voided: false
    },
    {
      id: "deposit-2",
      date: "2026-11-25",
      destination: "Bank",
      amount: 25,
      voided: true
    }
  ]
});

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fake }
});

const { onRequest } = await import("../functions/report.js");

const env = {
  SYNC_KEY: "local-test-key",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "local-placeholder"
};

async function call(method, key, query = "") {
  const headers = {};
  if (key !== null) headers.Authorization = `Bearer ${key}`;

  return onRequest({
    request: new Request(
      `https://example.test/report${query}`,
      { method, headers }
    ),
    env
  });
}

const from = "2026-11-25T00:00:00.000Z";
const to = "2026-11-26T00:00:00.000Z";
const range = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

// Authentication
const missingAuth = await call("GET", null, range);
assert.equal(missingAuth.status, 401);

const wrongAuth = await call("GET", "wrong-key", range);
assert.equal(wrongAuth.status, 401);

// Method restriction
const wrongMethod = await call("POST", "local-test-key");
assert.equal(wrongMethod.status, 405);

// Invalid date range
const invalidRange = await call(
  "GET",
  "local-test-key",
  "?from=invalid&to=also-invalid"
);
assert.equal(invalidRange.status, 400);

// Valid report
const response = await call("GET", "local-test-key", range);
assert.equal(response.status, 200);

const report = await response.json();

assert.equal(report.revenue, 500);
assert.equal(report.paymentCount, 1);
assert.equal(report.expensesTotal, 100);
assert.equal(report.payrollTotal, 200);
assert.equal(report.depositedTotal, 75);
assert.equal(report.net, 125);

// Voided invoice excluded
assert.equal(report.payments.some(p => p.invoiceNumber === "INV-002"), false);

// Payment method
assert.equal(report.byMethod.cash.count, 1);
assert.equal(report.byMethod.cash.amount, 500);
assert.equal(report.byMethod.card, undefined);

// Check-ins, check-outs and occupied rooms
assert.equal(report.checkins, 2);
assert.equal(report.checkouts, 1);
assert.equal(report.occupied.length, 2);
assert.ok(report.occupied.some(
  r => r.roomNumber === "101" && r.guestName === "Test Guest One"
));

// Expense audit details remain visible
assert.equal(report.expenses.length, 2);
assert.equal(report.expensesTotal, 100);
assert.equal(report.expenses.find(e => e.description === "Voided expense").voided, true);
assert.equal(
  report.expenses.find(e => e.description === "Voided expense").voidReason,
  "Test correction"
);

// Payroll and deposits
assert.equal(report.salaryPayments.length, 2);
assert.equal(report.salaryPayments.find(p => p.voided).employeeName, "Test Employee");
assert.equal(report.deposits.length, 2);

// All database operations must be reads
assert.ok(fake._log.length > 0);
assert.ok(fake._log.every(entry => entry.mode === "select"));

console.log("Cloudflare report tests passed.");
console.log("Missing and wrong keys rejected:", true);
console.log("POST rejected:", true);
console.log("Invalid date range rejected:", true);
console.log("Revenue and voided invoice handling:", true);
console.log("Expense, payroll and deposit totals:", true);
console.log("Net balance:", report.net);
console.log("Guest and room details:", true);
console.log("Audit information preserved:", true);
console.log("Database operations were read-only:", true);
console.log("Database used: in-memory test only.");
