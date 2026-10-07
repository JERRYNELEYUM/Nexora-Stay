/* ======================================================================
   NEXORA STAY — front-desk booking & billing for a small hotel
   Offline-first: everything is stored in this browser (localStorage)
   and every screen works with no internet connection at all. If you
   set up the optional cloud backend in Settings → Cloud sync, this
   device will also push its changes up and pull down changes from
   other devices whenever it's online — so the hotel owner can watch
   bookings update live, and other front-desk devices stay in step.
   Without that setup, the app behaves exactly like a fully offline,
   single-device tool. Export backups regularly either way.
   ====================================================================== */

const STORAGE_KEY = 'nexoraStayData_v1';

function pad2(n) { return String(n).padStart(2, '0'); }
function toLocalInput(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}
function nowLocal() { return toLocalInput(new Date()); }
function localDateStr(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}
const TODAY = () => localDateStr(new Date());

/* Short-stay durations, in hours. "nightly" (multi-night) is handled separately
   with an explicit check-out date/time rather than a fixed duration. */
const STAY_DURATIONS = { '1hour': 1, '3hours': 3, allnight: 12 };
const STAY_LABELS = { nightly: 'Full stay', '1hour': '1 hour', '3hours': '3 hours', allnight: 'All night' };
const STAY_RATE_FIELD = { '1hour': 'rate1h', '3hours': 'rate3h', allnight: 'rateNight' };

function computeShortStayCheckout(checkInStr, stayType) {
  const hours = STAY_DURATIONS[stayType];
  if (!hours) return checkInStr;
  const d = new Date(checkInStr);
  d.setHours(d.getHours() + hours);
  return toLocalInput(d);
}

/* Every record gets a real UUID (so it's already valid for the optional
   Postgres backend) and an updatedAt timestamp (so sync can tell whose
   edit is newer when two devices changed the same thing offline). */
function uuidv4() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  // Fallback for older browsers without crypto.randomUUID — not
  // cryptographically strong, but perfectly fine as a unique local id.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function uid() { return uuidv4(); }
function touch(record) { record.updatedAt = new Date().toISOString(); return record; }

let state = null;
let currentStaffInfo = null;

/* ---------------------------- SEED DATA ---------------------------- */
function seedData() {
  const types = [
    { id: uid(), name: 'Standard', rate: 15000, rate1h: 3000, rate3h: 6000, rateNight: 10000, capacity: 2 },
    { id: uid(), name: 'Deluxe', rate: 25000, rate1h: 5000, rate3h: 9000, rateNight: 15000, capacity: 2 },
    { id: uid(), name: 'Suite', rate: 40000, rate1h: 8000, rate3h: 14000, rateNight: 22000, capacity: 4 },
  ];
  types.forEach(touch);
  const rooms = [
    { id: uid(), number: '101', typeId: types[0].id, status: 'available' },
    { id: uid(), number: '102', typeId: types[0].id, status: 'available' },
    { id: uid(), number: '103', typeId: types[0].id, status: 'available' },
    { id: uid(), number: '201', typeId: types[1].id, status: 'available' },
    { id: uid(), number: '202', typeId: types[1].id, status: 'available' },
    { id: uid(), number: '301', typeId: types[2].id, status: 'available' },
  ];
  rooms.forEach(touch);
  const staff = [
    { id: uid(), name: 'Admin', pin: '1234', role: 'admin', active: true },
  ];
  staff.forEach(touch);
  return {
    hotel: touch({
      name: 'Nexora Stay',
      address: 'Buea, South-West Region, Cameroon',
      phone: '',
      email: '',
      taxpayerNumber: '',
      registrationNumber: '',
      currency: 'FCFA',
      taxRate: 19.25,
    }),
    staff: staff,
    roomTypes: types,
    rooms: rooms,
    guests: [],
    bookings: [],
    invoices: [],
    employees: [],
    salaryPayments: [],
    expenseCategories: ['Utilities', 'Maintenance & Repairs', 'Supplies', 'Laundry', 'Transport', 'Food & Beverage', 'Administration', 'Marketing', 'Other'],
    expenses: [],
    deposits: [],
    counters: { invoice: 1 },
    syncConfig: { backendUrl: '', syncKey: '' },
    lastSyncedAt: null,
  };
}

/* ---------------------------- PERSISTENCE ---------------------------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // fill in fields older saved data might not have yet
      if (!parsed.staff || !parsed.staff.length) {
        parsed.staff = [touch({ id: uid(), name: 'Admin', pin: parsed.pin || '1234', role: 'admin', active: true })];
      }
      if (!parsed.syncConfig) parsed.syncConfig = { backendUrl: '', syncKey: '' };
      if (parsed.lastSyncedAt === undefined) parsed.lastSyncedAt = null;
      if (!parsed.employees) parsed.employees = [];
      if (!parsed.salaryPayments) parsed.salaryPayments = [];
      if (!parsed.expenseCategories) parsed.expenseCategories = ['Utilities', 'Maintenance & Repairs', 'Supplies', 'Laundry', 'Transport', 'Food & Beverage', 'Administration', 'Marketing', 'Other'];
      if (!parsed.expenses) parsed.expenses = [];
      if (!parsed.deposits) parsed.deposits = [];
      if (parsed.hotel) {
        if (parsed.hotel.email === undefined) parsed.hotel.email = '';
        if (parsed.hotel.taxpayerNumber === undefined) parsed.hotel.taxpayerNumber = '';
        if (parsed.hotel.registrationNumber === undefined) parsed.hotel.registrationNumber = '';
      }
      return parsed;
    }
  } catch (e) { console.error('Failed to load saved data', e); }
  const fresh = seedData();
  saveState(fresh);
  return fresh;
}
function saveState(s) {
  if (s === undefined) s = state;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    console.error('Failed to save data', e);
    toast('Could not save — your browser storage may be full.');
  }
  scheduleSync();
}

/* ---------------------------- UTILITIES ---------------------------- */
function nextInvoiceCounter() {
  state.counters = state.counters || { invoice: 1 };
  const n = state.counters.invoice++;
  return n;
}
function formatMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US') + ' ' + state.hotel.currency;
}
function nightsBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.max(1, Math.ceil(ms / 86400000));
}
function stayDurationLabel(booking) {
  if (booking.stayType && booking.stayType !== 'nightly') return STAY_LABELS[booking.stayType] || booking.stayType;
  const n = nightsBetween(booking.checkIn, booking.checkOut);
  return n + (n === 1 ? ' night' : ' nights');
}
function formatDateTime(str) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d)) return str;
  const sameDay = str.slice(0, 10) === TODAY();
  const datePart = sameDay ? 'Today' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const timePart = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}
function overlaps(aIn, aOut, bIn, bOut) {
  return aIn < bOut && aOut > bIn;
}
function getRoom(id) { return state.rooms.find(r => r.id === id); }
function getType(id) { return state.roomTypes.find(t => t.id === id); }
function getGuest(id) { return state.guests.find(g => g.id === id); }
function getBooking(id) { return state.bookings.find(b => b.id === id); }
function getInvoiceForBooking(bookingId) { return state.invoices.find(i => i.bookingId === bookingId); }

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* Effective status of a room right now, derived from bookings */
function roomEffectiveStatus(room) {
  if (room.status === 'maintenance') return 'maintenance';
  const now = nowLocal();
  const active = state.bookings.find(b =>
    b.roomId === room.id && b.status === 'checked-in'
  );
  if (active) return 'occupied';
  const reserved = state.bookings.find(b =>
    b.roomId === room.id && b.status === 'reserved' &&
    b.checkIn <= now && now < b.checkOut
  );
  if (reserved) return 'reserved';
  return 'available';
}

/* Is a room free for a given date range, optionally ignoring one booking (for edits) */
function isRoomAvailable(roomId, checkIn, checkOut, excludeBookingId) {
  const room = getRoom(roomId);
  if (!room) return false;
  if (room.status === 'maintenance') return false;
  return !state.bookings.some(b =>
    b.roomId === roomId &&
    b.id !== excludeBookingId &&
    (b.status === 'reserved' || b.status === 'checked-in') &&
    overlaps(checkIn, checkOut, b.checkIn, b.checkOut)
  );
}

/* ============================================================
   RENDERING
   ============================================================ */

function renderAll() {
  document.getElementById('brand-hotel-name').textContent = state.hotel.name;
  document.getElementById('topbar-date').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  renderDashboard();
  renderBookings();
  renderRooms();
  renderGuests();
  renderInvoices();
  renderSettingsForm();
  if (document.getElementById('view-reports').classList.contains('active')) renderReports();
  if (document.getElementById('view-payroll').classList.contains('active')) renderPayroll();
  if (document.getElementById('view-spending').classList.contains('active')) renderSpending();
}

function renderDashboard() {
  const rooms = state.rooms;
  const occupied = rooms.filter(r => roomEffectiveStatus(r) === 'occupied').length;
  document.getElementById('stat-occupied').textContent = `${occupied} / ${rooms.length}`;

  const today = TODAY();
  const arrivals = state.bookings.filter(b => b.checkIn.slice(0, 10) === today && b.status === 'reserved');
  const departures = state.bookings.filter(b => b.checkOut.slice(0, 10) === today && b.status === 'checked-in');
  document.getElementById('stat-arrivals').textContent = arrivals.length;
  document.getElementById('stat-departures').textContent = departures.length;

  const maintenanceCount = rooms.filter(r => r.status === 'maintenance').length;
  document.getElementById('stat-maintenance').textContent = maintenanceCount;

  // room board
  const board = document.getElementById('room-board');
  board.innerHTML = '';
  rooms.slice().sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
    .forEach(r => {
      const t = getType(r.typeId);
      const status = roomEffectiveStatus(r);
      const div = document.createElement('div');
      div.className = `room-tag ${status}`;
      div.innerHTML = `<div class="rt-num">${escapeHtml(r.number)}</div><div class="rt-type">${escapeHtml(t ? t.name : '—')}</div>`;
      div.title = `Room ${r.number} — ${status}`;
      div.onclick = () => { switchView('rooms'); };
      board.appendChild(div);
    });

  // arrivals table
  const arrBody = document.querySelector('#table-arrivals tbody');
  arrBody.innerHTML = '';
  if (!arrivals.length) {
    arrBody.innerHTML = `<tr class="muted-row"><td colspan="4">No arrivals expected today.</td></tr>`;
  } else {
    arrivals.forEach(b => {
      const g = getGuest(b.guestId), r = getRoom(b.roomId);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml((g && g.name) || '—')}</td><td>${escapeHtml((r && r.number) || '—')}</td>
        <td>${escapeHtml(stayDurationLabel(b))}</td>
        <td><button class="link-btn" data-checkin="${b.id}">Check in</button></td>`;
      arrBody.appendChild(tr);
    });
  }

  // departures table
  const depBody = document.querySelector('#table-departures tbody');
  depBody.innerHTML = '';
  if (!departures.length) {
    depBody.innerHTML = `<tr class="muted-row"><td colspan="4">No departures expected today.</td></tr>`;
  } else {
    departures.forEach(b => {
      const g = getGuest(b.guestId), r = getRoom(b.roomId);
      const inv = getInvoiceForBooking(b.id);
      const balance = inv ? invoiceBalance(inv) : billableTotal(b);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml((g && g.name) || '—')}</td><td>${escapeHtml((r && r.number) || '—')}</td>
        <td>${formatMoney(balance)}</td>
        <td><button class="link-btn" data-checkout="${b.id}">Check out</button></td>`;
      depBody.appendChild(tr);
    });
  }

  arrBody.querySelectorAll('[data-checkin]').forEach(btn =>
    btn.onclick = () => doCheckIn(btn.dataset.checkin));
  depBody.querySelectorAll('[data-checkout]').forEach(btn =>
    btn.onclick = () => doCheckOut(btn.dataset.checkout));
}

function renderBookings() {
  const search = (document.getElementById('booking-search').value || '').toLowerCase();
  const statusFilter = document.getElementById('booking-filter-status').value;
  const body = document.querySelector('#table-bookings tbody');
  body.innerHTML = '';

  let list = state.bookings.slice().sort((a, b) => b.checkIn.localeCompare(a.checkIn));
  if (statusFilter) list = list.filter(b => b.status === statusFilter);
  if (search) {
    list = list.filter(b => {
      const g = getGuest(b.guestId), r = getRoom(b.roomId);
      return ((g && g.name) || '').toLowerCase().includes(search) || ((r && r.number) || '').toLowerCase().includes(search);
    });
  }

  if (!list.length) {
    body.innerHTML = `<tr class="muted-row"><td colspan="6">No bookings found.</td></tr>`;
    return;
  }

  list.forEach(b => {
    const g = getGuest(b.guestId), r = getRoom(b.roomId);
    const tr = document.createElement('tr');
    let actions = '';
    const isAdminRow = currentStaffInfo && currentStaffInfo.role === 'admin';
    if (b.status === 'reserved') {
      actions += `<button class="link-btn" data-checkin="${b.id}">Check in</button>`;
      if (isAdminRow) actions += `<button class="icon-btn" data-cancel="${b.id}" title="Cancel">Cancel</button>`;
    } else if (b.status === 'checked-in') {
      actions += `<button class="link-btn" data-checkout="${b.id}">Check out</button>`;
    }
    actions += `<button class="link-btn" data-bill="${b.id}">Billing</button>`;
    tr.innerHTML = `<td>${escapeHtml((g && g.name) || '—')}</td><td>${escapeHtml((r && r.number) || '—')}</td>
      <td>${escapeHtml(stayDurationLabel(b))}</td>
      <td>${formatDateTime(b.checkIn)}</td><td>${formatDateTime(b.checkOut)}</td>
      <td><span class="badge badge-${b.status}">${labelStatus(b.status)}</span></td>
      <td>${actions}</td>`;
    body.appendChild(tr);
  });

  body.querySelectorAll('[data-checkin]').forEach(btn => btn.onclick = () => doCheckIn(btn.dataset.checkin));
  body.querySelectorAll('[data-checkout]').forEach(btn => btn.onclick = () => doCheckOut(btn.dataset.checkout));
  body.querySelectorAll('[data-cancel]').forEach(btn => btn.onclick = () => doCancel(btn.dataset.cancel));
  body.querySelectorAll('[data-bill]').forEach(btn => btn.onclick = () => openInvoiceForBooking(btn.dataset.bill));
}

