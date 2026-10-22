process.env.SYNC_KEY = 'test-sync-key';
process.env.SUPABASE_URL = 'http://fake.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key';

const { makeFakeSupabase } = require('./fakeSupabase');

async function main() {
  const roomId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const guestId = 'aaaaaaaa-0000-0000-0000-000000000002';
  const bookingId = 'aaaaaaaa-0000-0000-0000-000000000003';
  const invoiceId = 'aaaaaaaa-0000-0000-0000-000000000004';

  const employeeId = 'aaaaaaaa-0000-0000-0000-000000000005';
  const seed = {
    rooms: [{ id: roomId, number: '101', type_id: 'x', status: 'available' }],
    guests: [{ id: guestId, name: 'Report Guest', phone: '677000111' }],
    bookings: [{
      id: bookingId, guest_id: guestId, room_id: roomId, stay_type: 'nightly',
      check_in: '2026-08-27T13:00:00.000Z', check_out: '2026-08-28T11:00:00.000Z',
      guests: 1, notes: '', status: 'checked-in',
    }],
    invoices: [
      { id: invoiceId, booking_id: bookingId, number: 'INV-0001', tax_rate: 19.25 },
      { id: 'voided-inv-1', booking_id: bookingId, number: 'INV-0002', tax_rate: 19.25, voided: true, voided_by: 'Admin', void_reason: 'Billing mistake' },
    ],
    invoice_payments: [
      { id: 'p1', invoice_id: invoiceId, amount: 15000, method: 'Cash', paid_at: '2026-08-27T14:00:00.000Z' },
      { id: 'p2', invoice_id: invoiceId, amount: 5000, method: 'MTN Mobile Money', paid_at: '2026-08-27T15:30:00.000Z' },
      { id: 'p3', invoice_id: invoiceId, amount: 9999, method: 'Cash', paid_at: '2026-08-26T10:00:00.000Z' }, // day before — must be excluded
      { id: 'p4', invoice_id: 'voided-inv-1', amount: 99999, method: 'Cash', paid_at: '2026-08-27T16:00:00.000Z' }, // voided invoice — must be excluded
    ],
    employees: [{ id: employeeId, name: 'Grace Mballa', role: 'Housekeeper', monthly_salary: 60000, status: 'active' }],
    salary_payments: [
      { id: 'sp1', employee_id: employeeId, month: 'August 2026', amount_due: 60000, amount_paid: 60000, date: '2026-08-27', method: 'Cash' },
      { id: 'sp2', employee_id: employeeId, month: 'July 2026', amount_due: 60000, amount_paid: 60000, date: '2026-07-27', method: 'Cash' }, // out of range
    ],
    expenses: [
      { id: 'ex1', date: '2026-08-27', category: 'Maintenance & Repairs', description: 'AC repair', amount: 12000, method: 'Cash' },
      { id: 'ex2', date: '2026-08-26', category: 'Utilities', description: 'Electricity', amount: 8000, method: 'Cash' }, // out of range
    ],
    deposits: [
      { id: 'dp1', date: '2026-08-27', amount: 10000, method: 'Cash', destination: 'Afriland First Bank' },
    ],
  };
  const fakeSupabase = makeFakeSupabase(seed);
  const supabaseLibPath = require.resolve('../netlify/functions/_lib/supabase');
  require.cache[supabaseLibPath] = {
    id: supabaseLibPath, filename: supabaseLibPath, loaded: true,
    exports: { getSupabase: () => fakeSupabase },
  };

  const report = require('../netlify/functions/report');

  let passed = 0, failed = 0;
  function check(label, cond, extra) {
    if (cond) { passed++; console.log('  PASS -', label); }
    else { failed++; console.log('  FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
  }

  const res = await report.handler({
    httpMethod: 'GET',
    queryStringParameters: { from: '2026-08-27T00:00:00.000Z', to: '2026-08-28T00:00:00.000Z' },
    headers: { authorization: 'Bearer test-sync-key' },
  });
  check('report succeeds (200)', res.statusCode === 200, res);
  const data = JSON.parse(res.body);
  check('revenue excludes the prior day payment and the voided invoice', data.revenue === 20000, data.revenue);
  check('payment count is 2 (excludes prior-day and voided)', data.paymentCount === 2, data.paymentCount);
  check('no payment in the list belongs to the voided invoice', data.payments.every(p => p.invoiceNumber !== 'INV-0002'), data.payments);
  check('byMethod has Cash=15000 and MTN=5000', data.byMethod.Cash.amount === 15000 && data.byMethod['MTN Mobile Money'].amount === 5000, data.byMethod);
  check('payments include resolved guest/room names', data.payments.every(p => p.guestName === 'Report Guest' && p.roomNumber === '101'), data.payments);
  check('occupied includes the room (stay spans the day)', data.occupied.length === 1 && data.occupied[0].roomNumber === '101', data.occupied);
  check('expensesTotal excludes the prior day expense', data.expensesTotal === 12000, data.expensesTotal);
  check('payrollTotal excludes the prior month payment', data.payrollTotal === 60000, data.payrollTotal);
  check('salary payment includes resolved employee name', data.salaryPayments[0].employeeName === 'Grace Mballa', data.salaryPayments);
  check('depositedTotal correct', data.depositedTotal === 10000, data.depositedTotal);
  check('net = revenue - expenses - payroll - deposits', data.net === 20000 - 12000 - 60000 - 10000, data.net);

  const noAuth = await report.handler({ httpMethod: 'GET', queryStringParameters: {}, headers: {} });
  check('missing sync key rejected (401)', noAuth.statusCode === 401, noAuth);

  console.log('\n=== RESULT:', passed, 'passed,', failed, 'failed ===\n');
  process.exit(failed ? 1 : 0);
}
main().catch(err => { console.error('CRASHED:', err); process.exit(1); });
