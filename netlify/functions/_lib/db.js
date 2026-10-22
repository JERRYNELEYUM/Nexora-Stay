/* Shared database helpers used by push / sync / report.
   - fetchAllRows: Supabase returns at most 1,000 rows per request, so a plain
     select('*') quietly truncates once a hotel has more than 1,000 bookings.
     This pages through everything.
   - describeDbError: turns raw Postgres/PostgREST errors into plain English.
   - upsertRows: bulk write that survives an out-of-date database schema by
     dropping a column the database doesn't have yet (and saying so). */

const PAGE = 1000;

async function fetchAllRows(supabase, table, options) {
  const opts = options || {};
  const select = opts.select || '*';
  const out = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(select);
    if (opts.filter) q = opts.filter(q);
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { data: out, error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return { data: out, error: null };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function missingColumn(error) {
  if (!error) return null;
  const msg = String(error.message || '');
  if (error.code === 'PGRST204' || error.code === '42703') {
    const m = msg.match(/'([^']+)' column/) || msg.match(/column "([^"]+)"/);
    return m ? m[1] : null;
  }
  return null;
}

function isMissingTable(error) {
  return !!error && (error.code === 'PGRST205' || error.code === '42P01');
}

function describeDbError(table, error) {
  if (!error) return 'Unknown error.';
  if (isMissingTable(error)) {
    return 'The backend database is missing the "' + table + '" table. Run supabase/schema.sql in your Supabase SQL editor (it is safe to re-run).';
  }
  const col = missingColumn(error);
  if (col) {
    return 'The backend database is missing the "' + col + '" column on "' + table + '". Re-run supabase/schema.sql in your Supabase SQL editor (it is safe to re-run).';
  }
  if (error.code === '23505') {
    if (table === 'rooms') return 'A room with that number already exists on the backend.';
    if (table === 'invoices') return 'The backend already has a different invoice for this booking.';
    return 'The backend already has a conflicting record (duplicate).';
  }
  if (error.code === '23503') {
    return 'Refers to a record that is not on the backend yet (the record it belongs to may have been rejected first).';
  }
  if (error.code === '23514') return 'A value was outside what the backend allows for this record.';
  return error.message || 'Unknown error.';
}

/* Upsert (insert-or-update by id). If the database is missing a column the app
   sends (schema older than the app), drop that column and retry so the rest of
   the record still syncs, and record a warning explaining what to run. */
async function upsertRows(supabase, table, rows, warnings) {
  let current = rows;
  for (let attempt = 0; attempt < 10; attempt++) {
    const { error } = await supabase.from(table).upsert(current, { onConflict: 'id' });
    if (!error) return { ok: true };
    const col = missingColumn(error);
    if (col && current.some(r => Object.prototype.hasOwnProperty.call(r, col))) {
      if (warnings) {
        warnings.add('The backend is missing the "' + col + '" column on "' + table + '", so that detail was saved without it. Re-run supabase/schema.sql to enable it.');
      }
      current = current.map(r => { const c = Object.assign({}, r); delete c[col]; return c; });
      continue;
    }
    return { ok: false, error };
  }
  return { ok: false, error: { message: 'The backend schema is out of date for "' + table + '". Re-run supabase/schema.sql.' } };
}

module.exports = { fetchAllRows, chunk, describeDbError, isMissingTable, missingColumn, upsertRows, PAGE };