function labelStatus(s) {
  return { reserved: 'Reserved', 'checked-in': 'Checked in', 'checked-out': 'Checked out', cancelled: 'Cancelled' }[s] || s;
}

function renderRooms() {
  const role = currentStaffInfo ? currentStaffInfo.role : null;
  const canEdit = role === 'admin' || role === 'assistant';
  const canDelete = role === 'admin';

  const body = document.querySelector('#table-rooms tbody');
  body.innerHTML = '';
  if (!state.rooms.length) {
    body.innerHTML = `<tr class="muted-row"><td colspan="5">No rooms yet — add your first room.</td></tr>`;
  }
  state.rooms.slice().sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
    .forEach(r => {
      const t = getType(r.typeId);
      const status = roomEffectiveStatus(r);
      const tr = document.createElement('tr');
      const actions = (canEdit ? `<button class="link-btn" data-edit-room="${r.id}">Edit</button>` : '') +
        (canDelete ? `<button class="icon-btn" data-del-room="${r.id}">Remove</button>` : '');
      tr.innerHTML = `<td>${escapeHtml(r.number)}</td><td>${escapeHtml(t ? t.name : '—')}</td>
        <td>${formatMoney(t ? t.rate : 0)}</td>
        <td><span class="badge badge-${status === 'occupied' ? 'checked-in' : status === 'reserved' ? 'reserved' : status === 'maintenance' ? 'cancelled' : 'paid'}">${status}</span></td>
        <td>${actions}</td>`;
      body.appendChild(tr);
    });
  body.querySelectorAll('[data-edit-room]').forEach(btn => btn.onclick = () => openRoomModal(btn.dataset.editRoom));
  body.querySelectorAll('[data-del-room]').forEach(btn => btn.onclick = () => deleteRoom(btn.dataset.delRoom));

  const typeBody = document.querySelector('#table-room-types tbody');
  typeBody.innerHTML = '';
  state.roomTypes.forEach(t => {
    const tr = document.createElement('tr');
    const actions = (canEdit ? `<button class="link-btn" data-edit-type="${t.id}">Edit</button>` : '') +
      (canDelete ? `<button class="icon-btn" data-del-type="${t.id}">Remove</button>` : '');
    tr.innerHTML = `<td>${escapeHtml(t.name)}</td><td>${formatMoney(t.rate)}</td>
      <td>${t.rate1h ? formatMoney(t.rate1h) : '—'}</td>
      <td>${t.rate3h ? formatMoney(t.rate3h) : '—'}</td>
      <td>${t.rateNight ? formatMoney(t.rateNight) : '—'}</td>
      <td>${t.capacity}</td>
      <td>${actions}</td>`;
    typeBody.appendChild(tr);
  });
  typeBody.querySelectorAll('[data-edit-type]').forEach(btn => btn.onclick = () => openTypeModal(btn.dataset.editType));
  typeBody.querySelectorAll('[data-del-type]').forEach(btn => btn.onclick = () => deleteType(btn.dataset.delType));

  // refresh room select in booking modal & room type select in room modal
  refreshRoomTypeSelect();
}

function renderGuests() {
  const search = (document.getElementById('guest-search').value || '').toLowerCase();
  const body = document.querySelector('#table-guests tbody');
  body.innerHTML = '';
  let list = state.guests.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (search) list = list.filter(g => g.name.toLowerCase().includes(search) || (g.phone || '').includes(search));
  if (!list.length) {
    body.innerHTML = `<tr class="muted-row"><td colspan="5">No guests yet.</td></tr>`;
    return;
  }
  list.forEach(g => {
    const stays = state.bookings.filter(b => b.guestId === g.id).length;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.phone || '—')}</td>
      <td>${escapeHtml(g.idNumber || '—')}</td><td>${stays}</td><td></td>`;
    body.appendChild(tr);
  });
}

/* ---------------------------- BILLING CALC ---------------------------- */
function billableTotal(booking) {
  const room = getRoom(booking.roomId);
  const type = room ? getType(room.typeId) : null;
  if (!type) return 0;
  if (booking.stayType && booking.stayType !== 'nightly') {
    const field = STAY_RATE_FIELD[booking.stayType];
    return Number(type[field]) || 0;
  }
  return (type.rate || 0) * nightsBetween(booking.checkIn, booking.checkOut);
}
function invoiceSubtotal(inv) {
  const booking = getBooking(inv.bookingId);
  const roomCharge = booking ? billableTotal(booking) : 0;
  const extra = (inv.charges || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  return roomCharge + extra;
}
function invoiceDiscountAmount(inv) {
  const d = inv.discount;
  if (!d || !(Number(d.value) > 0)) return 0;
  const subtotal = invoiceSubtotal(inv);
  let amount = d.type === 'flat' ? Number(d.value) : subtotal * (Number(d.value) / 100);
  return Math.max(0, Math.min(amount, subtotal));
}
function invoiceSubtotalAfterDiscount(inv) {
  return invoiceSubtotal(inv) - invoiceDiscountAmount(inv);
}
function invoiceTax(inv) {
  return invoiceSubtotalAfterDiscount(inv) * (((inv.taxRate != null ? inv.taxRate : state.hotel.taxRate)) / 100);
}
function invoiceTotal(inv) {
  return invoiceSubtotalAfterDiscount(inv) + invoiceTax(inv);
}
function invoicePaid(inv) {
  return (inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}
function invoiceBalance(inv) {
  return Math.max(0, invoiceTotal(inv) - invoicePaid(inv));
}
function invoiceStatus(inv) {
  if (inv.voided) return 'void';
  const bal = invoiceBalance(inv);
  if (bal <= 0) return 'paid';
  if (invoicePaid(inv) > 0) return 'partial';
  return 'unpaid';
}
function ensureInvoiceForBooking(bookingId) {
  let inv = getInvoiceForBooking(bookingId);
  if (!inv) {
    inv = touch({
      id: uid(),
      number: 'INV-' + String(nextInvoiceCounter()).padStart(4, '0'),
      bookingId: bookingId,
      charges: [],
      payments: [],
      taxRate: state.hotel.taxRate,
      createdAt: TODAY(),
    });
    state.invoices.push(inv);
    saveState();
  }
  return inv;
}

/* Shared by the Billing and Spending record tables: reads a
   Period/Date pair (same Daily/Weekly/Monthly/Yearly/All Time
   options as Reports) and returns the matching {from, to} date
   range, or null for "All Time" (no date filtering at all). */
function getPeriodFilterRange(periodId, dateId) {
  const periodSelect = document.getElementById(periodId);
  const dateInput = document.getElementById(dateId);
  const period = periodSelect.value;
  dateInput.classList.toggle('hidden', period === 'alltime');
  if (!dateInput.value) dateInput.value = TODAY();
  if (period === 'alltime') return null;
  return getReportRange(period, dateInput.value);
}

function renderInvoices() {
  const filter = document.getElementById('billing-filter-status').value;
  const range = getPeriodFilterRange('billing-filter-period', 'billing-filter-date');
  const body = document.querySelector('#table-invoices tbody');
  body.innerHTML = '';
  let list = state.invoices.slice().sort((a, b) => {
    const cmp = b.createdAt.localeCompare(a.createdAt);
    if (cmp !== 0) return cmp;
    return b.number.localeCompare(a.number, undefined, { numeric: true });
  });
  if (filter) list = list.filter(i => invoiceStatus(i) === filter);
  if (range) list = list.filter(i => i.createdAt >= range.from && i.createdAt <= range.to);
  if (!list.length) {
    const msg = state.invoices.length ? 'No invoices match your filters.' : 'No invoices yet — invoices are created automatically from bookings.';
    body.innerHTML = `<tr class="muted-row"><td colspan="8">${msg}</td></tr>`;
    return;
  }
  list.forEach(inv => {
    const booking = getBooking(inv.bookingId);
    const g = booking ? getGuest(booking.guestId) : null;
    const r = booking ? getRoom(booking.roomId) : null;
    const status = invoiceStatus(inv);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${inv.number}</td><td>${inv.createdAt}</td><td>${escapeHtml((g && g.name) || '—')}</td><td>${escapeHtml((r && r.number) || '—')}</td>
      <td>${formatMoney(invoiceTotal(inv))}</td><td>${formatMoney(invoiceBalance(inv))}</td>
      <td><span class="badge badge-${status}">${status}</span></td>
      <td><button class="link-btn" data-open-inv="${inv.id}">Open</button></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-open-inv]').forEach(btn => btn.onclick = () => openInvoiceModal(btn.dataset.openInv));
}

/* ============================================================
   ACTIONS
   ============================================================ */
function doCheckIn(bookingId) {
  const b = getBooking(bookingId);
  if (!b) return;
  b.status = 'checked-in';
  touch(b);
  ensureInvoiceForBooking(b.id);
  saveState();
  toast('Guest checked in.');
  renderAll();
}
function doCheckOut(bookingId) {
  const b = getBooking(bookingId);
  if (!b) return;
  const inv = ensureInvoiceForBooking(b.id);
  b.status = 'checked-out';
  touch(b);
  saveState();
  renderAll();
  toast('Guest checked out. Review the invoice.');
  openInvoiceModal(inv.id);
}
function doCancel(bookingId) {
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') { toast('Only an admin can cancel a booking.'); return; }
  const b = getBooking(bookingId);
  if (!b) return;
  if (!confirm('Cancel this booking?')) return;
  b.status = 'cancelled';
  touch(b);
  saveState();
  renderAll();
  toast('Booking cancelled.');
}
function deleteRoom(roomId) {
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') { toast('Only an admin can remove a room.'); return; }
  const inUse = state.bookings.some(b => b.roomId === roomId && (b.status === 'reserved' || b.status === 'checked-in'));
  if (inUse) { toast('Cannot remove a room with an active or upcoming booking.'); return; }
  if (!confirm('Remove this room?')) return;
  state.rooms = state.rooms.filter(r => r.id !== roomId);
  saveState();
  renderAll();
}
function deleteType(typeId) {
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') { toast('Only an admin can remove a room type.'); return; }
  const inUse = state.rooms.some(r => r.typeId === typeId);
  if (inUse) { toast('Cannot remove a type that rooms are using.'); return; }
  state.roomTypes = state.roomTypes.filter(t => t.id !== typeId);
  saveState();
  renderRooms();
}

/* ============================================================
   VIEW SWITCHING
   ============================================================ */
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const titles = { dashboard: 'Dashboard', bookings: 'Bookings', rooms: 'Rooms', guests: 'Guests', billing: 'Billing', reports: 'Reports', payroll: 'Payroll', spending: 'Spending', settings: 'Settings' };
  document.getElementById('view-title').textContent = titles[view] || view;
  document.querySelector('.sidebar').classList.remove('open');
  if (view === 'reports') renderReports();
  if (view === 'payroll') renderPayroll();
  if (view === 'spending') renderSpending();
}

/* ============================================================
   REPORTS — daily sales summary. Built from local state, so it
   works offline; if cloud sync is set up, syncing first brings in
   other devices' activity before you check the report.
   ============================================================ */
function getReportRange(period, anchorDateStr) {
  const anchor = new Date(anchorDateStr + 'T00:00:00');
  if (period === 'alltime') {
    return { from: '0001-01-01', to: TODAY() };
  }
  if (period === 'daily') {
    return { from: anchorDateStr, to: anchorDateStr };
  }
  if (period === 'weekly') {
    // Monday-Sunday week containing the anchor date
    const dow = anchor.getDay(); // 0=Sun..6=Sat
    const diffToMonday = (dow === 0 ? -6 : 1 - dow);
    const monday = new Date(anchor);
    monday.setDate(anchor.getDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: localDateStr(monday), to: localDateStr(sunday) };
  }
  if (period === 'monthly') {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { from: localDateStr(first), to: localDateStr(last) };
  }
  if (period === 'yearly') {
    return { from: anchor.getFullYear() + '-01-01', to: anchor.getFullYear() + '-12-31' };
  }
  return { from: anchorDateStr, to: anchorDateStr };
}

function reportDataForRange(fromStr, toStr) {
  const payments = [];
  state.invoices.forEach(inv => {
    if (inv.voided) return; // voided invoices never count toward revenue
    const booking = getBooking(inv.bookingId);
    (inv.payments || []).forEach(p => {
      if (p.date >= fromStr && p.date <= toStr) payments.push({ payment: p, invoice: inv, booking: booking });
    });
  });
  const revenue = payments.reduce((s, x) => s + (Number(x.payment.amount) || 0), 0);
  const byMethod = {};
  payments.forEach(x => {
    const m = x.payment.method || 'Other';
    byMethod[m] = byMethod[m] || { count: 0, amount: 0 };
    byMethod[m].count++;
    byMethod[m].amount += Number(x.payment.amount) || 0;
  });

  const checkins = state.bookings.filter(b =>
    localDateStr(new Date(b.checkIn)) >= fromStr && localDateStr(new Date(b.checkIn)) <= toStr &&
    (b.status === 'checked-in' || b.status === 'checked-out')
  );
  const checkouts = state.bookings.filter(b =>
    localDateStr(new Date(b.checkOut)) >= fromStr && localDateStr(new Date(b.checkOut)) <= toStr && b.status === 'checked-out'
  );
  const occupied = state.bookings.filter(b => {
    if (b.status !== 'checked-in' && b.status !== 'checked-out') return false;
    const inD = localDateStr(new Date(b.checkIn));
    const outD = localDateStr(new Date(b.checkOut));
    return inD <= toStr && outD >= fromStr;
  });

  const expenses = state.expenses.filter(e => e.date >= fromStr && e.date <= toStr);
  const expensesTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const salaryPayments = state.salaryPayments.filter(p => p.date >= fromStr && p.date <= toStr);
  const payrollTotal = salaryPayments.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0);
  const deposits = (state.deposits || []).filter(d => d.date >= fromStr && d.date <= toStr);
  const depositedTotal = deposits.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const net = revenue - expensesTotal - payrollTotal - depositedTotal;

  return {
    from: fromStr, to: toStr,
    payments: payments, revenue: revenue, byMethod: byMethod,
    checkins: checkins, checkouts: checkouts, occupied: occupied,
    expenses: expenses, expensesTotal: expensesTotal,
    salaryPayments: salaryPayments, payrollTotal: payrollTotal,
    deposits: deposits, depositedTotal: depositedTotal,
    net: net,
  };
}

function getTrendPeriods(period, anchorDateStr) {
  const periods = [];
  if (period === 'daily') {
    const end = new Date(anchorDateStr + 'T00:00:00');
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end); d.setDate(d.getDate() - i);
      const ds = localDateStr(d);
      periods.push({ label: ds === TODAY() ? 'Today (' + ds + ')' : ds, from: ds, to: ds });
    }
  } else if (period === 'weekly') {
    const anchorRange = getReportRange('weekly', anchorDateStr);
    for (let i = 7; i >= 0; i--) {
      const monday = new Date(anchorRange.from + 'T00:00:00');
      monday.setDate(monday.getDate() - i * 7);
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      periods.push({ label: localDateStr(monday) + ' \u2192 ' + localDateStr(sunday), from: localDateStr(monday), to: localDateStr(sunday) });
    }
  } else if (period === 'monthly') {
    const anchor = new Date(anchorDateStr + 'T00:00:00');
    for (let i = 11; i >= 0; i--) {
      const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
      const range = getReportRange('monthly', localDateStr(d));
      periods.push({ label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), from: range.from, to: range.to });
    }
  } else if (period === 'yearly' || period === 'alltime') {
    const anchor = new Date(anchorDateStr + 'T00:00:00');
    for (let i = 4; i >= 0; i--) {
      const y = anchor.getFullYear() - i;
      periods.push({ label: String(y), from: y + '-01-01', to: y + '-12-31' });
    }
  }
  return periods;
}

let lastReportData = null;

function renderLetterhead(elementId, title, subtitle) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const contactLine = [state.hotel.address, state.hotel.phone, state.hotel.email].filter(Boolean).join(' · ');
  const regLine = [
    state.hotel.taxpayerNumber ? 'NIU: ' + state.hotel.taxpayerNumber : '',
    state.hotel.registrationNumber ? 'RC: ' + state.hotel.registrationNumber : '',
  ].filter(Boolean).join(' · ');
  el.innerHTML = `
    <h2>${escapeHtml(state.hotel.name)}</h2>
    <div class="ph-meta">${escapeHtml(contactLine)}</div>
    ${regLine ? `<div class="ph-meta">${escapeHtml(regLine)}</div>` : ''}
    <div class="ph-period">${escapeHtml(title)}${subtitle ? ' \u2014 ' + escapeHtml(subtitle) : ''}</div>
  `;
}

function renderReports() {
  const periodSelect = document.getElementById('report-period');
  const dateInput = document.getElementById('report-date');
  if (!dateInput.value) dateInput.value = TODAY();
  const period = periodSelect.value;
  dateInput.classList.toggle('hidden', period === 'alltime');
  document.getElementById('btn-report-today').classList.toggle('hidden', period === 'alltime');

  const anchorDateStr = dateInput.value;
  const range = getReportRange(period, anchorDateStr);
  const data = reportDataForRange(range.from, range.to);
  lastReportData = data;

  const rangeLabelEl = document.getElementById('report-range-label');
  let rangeText;
  if (period === 'alltime') {
    rangeText = 'everything on record, up to today';
  } else if (range.from === range.to) {
    rangeText = range.from;
  } else {
    rangeText = range.from + ' \u2192 ' + range.to;
  }
  rangeLabelEl.textContent = 'Showing ' + rangeText + '.';
  renderLetterhead('reports-print-header', 'Sales & spending report', rangeText);

  document.getElementById('rpt-revenue').textContent = formatMoney(data.revenue);
  document.getElementById('rpt-expenses').textContent = formatMoney(data.expensesTotal);
  document.getElementById('rpt-payroll').textContent = formatMoney(data.payrollTotal);
  document.getElementById('rpt-net').textContent = formatMoney(data.net);
  document.getElementById('rpt-payment-count').textContent = data.payments.length;
  document.getElementById('rpt-checkins').textContent = data.checkins.length;
  document.getElementById('rpt-checkouts').textContent = data.checkouts.length;
  document.getElementById('rpt-deposited').textContent = formatMoney(data.depositedTotal);

  const methodBody = document.querySelector('#table-report-methods tbody');
  methodBody.innerHTML = '';
  const methods = Object.keys(data.byMethod);
  if (!methods.length) {
    methodBody.innerHTML = `<tr class="muted-row"><td colspan="3">No payments recorded in this period.</td></tr>`;
  } else {
    methods.sort((a, b) => data.byMethod[b].amount - data.byMethod[a].amount).forEach(m => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(m)}</td><td>${data.byMethod[m].count}</td><td>${formatMoney(data.byMethod[m].amount)}</td>`;
      methodBody.appendChild(tr);
    });
  }

  const occBody = document.querySelector('#table-report-occupancy tbody');
  occBody.innerHTML = '';
  if (!data.occupied.length) {
    occBody.innerHTML = `<tr class="muted-row"><td colspan="3">No rooms occupied in this period.</td></tr>`;
  } else {
    const occList = data.occupied.slice().sort((a, b) => {
      const ra = getRoom(a.roomId), rb = getRoom(b.roomId);
      return (ra ? ra.number : '').localeCompare(rb ? rb.number : '', undefined, { numeric: true });
    });
    const capped = occList.slice(0, 200);
    capped.forEach(b => {
      const r = getRoom(b.roomId), g = getGuest(b.guestId);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml((r && r.number) || '—')}</td><td>${escapeHtml((g && g.name) || '—')}</td><td>${escapeHtml(stayDurationLabel(b))}</td>`;
      occBody.appendChild(tr);
    });
    if (occList.length > 200) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="3" class="hint-text">+ ${occList.length - 200} more not shown \u2014 export CSV for the full list.</td>`;
      occBody.appendChild(tr);
    }
  }

  const expBody = document.querySelector('#table-report-expenses tbody');
  expBody.innerHTML = '';
  if (!data.expenses.length) {
    expBody.innerHTML = `<tr class="muted-row"><td colspan="4">No expenses in this period.</td></tr>`;
  } else {
    data.expenses.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(ex => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${ex.date}</td><td>${escapeHtml(ex.description)}</td><td>${escapeHtml(ex.category)}</td><td>${formatMoney(ex.amount)}</td>`;
      expBody.appendChild(tr);
    });
  }

  const salBody = document.querySelector('#table-report-salary tbody');
  salBody.innerHTML = '';
  if (!data.salaryPayments.length) {
    salBody.innerHTML = `<tr class="muted-row"><td colspan="4">No salary payments in this period.</td></tr>`;
  } else {
    data.salaryPayments.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(p => {
      const e = getEmployee(p.employeeId);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.date}</td><td>${escapeHtml(e ? e.name : '—')}</td><td>${escapeHtml(p.month)}</td><td>${formatMoney(p.amountPaid)}</td>`;
      salBody.appendChild(tr);
    });
  }

  const payBody = document.querySelector('#table-report-payments tbody');
  payBody.innerHTML = '';
  if (!data.payments.length) {
    payBody.innerHTML = `<tr class="muted-row"><td colspan="5">No payments recorded in this period.</td></tr>`;
  } else {
    data.payments.forEach(x => {
      const r = x.booking ? getRoom(x.booking.roomId) : null;
      const g = x.booking ? getGuest(x.booking.guestId) : null;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(x.invoice.number)}</td><td>${escapeHtml((g && g.name) || '—')}</td><td>${escapeHtml((r && r.number) || '—')}</td><td>${escapeHtml(x.payment.method)}</td><td>${formatMoney(x.payment.amount)}</td>`;
      payBody.appendChild(tr);
    });
  }

  const trendTitles = { daily: 'Last 7 days', weekly: 'Last 8 weeks', monthly: 'Last 12 months', yearly: 'Last 5 years', alltime: 'Last 5 years' };
  document.getElementById('report-trend-title').textContent = trendTitles[period] || 'Trend';
  const trendBody = document.querySelector('#table-report-trend tbody');
  trendBody.innerHTML = '';
  getTrendPeriods(period, anchorDateStr).forEach(p => {
    const dd = reportDataForRange(p.from, p.to);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(p.label)}</td><td>${formatMoney(dd.revenue)}</td><td>${formatMoney(dd.expensesTotal)}</td><td>${formatMoney(dd.payrollTotal)}</td><td>${formatMoney(dd.net)}</td>`;
    trendBody.appendChild(tr);
  });
}

