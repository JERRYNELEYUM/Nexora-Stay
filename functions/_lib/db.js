/* Shared database helpers used by Cloudflare push / sync / report.
   Preserves the original pagination, error handling and upsert behaviour. */

const PAGE = 1000;

export async function fetchAllRows(supabase, table, options) {
  const opts = options || {};
  const select = opts.select || "*";
  const out = [];
  let from = 0;

  for (;;) {
    let q = supabase.from(table).select(select);
    if (opts.filter) q = opts.filter(q);

    const { data, error } = await q
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) return { data: out, error };

    out.push(...(data || []));
    if (!data || data.length < PAGE) break;

    from += PAGE;
  }

  return { data: out, error: null };
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

export function missingColumn(error) {
  if (!error) return null;

  const msg = String(error.message || "");

  if (error.code === "PGRST204" || error.code === "42703") {
    const m = msg.match(/'([^']+)' column/) || msg.match(/column "([^"]+)"/);
    return m ? m[1] : null;
  }

  return null;
}

export function isMissingTable(error) {
  return !!error && (error.code === "PGRST205" || error.code === "42P01");
}

export function describeDbError(table, error) {
  if (!error) return "Unknown error.";

  if (isMissingTable(error)) {
    return 'The backend database is missing the "' + table + '" table. Check the existing Supabase schema; do not rerun migrations during this migration.';
  }

  const col = missingColumn(error);

  if (col) {
    return 'The backend database is missing the "' + col + '" column on "' + table + '". Check the existing Supabase schema before making any database changes.';
  }

  if (error.code === "23505") {
    if (table === "rooms") return "A room with that number already exists on the backend.";
    if (table === "invoices") return "The backend already has a different invoice for this booking.";
    return "The backend already has a conflicting record (duplicate).";
  }

  if (error.code === "23503") {
    return "Refers to a record that is not on the backend yet (the record it belongs to may have been rejected first).";
  }

  if (error.code === "23514") {
    return "A value was outside what the backend allows for this record.";
  }

  return error.message || "Unknown error.";
}

/* Upsert by id. If a sent column is absent from the database,
   retry without that column and record a warning. */
export async function upsertRows(supabase, table, rows, warnings) {
  let current = rows;

  for (let attempt = 0; attempt < 10; attempt++) {
    const { error } = await supabase
      .from(table)
      .upsert(current, { onConflict: "id" });

    if (!error) return { ok: true };

    const col = missingColumn(error);

    if (col && current.some(r => Object.prototype.hasOwnProperty.call(r, col))) {
      if (warnings) {
        warnings.add('The backend is missing the "' + col + '" column on "' + table + '", so that detail was saved without it. Check the existing Supabase schema before making any database changes.');
      }

      current = current.map(r => {
        const c = Object.assign({}, r);
        delete c[col];
        return c;
      });

      continue;
    }

    return { ok: false, error };
  }

  return {
    ok: false,
    error: { message: 'The backend schema is out of date for "' + table + '".' },
  };
}

export { PAGE };
