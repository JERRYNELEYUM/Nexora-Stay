// Data-safety regression tests. Each section replays a way recorded data used to be lost
// (two open windows overwriting each other, filters hiding a new record, damaged or full
// browser storage…) and asserts it can no longer happen. Run with:  npm test
// (needs: npm install   — uses Playwright to drive the real app in a browser)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = process.argv[2] || path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => { let fp = path.join(ROOT, decodeURIComponent(req.url.split('?')[0])); if (fp.endsWith('/')) fp += 'index.html';
  fs.readFile(fp, (e, d) => { if (e) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain', 'Cache-Control': 'no-store' }); res.end(d); }); });
const OLDER = path.join(require('os').tmpdir(), 'nexora_older_backup.json');
const K = 'nexoraStayData_v1', URL = 'http://localhost:' + (Number(process.argv[3]) || 8961) + '/index.html';
let ok = 0, bad = 0; const check = (l, c, x) => { if (c) { ok++; console.log('  PASS -', l); } else { bad++; console.log('  FAIL -', l, x !== undefined ? JSON.stringify(x) : ''); } };
const unlock = async (p, pin) => { await p.fill('#lock-pin', pin || '1234'); await p.click('#lock-form button[type=submit]'); await p.waitForSelector('#app:not(.hidden)'); };
const addExpense = async (p, desc, amount, date) => { await p.click('.nav-btn[data-view="spending"]'); await p.click('#btn-new-expense'); await p.fill('#ex-desc', desc); await p.fill('#ex-amount', String(amount)); if (date) await p.fill('#ex-date', date); await p.click('#form-expense button[type=submit]'); await p.waitForTimeout(250); };
const addBooking = async (p, name) => { await p.click('.nav-btn[data-view="bookings"]'); await p.click('#btn-new-booking'); await p.fill('#bk-guest-name', name); await p.fill('#bk-guest-phone', '677000000'); await p.waitForTimeout(150); await p.click('#form-booking button[type=submit]'); await p.waitForTimeout(250); };
const storedExpenses = (p) => p.evaluate((k) => (JSON.parse(localStorage.getItem(k)).expenses || []).map(e => e.description), K);
const storedBookings = (p) => p.evaluate((k) => (JSON.parse(localStorage.getItem(k)).bookings || []).length, K);
const visibleRows = (p) => p.$$eval('#table-expenses tbody tr:not(.muted-row)', r => r.length);
const goSpending = async (p) => { await p.click('.nav-btn[data-view="spending"]'); await p.waitForTimeout(150); };
const deafen = (p) => p.evaluate(() => { window.removeEventListener('storage', onStorageEvent); window.removeEventListener('focus', refreshFromStorageIfStale); });  // simulate a window that MISSES the notification

server.listen(Number(process.argv[3]) || 8961, async () => {
  const browser = await chromium.launch();
  try {
    console.log('\n[R1] TWO WINDOWS — the reproduced loss: window B saves a booking after window A recorded an expense');
    { const ctx = await browser.newContext(); const B = await ctx.newPage(), A = await ctx.newPage(); const errs = []; [A, B].forEach(p => p.on('pageerror', e => errs.push(e.message)));
      await B.goto(URL); await unlock(B); await A.goto(URL); await unlock(A);
      await addExpense(A, 'EXP-FROM-A', 5000);
      await goSpending(B);
      check('window B shows A\'s expense right away (windows stay in step)', await visibleRows(B) === 1);
      await addBooking(B, 'Walk-in guest');
      check('after B saves a booking, the expense is STILL in saved data', (await storedExpenses(B)).includes('EXP-FROM-A'));
      check('...and so is the booking', await storedBookings(B) === 1);
      await A.reload(); await unlock(A); await goSpending(A);
      check('after reloading A, the expense is still listed', await visibleRows(A) === 1);
      check('no page errors', errs.length === 0, errs); }

    console.log('\n[R1b] SAFETY NET — window B never receives the notification (frozen / background / missed event)');
    { const ctx = await browser.newContext(); const B = await ctx.newPage(), A = await ctx.newPage();
      await B.goto(URL); await unlock(B); await A.goto(URL); await unlock(A); await deafen(B);
      await addExpense(A, 'EXP-A-1', 1000);
      await addBooking(B, 'Guest from stale window');               // stale window saves — this used to erase EXP-A-1
      const ex = await storedExpenses(B);
      check('stale window\'s save did NOT erase the expense', ex.includes('EXP-A-1'), ex);
      check('stale window\'s own booking was saved too', await storedBookings(B) === 1);
      await A.reload(); await unlock(A); await goSpending(A);
      check('both survive a reload', await visibleRows(A) === 1 && await storedBookings(A) === 1); }

    console.log('\n[R1c] BOTH windows record expenses at the same time, neither hearing the other');
    { const ctx = await browser.newContext(); const B = await ctx.newPage(), A = await ctx.newPage();
      await B.goto(URL); await unlock(B); await A.goto(URL); await unlock(A); await deafen(A); await deafen(B);
      await addExpense(A, 'EXP-ONLY-A', 111); await addExpense(B, 'EXP-ONLY-B', 222);
      const ex = await storedExpenses(B);
      check('both expenses exist in saved data', ex.includes('EXP-ONLY-A') && ex.includes('EXP-ONLY-B'), ex); }

    console.log('\n[R1d] A deliberate delete stays deleted (merging must not undo it)');
    { const ctx = await browser.newContext(); const B = await ctx.newPage(), A = await ctx.newPage(); A.on('dialog', d => d.accept());
      await B.goto(URL); await unlock(B); await A.goto(URL); await unlock(A);
      await addExpense(A, 'KEEP-ME', 100); await addExpense(A, 'DELETE-ME', 200);
      await goSpending(A);
      await A.click('#table-expenses tr:has-text("DELETE-ME") [data-del-expense]'); await A.waitForTimeout(250);
      await addBooking(B, 'Another guest');
      const ex = await storedExpenses(B);
      check('deleted expense did not come back; the other one is kept', !ex.includes('DELETE-ME') && ex.includes('KEEP-ME'), ex); }

    console.log('\n[R1e] TYPING an expense in one window while another window saves');
    { const ctx = await browser.newContext(); const B = await ctx.newPage(), A = await ctx.newPage();
      await B.goto(URL); await unlock(B); await A.goto(URL); await unlock(A);
      await B.click('.nav-btn[data-view="spending"]'); await B.click('#btn-new-expense'); await B.fill('#ex-desc', 'HALF TYPED IN B'); await B.fill('#ex-amount', '321');
      await addExpense(A, 'SAVED-IN-A', 5);                       // window A saves while B's form is open
      await B.waitForTimeout(300);
      check('B\'s half-typed form is untouched by the other window\'s save', (await B.$eval('#ex-desc', e => e.value)) === 'HALF TYPED IN B' && (await B.$eval('#ex-amount', e => e.value)) === '321');
      await B.click('#form-expense button[type=submit]'); await B.waitForTimeout(250);
      const ex = await storedExpenses(B);
      check('both the expense from A and the one typed in B are saved', ex.includes('SAVED-IN-A') && ex.includes('HALF TYPED IN B'), ex); }

    console.log('\n[R2] FILTER hiding a backdated record you just saved');
    { const ctx = await browser.newContext(); const P = await ctx.newPage(); await P.goto(URL); await unlock(P);
      await goSpending(P); await P.selectOption('#expense-filter-period', 'monthly');
      const old = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
      await addExpense(P, 'TODAYS-EXPENSE', 50);
      await addExpense(P, 'BACKDATED-EXPENSE', 7000, old);
      const toastText = await P.$eval('#toast', e => e.textContent);
      check('the backdated expense IS visible right after saving', /BACKDATED-EXPENSE/.test(await P.$eval('#table-expenses tbody', e => e.textContent)));
      check('the screen explained that it moved the list', /now shows/.test(toastText), toastText);
      const summary = await P.$eval('#expense-filter-summary', e => e.textContent);
      check('a line always says what is being shown ("Showing 1 of 2 …")', /Showing 1 of 2/.test(summary), summary);
      await P.click('#btn-expense-clear-filters'); await P.waitForTimeout(150);
      check('"Show all" reveals every record and hides the line', await visibleRows(P) === 2 && (await P.getAttribute('#expense-filter-summary', 'class')).includes('hidden'));
      await P.click('.nav-btn[data-view="billing"]'); await P.selectOption('#billing-filter-period', 'daily'); await P.fill('#billing-filter-date', '2020-01-01'); await P.waitForTimeout(100);
      check('Billing also says when filters are hiding invoices', /Showing 0 of 0|Showing 0 of/.test(await P.$eval('#billing-filter-summary', e => e.textContent)) ); }

    console.log('\n[R3] DAMAGED saved data — must be kept, not replaced by a blank hotel');
    { const original = JSON.stringify({ hotel: { name: 'Test hotel' }, rooms: [], filler: 'x'.repeat(8000) }); const damaged = original.slice(0, Math.floor(original.length * 0.7));
      const ctx = await browser.newContext({ acceptDownloads: true }); const Q = await ctx.newPage();
      await Q.addInitScript(([k, v]) => { if (!localStorage.getItem('__once')) { localStorage.setItem('__once', '1'); localStorage.setItem(k, v); } }, [K, damaged]);
      await Q.goto(URL); await Q.waitForTimeout(300);
      const kept = await Q.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('_damaged_') > 0).map(k => localStorage.getItem(k).length));
      check('a copy of the damaged data was kept, byte for byte', kept.length === 1 && kept[0] === damaged.length, kept);
      check('the lock screen says so', /could not be read/.test(await Q.$eval('#lock-hint', e => e.textContent)));
      await unlock(Q);
      check('a red bar with a download button stays on screen', (await Q.$$('#btn-alert-download-damaged')).length === 1);
      const [dl] = await Promise.all([Q.waitForEvent('download'), Q.click('#btn-alert-download-damaged')]);
      check('the download is exactly the damaged data', fs.readFileSync(await dl.path(), 'utf-8') === damaged); }

    console.log('\n[R4] STORAGE FULL — a failed save must never look like success');
    { const ctx = await browser.newContext({ acceptDownloads: true }); const Z = await ctx.newPage(); Z.on('dialog', d => d.accept()); await Z.goto(URL); await unlock(Z);
      await Z.evaluate(() => { window.__realSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); }; });
      await addExpense(Z, 'EXPENSE-WHEN-FULL', 900);
      const t = await Z.$eval('#toast', e => e.textContent);
      check('the message says NOT SAVED instead of "Expense recorded."', /NOT SAVED/.test(t), t);
      check('a red "Changes are NOT being saved" bar is shown', /NOT being saved/.test(await Z.$eval('#global-alerts', e => e.textContent)));
      const [dl] = await Promise.all([Z.waitForEvent('download'), Z.click('#btn-alert-export')]);
      check('"Export backup" in the bar works and contains the unsaved expense', /EXPENSE-WHEN-FULL/.test(fs.readFileSync(await dl.path(), 'utf-8')));
      await Z.evaluate(() => { Storage.prototype.setItem = window.__realSet; });
      await addExpense(Z, 'AFTER-RECOVERY', 10);
      check('once storage works again the bar disappears by itself', (await Z.$eval('#global-alerts', e => e.textContent.trim())) === '');
      check('and nothing recorded meanwhile was lost', (await storedExpenses(Z)).includes('EXPENSE-WHEN-FULL')); }

    console.log('\n[R5] SAFETY LOG — an expense that vanishes for ANY reason can be restored');
    { const ctx = await browser.newContext(); const P = await ctx.newPage(); P.on('dialog', d => d.accept()); await P.goto(URL); await unlock(P);
      await addExpense(P, 'LOG-1', 1500, '2026-09-20'); await addExpense(P, 'LOG-2', 2500, '2026-09-21'); await addExpense(P, 'DELETED-ON-PURPOSE', 99);
      await goSpending(P); await P.click('#table-expenses tr:has-text("DELETED-ON-PURPOSE") [data-del-expense]'); await P.waitForTimeout(250);
      // simulate any kind of loss: restore an OLDER backup that does not contain the expenses
      const older = await P.evaluate(() => { const c = JSON.parse(JSON.stringify(state)); c.expenses = []; return JSON.stringify(c); });
      fs.writeFileSync(OLDER, older);
      await P.click('.nav-btn[data-view="settings"]'); await P.setInputFiles('#btn-import', OLDER); await P.waitForTimeout(500);
      check('import warns that expenses recorded after that backup are missing', /missing/.test(await P.$eval('#toast', e => e.textContent)), await P.$eval('#toast', e => e.textContent));
      await goSpending(P);
      check('Spending shows a banner: 2 expense records went missing', /2 expense records went missing/.test(await P.$eval('#expense-recovery', e => e.textContent)));
      check('the expense deleted on purpose is NOT reported as missing', !/DELETED-ON-PURPOSE/.test(await P.$eval('#expense-recovery', e => e.textContent)));
      await P.click('#btn-restore-expenses'); await P.waitForTimeout(300);
      const ex = await storedExpenses(P);
      check('Restore brings both back (and only those)', ex.includes('LOG-1') && ex.includes('LOG-2') && !ex.includes('DELETED-ON-PURPOSE') && ex.length === 2, ex);
      check('the banner disappears afterwards', (await P.getAttribute('#expense-recovery', 'class')).includes('hidden'));
      const row = await P.$eval('#table-expenses tr:has-text("LOG-1")', e => e.textContent);
      check('restored records keep their original date and amount', /2026-09-20/.test(row) && /1,500/.test(row), row); }

    console.log('\n[R6] "Where is my data?" help in Settings');
    { const ctx = await browser.newContext(); const P = await ctx.newPage(); await P.goto(URL); await unlock(P); await P.click('.nav-btn[data-view="settings"]'); await P.waitForTimeout(200);
      const txt = await P.$eval('#data-location-text', e => e.textContent);
      check('shows the address this copy lives at, its record counts, and warns about separate copies', /localhost:/.test(txt) && /expenses/.test(txt) && /separate copies/.test(txt), txt); }
  } catch (e) { bad++; console.log('  CRASHED:', e.message); }
  await browser.close(); server.close();
  console.log('\nDATA-SAFETY RESULT:', ok, 'passed,', bad, 'failed'); process.exit(bad ? 1 : 0);
});