/* ============================================================
   PAYROLL — staff directory (salaried employees) and salary payments.
   This roster is separate from Settings → Staff accounts: that one
   controls who can sign in to this app, this one is who gets paid —
   a hotel's cleaners, cooks and security guards usually need the
   second without the first.
   ============================================================ */
function getEmployee(id) { return state.employees.find(e => e.id === id); }

function renderPayroll() {
  const active = state.employees.filter(e => e.status !== 'left');
  const monthlyTotal = active.reduce((s, e) => s + (Number(e.monthlySalary) || 0), 0);
  const paidAllTime = state.salaryPayments.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0);

  document.getElementById('pr-active-count').textContent = active.length;
  document.getElementById('pr-monthly-total').textContent = formatMoney(monthlyTotal);
  document.getElementById('pr-paid-alltime').textContent = formatMoney(paidAllTime);

  const body = document.querySelector('#table-employees tbody');
  body.innerHTML = '';
  if (!state.employees.length) {
    body.innerHTML = `<tr class="muted-row"><td colspan="6">No employees added yet.</td></tr>`;
  } else {
    state.employees.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
      const tr = document.createElement('tr');
      const left = e.status === 'left';
      tr.innerHTML = `<td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.role)}</td><td>${escapeHtml(e.phone || '—')}</td>
        <td>${formatMoney(e.monthlySalary)}</td>
        <td><span class="badge ${left ? 'badge-cancelled' : 'badge-checked-in'}">${left ? 'Left' : 'Active'}</span></td>
        <td><button class="link-btn" data-pay-salary="${e.id}">Pay salary</button>
          <button class="link-btn" data-edit-employee="${e.id}">Edit</button></td>`;
      body.appendChild(tr);
    });
  }
  body.querySelectorAll('[data-pay-salary]').forEach(btn => btn.onclick = () => openSalaryPayModal(btn.dataset.paySalary));
  body.querySelectorAll('[data-edit-employee]').forEach(btn => btn.onclick = () => openEmployeeModal(btn.dataset.editEmployee));

  const payBody = document.querySelector('#table-salary-payments tbody');
  payBody.innerHTML = '';
  const recent = state.salaryPayments.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  if (!recent.length) {
    payBody.innerHTML = `<tr class="muted-row"><td colspan="6">No salary payments recorded yet.</td></tr>`;
  } else {
    recent.forEach(p => {
      const e = getEmployee(p.employeeId);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(e ? e.name : '—')}</td><td>${escapeHtml(p.month)}</td>
        <td>${formatMoney(p.amountDue)}</td><td>${formatMoney(p.amountPaid)}</td>
        <td>${escapeHtml(p.method)}</td><td>${p.date}</td>`;
      payBody.appendChild(tr);
    });
  }
}

function openEmployeeModal(employeeId) {
  const e = employeeId ? getEmployee(employeeId) : null;
  document.getElementById('employee-modal-title').textContent = e ? 'Edit employee' : 'Add employee';
  document.getElementById('em-id').value = e ? e.id : '';
  document.getElementById('em-name').value = e ? e.name : '';
  document.getElementById('em-role').value = e ? e.role : '';
  document.getElementById('em-phone').value = e ? (e.phone || '') : '';
  document.getElementById('em-salary').value = e ? e.monthlySalary : '';
  document.getElementById('em-status-label').classList.toggle('hidden', !e);
  if (e) document.getElementById('em-status').value = e.status || 'active';
  document.getElementById('em-error').textContent = '';
  document.getElementById('modal-employee').classList.remove('hidden');
}
document.getElementById('form-employee').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('em-error');
  errEl.textContent = '';
  const id = document.getElementById('em-id').value || null;
  const name = document.getElementById('em-name').value.trim();
  const role = document.getElementById('em-role').value.trim();
  const phone = document.getElementById('em-phone').value.trim();
  const monthlySalary = Number(document.getElementById('em-salary').value) || 0;
  if (!name || !role) { errEl.textContent = 'Name and role are required.'; return; }

  if (id) {
    const emp = getEmployee(id);
    emp.name = name; emp.role = role; emp.phone = phone; emp.monthlySalary = monthlySalary;
    emp.status = document.getElementById('em-status').value;
    touch(emp);
  } else {
    state.employees.push(touch({ id: uid(), name, role, phone, monthlySalary, status: 'active', dateJoined: TODAY() }));
  }
  saveState();
  document.getElementById('modal-employee').classList.add('hidden');
  renderPayroll();
  toast('Employee saved.');
});

function openSalaryPayModal(employeeId) {
  const e = getEmployee(employeeId);
  if (!e) return;
  const now = new Date();
  const defaultMonth = now.toLocaleString('en-US', { month: 'long' }) + ' ' + now.getFullYear();
  document.getElementById('salary-modal-title').textContent = 'Pay salary — ' + e.name;
  document.getElementById('sp-employee-id').value = e.id;
  document.getElementById('sp-month').value = defaultMonth;
  document.getElementById('sp-due').value = e.monthlySalary;
  document.getElementById('sp-paid').value = e.monthlySalary;
  document.getElementById('sp-date').value = TODAY();
  document.getElementById('sp-error').textContent = '';
  document.getElementById('modal-salary-pay').classList.remove('hidden');
}
document.getElementById('form-salary-pay').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('sp-error');
  errEl.textContent = '';
  const employeeId = document.getElementById('sp-employee-id').value;
  const month = document.getElementById('sp-month').value.trim();
  const amountDue = Number(document.getElementById('sp-due').value) || 0;
  const amountPaid = Number(document.getElementById('sp-paid').value) || 0;
  const date = document.getElementById('sp-date').value || TODAY();
  const method = document.getElementById('sp-method').value;
  const note = document.getElementById('sp-note').value.trim();
  if (!month || amountPaid <= 0) { errEl.textContent = 'Enter a month and a valid amount paid.'; return; }

  state.salaryPayments.push(touch({
    id: uid(), employeeId, month, amountDue, amountPaid, date, method, note,
  }));
  saveState();
  document.getElementById('modal-salary-pay').classList.add('hidden');
  renderPayroll();
  toast('Salary payment recorded.');
});

/* ============================================================
   SPENDING — general hotel expenses (utilities, maintenance,
   supplies, etc.), separate from payroll.
   ============================================================ */
function renderSpending() {
  renderLetterhead('spending-print-header', 'Spending report', 'as of ' + TODAY());
  const total = state.expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const monthPrefix = TODAY().slice(0, 7);
  const monthTotal = state.expenses
    .filter(e => e.date.slice(0, 7) === monthPrefix)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const depositedTotal = (state.deposits || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);

  document.getElementById('sp-total').textContent = formatMoney(total);
  document.getElementById('sp-count').textContent = state.expenses.length;
  document.getElementById('sp-month-total').textContent = formatMoney(monthTotal);
  document.getElementById('sp-deposited-total').textContent = formatMoney(depositedTotal);

  const catSelect = document.getElementById('expense-filter-category');
  const currentFilterVal = catSelect.value;
  catSelect.innerHTML = '<option value="">All categories</option>' +
    state.expenseCategories.map(c => `<option${c === currentFilterVal ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');

  renderExpenseTable();
  renderDepositsTable();
}

function renderDepositsTable() {
  const body = document.querySelector('#table-deposits tbody');
  body.innerHTML = '';
  const list = (state.deposits || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) {
    body.innerHTML = `<tr class="muted-row"><td colspan="6">No deposits recorded yet.</td></tr>`;
    return;
  }
  const canDelete = currentStaffInfo && currentStaffInfo.role === 'admin';
  list.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d.date}</td><td>${escapeHtml(d.destination || '—')}</td><td>${escapeHtml(d.method)}</td>
      <td>${escapeHtml(d.note || '—')}</td><td>${formatMoney(d.amount)}</td>
      <td>${canDelete ? `<button class="icon-btn" data-del-deposit="${d.id}">Remove</button>` : ''}</td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-del-deposit]').forEach(btn => btn.onclick = () => deleteDeposit(btn.dataset.delDeposit));
}

