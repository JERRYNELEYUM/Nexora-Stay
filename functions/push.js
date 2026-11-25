import { getSupabase } from "./_lib/supabase.js";
import { checkSyncKey } from "./_lib/syncAuth.js";
import { json, preflight, error } from "./_lib/respond.js";
import {
  chunk,
  fetchAllRows,
  describeDbError,
  isMissingTable,
  upsertRows,
} from "./_lib/db.js";

/* Order matters for foreign keys. Independent tables are processed
   before bookings and invoices so they are not starved by large syncs. */
const TABLES = [
  { key: "hotel", table: "hotel_settings", single: true },
  { key: "staff", table: "staff" },
  { key: "roomTypes", table: "room_types" },
  { key: "rooms", table: "rooms" },
  { key: "guests", table: "guests" },
  { key: "employees", table: "employees" },
  { key: "salaryPayments", table: "salary_payments" },
  { key: "expenses", table: "expenses" },
  { key: "deposits", table: "deposits" },
  { key: "bookings", table: "bookings" },
  { key: "invoices", table: "invoices" },
  { key: "invoiceCharges", table: "invoice_charges" },
  { key: "invoicePayments", table: "invoice_payments" },
];

const WRITE_BATCH = 200;
const ID_CHUNK = 50;

const toMs = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

const isActive = (b) =>
  b.status === "reserved" || b.status === "checked-in";

async function fetchExisting(supabase, table, ids) {
  const existing = new Map();

  for (const group of chunk(ids, ID_CHUNK)) {
    const { data, error: err } = await supabase
      .from(table)
      .select("id, updated_at")
      .in("id", group);

    if (err) return { error: err };

    (data || []).forEach((r) => {
      existing.set(r.id, toMs(r.updated_at));
    });
  }

  return { existing };
}

/* Check overlapping active bookings using one lookup per room group.
   Preserve the original fail-open behaviour if the lookup itself fails. */
async function guardBookings(supabase, rows) {
  const conflicts = new Map();
  const byRoom = new Map();
  const active = rows.filter(isActive);

  if (active.length) {
    const roomIds = [...new Set(active.map((r) => r.room_id))];

    for (const group of chunk(roomIds, ID_CHUNK)) {
      const { data, error: err } = await fetchAllRows(
        supabase,
        "bookings",
        {
          select: "id, room_id, check_in, check_out",
          filter: (q) => q
            .in("room_id", group)
            .in("status", ["reserved", "checked-in"]),
        }
      );

      if (err) return { conflicts };

      (data || []).forEach((b) => {
        if (!byRoom.has(b.room_id)) byRoom.set(b.room_id, []);

        byRoom.get(b.room_id).push({
          id: b.id,
          a: toMs(b.check_in),
          b: toMs(b.check_out),
        });
      });
    }
  }

  for (const r of rows) {
    if (!byRoom.has(r.room_id)) byRoom.set(r.room_id, []);

    const list = byRoom.get(r.room_id);
    const i = list.findIndex((x) => x.id === r.id);

    if (!isActive(r)) {
      if (i >= 0) list.splice(i, 1);
      continue;
    }

    const a = toMs(r.check_in);
    const b = toMs(r.check_out);

    const clash = list.some(
      (x) => x.id !== r.id && a < x.b && b > x.a
    );

    if (clash) {
      conflicts.set(
        r.id,
        "Room already booked for an overlapping time by another device. Please pick a different room or time."
      );
      continue;
    }

    if (i >= 0) {
      list[i].a = a;
      list[i].b = b;
    } else {
      list.push({ id: r.id, a, b });
    }
  }

  return { conflicts };
}

