const { getSupabase } = require('./_lib/supabase');
const { checkSyncKey } = require('./_lib/syncAuth');
const { json, preflight, error } = require('./_lib/respond');
const { fetchAllRows, describeDbError } = require('./_lib/db');

// [name the app uses, database table]
const TABLES = [
  ['staff', 'staff', 'id, name, role, active, updated_at'], // never includes PINs
  ['roomTypes', 'room_types'],
  ['rooms', 'rooms'],
  ['guests', 'guests'],
  ['bookings', 'bookings'],
  ['invoices', 'invoices'],
  ['invoiceCharges', 'invoice_charges'],
  ['invoicePayments', 'invoice_payments'],
  ['employees', 'employees'],
  ['salaryPayments', 'salary_payments'],
  ['expenses', 'expenses'],
  ['deposits', 'deposits'],
];

// Columns added after the first release. The connection check uses these to tell
// the owner when supabase/schema.sql needs re-running on an older database.
const LATE_COLUMNS = [
  ['hotel_settings', ['email', 'taxpayer_number', 'registration_number']],
  ['invoices', ['discount_type', 'discount_value', 'discount_note', 'discount_applied_by', 'voided', 'voided_at', 'voided_by', 'void_reason']],
  ['expenses', ['recorded_by']],
];

/* GET /sync?ping=1 — quick "is the backend set up correctly?" check. Cheap:
   one tiny query per table, no data returned. */
async function ping(supabase) {
  const problems = [];
  const missingTable = new Set();
  const tableNames = ['hotel_settings'].concat(TABLES.map(t => t[1]));
  await Promise.all(tableNames.map(async (t) => {
    const { error: e } = await supabase.from(t).select('id').limit(1);
    if (e) { missingTable.add(t); problems.push({ table: t, message: describeDbError(t, e) }); }
  }));
  await Promise.all(LATE_COLUMNS.filter(([t]) => !missingTable.has(t)).map(async ([t, cols]) => {
    const { error: e } = await supabase.from(t).select(cols.join(',')).limit(1);
    if (e) problems.push({ table: t, message: describeDbError(t, e) });
  }));
  return { ok: problems.length === 0, connected: true, problems: problems };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return error(405, 'Method not allowed.');

  const auth = checkSyncKey(event);
  if (!auth.ok) return error(401, auth.reason);

  const supabase = getSupabase();
  const qs = event.queryStringParameters || {};
  if (qs.ping) return json(200, await ping(supabase));

  const errors = {};

  // One table failing (e.g. an older database missing a newer table) must not
  // stop everything else from syncing — report it and carry on.
  const [hotelRes, ...results] = await Promise.all([
    supabase.from('hotel_settings').select('*').eq('id', 'default').limit(1),
    ...TABLES.map(([key, table, select]) => fetchAllRows(supabase, table, { select: select || '*' })),
  ]);

  const out = { serverTime: new Date().toISOString() };
  if (hotelRes.error) errors.hotel = describeDbError('hotel_settings', hotelRes.error);
  out.hotel = (hotelRes.data && hotelRes.data[0]) || null;
  TABLES.forEach(([key, table], i) => {
    const r = results[i];
    if (r.error) errors[key] = describeDbError(table, r.error);
    out[key] = r.data || [];
  });
  if (Object.keys(errors).length) out.errors = errors;

  return json(200, out);
};