function openDepositModal() {
  document.getElementById('dp-amount').value = '';
  document.getElementById('dp-date').value = TODAY();
  document.getElementById('dp-destination').value = '';
  document.getElementById('dp-note').value = '';
  document.getElementById('dp-error').textContent = '';
  document.getElementById('modal-deposit').classList.remove('hidden');
}
document.getElementById('form-deposit').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('dp-error');
  errEl.textContent = '';
  const amount = Number(document.getElementById('dp-amount').value);
  const date = document.getElementById('dp-date').value || TODAY();
  const method = document.getElementById('dp-method').value;
  const destination = document.getElementById('dp-destination').value.trim();
  const note = document.getElementById('dp-note').value.trim();
  if (!amount || amount <= 0) { errEl.textContent = 'Enter a valid amount.'; return; }

  state.deposits = state.deposits || [];
  state.deposits.push(touch({ id: uid(), date, amount, method, destination, note }));
  saveState();
  document.getElementById('modal-deposit').classList.add('hidden');
  renderSpending();
  toast('Deposit recorded.');
});
function deleteDeposit(id) {
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') { toast('Only an admin can remove a deposit record.'); return; }
  if (!confirm('Delete this deposit record? This cannot be undone.')) return;
  state.deposits = (state.deposits || []).filter(d => d.id !== id);
  saveState();
  renderDepositsTable();
  renderSpending();
  toast('Deposit removed.');
}

function renderExpenseTable() {
  const search = (document.getElementById('expense-search').value || '').toLowerCase();
  const category = document.getElementById('expense-filter-category').value;
  const range = getPeriodFilterRange('expense-filter-period', 'expense-filter-date');
  const body = document.querySelector('#table-expenses tbody');
  body.innerHTML = '';

  let list = state.expenses.slice().sort((a, b) => b.date.localeCompare(a.date));
  if (category) list = list.filter(e => e.category === category);
  if (range) list = list.filter(e => e.date >= range.from && e.date <= range.to);
  if (search) {
    list = list.filter(e =>
      e.description.toLowerCase().includes(search) || (e.vendor || '').toLowerCase().includes(search)
    );
  }

  if (!list.length) {
    body.innerHTML = `<tr class="muted-row"><td colspan="7">No expenses match your filters.</td></tr>`;
    return;
  }
  const canDelete = currentStaffInfo && currentStaffInfo.role === 'admin';
  list.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.date}</td><td>${escapeHtml(e.description)}</td>
      <td><span class="badge badge-reserved">${escapeHtml(e.category)}</span></td>
      <td>${escapeHtml(e.vendor || '—')}</td><td>${escapeHtml(e.method)}</td>
      <td>${formatMoney(e.amount)}</td>
      <td><button class="link-btn" data-view-expense="${e.id}">View</button>${canDelete ? `<button class="icon-btn" data-del-expense="${e.id}">Remove</button>` : ''}</td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-view-expense]').forEach(btn => btn.onclick = () => openExpenseView(btn.dataset.viewExpense));
  body.querySelectorAll('[data-del-expense]').forEach(btn => btn.onclick = () => deleteExpense(btn.dataset.delExpense));
}

function expenseNumber(ex) {
  // A short, stable reference derived from the record's id — not a
  // sequential counter like invoices, since expenses can be entered
  // out of order, but still gives staff something to cite on paper.
  return 'EXP-' + ex.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
}

function openExpenseView(expenseId) {
  const ex = state.expenses.find(e => e.id === expenseId);
  if (!ex) return;
  const contactLine = [state.hotel.address, state.hotel.phone, state.hotel.email].filter(Boolean).join(' · ');
  const regLine = [
    state.hotel.taxpayerNumber ? 'NIU: ' + state.hotel.taxpayerNumber : '',
    state.hotel.registrationNumber ? 'RC: ' + state.hotel.registrationNumber : '',
  ].filter(Boolean).join(' · ');
  document.getElementById('expense-view-content').innerHTML = `
    <div class="invoice">
      <div class="invoice-head">
        <div>
          <h2>${escapeHtml(state.hotel.name)}</h2>
          <div style="font-size:12.5px;color:var(--muted)">${escapeHtml(contactLine)}</div>
          ${regLine ? `<div style="font-size:11px;color:var(--muted)">${escapeHtml(regLine)}</div>` : ''}
        </div>
        <div class="inv-meta">
          Expense ${expenseNumber(ex)}<br>
          Dated ${ex.date}
        </div>
      </div>
      <table>
        <thead><tr><th>Field</th><th>Detail</th></tr></thead>
        <tbody>
          <tr><td class="desc">Description</td><td>${escapeHtml(ex.description)}</td></tr>
          <tr><td class="desc">Category</td><td>${escapeHtml(ex.category)}</td></tr>
          <tr><td class="desc">Vendor / payee</td><td>${escapeHtml(ex.vendor || '—')}</td></tr>
          <tr><td class="desc">Payment method</td><td>${escapeHtml(ex.method)}</td></tr>
          ${ex.recordedBy ? `<tr><td class="desc">Recorded by</td><td>${escapeHtml(ex.recordedBy)}</td></tr>` : ''}
        </tbody>
      </table>
      <div class="totals">
        <div class="grand"><span>Amount</span><span>${formatMoney(ex.amount)}</span></div>
      </div>
    </div>
  `;
  document.getElementById('modal-expense-view').classList.remove('hidden');
}
document.getElementById('btn-print-expense').addEventListener('click', () => window.print());

function openExpenseModal() {
  const catSelect = document.getElementById('ex-category');
  catSelect.innerHTML = state.expenseCategories.map(c => `<option>${escapeHtml(c)}</option>`).join('');
  document.getElementById('ex-desc').value = '';
  document.getElementById('ex-amount').value = '';
  document.getElementById('ex-date').value = TODAY();
  document.getElementById('ex-vendor').value = '';
  document.getElementById('ex-error').textContent = '';
  document.getElementById('modal-expense').classList.remove('hidden');
}
document.getElementById('form-expense').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('ex-error');
  errEl.textContent = '';
  const description = document.getElementById('ex-desc').value.trim();
  const category = document.getElementById('ex-category').value;
  const amount = Number(document.getElementById('ex-amount').value);
  const date = document.getElementById('ex-date').value || TODAY();
  const method = document.getElementById('ex-method').value;
  const vendor = document.getElementById('ex-vendor').value.trim();
  if (!description || !amount || amount <= 0) { errEl.textContent = 'Enter a description and a valid amount.'; return; }

  const recordedBy = currentStaffInfo ? currentStaffInfo.name : '';
  state.expenses.push(touch({ id: uid(), date, category, description, amount, method, vendor, recordedBy }));
  saveState();
  document.getElementById('modal-expense').classList.add('hidden');
  renderSpending();
  toast('Expense recorded.');
});
function deleteExpense(id) {
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') { toast('Only an admin can remove an expense record.'); return; }
  if (!confirm('Delete this expense record? This cannot be undone.')) return;
  state.expenses = state.expenses.filter(e => e.id !== id);
  saveState();
  renderExpenseTable();
  renderSpending();
  toast('Expense removed.');
}