async function processTable(
  supabase,
  def,
  records,
  out,
  warnings,
  overBudget
) {
  const reject = (id, reason) => {
    (out.rejected[def.key] = out.rejected[def.key] || []).push({
      id,
      reason,
    });
  };

  const markSynced = (ids, written) => {
    out.synced[def.key] = (out.synced[def.key] || []).concat(ids);

    if (written) {
      out.accepted[def.key] = (out.accepted[def.key] || []).concat(ids);
    }
  };

  const valid = [];

  for (const rec of records) {
    if (!rec || !rec.id) {
      reject(rec && rec.id, "Missing id.");
      continue;
    }

    if (toMs(rec.updated_at) === null) {
      reject(rec.id, "Missing or invalid updated_at.");
      continue;
    }

    valid.push(rec);
  }

  if (!valid.length) return;

  // Look up existing records in groups of 50.
  const ex = await fetchExisting(
    supabase,
    def.table,
    valid.map((r) => r.id)
  );

  if (ex.error) {
    const reason = describeDbError(def.table, ex.error);
    valid.forEach((r) => reject(r.id, reason));
    return;
  }

  // Only new or newer records may be written.
  const alreadyCurrent = [];
  const write = [];

  for (const rec of valid) {
    const have = ex.existing.get(rec.id);

    if (have !== undefined && !(toMs(rec.updated_at) > have)) {
      alreadyCurrent.push(rec.id);
    } else {
      write.push(rec);
    }
  }

  if (alreadyCurrent.length) {
    markSynced(alreadyCurrent, false);
  }

  if (!write.length) return;

  let toWrite = write;

  if (def.key === "bookings") {
    const g = await guardBookings(supabase, write);

    toWrite = write.filter((r) => !g.conflicts.has(r.id));

    write.forEach((r) => {
      if (g.conflicts.has(r.id)) {
        reject(r.id, g.conflicts.get(r.id));
      }
    });
  }

  for (const group of chunk(toWrite, WRITE_BATCH)) {
    if (overBudget()) {
      out.incomplete = true;
      return;
    }

    const bulk = await upsertRows(
      supabase,
      def.table,
      group,
      warnings
    );

    if (bulk.ok) {
      markSynced(group.map((r) => r.id), true);
      continue;
    }

    if (isMissingTable(bulk.error)) {
      const reason = describeDbError(def.table, bulk.error);
      group.forEach((r) => reject(r.id, reason));
      continue;
    }

    // Isolate individual failures so one bad record cannot block a batch.
    for (const rec of group) {
      if (overBudget()) {
        out.incomplete = true;
        return;
      }

      const one = await upsertRows(
        supabase,
        def.table,
        [rec],
        warnings
      );

      if (one.ok) {
        markSynced([rec.id], true);
      } else {
        reject(rec.id, describeDbError(def.table, one.error));
      }
    }
  }
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") {
    return error(405, "Method not allowed.");
  }

  const auth = checkSyncKey(request, env);
  if (!auth.ok) return error(auth.status, auth.reason);

  let body;

  try {
    body = await request.json();
  } catch {
    return error(400, "Invalid request body.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error(400, "Invalid request body.");
  }

  const tables = body.tables || {};

  if (
    typeof tables !== "object" ||
    tables === null ||
    Array.isArray(tables)
  ) {
    return error(400, "Invalid tables payload.");
  }

  try {
    const supabase = getSupabase(env);

    const started = Date.now();
    const configuredBudget = Number(env.PUSH_TIME_BUDGET_MS);
    const budget =
      Number.isFinite(configuredBudget) && configuredBudget > 0
        ? configuredBudget
        : 8000;

    const overBudget = () => Date.now() - started > budget;

    const out = {
      accepted: {},
      synced: {},
      rejected: {},
      incomplete: false,
      warnings: [],
    };

    const warnings = new Set();

    for (const def of TABLES) {
      let records = tables[def.key];

      if (!records) continue;

      if (!Array.isArray(records)) records = [records];

      if (def.single) {
        records = records.map((r) =>
          Object.assign({}, r, { id: "default" })
        );
      }

      if (!records.length) continue;

      if (overBudget()) {
        out.incomplete = true;
        break;
      }

      await processTable(
        supabase,
        def,
        records,
        out,
        warnings,
        overBudget
      );

      if (out.incomplete) break;
    }

    out.warnings = Array.from(warnings);

    return json(200, out);
  } catch (err) {
    return error(
      500,
      err && err.message ? err.message : "Push request failed."
    );
  }
}
