process.env.SYNC_KEY = 'k'; process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
const { makeFakeSupabase } = require('./fakeSupabase');
const libPath = require.resolve('../netlify/functions/_lib/supabase');
let current = null;
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { getSupabase: () => current } };
const push = require('../netlify/functions/push');
const sync = require('../netlify/functions/sync');

let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log('  PASS -', label); } else { failed++; console.log('  FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const H = { authorization: 'Bearer k' };
const doPush = async (tables) => JSON.parse((await push.handler({ httpMethod: 'POST', headers: H, body: JSON.stringify({ tables }) })).body);
const doPull = async (qs) => { const r = await sync.handler({ httpMethod: 'GET', headers: H, queryStringParameters: qs || {} }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const T = '2026-10-01T10:00:00.000Z';
const exp = (n, extra) => Object.assign({ id: 'e0000000-0000-0000-0000-' + String(n).padStart(12, '0'), date: '2026-10-01', category: 'Other', description: 'x' + n, amount: 100, method: 'Cash', vendor: '', recorded_by: 'Admin', updated_at: T }, extra);

(async () => {
  console.log('\n== expenses are NOT starved by a big first sync (order + batching) ==');
  current = makeFakeSupabase({});
  const rooms = [{ id: 'r0000000-0000-0000-0000-000000000001', number: '1', type_id: null, status: 'available', updated_at: T }];
  const bookings = Array.from({ length: 600 }, (_, i) => ({ id: 'b0000000-0000-0000-0000-' + String(i).padStart(12, '0'), guest_id: null, room_id: rooms[0].id, stay_type: 'nightly',
    check_in: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), check_out: new Date(Date.UTC(2026, 0, 1 + i, 12)).toISOString(), guests: 1, notes: '', status: 'checked-out', updated_at: T }));
  const r1 = await doPush({ rooms, bookings: bookings.slice(0, 150), expenses: [exp(1), exp(2)] });
  check('a push with expenses + bookings reaches the expenses', (r1.accepted.expenses || []).length === 2, r1);
  check('150 bookings + rooms + expenses cost only a handful of round trips', current._log.length <= 12, current._log.length);

  console.log('\n== re-sending already-synced records is cheap and reported as synced ==');
  const before = current._log.length;
  const r2 = await doPush({ expenses: [exp(1), exp(2)] });
  check('nothing re-written', !(r2.accepted.expenses || []).length, r2);
  check('but reported as synced so the app can stop re-sending', (r2.synced.expenses || []).length === 2, r2);
  check('one round trip', current._log.length - before === 1, current._log.length - before);

  console.log('\n== backend database is OLDER than the app (missing recorded_by column) ==');
  current = makeFakeSupabase({}, { columns: { expenses: ['id', 'date', 'category', 'description', 'amount', 'method', 'vendor', 'updated_at'] } });
  const r3 = await doPush({ expenses: [exp(1), exp(2), exp(3)] });
  check('expenses still sync (saved without the new column)', (r3.accepted.expenses || []).length === 3 && !(r3.rejected.expenses || []).length, r3);
  check('stored rows really lack recorded_by', current._db.expenses.every(e => !('recorded_by' in e)));
  check('a plain-English warning tells the owner to re-run schema.sql', r3.warnings.some(w => /recorded_by/.test(w) && /schema\.sql/.test(w)), r3.warnings);

  console.log('\n== a whole table is missing on the backend ==');
  current = makeFakeSupabase({}, { missingTables: ['deposits'] });
  const r4 = await doPush({ expenses: [exp(1)], deposits: [{ id: 'd0000000-0000-0000-0000-000000000001', date: '2026-10-01', amount: 5, method: 'Cash', destination: '', note: '', updated_at: T }] });
  check('other tables are unaffected', (r4.accepted.expenses || []).length === 1, r4);
  check('deposit rejected with an actionable message', (r4.rejected.deposits || []).length === 1 && /deposits/.test(r4.rejected.deposits[0].reason) && /schema\.sql/.test(r4.rejected.deposits[0].reason), r4.rejected);

  console.log('\n== one bad row cannot block the rest of its batch ==');
  current = makeFakeSupabase({}, { unique: { rooms: 'number' } });
  const mk = (n, number) => ({ id: 'r0000000-0000-0000-0000-' + String(n).padStart(12, '0'), number, type_id: null, status: 'available', updated_at: T });
  const r5 = await doPush({ rooms: [mk(1, '101'), mk(2, '102'), mk(3, '101'), mk(4, '104')] });
  check('3 good rooms accepted', (r5.accepted.rooms || []).length === 3, r5);
  check('the duplicate is rejected in plain English', (r5.rejected.rooms || []).length === 1 && /already exists/.test(r5.rejected.rooms[0].reason), r5.rejected);

  console.log('\n== the 10-second function limit: stops politely and says what is left ==');
  process.env.PUSH_TIME_BUDGET_MS = '1';
  current = makeFakeSupabase({}, { delayMs: 8 });
  const r6 = await doPush({ roomTypes: [{ id: 't0000000-0000-0000-0000-000000000001', name: 'S', rate: 1, rate_1h: 0, rate_3h: 0, rate_night: 0, capacity: 2, updated_at: T }], rooms: [mk(1, '1')], expenses: [exp(1)] });
  check('response is flagged incomplete', r6.incomplete === true, r6);
  check('unprocessed expense is in NEITHER synced nor rejected (so the app keeps it pending)', !(r6.synced.expenses || []).length && !(r6.rejected.expenses || []).length, r6);
  delete process.env.PUSH_TIME_BUDGET_MS;

  console.log('\n== pull is not silently truncated at 1,000 rows ==');
  current = makeFakeSupabase({ bookings: Array.from({ length: 2350 }, (_, i) => ({ id: 'b' + String(i).padStart(6, '0'), room_id: 'r', status: 'checked-out', check_in: T, check_out: T, updated_at: T })), hotel_settings: [{ id: 'default', name: 'H', updated_at: T }] });
  const p1 = await doPull();
  check('all 2,350 bookings returned', p1.body.bookings.length === 2350, p1.body.bookings.length);

  console.log('\n== pull survives one missing table and says so ==');
  current = makeFakeSupabase({ expenses: [{ id: 'e1', date: '2026-10-01', updated_at: T }], rooms: [{ id: 'r1', number: '1', updated_at: T }], hotel_settings: [{ id: 'default', name: 'H', updated_at: T }] }, { missingTables: ['deposits'] });
  const p2 = await doPull();
  check('still 200, with the other data', p2.status === 200 && p2.body.expenses.length === 1 && p2.body.rooms.length === 1, p2.status);
  check('error names the broken table', p2.body.errors && /deposits/.test(p2.body.errors.deposits), p2.body.errors);

  console.log('\n== connection check (?ping=1) tells the owner what to fix ==');
  current = makeFakeSupabase({}, { missingTables: ['expenses'], columns: { invoices: ['id', 'booking_id', 'number', 'tax_rate', 'updated_at'] } });
  const g1 = await doPull({ ping: '1' });
  check('connected but not ok', g1.body.connected === true && g1.body.ok === false, g1.body);
  check('lists the missing table', g1.body.problems.some(p => p.table === 'expenses'), g1.body.problems);
  check('lists the missing invoice columns', g1.body.problems.some(p => p.table === 'invoices'), g1.body.problems);
  current = makeFakeSupabase({});
  const g2 = await doPull({ ping: '1' });
  check('healthy backend reports ok', g2.body.ok === true && g2.body.problems.length === 0, g2.body);
  const g3 = await sync.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer wrong' }, queryStringParameters: { ping: '1' } });
  check('wrong sync key is a clear 401', g3.statusCode === 401, g3);

  console.log('\n=== RESULT:', passed, 'passed,', failed, 'failed ===\n');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
