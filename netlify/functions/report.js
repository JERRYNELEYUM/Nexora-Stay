const { getSupabase } = require('./_lib/supabase');
const { checkSyncKey } = require('./_lib/syncAuth');
const { json, preflight, error } = require('./_lib/respond');
const { fetchAllRows } = require('./_lib/db');

/**
 * GET /report?from=<UTC ISO>&to=<UTC ISO>
 *
 * `from`/`to` should bracket exactly one local calendar day, converted
 * to UTC by whoever is calling this (the owner-report page does this
 * using the viewer's own browser timezone, so "today" always means
 * today wherever the owner happens to be looking from). If omitted,
 * falls back to "today in UTC", which may be off by a few hours from
 * the hotel's actual local day — always pass from/to explicitly.
 */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return error(405, 'Method not allowed.');

  const auth = checkSyncKey(event);
  if (!auth.ok) return error(401, auth.reason);

  const params = event.queryStringParameters || {};
  let from = params.from;
  let to = params.to;
  if (!from || !to) {
    const now = new Date();
    const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    from = startOfUtcDay.toISOString();
    to = new Date(startOfUtcDay.getTime() + 86400000).toISOString();
  }

  const supabase = getSupabase();
  const fromDateStr = from.slice(0, 10);
  const toDateStr = new Date(new Date(to).getTime() - 1).toISOString().slice(0, 10);

  const [paymentsRes, invoicesRes, bookingsRes, roomsRes, guestsRes, expensesRes, salaryRes, employeesRes, depositsRes] = await Promise.all([
    supabase.from('invoice_payments').select('*').gte('paid_at', from).lt('paid_at', to),
    fetchAllRows(supabase, 'invoices'),
    fetchAllRows(supabase, 'bookings'),
    fetchAllRows(supabase, 'rooms'),
    fetchAllRows(supabase, 'guests'),
    supabase.from('expenses').select('*').gte('date', fromDateStr).lte('date', toDateStr),
    supabase.from('salary_payments').select('*').gte('date', fromDateStr).lte('date', toDateStr),
    fetchAllRows(supabase, 'employees'),
    supabase.from('deposits').select('*').gte('date', fromDateStr).lte('date', toDateStr),
  ]);
  const firstError = [paymentsRes, invoicesRes, bookingsRes, roomsRes, guestsRes, expensesRes, salaryRes, employeesRes, depositsRes].find(r => r.error);
  if (firstError) return error(500, 'Could not load report data: ' + firstError.error.message);

  const invoicesById = {};
  (invoicesRes.data || []).forEach(i => { invoicesById[i.id] = i; });
  const bookingsById = {};
  (bookingsRes.data || []).forEach(b => { bookingsById[b.id] = b; });
  const roomsById = {};
  (roomsRes.data || []).forEach(r => { roomsById[r.id] = r; });
  const guestsById = {};
  (guestsRes.data || []).forEach(g => { guestsById[g.id] = g; });

  const payments = (paymentsRes.data || [])
    .filter(p => {
      const inv = invoicesById[p.invoice_id];
      return !(inv && inv.voided); // voided invoices never count toward revenue
    })
    .map(p => {
      const inv = invoicesById[p.invoice_id];
      const booking = inv ? bookingsById[inv.booking_id] : null;
      const room = booking ? roomsById[booking.room_id] : null;
      const guest = booking ? guestsById[booking.guest_id] : null;
      return {
        amount: p.amount,
        method: p.method,
        paidAt: p.paid_at,
        invoiceNumber: inv ? inv.number : null,
        roomNumber: room ? room.number : null,
        guestName: guest ? guest.name : null,
      };
    });

  const revenue = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const byMethod = {};
  payments.forEach(p => {
    const m = p.method || 'Other';
    byMethod[m] = byMethod[m] || { count: 0, amount: 0 };
    byMethod[m].count++;
    byMethod[m].amount += Number(p.amount) || 0;
  });

  const activeStatuses = ['checked-in', 'checked-out'];
  const checkins = (bookingsRes.data || []).filter(b =>
    activeStatuses.includes(b.status) && b.check_in >= from && b.check_in < to
  ).length;
  const checkouts = (bookingsRes.data || []).filter(b =>
    b.status === 'checked-out' && b.check_out >= from && b.check_out < to
  ).length;
  const occupied = (bookingsRes.data || [])
    .filter(b => activeStatuses.includes(b.status) && b.check_in < to && b.check_out > from)
    .map(b => {
      const room = roomsById[b.room_id];
      const guest = guestsById[b.guest_id];
      return {
        roomNumber: room ? room.number : null,
        guestName: guest ? guest.name : null,
        stayType: b.stay_type,
        checkIn: b.check_in,
        checkOut: b.check_out,
      };
    });

  const employeesById = {};
  (employeesRes.data || []).forEach(e => { employeesById[e.id] = e; });

  const expensesTotal = (expensesRes.data || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const payrollTotal = (salaryRes.data || []).reduce((s, p) => s + (Number(p.amount_paid) || 0), 0);
  const depositedTotal = (depositsRes.data || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const net = revenue - expensesTotal - payrollTotal - depositedTotal;

  return json(200, {
    from: from,
    to: to,
    revenue: revenue,
    paymentCount: payments.length,
    checkins: checkins,
    checkouts: checkouts,
    byMethod: byMethod,
    payments: payments,
    occupied: occupied,
    expensesTotal: expensesTotal,
    expenses: (expensesRes.data || []).map(e => ({ date: e.date, description: e.description, category: e.category, amount: e.amount })),
    payrollTotal: payrollTotal,
    salaryPayments: (salaryRes.data || []).map(p => ({ date: p.date, month: p.month, amount: p.amount_paid, employeeName: employeesById[p.employee_id] ? employeesById[p.employee_id].name : null })),
    depositedTotal: depositedTotal,
    deposits: (depositsRes.data || []).map(d => ({ date: d.date, destination: d.destination, amount: d.amount })),
    net: net,
  });
};