function refreshRoomSelect(selectedRoomId, checkIn, checkOut, excludeBookingId, stayType) {
  const sel = document.getElementById('bk-room');
  sel.innerHTML = '';
  state.rooms.slice().sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
    .forEach(r => {
      const t = getType(r.typeId);
      if (stayType && stayType !== 'nightly') {
        const field = STAY_RATE_FIELD[stayType];
        if (!t || !(Number(t[field]) > 0)) return; // this type doesn't offer that short-stay option
      }
      const available = checkIn && checkOut ? isRoomAvailable(r.id, checkIn, checkOut, excludeBookingId) : (r.status !== 'maintenance');
      if (!available && r.id !== selectedRoomId) return; // hide unavailable rooms
      const rate = stayType && stayType !== 'nightly' ? t[STAY_RATE_FIELD[stayType]] : (t ? t.rate : 0);
      const rateLabel = stayType && stayType !== 'nightly' ? STAY_LABELS[stayType] : 'night';
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.number} — ${t ? t.name : ''} (${formatMoney(rate)}/${rateLabel})`;
      sel.appendChild(opt);
    });
  if (selectedRoomId) sel.value = selectedRoomId;
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  if (!sel.options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No rooms available for this stay type / time';
    sel.appendChild(opt);
  }
}

function applyStayTypeUI(stayType) {
  const coInput = document.getElementById('bk-checkout');
  const coLabel = document.getElementById('bk-checkout-label');
  if (stayType && stayType !== 'nightly') {
    coInput.readOnly = true;
    coInput.classList.add('readonly-field');
    coLabel.firstChild.textContent = 'Check-out (auto)';
  } else {
    coInput.readOnly = false;
    coInput.classList.remove('readonly-field');
    coLabel.firstChild.textContent = 'Check-out';
  }
}

function openBookingModal(bookingId) {
  const modal = document.getElementById('modal-booking');
  const form = document.getElementById('form-booking');
  form.reset();
  document.getElementById('bk-error').textContent = '';
  const b = bookingId ? getBooking(bookingId) : null;
  document.getElementById('booking-modal-title').textContent = b ? 'Edit booking' : 'New booking';
  document.getElementById('bk-id').value = b ? b.id : '';

  if (b) {
    const g = getGuest(b.guestId);
    document.getElementById('bk-guest-name').value = (g && g.name) || '';
    document.getElementById('bk-guest-phone').value = (g && g.phone) || '';
    document.getElementById('bk-guest-idnum').value = (g && g.idNumber) || '';
    const stayType = b.stayType || 'nightly';
    document.getElementById('bk-stay-type').value = stayType;
    document.getElementById('bk-checkin').value = b.checkIn;
    document.getElementById('bk-checkout').value = b.checkOut;
    document.getElementById('bk-guests').value = b.guests || 1;
    document.getElementById('bk-notes').value = b.notes || '';
    applyStayTypeUI(stayType);
    refreshRoomSelect(b.roomId, b.checkIn, b.checkOut, b.id, stayType);
  } else {
    const checkIn = nowLocal();
    document.getElementById('bk-stay-type').value = 'nightly';
    document.getElementById('bk-checkin').value = checkIn;
    const tomorrow = new Date(Date.now() + 86400000);
    document.getElementById('bk-checkout').value = toLocalInput(tomorrow);
    applyStayTypeUI('nightly');
    refreshRoomSelect(null, checkIn, document.getElementById('bk-checkout').value, null, 'nightly');
  }
  modal.classList.remove('hidden');
}

document.getElementById('bk-checkin').addEventListener('change', updateBookingRoomOptions);
document.getElementById('bk-checkout').addEventListener('change', updateBookingRoomOptions);
document.getElementById('bk-stay-type').addEventListener('change', (e) => {
  applyStayTypeUI(e.target.value);
  updateBookingRoomOptions();
});
function updateBookingRoomOptions() {
  const stayType = document.getElementById('bk-stay-type').value;
  const ci = document.getElementById('bk-checkin').value;
  let co = document.getElementById('bk-checkout').value;
  if (stayType !== 'nightly' && ci) {
    co = computeShortStayCheckout(ci, stayType);
    document.getElementById('bk-checkout').value = co;
  }
  const bkId = document.getElementById('bk-id').value || null;
  const current = document.getElementById('bk-room').value;
  if (ci && co) refreshRoomSelect(current, ci, co, bkId, stayType);
}

document.getElementById('form-booking').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('bk-error');
  errEl.textContent = '';

  const id = document.getElementById('bk-id').value || null;
  const name = document.getElementById('bk-guest-name').value.trim();
  const phone = document.getElementById('bk-guest-phone').value.trim();
  const idnum = document.getElementById('bk-guest-idnum').value.trim();
  const roomId = document.getElementById('bk-room').value;
  const stayType = document.getElementById('bk-stay-type').value;
  const checkIn = document.getElementById('bk-checkin').value;
  let checkOut = document.getElementById('bk-checkout').value;
  const guestsCount = Number(document.getElementById('bk-guests').value) || 1;
  const notes = document.getElementById('bk-notes').value.trim();

  if (stayType !== 'nightly') checkOut = computeShortStayCheckout(checkIn, stayType);

  if (checkOut <= checkIn) { errEl.textContent = 'Check-out must be after check-in.'; return; }
  if (!roomId) { errEl.textContent = 'No room selected for this stay type.'; return; }
  const room = getRoom(roomId);
  const type = room ? getType(room.typeId) : null;
  if (stayType !== 'nightly' && !(Number((type && type[STAY_RATE_FIELD[stayType]])) > 0)) {
    errEl.textContent = 'This room\u2019s type doesn\u2019t have a rate set for that stay length.';
    return;
  }
  if (!isRoomAvailable(roomId, checkIn, checkOut, id)) {
    errEl.textContent = 'This room is not available for the selected time.';
    return;
  }

  // find or create guest by phone
  let guest = state.guests.find(g => g.phone === phone && phone);
  if (!guest) {
    guest = touch({ id: uid(), name, phone, idNumber: idnum });
    state.guests.push(guest);
  } else {
    guest.name = name;
    guest.idNumber = idnum || guest.idNumber;
    touch(guest);
  }

  if (id) {
    const b = getBooking(id);
    b.guestId = guest.id;
    b.roomId = roomId;
    b.stayType = stayType;
    b.checkIn = checkIn;
    b.checkOut = checkOut;
    b.guests = guestsCount;
    b.notes = notes;
    touch(b);
  } else {
    state.bookings.push(touch({
      id: uid(), guestId: guest.id, roomId, stayType, checkIn, checkOut,
      guests: guestsCount, notes, status: 'reserved',
    }));
  }

  saveState();
  document.getElementById('modal-booking').classList.add('hidden');
  renderAll();
  toast('Booking saved.');
});

/* ============================================================
   MODALS: ROOM
   ============================================================ */
function refreshRoomTypeSelect() {
  const sel = document.getElementById('rm-type');
  const current = sel.value;
  sel.innerHTML = '';
  state.roomTypes.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.name} (${formatMoney(t.rate)})`;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}
function openRoomModal(roomId) {
  refreshRoomTypeSelect();
  const r = roomId ? getRoom(roomId) : null;
  document.getElementById('room-modal-title').textContent = r ? 'Edit room' : 'Add room';
  document.getElementById('rm-id').value = r ? r.id : '';
  document.getElementById('rm-number').value = r ? r.number : '';
  document.getElementById('rm-status').value = r ? r.status : 'available';
  if (r) document.getElementById('rm-type').value = r.typeId;
  document.getElementById('modal-room').classList.remove('hidden');
}
document.getElementById('form-room').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = document.getElementById('rm-id').value || null;
  const number = document.getElementById('rm-number').value.trim();
  const typeId = document.getElementById('rm-type').value;
  const status = document.getElementById('rm-status').value;
  if (!number) return;

  const dup = state.rooms.find(r => r.number === number && r.id !== id);
  if (dup) { toast('A room with that number already exists.'); return; }

  if (id) {
    const r = getRoom(id);
    r.number = number; r.typeId = typeId; r.status = status;
    touch(r);
  } else {
    state.rooms.push(touch({ id: uid(), number, typeId, status }));
  }
  saveState();
  document.getElementById('modal-room').classList.add('hidden');
  renderAll();
  toast('Room saved.');
});

/* ============================================================
   MODALS: ROOM TYPE
   ============================================================ */
function openTypeModal(typeId) {
  const t = typeId ? getType(typeId) : null;
  document.getElementById('type-modal-title').textContent = t ? 'Edit room type' : 'Add room type';
  document.getElementById('tp-id').value = t ? t.id : '';
  document.getElementById('tp-name').value = t ? t.name : '';
  document.getElementById('tp-rate').value = t ? t.rate : '';
  document.getElementById('tp-rate-1h').value = t && t.rate1h ? t.rate1h : '';
  document.getElementById('tp-rate-3h').value = t && t.rate3h ? t.rate3h : '';
  document.getElementById('tp-rate-night').value = t && t.rateNight ? t.rateNight : '';
  document.getElementById('tp-capacity').value = t ? t.capacity : '';
  document.getElementById('modal-type').classList.remove('hidden');
}
document.getElementById('form-type').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = document.getElementById('tp-id').value || null;
  const name = document.getElementById('tp-name').value.trim();
  const rate = Number(document.getElementById('tp-rate').value) || 0;
  const rate1h = Number(document.getElementById('tp-rate-1h').value) || 0;
  const rate3h = Number(document.getElementById('tp-rate-3h').value) || 0;
  const rateNight = Number(document.getElementById('tp-rate-night').value) || 0;
  const capacity = Number(document.getElementById('tp-capacity').value) || 1;
  if (!name) return;
  if (id) {
    const t = getType(id);
    t.name = name; t.rate = rate; t.rate1h = rate1h; t.rate3h = rate3h; t.rateNight = rateNight; t.capacity = capacity;
    touch(t);
  } else {
    state.roomTypes.push(touch({ id: uid(), name, rate, rate1h, rate3h, rateNight, capacity }));
  }
  saveState();
  document.getElementById('modal-type').classList.add('hidden');
  renderRooms();
  toast('Room type saved.');
});

/* ============================================================
   MODAL: INVOICE
   ============================================================ */
let currentInvoiceId = null;

function openInvoiceForBooking(bookingId) {
  const inv = ensureInvoiceForBooking(bookingId);
  openInvoiceModal(inv.id);
}
function openInvoiceModal(invoiceId) {
  currentInvoiceId = invoiceId;
  renderInvoiceContent();
  document.getElementById('modal-invoice').classList.remove('hidden');
}
function renderInvoiceContent() {
  const inv = state.invoices.find(i => i.id === currentInvoiceId);
  if (!inv) return;
  const booking = getBooking(inv.bookingId);
  const guest = booking ? getGuest(booking.guestId) : null;
  const room = booking ? getRoom(booking.roomId) : null;
  const type = room ? getType(room.typeId) : null;
  const durationLabel = booking ? stayDurationLabel(booking) : '';
  const roomCharge = booking ? billableTotal(booking) : 0;

  let rows = '';
  if (booking) {
    rows += `<tr><td class="desc">${escapeHtml(type ? type.name : 'Room')} — Room ${escapeHtml((room && room.number) || '')} \u2014 ${escapeHtml(durationLabel)}</td><td>${formatMoney(roomCharge)}</td></tr>`;
  }
  (inv.charges || []).forEach((c, i) => {
    rows += `<tr><td class="desc">${escapeHtml(c.desc)} <button class="icon-btn no-print" data-del-charge="${i}">✕</button></td><td>${formatMoney(c.amount)}</td></tr>`;
  });

  const subtotal = invoiceSubtotal(inv);
  const discountAmount = invoiceDiscountAmount(inv);
  const tax = invoiceTax(inv);
  const total = invoiceTotal(inv);
  const paid = invoicePaid(inv);
  const balance = invoiceBalance(inv);

  let paymentsHtml = '';
  if ((inv.payments || []).length) {
    paymentsHtml = '<div class="payments"><strong>Payments:</strong><br>' +
      inv.payments.map(p => `${p.date} — ${formatMoney(p.amount)} (${escapeHtml(p.method)})`).join('<br>') +
      '</div>';
  }

  let discountLineHtml = '';
  if (discountAmount > 0) {
    const d = inv.discount;
    const label = d.type === 'flat' ? 'Discount' : `Discount (${d.value}%)`;
    discountLineHtml = `<div class="discount-line"><span>${escapeHtml(label)}${d.note ? ' \u2014 ' + escapeHtml(d.note) : ''}</span><span>\u2212${formatMoney(discountAmount)}</span></div>`;
  }

  const voided = !!inv.voided;
  const voidStampHtml = voided ? `
    <div style="border:2px solid var(--occupied);color:var(--occupied);display:inline-block;padding:4px 14px;font-weight:700;letter-spacing:2px;transform:rotate(-4deg);margin-bottom:10px;">VOID</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Voided ${inv.voidedAt ? escapeHtml(localDateStr(new Date(inv.voidedAt))) : ''} by ${escapeHtml(inv.voidedBy || '—')} \u2014 ${escapeHtml(inv.voidReason || '')}</div>
  ` : '';

  document.getElementById('invoice-content').innerHTML = `
    <div class="invoice">
      ${voidStampHtml}
      <div class="invoice-head">
        <div>
          <h2>${escapeHtml(state.hotel.name)}</h2>
          <div style="font-size:12.5px;color:var(--muted)">${escapeHtml(state.hotel.address || '')}${state.hotel.phone ? ' · ' + escapeHtml(state.hotel.phone) : ''}${state.hotel.email ? ' · ' + escapeHtml(state.hotel.email) : ''}</div>
          <div style="font-size:11px;color:var(--muted)">${state.hotel.taxpayerNumber ? 'NIU: ' + escapeHtml(state.hotel.taxpayerNumber) : ''}${state.hotel.taxpayerNumber && state.hotel.registrationNumber ? ' · ' : ''}${state.hotel.registrationNumber ? 'RC: ' + escapeHtml(state.hotel.registrationNumber) : ''}</div>
        </div>
        <div class="inv-meta">
          Invoice ${inv.number}<br>
          Issued ${inv.createdAt}
        </div>
      </div>
      <div class="invoice-parties">
        <div><strong>Billed to</strong>${escapeHtml((guest && guest.name) || '—')}<br>${escapeHtml((guest && guest.phone) || '')}</div>
        <div style="text-align:right"><strong>Stay</strong>${booking ? formatDateTime(booking.checkIn) + ' \u2192 ' + formatDateTime(booking.checkOut) : '—'}</div>
      </div>
      <table>
        <thead><tr><th>Description</th><th>Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><span>${formatMoney(subtotal)}</span></div>
        ${discountLineHtml}
        <div><span>Tax (${inv.taxRate != null ? inv.taxRate : state.hotel.taxRate}%)</span><span>${formatMoney(tax)}</span></div>
        <div class="grand"><span>Total</span><span>${formatMoney(total)}</span></div>
        <div><span>Paid</span><span>${formatMoney(paid)}</span></div>
        <div><span>Balance due</span><span>${formatMoney(balance)}</span></div>
      </div>
      ${paymentsHtml}
    </div>
  `;

  const isAdmin = currentStaffInfo && currentStaffInfo.role === 'admin';
  const canDiscount = currentStaffInfo && (currentStaffInfo.role === 'admin' || currentStaffInfo.role === 'assistant');
  document.getElementById('discount-section').classList.toggle('hidden', !canDiscount || voided);
  if (canDiscount && !voided) {
    const d = inv.discount;
    document.getElementById('disc-value').value = d ? Math.round(discountAmount) : '';
    document.getElementById('disc-note').value = d ? (d.note || '') : '';
    document.getElementById('disc-error').textContent = '';
    document.getElementById('form-discount').querySelector('button[type=submit]').textContent = d ? 'Update' : 'Apply';
    document.getElementById('btn-remove-discount').classList.toggle('hidden', !d || !isAdmin);
  }

  document.getElementById('section-add-charge').classList.toggle('hidden', voided);
  document.getElementById('section-record-payment').classList.toggle('hidden', voided);
  const voidBanner = document.getElementById('void-banner');
  if (voided) {
    voidBanner.style.display = '';
    voidBanner.textContent = `This invoice was voided${inv.voidedBy ? ' by ' + inv.voidedBy : ''}${inv.voidedAt ? ' on ' + localDateStr(new Date(inv.voidedAt)) : ''}${inv.voidReason ? ': ' + inv.voidReason : ''}. Its payments no longer count in revenue reports.`;
  } else {
    voidBanner.style.display = 'none';
  }
  document.getElementById('void-section').classList.toggle('hidden', !isAdmin || voided);
  document.getElementById('void-reason').value = '';
  document.getElementById('void-error').textContent = '';

  document.querySelectorAll('[data-del-charge]').forEach(btn => {
    btn.onclick = () => {
      inv.charges.splice(Number(btn.dataset.delCharge), 1);
      saveState();
      renderInvoiceContent();
      renderInvoices();
    };
  });
}

