process.env.SYNC_KEY = 'test-sync-key';
process.env.SUPABASE_URL = 'http://fake.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key';

const { makeFakeSupabase } = require('./fakeSupabase');

async function main() {
  const seed = {
    hotel_settings: [{ id: 'default', name: 'Nexora Stay', address: '', phone: '', currency: 'FCFA', tax_rate: 19.25, updated_at: '2026-01-01T00:00:00.000Z' }],
    staff: [], room_types: [], rooms: [], guests: [], bookings: [],
    invoices: [], invoice_charges: [], invoice_payments: [],
    employees: [], salary_payments: [], expenses: [], deposits: [],
  };
  const fakeSupabase = makeFakeSupabase(seed);

  const supabaseLibPath = require.resolve('../netlify/functions/_lib/supabase');
  require.cache[supabaseLibPath] = {
    id: supabaseLibPath, filename: supabaseLibPath, loaded: true,
    exports: { getSupabase: () => fakeSupabase },
  };

  const push = require('../netlify/functions/push');
  const sync = require('../netlify/functions/sync');

  let passed = 0, failed = 0;
  function check(label, cond, extra) {
    if (cond) { passed++; console.log('  PASS -', label); }
    else { failed++; console.log('  FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
  }
  function ev(method, body, key) {
    return { httpMethod: method, body: body ? JSON.stringify(body) : null, headers: key ? { authorization: 'Bearer ' + key } : {} };
  }

  console.log('\n== sync key auth ==');
  const noKey = await sync.handler(ev('GET', null, null));
  check('sync without key rejected (401)', noKey.statusCode === 401, noKey);
  const wrongKey = await push.handler(ev('POST', { tables: {} }, 'nope'));
  check('push with wrong key rejected (401)', wrongKey.statusCode === 401, wrongKey);

  console.log('\n== push: new records accepted ==');
  const typeId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const roomId = 'aaaaaaaa-0000-0000-0000-000000000002';
  const guestId = 'aaaaaaaa-0000-0000-0000-000000000003';
  const bookingId = 'aaaaaaaa-0000-0000-0000-000000000004';
  const t1 = '2026-08-10T10:00:00.000Z';

  const push1 = await push.handler(ev('POST', {
    tables: {
      roomTypes: [{ id: typeId, name: 'Standard', rate: 15000, rate_1h: 3000, rate_3h: 6000, rate_night: 10000, capacity: 2, updated_at: t1 }],
      rooms: [{ id: roomId, number: '101', type_id: typeId, status: 'available', updated_at: t1 }],
      guests: [{ id: guestId, name: 'Test Guest', phone: '677000111', id_number: '', updated_at: t1 }],
      bookings: [{ id: bookingId, guest_id: guestId, room_id: roomId, stay_type: 'nightly', check_in: '2026-09-01T13:00:00.000Z', check_out: '2026-09-02T11:00:00.000Z', guests: 1, notes: '', status: 'reserved', updated_at: t1 }],
    },
  }, 'test-sync-key'));
  const r1 = JSON.parse(push1.statusCode === 200 ? push1.body : '{}');
  check('push succeeds (200)', push1.statusCode === 200, push1);
  check('all 4 records accepted', (r1.accepted.roomTypes || []).length === 1 && (r1.accepted.rooms || []).length === 1 &&
    (r1.accepted.guests || []).length === 1 && (r1.accepted.bookings || []).length === 1, r1);

  console.log('\n== push: stale record is skipped, not overwritten ==');
  const staleUpdate = await push.handler(ev('POST', {
    tables: { rooms: [{ id: roomId, number: 'STALE', type_id: typeId, status: 'available', updated_at: '2026-01-01T00:00:00.000Z' }] },
  }, 'test-sync-key'));
  const r2 = JSON.parse(staleUpdate.body);
  check('stale write not accepted', !(r2.accepted.rooms || []).length, r2);

  console.log('\n== push: newer record overwrites ==');
  const newerUpdate = await push.handler(ev('POST', {
    tables: { rooms: [{ id: roomId, number: '101-B', type_id: typeId, status: 'available', updated_at: '2026-08-11T00:00:00.000Z' }] },
  }, 'test-sync-key'));
  const r3 = JSON.parse(newerUpdate.body);
  check('newer write accepted', (r3.accepted.rooms || []).length === 1, r3);

  console.log('\n== push: conflicting double-booking from another device is rejected ==');
  const conflictBookingId = 'aaaaaaaa-0000-0000-0000-000000000005';
  const conflictPush = await push.handler(ev('POST', {
    tables: {
      bookings: [{
        id: conflictBookingId, guest_id: guestId, room_id: roomId, stay_type: 'nightly',
        check_in: '2026-09-01T18:00:00.000Z', check_out: '2026-09-02T09:00:00.000Z',
        guests: 1, notes: '', status: 'reserved', updated_at: t1,
      }],
    },
  }, 'test-sync-key'));
  const r4 = JSON.parse(conflictPush.body);
  check('overlapping booking rejected with a reason', (r4.rejected.bookings || []).length === 1, r4);

  console.log('\n== pull returns the merged canonical state ==');
  const pull = await sync.handler(ev('GET', null, 'test-sync-key'));
  const synced = JSON.parse(pull.body);
  check('pull succeeds (200)', pull.statusCode === 200, pull);
  check('pulled room reflects the newer push (101-B)', synced.rooms.find(r => r.id === roomId).number === '101-B', synced.rooms);
  check('pulled bookings only include the accepted one', synced.bookings.length === 1 && synced.bookings[0].id === bookingId, synced.bookings);
  check('staff table has no pin fields', synced.staff.every(s => !('pin_hash' in s) && !('pin' in s)), synced.staff);

  console.log('\n== payroll: employees + salary payments sync ==');
  const employeeId = 'aaaaaaaa-0000-0000-0000-000000000006';
  const salaryPaymentId = 'aaaaaaaa-0000-0000-0000-000000000007';
  const payrollPush = await push.handler(ev('POST', {
    tables: {
      employees: [{ id: employeeId, name: 'Grace Mballa', role: 'Housekeeper', phone: '677123456', monthly_salary: 60000, status: 'active', date_joined: '2026-01-15', updated_at: t1 }],
      salaryPayments: [{ id: salaryPaymentId, employee_id: employeeId, month: 'August 2026', amount_due: 60000, amount_paid: 60000, date: '2026-08-30', method: 'Cash', note: '', updated_at: t1 }],
    },
  }, 'test-sync-key'));
  const rp = JSON.parse(payrollPush.body);
  check('employee + salary payment accepted', (rp.accepted.employees || []).length === 1 && (rp.accepted.salaryPayments || []).length === 1, rp);

  console.log('\n== spending: expenses sync ==');
  const expenseId = 'aaaaaaaa-0000-0000-0000-000000000008';
  const spendingPush = await push.handler(ev('POST', {
    tables: {
      expenses: [{ id: expenseId, date: '2026-08-27', category: 'Maintenance & Repairs', description: 'AC repair room 201', amount: 15000, method: 'Cash', vendor: 'ABC Hardware', updated_at: t1 }],
    },
  }, 'test-sync-key'));
  const rs = JSON.parse(spendingPush.body);
  check('expense accepted', (rs.accepted.expenses || []).length === 1, rs);

  console.log('\n== payroll/spending pull back correctly ==');
  const pull2 = await sync.handler(ev('GET', null, 'test-sync-key'));
  const synced2 = JSON.parse(pull2.body);
  check('pulled employee matches', synced2.employees.length === 1 && synced2.employees[0].name === 'Grace Mballa', synced2.employees);
  check('pulled salary payment matches', synced2.salaryPayments.length === 1 && synced2.salaryPayments[0].amount_paid === 60000, synced2.salaryPayments);
  check('pulled expense matches', synced2.expenses.length === 1 && synced2.expenses[0].amount === 15000, synced2.expenses);

  console.log('\n== deposits sync ==');
  const depositId = 'aaaaaaaa-0000-0000-0000-000000000009';
  const depositPush = await push.handler(ev('POST', {
    tables: { deposits: [{ id: depositId, date: '2026-08-27', amount: 50000, method: 'Cash', destination: 'Afriland First Bank', note: 'End of week', updated_at: t1 }] },
  }, 'test-sync-key'));
  const rd = JSON.parse(depositPush.body);
  check('deposit accepted', (rd.accepted.deposits || []).length === 1, rd);
  const pull3 = await sync.handler(ev('GET', null, 'test-sync-key'));
  const synced3 = JSON.parse(pull3.body);
  check('pulled deposit matches', synced3.deposits.length === 1 && synced3.deposits[0].amount === 50000, synced3.deposits);

  console.log('\n=== RESULT:', passed, 'passed,', failed, 'failed ===\n');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('TEST HARNESS CRASHED:', err); process.exit(1); });
