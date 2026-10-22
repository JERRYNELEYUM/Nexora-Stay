const { getSupabase } = require('./_lib/supabase');
const { checkSyncKey } = require('./_lib/syncAuth');
const { json, preflight, error } = require('./_lib/respond');
const { fetchAllRows, chunk, describeDbError, isMissingTable, upsertRows } = require('./_lib/db');

/* Order matters for foreign keys (a booking needs its room and guest first;
   an invoice needs its booking; a payment needs its invoice). Tables that
   don't depend on bookings — expenses, payroll, deposits — go BEFORE the big
   booking/invoice tables, so a long first sync can never starve them. */
const TABLES = [
  { key: 'hotel', table: 'hotel_settings', single: true },
  { key: 'staff', table: 'staff' },
  { key: 'roomTypes', table: 'room_types' },
  { key: 'rooms', table: 'rooms' },
  { key: 'guests', table: 'guests' },
  { key: 'employees', table: 'employees' },
  { key: 'salaryPayments', table: 'salary_payments' },
  { key: 'expenses', table: 'expenses' },
  { key: 'deposits', table: 'deposits' },
  { key: 'bookings', table: 'bookings' },
  { key: 'invoices', table: 'invoices' },
  { key: 'invoiceCharges', table: 'invoice_charges' },
  { key: 'invoicePayments', table: 'invoice_payments' },
];

const WRITE_BATCH = 200; // rows per database write
const ID_CHUNK = 50;     // ids per lookup (keeps the request URL short)

const toMs = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const isActive = (b) => b.status === 'reserved' || b.status === 'checked-in';

async function fetchExisting(supabase, table, ids) {
  const existing = new Map();
  for (const group of chunk(ids, ID_CHUNK)) {
    const { data, error: err } = await supabase.from(table).select('id, updated_at').in('id', group);
    if (err) return { error: err };
    (data || []).forEach(r => existing.set(r.id, toMs(r.updated_at)));
  }
  return { existing };
}

/* Double-booking guard, done in memory against ONE lookup of the relevant
   rooms' active bookings (instead of one database query per booking). */
async function guardBookings(supabase, rows) {
  const conflicts = new Map();
  const byRoom = new Map();
  const active = rows.filter(isActive);
  if (active.length) {
    const roomIds = [...new Set(active.map(r => r.room_id))];
    for (const group of chunk(roomIds, ID_CHUNK)) {
      const { data, error: err } = await fetchAllRows(supabase, 'bookings', {
        select: 'id, room_id, check_in, check_out',
        filter: q => q.in('room_id', group).in('status', ['reserved', 'checked-in']),
      });
      if (err) return { conflicts }; // can't check — fail open; the write itself will surface real problems
      data.forEach(b => {
        if (!byRoom.has(b.room_id)) byRoom.set(b.room_id, []);
        byRoom.get(b.room_id).push({ id: b.id, a: toMs(b.check_in), b: toMs(b.check_out) });
      });
    }
  }
  for (const r of rows) {
    if (!byRoom.has(r.room_id)) byRoom.set(r.room_id, []);
    const list = byRoom.get(r.room_id);
    const i = list.findIndex(x => x.id === r.id);
    if (!isActive(r)) { if (i >= 0) list.splice(i, 1); continue; } // cancelling / checking out frees the room
    const a = toMs(r.check_in), b = toMs(r.check_out);
    const clash = list.some(x => x.id !== r.id && a < x.b && b > x.a);
    if (clash) {
      conflicts.set(r.id, 'Room already booked for an overlapping time by another device. Please pick a different room or time.');
      continue;
    }
    if (i >= 0) { list[i].a = a; list[i].b = b; } else list.push({ id: r.id, a: a, b: b });
  }
  return { conflicts };
}

async function processTable(supabase, def, records, out, warnings, overBudget) {
  const reject = (id, reason) => { (out.rejected[def.key] = out.rejected[def.key] || []).push({ id: id, reason: reason }); };
  const markSynced = (ids, written) => {
    out.synced[def.key] = (out.synced[def.key] || []).concat(ids);
    if (written) out.accepted[def.key] = (out.accepted[def.key] || []).concat(ids);
  };

  const valid = [];
  for (const rec of records) {
    if (!rec || !rec.id) { reject(rec && rec.id, 'Missing id.'); continue; }
    if (toMs(rec.updated_at) === null) { reject(rec.id, 'Missing or invalid updated_at.'); continue; }
    valid.push(rec);
  }
  if (!valid.length) return;

  // What does the backend already have? One lookup per 50 ids, not one per record.
  const ex = await fetchExisting(supabase, def.table, valid.map(r => r.id));
  if (ex.error) {
    const reason = describeDbError(def.table, ex.error);
    valid.forEach(r => reject(r.id, reason));
    return;
  }

  // Last-write-wins: only write records that are new or newer than the backend's copy.
  const alreadyCurrent = [], write = [];
  for (const rec of valid) {
    const have = ex.existing.get(rec.id);
    if (have !== undefined && !(toMs(rec.updated_at) > have)) alreadyCurrent.push(rec.id); else write.push(rec);
  }
  if (alreadyCurrent.length) markSynced(alreadyCurrent, false);
  if (!write.length) return;

  let toWrite = write;
  if (def.key === 'bookings') {
    const g = await guardBookings(supabase, write);
    toWrite = write.filter(r => !g.conflicts.has(r.id));
    write.forEach(r => { if (g.conflicts.has(r.id)) reject(r.id, g.conflicts.get(r.id)); });
  }

  for (const group of chunk(toWrite, WRITE_BATCH)) {
    if (overBudget()) { out.incomplete = true; return; }
    const bulk = await upsertRows(supabase, def.table, group, warnings);
    if (bulk.ok) { markSynced(group.map(r => r.id), true); continue; }
    if (isMissingTable(bulk.error)) {
      const reason = describeDbError(def.table, bulk.error);
      group.forEach(r => reject(r.id, reason));
      continue;
    }
    // Something specific to one row (duplicate, foreign key…). Find which one,
    // so a single bad record can never block the rest of the batch.
    for (const rec of group) {
      if (overBudget()) { out.incomplete = true; return; }
      const one = await upsertRows(supabase, def.table, [rec], warnings);
      if (one.ok) markSynced([rec.id], true); else reject(rec.id, describeDbError(def.table, one.error));
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return error(405, 'Method not allowed.');

  const auth = checkSyncKey(event);
  if (!auth.ok) return error(401, auth.reason);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return error(400, 'Invalid request body.');
  }
  const tables = body.tables || {};
  const supabase = getSupabase();

  // Netlify functions stop at ~10 s. Stop politely before that and tell the app
  // what is left, so it simply continues on the next request.
  const started = Date.now();
  const budget = Number(process.env.PUSH_TIME_BUDGET_MS) || 8000;
  const overBudget = () => Date.now() - started > budget;

  const out = { accepted: {}, synced: {}, rejected: {}, incomplete: false, warnings: [] };
  const warnings = new Set();

  for (const def of TABLES) {
    let records = tables[def.key];
    if (!records) continue;
    if (!Array.isArray(records)) records = [records];
    if (def.single) records = records.map(r => Object.assign({}, r, { id: 'default' }));
    if (!records.length) continue;
    if (overBudget()) { out.incomplete = true; break; }
    await processTable(supabase, def, records, out, warnings, overBudget);
    if (out.incomplete) break;
  }

  out.warnings = Array.from(warnings);
  return json(200, out);
};