document.getElementById('form-charge').addEventListener('submit', (e) => {
  e.preventDefault();
  const inv = state.invoices.find(i => i.id === currentInvoiceId);
  if (!inv) return;
  const desc = document.getElementById('ch-desc').value.trim();
  const amount = Number(document.getElementById('ch-amount').value) || 0;
  if (!desc || amount <= 0) return;
  inv.charges = inv.charges || [];
  inv.charges.push(touch({ id: uid(), desc, amount }));
  saveState();
  e.target.reset();
  renderInvoiceContent();
  renderInvoices();
});

document.getElementById('form-payment').addEventListener('submit', (e) => {
  e.preventDefault();
  const inv = state.invoices.find(i => i.id === currentInvoiceId);
  if (!inv) return;
  const amount = Number(document.getElementById('pay-amount').value) || 0;
  const method = document.getElementById('pay-method').value;
  if (amount <= 0) return;
  inv.payments = inv.payments || [];
  inv.payments.push(touch({ id: uid(), amount, method, date: TODAY() }));
  saveState();
  e.target.reset();
  renderInvoiceContent();
  renderInvoices();
  renderDashboard();
  toast('Payment recorded.');
});

document.getElementById('form-discount').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('disc-error');
  errEl.textContent = '';
  if (!currentStaffInfo || (currentStaffInfo.role !== 'admin' && currentStaffInfo.role !== 'assistant')) { errEl.textContent = 'Only an admin or assistant manager can apply a discount.'; return; }
  const inv = state.invoices.find(i => i.id === currentInvoiceId);
  if (!inv) return;
  const value = Number(document.getElementById('disc-value').value);
  const note = document.getElementById('disc-note').value.trim();
  if (!(value > 0)) { errEl.textContent = 'Enter a discount amount greater than 0.'; return; }
  const subtotal = invoiceSubtotal(inv);
  if (value > subtotal) { errEl.textContent = `Discount can't be more than the subtotal (${formatMoney(subtotal)}).`; return; }

  inv.discount = { type: 'flat', value: value, note: note, appliedBy: currentStaffInfo.name };
  touch(inv);
  saveState();
  renderInvoiceContent();
  renderInvoices();
  toast('Discount applied.');
});
document.getElementById('btn-remove-discount').addEventListener('click', () => {
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') return;
  const inv = state.invoices.find(i => i.id === currentInvoiceId);
  if (!inv) return;
  delete inv.discount;
  touch(inv);
  saveState();
  renderInvoiceContent();
  renderInvoices();
  toast('Discount removed.');
});

document.getElementById('form-void').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('void-error');
  errEl.textContent = '';
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') { errEl.textContent = 'Only an admin can void an invoice.'; return; }
  const inv = state.invoices.find(i => i.id === currentInvoiceId);
  if (!inv) return;
  const reason = document.getElementById('void-reason').value.trim();
  if (!reason) { errEl.textContent = 'A reason is required.'; return; }
  if (!confirm('Void this invoice? This cannot be undone, and its payments will no longer count toward revenue.')) return;

  inv.voided = true;
  inv.voidedAt = new Date().toISOString();
  inv.voidedBy = currentStaffInfo.name;
  inv.voidReason = reason;
  touch(inv);
  saveState();
  renderInvoiceContent();
  renderInvoices();
  renderAll();
  toast('Invoice voided.');
});

document.getElementById('btn-print-invoice').addEventListener('click', () => window.print());

/* ============================================================
   SETTINGS
   ============================================================ */
function renderSettingsForm() {
  document.getElementById('set-hotel-name').value = state.hotel.name;
  document.getElementById('set-hotel-address').value = state.hotel.address || '';
  document.getElementById('set-hotel-phone').value = state.hotel.phone || '';
  document.getElementById('set-hotel-email').value = state.hotel.email || '';
  document.getElementById('set-hotel-taxpayer').value = state.hotel.taxpayerNumber || '';
  document.getElementById('set-hotel-registration').value = state.hotel.registrationNumber || '';
  document.getElementById('set-hotel-currency').value = state.hotel.currency;
  document.getElementById('set-hotel-tax').value = state.hotel.taxRate;
  renderStaffTable();
  renderSyncPanel();
}
document.getElementById('form-hotel').addEventListener('submit', (e) => {
  e.preventDefault();
  state.hotel.name = document.getElementById('set-hotel-name').value.trim() || 'Nexora Stay';
  state.hotel.address = document.getElementById('set-hotel-address').value.trim();
  state.hotel.phone = document.getElementById('set-hotel-phone').value.trim();
  state.hotel.email = document.getElementById('set-hotel-email').value.trim();
  state.hotel.taxpayerNumber = document.getElementById('set-hotel-taxpayer').value.trim();
  state.hotel.registrationNumber = document.getElementById('set-hotel-registration').value.trim();
  state.hotel.currency = document.getElementById('set-hotel-currency').value.trim() || 'FCFA';
  state.hotel.taxRate = Number(document.getElementById('set-hotel-tax').value) || 0;
  touch(state.hotel);
  saveState();
  renderAll();
  toast('Hotel details saved.');
});

/* ---------------------------- STAFF ACCOUNTS ---------------------------- */
const ROLE_LABELS = { admin: 'Administrator', assistant: 'Assistant Manager', staff: 'Front desk staff' };
const ROLE_BADGE_CLASS = { admin: 'badge-paid', assistant: 'badge-assistant', staff: 'badge-reserved' };

