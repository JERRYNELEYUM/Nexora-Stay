import { getSupabase } from "./_lib/supabase.js";
import { checkSyncKey } from "./_lib/syncAuth.js";
import { json, preflight, error } from "./_lib/respond.js";
import { fetchAllRows, describeDbError } from "./_lib/db.js";

// [name the app uses, database table]
const TABLES = [
  ["staff", "staff", "id, name, role, active, updated_at"], // never includes PINs
  ["roomTypes", "room_types"],
  ["rooms", "rooms"],
  ["guests", "guests"],
  ["bookings", "bookings"],
  ["invoices", "invoices"],
  ["invoiceCharges", "invoice_charges"],
  ["invoicePayments", "invoice_payments"],
  ["employees", "employees"],
  ["salaryPayments", "salary_payments"],
  ["expenses", "expenses"],
  ["deposits", "deposits"],
];

// Additional columns checked by the connection test.
const LATE_COLUMNS = [
  ["hotel_settings", ["email", "taxpayer_number", "registration_number"]],
  ["invoices", ["discount_type", "discount_value", "discount_note", "discount_applied_by", "voided", "voided_at", "voided_by", "void_reason"]],
  ["expenses", ["recorded_by", "created_at", "voided", "voided_at", "voided_by", "void_reason"]],
  ["deposits", ["voided", "voided_at", "voided_by", "void_reason"]],
];

/* GET /sync?ping=1 — checks database connectivity and expected columns.
   This performs reads only and returns no hotel records. */
async function ping(supabase) {
  const problems = [];
  const missingTable = new Set();
  const tableNames = ["hotel_settings"].concat(TABLES.map(t => t[1]));

  await Promise.all(tableNames.map(async (table) => {
    const { error: queryError } = await supabase
      .from(table)
      .select("id")
      .limit(1);

    if (queryError) {
      missingTable.add(table);
      problems.push({
        table,
        message: describeDbError(table, queryError),
      });
    }
  }));

  await Promise.all(
    LATE_COLUMNS
      .filter(([table]) => !missingTable.has(table))
      .map(async ([table, columns]) => {
        const { error: queryError } = await supabase
          .from(table)
          .select(columns.join(","))
          .limit(1);

        if (queryError) {
          problems.push({
            table,
            message: describeDbError(table, queryError),
          });
        }
      })
  );

  return {
    ok: problems.length === 0,
    connected: true,
    problems,
  };
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET") return error(405, "Method not allowed.");

  const auth = checkSyncKey(request, env);
  if (!auth.ok) return error(auth.status, auth.reason);

  try {
    const supabase = getSupabase(env);
    const url = new URL(request.url);

    if (url.searchParams.has("ping")) {
      return json(200, await ping(supabase));
    }

    const errors = {};

    // A failing table must not prevent the remaining tables from syncing.
    const [hotelRes, ...results] = await Promise.all([
      supabase
        .from("hotel_settings")
        .select("*")
        .eq("id", "default")
        .limit(1),

      ...TABLES.map(([key, table, select]) =>
        fetchAllRows(supabase, table, { select: select || "*" })
      ),
    ]);

    const out = {
      serverTime: new Date().toISOString(),
    };

    if (hotelRes.error) {
      errors.hotel = describeDbError("hotel_settings", hotelRes.error);
    }

    out.hotel = (hotelRes.data && hotelRes.data[0]) || null;

    TABLES.forEach(([key, table], index) => {
      const result = results[index];

      if (result.error) {
        errors[key] = describeDbError(table, result.error);
      }

      out[key] = result.data || [];
    });

    if (Object.keys(errors).length) {
      out.errors = errors;
    }

    return json(200, out);
  } catch (err) {
    return error(500, err && err.message ? err.message : "Sync request failed.");
  }
}
