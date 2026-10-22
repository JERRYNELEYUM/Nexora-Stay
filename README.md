# Nexora Stay — offline-first, with optional cloud sync

Nexora Stay is a front-desk app for a small hotel. **It works completely offline, out of the box, on a single device** — open `Nexora-Hotel-System.html` in a browser and everything (bookings, billing, rooms, staff) runs from that browser's local storage. No internet, no setup, no account needed.

If you want multiple devices to share data — and want the owner/administrator to see live activity from anywhere — you can optionally connect the app to a small free-tier backend (Netlify + Supabase). This is entirely additive: nothing about the offline app changes or breaks if you never set it up.

## Installing it as an app (optional)

Nexora Stay is also a **PWA (installable web app)** — hosted normally (e.g. via Netlify), staff can "install" it on a phone, tablet, or laptop so it opens like a real app: its own icon, no browser address bar, and it works with **zero internet connection**, even on a device that's never been online since the app was installed.

- **On a phone**: open the site in Chrome (Android) or Safari (iPhone), then use the browser's "Add to Home Screen" option (Android often also shows an in-app "Install app" button in the sidebar automatically).
- **On a laptop**: Chrome/Edge show an install icon in the address bar, or use the "Install app" button in the sidebar.

Installed copies keep themselves current: while online, the app always loads its newest version (the offline copy is only used when there's no connection), and calls to the backend are never cached. If you ever change the app files yourself, bump `CACHE_NAME` in `public/service-worker.js` so devices drop their old offline copy.

This requires the files to be served over the network (not opened as a local `file://` page) — see "Files in this download" below for which ones need to be deployed together. **This is optional**: the plain `Nexora-Hotel-System.html` file still works exactly as described below whether or not you set up the installable version.

## Part 1 — Using the app offline (no setup required)

Open `Nexora-Hotel-System.html` in any browser, or drag it into [Netlify Drop](https://app.netlify.com/drop) for a shareable link. Sign in with the default admin PIN **1234** (change it immediately in Settings → Staff accounts).

- **Dashboard** — room board, today's arrivals/departures, occupancy, rooms in maintenance. (Financial figures live in Reports, admin-only, rather than on the Dashboard everyone sees.)
- **Bookings** — full-night stays or short stays (1 hour / 3 hours / all night), with automatic double-booking prevention
- **Rooms** — rooms and room types, each with its own night/hour/3-hour/all-night rates
- **Guests** — directory with stay history
- **Billing** — auto-generated invoices, dated and ranked newest-first (ties broken by invoice number), extra charges, tax, payments (Cash, MTN MoMo, Orange Money, card, transfer), and discounts (a flat amount off the bill, applied before tax, with an optional reason) that admins and assistant managers can apply or update — only an admin can remove one. Admins can also **void an invoice** (requires a reason, can't be undone) — a voided invoice is clearly stamped and excluded from revenue in Reports, while the booking itself stays on record. Cancelling a reserved booking before check-in is admin-only. Filter the invoice list by a **period** (Daily, Weekly, Monthly, Yearly, or All Time) — the same picker used in Reports — to pull up invoices from a specific day, week, month, or year.
- **Settings → Staff accounts** — multiple staff, each with their own PIN and one of three roles:
  - **Administrator** — full control over everything, including staff accounts and cloud sync.
  - **Assistant Manager** — sees and can do almost everything an admin can (Reports, Payroll, Spending, editing rooms/rates/hotel details, applying discounts) but can't delete anything, can't void an invoice or cancel a booking, and can't touch staff accounts or cloud sync credentials.
  - **Front desk staff** — bookings and billing only.

  Hotel details include an email address, taxpayer number (NIU), and registration number (RCCM) — these print on invoices alongside the address and phone.
- **Reports** (admin and assistant manager) — sales and spending together in one view. Choose a period — **Daily, Weekly, Monthly, Yearly, or All Time** — and pick any date to anchor it. Shows revenue collected, expenses, payroll paid, and **net cash position** (revenue minus expenses, payroll, and anything deposited to the bank), alongside payments by method, room occupancy, expense and salary detail for that period, and a trend table (last 7 days / 8 weeks / 12 months / 5 years depending on the period chosen). Works from local data, so it's available offline too — no cloud sync required. Has its own **Print** button for a clean printout (hotel letterhead, no sidebar or filter controls).
- **Payroll** (admin and assistant manager) — a salary roster separate from staff logins: cleaners, cooks, security and anyone else on payroll, whether or not they ever use this app. Add employees with a monthly salary, then record salary payments against them (partial payments supported — enter a different "amount paid" than "amount due"). Shows active headcount, total monthly payroll, and payments made all-time. Feeds directly into Reports.
- **Spending** (admin and assistant manager) — general hotel expenses (utilities, maintenance, supplies, etc.), with categories, a vendor field, search and category filtering, and a **period filter** (Daily, Weekly, Monthly, Yearly, or All Time) to narrow the list to a specific stretch of time. Running totals (all-time and this month) stay unaffected by the filters, same as the search/category boxes. Each expense has its own **View** button opening a printable record — hotel letterhead, description, category, vendor, payment method, who recorded it, and the amount — just like an invoice. Deleting an expense is admin-only. Also tracks **cash/bank deposits** — when cash is taken out of the till and deposited at the bank or moved to mobile money, record it here; it's kept separate from expenses (it's a transfer, not money spent) but still counts as a deduction in Reports, and deleting one is admin-only too. The whole Spending view also has a **Print** button for a clean printout of everything at once.
- **CSV exports** — every major screen (Bookings, Guests, Billing, Payroll, Spending, and Reports) has an "Export CSV" button for that screen's data, so you can open it in Excel or share it however you need.

**Staff PINs are a courtesy lock, not real security** — they're stored in this browser, not encrypted. Don't reuse a sensitive password as a PIN.

**Back up regularly**: Settings → Data & backup → "Export backup" downloads everything as a `.json` file. Do this before clearing browser data or switching computers, whether or not you set up cloud sync.

## Part 2 — Optional: syncing across devices, and a remote report for the owner

Without this, the app is a single-device tool. With it:
- Every device pushes its changes and pulls everyone else's whenever it's online
- The hotel owner/administrator can open the app on their own device or a browser pointed at the same backend and see near-live activity (the app syncs automatically roughly every 20 seconds while online, plus right after each change)
- If a device goes offline, it keeps working exactly as before — bookings, check-ins, billing, everything — and simply catches up the next time it's back online

### What you need
A free [Supabase](https://supabase.com) project and a free [Netlify](https://netlify.com) site. Takes about 15 minutes the first time.

### Setup steps

1. **Create a Supabase project** at supabase.com. Once it's ready, open **SQL Editor → New query**, paste in the contents of `supabase/schema.sql` (included in this download), and run it. That creates all the tables.

2. **Get your Supabase keys**: Project Settings → API. You'll need the **Project URL** and the **service_role key** (not the anon/public key — the service role key is secret, never put it in the app itself).

3. **Deploy the backend** to Netlify:
   - Push this folder (minus `public/`, or including it — your choice) to a GitHub repo, or drag the `netlify` + `netlify.toml` + `package.json` + `supabase` folders into Netlify's deploy UI.
   - In Netlify: **Site settings → Environment variables**, add:
     - `SUPABASE_URL` — your Project URL from step 2
     - `SUPABASE_SERVICE_ROLE_KEY` — your service role key from step 2
     - `SYNC_KEY` — make up a long random secret (e.g. generate one at `https://www.uuidgenerator.net`, or run `openssl rand -hex 24` if you have a terminal). This is a shared password that lets your devices talk to your backend — anyone who has it can read/write your hotel's data, so treat it like a password.
   - Deploy the site. Your functions will be live at `https://<your-site-name>.netlify.app/.netlify/functions`.

4. **Connect each device**: open the app → Settings → Cloud sync (admin only) → paste in:
   - **Backend URL**: `https://<your-site-name>.netlify.app/.netlify/functions` — your site's **own address** ending in `/.netlify/functions`. **Not** the `app.netlify.com/projects/…` link you see in your Netlify dashboard — that is the dashboard page, not your site (if you paste it by mistake, the app notices and corrects it for you).
   - **Sync key**: the `SYNC_KEY` you set in step 3
   - Press **Save & test**. The app checks the connection and tells you in plain English whether it worked — and if not, exactly what to fix (wrong address, wrong key, or a database that needs `supabase/schema.sql` re-run). You can also open `https://<your-site-name>.netlify.app/.netlify/functions/sync` in a browser: seeing `{"error":"Invalid or missing sync key."}` means the backend is deployed and reachable.

Repeat step 4 on every device/browser you want kept in sync — front desk computers, and the owner's own laptop or phone if they want to watch live activity.

5. **Give the owner the standalone report page**: open `owner-report.html` (also included in this download) in any browser — it doesn't need to be hosted anywhere special, it can be opened as a local file just like the main app, or you can drop it onto the same Netlify site for a proper link. Enter the same **Backend URL** and **Sync key** from step 4. That's it — no PIN, no front-desk login, just a clean sales and spending report (with the same Daily/Weekly/Monthly/Yearly/All Time period picker as the in-app Reports screen, plus a CSV export button) the owner can check from their own phone or laptop, anywhere. It refreshes automatically every 30 seconds while left open, and remembers the connection for next time.

### How the sync actually behaves

- **Nothing blocks on the network.** Every action (booking, check-in, billing) applies to the local device instantly, online or not. Syncing happens quietly in the background afterward.
- **Conflicts are resolved by "whoever edited it most recently wins."** Every record has a timestamp; when two devices have both changed the same thing while apart, the newer edit is kept.
- **Big first syncs are fine.** A device with months of history sends it in small chunks (150 records at a time — expenses, payroll and deposits first), with live progress ("Syncing 620/1,471") in the sidebar. Each record is tracked individually, so if the connection drops half-way, the next attempt carries on where it stopped instead of starting over. If the backend can't be reached, the app backs off (20 s → 40 s → … up to 5 min) rather than retrying constantly.
- **Double-bookings across devices are caught at sync time.** If two offline devices both book the same room for overlapping times before ever syncing, the one that syncs second gets a clear rejection message and that booking stays local-only until someone reassigns it to a different room or time.

### If sync isn't working — what the messages mean

Open **Settings → Cloud sync**: the status text under the heading always says what's happening (last sync time, how many records are waiting, and the reason for any problem). The sidebar dot shows the same at a glance.

| You see | What it means | What to do |
| --- | --- | --- |
| "Couldn't reach the backend" | The address is wrong, or there's no internet | Check the Backend URL (it must be your site's address + `/.netlify/functions`) |
| "That address answered with a web page, not the sync service" | The address points at a website, not your functions | Same as above — the functions must be deployed on that site |
| "The backend rejected the sync key" | The key here doesn't match `SYNC_KEY` on Netlify | Re-enter the key exactly (Netlify → Site configuration → Environment variables) |
| "The backend database is missing the … table/column" | Your Supabase database is older than the app | Re-run `supabase/schema.sql` in the Supabase SQL editor — it's safe to run again. Until you do, the app keeps syncing what it can and tells you what's missing |
| "N records couldn't be synced: …" | The backend refused specific records (e.g. a room double-booked from two devices) | Read the reason shown; fix the record on the device; it retries automatically |
| "N records waiting to sync" that never goes down | Something is blocking sync | Press **Sync now** and read the message; as a last resort use **Re-send all data** (safe — the backend skips anything it already has) |

**After updating the app**, redeploy the site on Netlify (so the new `netlify/functions` go live) and re-run `supabase/schema.sql` once. Installed copies of the app update themselves the next time they're opened while online.

### Keeping your data safe

Everything you enter is saved in the browser on that computer or phone first. A few built-in protections make sure it can't quietly disappear:

- **Two windows can't overwrite each other.** If the app is open in more than one window or tab on the same computer (for example the installed app plus a browser tab, or a front-desk window left open while someone records expenses in another), they now stay in step automatically, and a window always folds in what another one saved *before* it saves its own changes. (Before this, an idle or out-of-date window could silently erase expenses recorded in another window the next time it saved a booking.)
- **A filter can never hide what you just saved.** Spending and Billing always say what they are showing — for example *"Showing 3 of 36 expenses — Monthly 2026-10-01 → 2026-10-31. Show all"* — and when you record a back-dated expense the list moves to its period so you can see it.
- **A failed save is never silent.** If the browser can't store your changes (storage full or blocked) a red bar stays on screen until saving works again, and "Export backup" is one click away. The app no longer says "recorded" when it wasn't.
- **Damaged data is never wiped.** If saved data can't be read, it is kept (Settings → Data & backup → *Recovery copies*, downloadable) instead of being replaced by a blank hotel.
- **Expense safety log.** Every expense is also remembered in a small separate log on the device. If an expense ever goes missing for any reason (for example after restoring an older backup), Spending shows *"N expense records went missing — Restore them"*. Expenses you delete on purpose are never restored.
- **Cloud sync is a second copy.** Anything that has synced can always be pulled back down.

Good habits: open the app from **one web address** (another address, another browser, or the plain `.html` file is a separate copy with its own data — Settings → Data & backup shows which copy you are in), and export a backup regularly. **After updating the app, close every open window of it once and reopen** — a window left on the old version is exactly the kind that used to overwrite newer data. Installed copies now show a "new version ready — Reload now" bar when an update arrives.

### Known limitations (worth knowing up front)

- **Deleting a room, room type, invoice charge, expense, or deposit record is local-only.** It won't remove that record from the server or other devices. If a room is already synced and you don't want it used anymore, set it to **Maintenance** instead of deleting it.
- **Staff PINs never sync, on purpose.** A staff account created on one device shows up on others (so the owner can see who's on the team), but each device needs that staff member's PIN entered separately (Settings → Staff accounts → "Set up PIN"). This keeps PINs from ever crossing the network.
- **Duplicate guests are possible** if the same guest is booked on two different devices while both are offline — each device creates its own local guest record. Low-impact for a small hotel; a future version could add matching/merge for this.
- The backend is a **sync target, not a login system** — access to the shared data is controlled by the one `SYNC_KEY` per hotel, not per staff member. Anyone with that key and the URL can read/write everything (including the owner's report page, which uses the same key just to read), so keep it as private as you would a password.

## Files in this download

- `Nexora-Hotel-System.html` — the whole front-desk app, single file. Open this directly (as a local file, or hosted anywhere) for the plain offline experience — no install, no PWA features, works immediately.
- `public/` — the installable PWA version: `index.html`, `css/style.css`, `js/app.js`, `manifest.json`, `service-worker.js`, and `icons/`. **These six items must be deployed together, in the same folder, for the install/offline-app features to work** — the service worker and icons are separate files by nature of how browsers handle installable apps, so this can't be collapsed into one file the way `Nexora-Hotel-System.html` is. Drag the whole `public` folder into Netlify Drop (or point your Netlify site at it via `netlify.toml`, already configured) to deploy it.
- `public/owner-report.html` — the standalone, read-only sales &amp; spending report for the owner, with the same period picker and CSV export as the in-app Reports screen. Needs cloud sync set up to show anything. (Not part of the installable app itself — just a page on the same site.)
- `netlify/functions/` — the backend functions (`push.js`, `sync.js`, `report.js`) plus shared helpers. Only needed if you're setting up cloud sync.
- `supabase/schema.sql` — run once in Supabase to create the database tables.
- `netlify.toml`, `package.json` — deployment config for the backend.