function renderStaffTable() {
  const body = document.querySelector('#table-staff tbody');
  if (!body) return;
  const isAdmin = currentStaffInfo && currentStaffInfo.role === 'admin';
  body.innerHTML = '';
  (state.staff || []).forEach(s => {
    const tr = document.createElement('tr');
    const needsPin = s.pin == null;
    tr.innerHTML = `<td>${escapeHtml(s.name)}${needsPin ? ' <span class="badge badge-unpaid">no PIN on this device</span>' : ''}</td>
      <td><span class="badge ${ROLE_BADGE_CLASS[s.role] || 'badge-reserved'}">${escapeHtml(ROLE_LABELS[s.role] || s.role)}</span></td>
      <td><span class="badge ${s.active === false ? 'badge-cancelled' : 'badge-checked-in'}">${s.active === false ? 'Deactivated' : 'Active'}</span></td>
      <td>${isAdmin ? `<button class="link-btn" data-edit-staff="${s.id}">${needsPin ? 'Set up PIN' : 'Edit / reset PIN'}</button>` : ''}</td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-edit-staff]').forEach(btn => btn.onclick = () => openStaffModal(btn.dataset.editStaff));
}
function openStaffModal(staffId) {
  const s = staffId ? (state.staff || []).find(x => x.id === staffId) : null;
  const needsPin = s && s.pin == null;
  document.getElementById('staff-modal-title').textContent = s ? 'Edit staff' : 'Add staff';
  document.getElementById('sf-id').value = s ? s.id : '';
  document.getElementById('sf-name').value = s ? s.name : '';
  document.getElementById('sf-role').value = s ? s.role : 'staff';
  document.getElementById('sf-pin').value = '';
  document.getElementById('sf-pin').placeholder = (s && !needsPin) ? 'Leave blank to keep current PIN' : 'e.g. 4821';
  document.getElementById('sf-pin').required = !s || needsPin;
  document.getElementById('sf-active-label').classList.toggle('hidden', !s);
  if (s) document.getElementById('sf-active').value = String(s.active !== false);
  document.getElementById('sf-error').textContent = '';
  document.getElementById('modal-staff').classList.remove('hidden');
}
document.getElementById('form-staff').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('sf-error');
  errEl.textContent = '';
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') { errEl.textContent = 'Only an admin can manage staff accounts.'; return; }
  const id = document.getElementById('sf-id').value || null;
  const name = document.getElementById('sf-name').value.trim();
  const role = document.getElementById('sf-role').value;
  const pin = document.getElementById('sf-pin').value.trim();
  if (!name) { errEl.textContent = 'Name is required.'; return; }
  if (pin && !/^\d{4,8}$/.test(pin)) { errEl.textContent = 'PIN should be 4\u20138 digits.'; return; }

  state.staff = state.staff || [];
  if (id) {
    const s = state.staff.find(x => x.id === id);
    if (!s) return;
    s.name = name;
    s.role = role;
    if (pin) s.pin = pin;
    s.active = document.getElementById('sf-active').value === 'true';
    touch(s);
  } else {
    if (!pin) { errEl.textContent = 'A PIN is required for a new staff member.'; return; }
    const dupPin = state.staff.some(x => x.active !== false && x.pin === pin);
    if (dupPin) { errEl.textContent = 'That PIN is already in use by another active staff member.'; return; }
    state.staff.push(touch({ id: uid(), name, role, pin, active: true }));
  }
  saveState();
  document.getElementById('modal-staff').classList.add('hidden');
  renderStaffTable();
  toast('Staff account saved.');
});

/* ---------------------------- CLOUD SYNC ---------------------------- */
function renderSyncPanel() {
  const cfg = state.syncConfig || { backendUrl: '', syncKey: '' };
  const urlInput = document.getElementById('sync-backend-url');
  const keyInput = document.getElementById('sync-key-input');
  if (urlInput) urlInput.value = cfg.backendUrl || '';
  if (keyInput) keyInput.value = cfg.syncKey || '';
  updateSyncStatusText();
}
function updateSyncStatusText() {
  const el = document.getElementById('sync-status-text');
  if (!el) return;
  const cfg = state.syncConfig || {};
  if (!cfg.backendUrl || !cfg.syncKey) {
    el.textContent = 'Not set up — this device is fully offline-only until you add a backend URL and sync key below.';
    setSidebarSyncDot('off', 'Offline only');
    return;
  }
  if (!navigator.onLine) {
    setSidebarSyncDot('stale', 'Offline');
    el.textContent = 'No internet connection right now — changes are saved locally and will sync automatically once you\u2019re back online.';
    return;
  }
  if (state.lastSyncedAt) {
    const mins = Math.round((Date.now() - new Date(state.lastSyncedAt).getTime()) / 60000);
    el.textContent = 'Last synced ' + (mins <= 0 ? 'just now' : mins + ' minute' + (mins === 1 ? '' : 's') + ' ago') + '.';
  } else {
    el.textContent = 'Configured, but hasn\u2019t synced yet.';
  }
}
function setSidebarSyncDot(kind, label) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if (!dot || !lbl) return;
  dot.className = 'sync-dot' + (kind === 'ok' ? '' : ' ' + (kind === 'off' ? 'stale' : kind));
  lbl.textContent = label;
}

document.getElementById('form-sync').addEventListener('submit', (e) => {
  e.preventDefault();
  state.syncConfig = {
    backendUrl: document.getElementById('sync-backend-url').value.trim().replace(/\/+$/, ''),
    syncKey: document.getElementById('sync-key-input').value.trim(),
  };
  saveState();
  toast('Cloud sync settings saved.');
  updateSyncStatusText();
  attemptSync();
});
document.getElementById('btn-sync-now').addEventListener('click', () => {
  attemptSync(true);
});

document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nexora-stay-backup-${TODAY()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('btn-import').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.hotel || !parsed.rooms) throw new Error('Invalid file');
      state = parsed;
      saveState();
      renderAll();
      toast('Backup imported.');
    } catch (err) {
      toast('That file does not look like a valid backup.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});
document.getElementById('btn-reset').addEventListener('click', () => {
  if (!confirm('This will erase all rooms, bookings, guests and invoices in this browser. Export a backup first if you want to keep them. Continue?')) return;
  state = seedData();
  saveState();
  renderAll();
  toast('All data has been reset.');
});

/* ============================================================
   CLOUD SYNC (optional, additive) — every screen above this line
   works purely from localStorage with zero network calls. This
   section only ever runs when the browser reports it's online AND
   a backend URL + sync key have been set in Settings → Cloud sync.
   If either condition isn't met, none of this fires and the app is
   simply a single-device offline tool, exactly as if this code
   didn't exist.

   How the merge works: every record has an updatedAt timestamp.
   Pushing sends only records changed since the last successful
   sync; the server accepts a record only if it's new or newer than
   its stored copy (server upsert-if-newer), and rejects a booking
   that would double-book a room another device already claimed.
   Pulling then fetches the server's canonical copy of everything
   and merges it in, again preferring whichever side is newer.

   Known limitations (small-hotel scale tradeoffs, not bugs):
   - Deleting a room/room type/invoice charge is local-only and does
     not remove it from the server or other devices. Use "Maintenance"
     status instead of deleting a room once it's been synced.
   - Staff PINs are intentionally never sent to the server, so a
     staff account created on one device needs its PIN set up
     separately on every other device it will be used from (Settings
     → Staff accounts → "Set up PIN"). Everything else does sync.
   - If two devices book the same room for overlapping times while
     both offline, the sync that happens second gets rejected with a
     clear message — that booking stays local-only until you resolve
     it (e.g. move it to a different room).
   ============================================================ */
let syncInFlight = false;
let syncDebounceTimer = null;
let syncPollTimer = null;

function initSyncEngine() {
  window.addEventListener('online', () => { updateSyncStatusText(); attemptSync(); });
  window.addEventListener('offline', () => updateSyncStatusText());
}
function startSyncPolling() {
  stopSyncPolling();
  syncPollTimer = setInterval(() => attemptSync(), 20000);
}
function stopSyncPolling() {
  if (syncPollTimer) clearInterval(syncPollTimer);
  syncPollTimer = null;
}
function scheduleSync() {
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => attemptSync(), 2500);
}
function syncReady() {
  const cfg = state && state.syncConfig;
  return !!(cfg && cfg.backendUrl && cfg.syncKey);
}

async function attemptSync(manual) {
  if (!state || !currentStaffInfo) return; // not logged in / not loaded yet
  if (!syncReady()) { updateSyncStatusText(); return; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { updateSyncStatusText(); return; }
  if (syncInFlight) return;
  syncInFlight = true;
  setSidebarSyncDot('stale', 'Syncing…');
  try {
    await pushChanges();
    await pullChanges();
    state.lastSyncedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setSidebarSyncDot('ok', 'Live');
    renderAll();
    if (manual) toast('Synced.');
  } catch (err) {
    console.error('Sync failed', err);
    setSidebarSyncDot('error', 'Sync issue');
    if (manual) toast('Sync failed: ' + err.message);
  } finally {
    syncInFlight = false;
    updateSyncStatusText();
  }
}

function toUTCISOFromLocal(localStr) {
  const d = new Date(localStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function buildPushPayload() {
  const since = state.lastSyncedAt;
  const isPending = (rec) => !rec.updatedAt || !since || new Date(rec.updatedAt) > new Date(since);

  const tables = {};
  if (isPending(state.hotel)) {
    tables.hotel = {
      name: state.hotel.name, address: state.hotel.address, phone: state.hotel.phone,
      email: state.hotel.email || '', taxpayer_number: state.hotel.taxpayerNumber || '',
      registration_number: state.hotel.registrationNumber || '',
      currency: state.hotel.currency, tax_rate: state.hotel.taxRate, updated_at: state.hotel.updatedAt,
    };
  }
  tables.staff = (state.staff || []).filter(isPending).map(s => ({
    id: s.id, name: s.name, role: s.role, active: s.active !== false, updated_at: s.updatedAt,
  }));
  tables.roomTypes = state.roomTypes.filter(isPending).map(t => ({
    id: t.id, name: t.name, rate: t.rate, rate_1h: t.rate1h, rate_3h: t.rate3h, rate_night: t.rateNight,
    capacity: t.capacity, updated_at: t.updatedAt,
  }));
  tables.rooms = state.rooms.filter(isPending).map(r => ({
    id: r.id, number: r.number, type_id: r.typeId, status: r.status, updated_at: r.updatedAt,
  }));
  tables.guests = state.guests.filter(isPending).map(g => ({
    id: g.id, name: g.name, phone: g.phone, id_number: g.idNumber, updated_at: g.updatedAt,
  }));
  tables.bookings = state.bookings.filter(isPending).map(b => ({
    id: b.id, guest_id: b.guestId, room_id: b.roomId, stay_type: b.stayType,
    check_in: toUTCISOFromLocal(b.checkIn), check_out: toUTCISOFromLocal(b.checkOut),
    guests: b.guests, notes: b.notes, status: b.status, updated_at: b.updatedAt,
  })).filter(b => b.check_in && b.check_out);
  tables.invoices = state.invoices.filter(isPending).map(i => ({
    id: i.id, booking_id: i.bookingId, number: i.number, tax_rate: i.taxRate,
    discount_type: i.discount ? i.discount.type : null,
    discount_value: i.discount ? i.discount.value : null,
    discount_note: i.discount ? (i.discount.note || '') : null,
    discount_applied_by: i.discount ? (i.discount.appliedBy || '') : null,
    voided: !!i.voided, voided_at: i.voidedAt || null, voided_by: i.voidedBy || '', void_reason: i.voidReason || '',
    updated_at: i.updatedAt || new Date(i.createdAt).toISOString(),
  }));
  const charges = [], payments = [];
  state.invoices.forEach(i => {
    (i.charges || []).forEach(c => {
      if (isPending(c)) charges.push({ id: c.id, invoice_id: i.id, description: c.desc, amount: c.amount, updated_at: c.updatedAt });
    });
    (i.payments || []).forEach(p => {
      if (isPending(p)) payments.push({ id: p.id, invoice_id: i.id, amount: p.amount, method: p.method, paid_at: p.updatedAt, updated_at: p.updatedAt });
    });
  });
  tables.invoiceCharges = charges;
  tables.invoicePayments = payments;
  tables.employees = (state.employees || []).filter(isPending).map(emp => ({
    id: emp.id, name: emp.name, role: emp.role, phone: emp.phone, monthly_salary: emp.monthlySalary,
    status: emp.status || 'active', date_joined: emp.dateJoined, updated_at: emp.updatedAt,
  }));
  tables.salaryPayments = (state.salaryPayments || []).filter(isPending).map(p => ({
    id: p.id, employee_id: p.employeeId, month: p.month, amount_due: p.amountDue, amount_paid: p.amountPaid,
    date: p.date, method: p.method, note: p.note || '', updated_at: p.updatedAt,
  }));
  tables.expenses = (state.expenses || []).filter(isPending).map(ex => ({
    id: ex.id, date: ex.date, category: ex.category, description: ex.description, amount: ex.amount,
    method: ex.method, vendor: ex.vendor || '', recorded_by: ex.recordedBy || '', updated_at: ex.updatedAt,
  }));
  tables.deposits = (state.deposits || []).filter(isPending).map(d => ({
    id: d.id, date: d.date, amount: d.amount, method: d.method, destination: d.destination || '', note: d.note || '',
    updated_at: d.updatedAt,
  }));
  return tables;
}

async function pushChanges() {
  const tables = buildPushPayload();
  const hasAny = Object.keys(tables).some(k => {
    const v = tables[k];
    return Array.isArray(v) ? v.length > 0 : !!v;
  });
  if (!hasAny) return;
  const cfg = state.syncConfig;
  let res;
  try {
    res = await fetch(cfg.backendUrl + '/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.syncKey },
      body: JSON.stringify({ tables: tables }),
    });
  } catch (networkErr) {
    throw new Error('Could not reach the backend.');
  }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch (e) { /* ignore */ }
    throw new Error(body.error || ('Push failed (' + res.status + ')'));
  }
  const result = await res.json();
  handlePushResult(result);
}

function handlePushResult(result) {
  const rejected = result.rejected || {};
  const messages = [];
  Object.keys(rejected).forEach(table => {
    (rejected[table] || []).forEach(r => {
      if (r.reason && r.reason.indexOf('skipped') === -1) messages.push(r.reason);
    });
  });
  if (messages.length) toast(messages[0] + (messages.length > 1 ? ' (+' + (messages.length - 1) + ' more)' : ''));
}

async function pullChanges() {
  const cfg = state.syncConfig;
  let res;
  try {
    res = await fetch(cfg.backendUrl + '/sync', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + cfg.syncKey },
    });
  } catch (networkErr) {
    throw new Error('Could not reach the backend.');
  }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch (e) { /* ignore */ }
    throw new Error(body.error || ('Pull failed (' + res.status + ')'));
  }
  const server = await res.json();
  mergeServerState(server);
}

function newer(serverUpdatedAt, localRecord) {
  return !localRecord || !localRecord.updatedAt || new Date(serverUpdatedAt) >= new Date(localRecord.updatedAt);
}
function mergeArray(list, serverRecords, mapFn) {
  if (!serverRecords) return;
  const localById = {};
  list.forEach(r => { localById[r.id] = r; });
  serverRecords.forEach(sr => {
    const mapped = mapFn(sr);
    const local = localById[mapped.id];
    if (newer(mapped.updatedAt, local)) {
      if (local) Object.assign(local, mapped);
      else list.push(mapped);
    }
  });
}
function mergeServerState(server) {
  if (server.hotel && newer(server.hotel.updated_at, state.hotel)) {
    state.hotel.name = server.hotel.name;
    state.hotel.address = server.hotel.address;
    state.hotel.phone = server.hotel.phone;
    state.hotel.email = server.hotel.email || '';
    state.hotel.taxpayerNumber = server.hotel.taxpayer_number || '';
    state.hotel.registrationNumber = server.hotel.registration_number || '';
    state.hotel.currency = server.hotel.currency;
    state.hotel.taxRate = server.hotel.tax_rate;
    state.hotel.updatedAt = server.hotel.updated_at;
  }
  mergeArray(state.roomTypes, server.roomTypes, sr => ({
    id: sr.id, name: sr.name, rate: sr.rate, rate1h: sr.rate_1h, rate3h: sr.rate_3h, rateNight: sr.rate_night,
    capacity: sr.capacity, updatedAt: sr.updated_at,
  }));
  mergeArray(state.rooms, server.rooms, sr => ({
    id: sr.id, number: sr.number, typeId: sr.type_id, status: sr.status, updatedAt: sr.updated_at,
  }));
  mergeArray(state.guests, server.guests, sr => ({
    id: sr.id, name: sr.name, phone: sr.phone, idNumber: sr.id_number, updatedAt: sr.updated_at,
  }));
  mergeArray(state.bookings, server.bookings, sr => ({
    id: sr.id, guestId: sr.guest_id, roomId: sr.room_id, stayType: sr.stay_type,
    checkIn: toLocalInput(new Date(sr.check_in)), checkOut: toLocalInput(new Date(sr.check_out)),
    guests: sr.guests, notes: sr.notes, status: sr.status, updatedAt: sr.updated_at,
  }));
  mergeStaff(server.staff);
  mergeInvoices(server.invoices, server.invoiceCharges, server.invoicePayments);
  mergeArray(state.employees, server.employees, sr => ({
    id: sr.id, name: sr.name, role: sr.role, phone: sr.phone, monthlySalary: sr.monthly_salary,
    status: sr.status, dateJoined: sr.date_joined, updatedAt: sr.updated_at,
  }));
  mergeArray(state.salaryPayments, server.salaryPayments, sr => ({
    id: sr.id, employeeId: sr.employee_id, month: sr.month, amountDue: sr.amount_due, amountPaid: sr.amount_paid,
    date: sr.date, method: sr.method, note: sr.note, updatedAt: sr.updated_at,
  }));
  mergeArray(state.expenses, server.expenses, sr => ({
    id: sr.id, date: sr.date, category: sr.category, description: sr.description, amount: sr.amount,
    method: sr.method, vendor: sr.vendor, recordedBy: sr.recorded_by || '', updatedAt: sr.updated_at,
  }));
  state.deposits = state.deposits || [];
  mergeArray(state.deposits, server.deposits, sr => ({
    id: sr.id, date: sr.date, amount: sr.amount, method: sr.method, destination: sr.destination, note: sr.note, updatedAt: sr.updated_at,
  }));
}
function mergeStaff(serverStaff) {
  if (!serverStaff) return;
  state.staff = state.staff || [];
  const localById = {};
  state.staff.forEach(s => { localById[s.id] = s; });
  serverStaff.forEach(ss => {
    const local = localById[ss.id];
    if (!local) {
      // A staff account created on another device — PINs never sync
      // for security, so this device needs its own PIN set for them.
      state.staff.push({ id: ss.id, name: ss.name, role: ss.role, active: ss.active, pin: null, updatedAt: ss.updated_at });
    } else if (newer(ss.updated_at, local)) {
      local.name = ss.name; local.role = ss.role; local.active = ss.active; local.updatedAt = ss.updated_at;
      // local.pin is intentionally left untouched
    }
  });
}
function mergeInvoices(serverInvoices, serverCharges, serverPayments) {
  if (!serverInvoices) return;
  const localById = {};
  state.invoices.forEach(i => { localById[i.id] = i; });
  serverInvoices.forEach(si => {
    const discount = si.discount_type ? { type: si.discount_type, value: si.discount_value, note: si.discount_note || '', appliedBy: si.discount_applied_by || '' } : null;
    let local = localById[si.id];
    if (!local) {
      local = {
        id: si.id, number: si.number, bookingId: si.booking_id, taxRate: si.tax_rate,
        discount: discount,
        voided: !!si.voided, voidedAt: si.voided_at || null, voidedBy: si.voided_by || '', voidReason: si.void_reason || '',
        createdAt: localDateStr(new Date(si.updated_at)), updatedAt: si.updated_at,
        charges: [], payments: [],
      };
      state.invoices.push(local);
      localById[si.id] = local;
    } else if (newer(si.updated_at, local)) {
      local.number = si.number; local.taxRate = si.tax_rate; local.updatedAt = si.updated_at;
      if (discount) local.discount = discount; else delete local.discount;
      local.voided = !!si.voided; local.voidedAt = si.voided_at || null; local.voidedBy = si.voided_by || ''; local.voidReason = si.void_reason || '';
    }
  });
  (serverCharges || []).forEach(sc => {
    const inv = localById[sc.invoice_id];
    if (!inv) return;
    inv.charges = inv.charges || [];
    const local = inv.charges.find(c => c.id === sc.id);
    const mapped = { id: sc.id, desc: sc.description, amount: sc.amount, updatedAt: sc.updated_at };
    if (newer(sc.updated_at, local)) {
      if (local) Object.assign(local, mapped); else inv.charges.push(mapped);
    }
  });
  (serverPayments || []).forEach(sp => {
    const inv = localById[sp.invoice_id];
    if (!inv) return;
    inv.payments = inv.payments || [];
    const local = inv.payments.find(p => p.id === sp.id);
    const mapped = { id: sp.id, amount: sp.amount, method: sp.method, date: localDateStr(new Date(sp.paid_at)), updatedAt: sp.updated_at };
    if (newer(sp.updated_at, local)) {
      if (local) Object.assign(local, mapped); else inv.payments.push(mapped);
    }
  });
}
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ============================================================
   CSV EXPORTS — one per record type, plus the current Reports view.
   ============================================================ */
function csvEscape(val) {
  const str = val == null ? '' : String(val);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
function downloadCSV(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach(row => lines.push(row.map(csvEscape).join(',')));
  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportBookingsCSV() {
  const headers = ['Guest', 'Phone', 'Room', 'Stay type', 'Check-in', 'Check-out', 'Guests', 'Status', 'Notes'];
  const rows = state.bookings.map(b => {
    const g = getGuest(b.guestId), r = getRoom(b.roomId);
    return [g ? g.name : '', g ? g.phone : '', r ? r.number : '', STAY_LABELS[b.stayType] || b.stayType, b.checkIn, b.checkOut, b.guests, b.status, b.notes || ''];
  });
  downloadCSV(`bookings-${TODAY()}.csv`, headers, rows);
}
function exportGuestsCSV() {
  const headers = ['Name', 'Phone', 'ID number', 'Stays'];
  const rows = state.guests.map(g => [g.name, g.phone || '', g.idNumber || '', state.bookings.filter(b => b.guestId === g.id).length]);
  downloadCSV(`guests-${TODAY()}.csv`, headers, rows);
}
function exportInvoicesCSV() {
  const headers = ['Invoice #', 'Guest', 'Room', 'Subtotal', 'Discount', 'Tax', 'Total', 'Paid', 'Balance', 'Status', 'Created', 'Void reason'];
  const rows = state.invoices.map(inv => {
    const booking = getBooking(inv.bookingId);
    const g = booking ? getGuest(booking.guestId) : null;
    const r = booking ? getRoom(booking.roomId) : null;
    return [
      inv.number, g ? g.name : '', r ? r.number : '',
      invoiceSubtotal(inv), invoiceDiscountAmount(inv), invoiceTax(inv), invoiceTotal(inv),
      invoicePaid(inv), invoiceBalance(inv), invoiceStatus(inv), inv.createdAt, inv.voided ? (inv.voidReason || '') : '',
    ];
  });
  downloadCSV(`invoices-${TODAY()}.csv`, headers, rows);
}
function exportEmployeesCSV() {
  const headers = ['Name', 'Role', 'Phone', 'Monthly salary', 'Status', 'Date joined'];
  const rows = state.employees.map(e => [e.name, e.role, e.phone || '', e.monthlySalary, e.status || 'active', e.dateJoined || '']);
  downloadCSV(`employees-${TODAY()}.csv`, headers, rows);
}
function exportSalaryPaymentsCSV() {
  const headers = ['Employee', 'Month', 'Amount due', 'Amount paid', 'Method', 'Date', 'Note'];
  const rows = state.salaryPayments.map(p => {
    const e = getEmployee(p.employeeId);
    return [e ? e.name : '', p.month, p.amountDue, p.amountPaid, p.method, p.date, p.note || ''];
  });
  downloadCSV(`salary-payments-${TODAY()}.csv`, headers, rows);
}
function exportExpensesCSV() {
  const headers = ['Date', 'Description', 'Category', 'Vendor', 'Method', 'Amount', 'Recorded by'];
  const rows = state.expenses.map(e => [e.date, e.description, e.category, e.vendor || '', e.method, e.amount, e.recordedBy || '']);
  downloadCSV(`expenses-${TODAY()}.csv`, headers, rows);
}
function exportDepositsCSV() {
  const headers = ['Date', 'Destination', 'Method', 'Note', 'Amount'];
  const rows = (state.deposits || []).map(d => [d.date, d.destination || '', d.method, d.note || '', d.amount]);
  downloadCSV(`deposits-${TODAY()}.csv`, headers, rows);
}
function exportReportCSV() {
  if (!lastReportData) return;
  const d = lastReportData;
  const headers = ['Section', 'Field', 'Value'];
  const rows = [
    ['Summary', 'Period', d.from === d.to ? d.from : d.from + ' to ' + d.to],
    ['Summary', 'Revenue collected', d.revenue],
    ['Summary', 'Expenses', d.expensesTotal],
    ['Summary', 'Payroll paid', d.payrollTotal],
    ['Summary', 'Net cash position', d.net],
    ['Summary', 'Deposited to bank', d.depositedTotal],
    ['Summary', 'Payments recorded', d.payments.length],
    ['Summary', 'Check-ins', d.checkins.length],
    ['Summary', 'Check-outs', d.checkouts.length],
  ];
  Object.keys(d.byMethod).forEach(m => rows.push(['By payment method', m, d.byMethod[m].amount]));
  d.payments.forEach(x => {
    const r = x.booking ? getRoom(x.booking.roomId) : null;
    const g = x.booking ? getGuest(x.booking.guestId) : null;
    rows.push(['Payment', x.invoice.number + ' — ' + (g ? g.name : '') + ' — Room ' + (r ? r.number : ''), x.payment.amount]);
  });
  d.expenses.forEach(e => rows.push(['Expense', e.date + ' — ' + e.description + ' (' + e.category + ')', e.amount]));
  d.salaryPayments.forEach(p => {
    const e = getEmployee(p.employeeId);
    rows.push(['Salary payment', p.date + ' — ' + (e ? e.name : '') + ' (' + p.month + ')', p.amountPaid]);
  });
  d.deposits.forEach(dep => rows.push(['Deposit', dep.date + ' — ' + (dep.destination || '') + (dep.note ? ' (' + dep.note + ')' : ''), dep.amount]));
  downloadCSV(`report-${d.from}-to-${d.to}.csv`, headers, rows);
}

/* ============================================================
   INIT & GLOBAL EVENT WIRING
   ============================================================ */
function init() {
  state = loadState();
  initSyncEngine();

  // lock screen
  const lockScreen = document.getElementById('lock-screen');
  const app = document.getElementById('app');
  document.getElementById('lock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('lock-pin').value;
    const staffMember = (state.staff || []).find(s => s.active !== false && s.pin != null && s.pin === val);
    if (staffMember) {
      currentStaffInfo = { id: staffMember.id, name: staffMember.name, role: staffMember.role };
      lockScreen.classList.add('hidden');
      app.classList.remove('hidden');
      document.getElementById('lock-hint').textContent = '';
      applyRolePermissions();
      renderAll();
      attemptSync();
      startSyncPolling();
    } else {
      document.getElementById('lock-hint').textContent = 'Incorrect PIN, try again.';
    }
    document.getElementById('lock-pin').value = '';
  });
  document.getElementById('btn-lock').addEventListener('click', () => {
    currentStaffInfo = null;
    stopSyncPolling();
    app.classList.add('hidden');
    lockScreen.classList.remove('hidden');
  });

  // nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('btn-hamburger').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.toggle('open');
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.remove('open');
  });

  // top bar
  document.getElementById('btn-new-booking').addEventListener('click', () => openBookingModal(null));
  document.getElementById('btn-new-room').addEventListener('click', () => openRoomModal(null));
  document.getElementById('btn-new-type').addEventListener('click', () => openTypeModal(null));
  document.getElementById('btn-new-staff').addEventListener('click', () => openStaffModal(null));
  document.getElementById('btn-new-employee').addEventListener('click', () => openEmployeeModal(null));
  document.getElementById('btn-new-expense').addEventListener('click', () => openExpenseModal());
  document.getElementById('btn-new-deposit').addEventListener('click', () => openDepositModal());

  // modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => document.getElementById(btn.dataset.close).classList.add('hidden'));
  });
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.add('hidden'); });
  });

  // search/filter listeners
  document.getElementById('booking-search').addEventListener('input', renderBookings);
  document.getElementById('booking-filter-status').addEventListener('change', renderBookings);
  document.getElementById('guest-search').addEventListener('input', renderGuests);
  document.getElementById('billing-filter-status').addEventListener('change', renderInvoices);
  document.getElementById('billing-filter-period').addEventListener('change', renderInvoices);
  document.getElementById('billing-filter-date').addEventListener('change', renderInvoices);
  document.getElementById('report-date').addEventListener('change', renderReports);
  document.getElementById('report-period').addEventListener('change', renderReports);
  document.getElementById('btn-report-today').addEventListener('click', () => {
    document.getElementById('report-date').value = TODAY();
    renderReports();
  });
  document.getElementById('expense-search').addEventListener('input', renderExpenseTable);
  document.getElementById('expense-filter-category').addEventListener('change', renderExpenseTable);
  document.getElementById('expense-filter-period').addEventListener('change', renderExpenseTable);
  document.getElementById('expense-filter-date').addEventListener('change', renderExpenseTable);

  // CSV exports
  document.getElementById('btn-export-bookings').addEventListener('click', exportBookingsCSV);
  document.getElementById('btn-export-guests').addEventListener('click', exportGuestsCSV);
  document.getElementById('btn-export-invoices').addEventListener('click', exportInvoicesCSV);
  document.getElementById('btn-export-employees').addEventListener('click', exportEmployeesCSV);
  document.getElementById('btn-export-salary-payments').addEventListener('click', exportSalaryPaymentsCSV);
  document.getElementById('btn-export-expenses').addEventListener('click', exportExpensesCSV);
  document.getElementById('btn-export-deposits').addEventListener('click', exportDepositsCSV);
  document.getElementById('btn-export-report').addEventListener('click', exportReportCSV);
  document.getElementById('btn-print-report').addEventListener('click', () => window.print());
  document.getElementById('btn-print-spending').addEventListener('click', () => window.print());
}

/* Hide admin-only controls for front-desk staff. This is a UX
   courtesy, not a security boundary — like the PIN itself, everything
   here runs on-device. If you need real access control per person,
   that's what the optional cloud backend's per-device sync key is for
   (it doesn't gate individual staff, only which devices can sync). */
/* Three roles:
   - admin: full control, including every delete/void/cancel action,
     staff accounts, and cloud sync credentials.
   - assistant (Assistant Manager): sees and can operate everything an
     admin can — Reports, Payroll, Spending, hotel details, adding/
     editing rooms and room types — but cannot delete anything, cannot
     void an invoice or cancel a booking, and cannot manage staff
     accounts or cloud sync (those stay admin-only since they control
     who has access at all).
   - staff: front desk only — bookings and billing, nothing else. */
function applyRolePermissions() {
  const role = currentStaffInfo ? currentStaffInfo.role : null;
  const isAdmin = role === 'admin';
  const canView = role === 'admin' || role === 'assistant'; // "view everything" tier
  document.getElementById('session-name').textContent = currentStaffInfo ? currentStaffInfo.name : '—';
  document.getElementById('session-role').textContent = currentStaffInfo ? (ROLE_LABELS[role] || role) : '—';

  // Settings — hotel details & staff list are viewable by admin+assistant;
  // only admin can manage staff accounts or cloud sync credentials.
  document.getElementById('panel-hotel-details').classList.toggle('hidden', !canView);
  document.getElementById('panel-staff').classList.toggle('hidden', !canView);
  document.getElementById('btn-new-staff').classList.toggle('hidden', !isAdmin);
  document.getElementById('panel-sync').classList.toggle('hidden', !canView);
  document.getElementById('sync-form-wrap').classList.toggle('hidden', !isAdmin);
  document.getElementById('sync-assistant-note').classList.toggle('hidden', isAdmin);
  document.getElementById('panel-non-admin-note').classList.toggle('hidden', canView);
  document.getElementById('btn-import-label').classList.toggle('hidden', !isAdmin);
  document.getElementById('btn-reset').classList.toggle('hidden', !isAdmin);

  // Rooms — admin+assistant can add/edit; only admin can remove.
  document.getElementById('btn-new-room').classList.toggle('hidden', !canView);
  document.getElementById('btn-new-type').classList.toggle('hidden', !canView);

  // Nav — Reports/Payroll/Spending open up to admin+assistant.
  document.getElementById('nav-reports').classList.toggle('hidden', !canView);
  document.getElementById('nav-payroll').classList.toggle('hidden', !canView);
  document.getElementById('nav-spending').classList.toggle('hidden', !canView);
  if (!canView && ['view-reports', 'view-payroll', 'view-spending'].some(id => document.getElementById(id).classList.contains('active'))) {
    switchView('dashboard');
  }
}

function showFatalError(msg) {
  const pf = document.getElementById('preflight-status');
  if (pf && pf.parentNode) pf.parentNode.removeChild(pf);
  if (window.__nexoraPreflightTimeout) {
    window.clearTimeout(window.__nexoraPreflightTimeout);
    window.__nexoraPreflightTimeout = null;
  }
  let el = document.getElementById('fatal-error-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal-error-banner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#B0452E;color:#fff;' +
      'font-family:sans-serif;font-size:13px;padding:10px 14px;z-index:99999;text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = 'Nexora Stay hit an error: ' + msg + ' — please reload the page. If this keeps happening, try a different browser or check that JavaScript is enabled.';
}
window.addEventListener('error', (e) => showFatalError(e.message || 'unknown error'));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  showFatalError(reason || 'unknown error');
});

function clearPreflight() {
  if (window.__nexoraPreflightTimeout) {
    window.clearTimeout(window.__nexoraPreflightTimeout);
    window.__nexoraPreflightTimeout = null;
  }
  const pf = document.getElementById('preflight-status');
  if (pf && pf.parentNode) pf.parentNode.removeChild(pf);
}

function boot() {
  try {
    init();
    clearPreflight();
  } catch (err) {
    console.error('Startup failed', err);
    showFatalError(err.message || String(err));
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
