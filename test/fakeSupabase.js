const crypto = require('crypto');
function uid() { return crypto.randomUUID(); }

/* In-memory stand-in for the Supabase client. Supports the calls our functions
   make, and can imitate real failure modes:
     opts.missingTables : ['expenses']            -> PGRST205 on any access
     opts.columns       : { expenses: ['id',…] }  -> PGRST204 for unknown columns
     opts.unique        : { rooms: 'number' }     -> 23505 on duplicates (whole write fails)
     opts.delayMs       : 5                       -> every round trip takes this long
   Every round trip is logged in fake._log so tests can count them. */
class FakeQuery {
  constructor(db, table, ctx) {
    this.db = db; this.table = table; this.ctx = ctx;
    this.filters = []; this.mode = null; this.payload = null;
    this._single = false; this._limit = null; this._order = null; this._range = null; this._cols = null;
  }
  select(cols) { if (!this.mode) this.mode = 'select'; if (cols && cols !== '*') this._cols = String(cols).split(',').map(c => c.trim()); return this; }
  eq(col, val) { this.filters.push(row => row[col] === val); return this; }
  neq(col, val) { this.filters.push(row => row[col] !== val); return this; }
  in(col, vals) { this.filters.push(row => vals.includes(row[col])); return this; }
  gte(col, val) { this.filters.push(row => row[col] >= val); return this; }
  lte(col, val) { this.filters.push(row => row[col] <= val); return this; }
  lt(col, val) { this.filters.push(row => row[col] < val); return this; }
  limit(n) { this._limit = n; return this; }
  range(from, to) { this._range = [from, to]; return this; }
  order(col, opts) { this._order = { col, ascending: !opts || opts.ascending !== false }; return this; }
  single() { this._single = true; return this; }
  insert(payload) { this.mode = 'insert'; this.payload = payload; return this; }
  upsert(payload) { this.mode = 'upsert'; this.payload = payload; return this; }
  update(payload) { this.mode = 'update'; this.payload = payload; return this; }
  delete() { this.mode = 'delete'; return this; }

  _rows() { return (this.db[this.table] || []).filter(row => this.filters.every(f => f(row))); }

  _schemaError() {
    const o = this.ctx.opts;
    if ((o.missingTables || []).includes(this.table)) {
      return { code: 'PGRST205', message: "Could not find the table 'public." + this.table + "' in the schema cache" };
    }
    const allowed = o.columns && o.columns[this.table];
    if (allowed) {
      const wanted = new Set(this._cols || []);
      if (this.mode === 'insert' || this.mode === 'upsert' || this.mode === 'update') {
        (Array.isArray(this.payload) ? this.payload : [this.payload]).forEach(r => Object.keys(r || {}).forEach(k => wanted.add(k)));
      }
      for (const k of wanted) {
        if (!allowed.includes(k)) return { code: 'PGRST204', message: "Could not find the '" + k + "' column of '" + this.table + "' in the schema cache" };
      }
    }
    return null;
  }

  _uniqueError(items) {
    const field = this.ctx.opts.unique && this.ctx.opts.unique[this.table];
    if (!field) return null;
    const table = this.db[this.table] || [];
    const seen = new Map();
    for (const it of items) {
      const v = it[field];
      const other = table.find(r => r[field] === v && r.id !== it.id);
      if (other || (seen.has(v) && seen.get(v) !== it.id)) return { code: '23505', message: 'duplicate key value violates unique constraint' };
      seen.set(v, it.id);
    }
    return null;
  }

  async _exec() {
    this.ctx.log.push({ table: this.table, mode: this.mode });
    if (this.ctx.opts.delayMs) await new Promise(r => setTimeout(r, this.ctx.opts.delayMs));
    const err = this._schemaError();
    if (err) return { data: null, error: err };
    const table = (this.db[this.table] = this.db[this.table] || []);

    if (this.mode === 'insert' || this.mode === 'upsert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(i => Object.assign({ id: uid() }, i));
      const uerr = this._uniqueError(items);
      if (uerr) return { data: null, error: uerr };
      items.forEach(item => {
        const existing = this.mode === 'upsert' ? table.find(r => r.id === item.id) : null;
        if (existing) Object.assign(existing, item); else table.push(item);
      });
      return { data: this._single ? items[0] : items, error: null };
    }
    if (this.mode === 'update') {
      const matched = this._rows();
      matched.forEach(row => Object.assign(row, this.payload));
      return { data: this._single ? matched[0] : matched, error: null };
    }
    if (this.mode === 'delete') {
      const matched = this._rows();
      this.db[this.table] = table.filter(row => !matched.includes(row));
      return { data: matched, error: null };
    }
    let rows = this._rows();
    if (this._order) {
      rows = rows.slice().sort((a, b) => {
        const av = a[this._order.col], bv = b[this._order.col];
        if (av === bv) return 0;
        return this._order.ascending ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
      });
    }
    if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
    if (this._limit != null) rows = rows.slice(0, this._limit);
    if (this._single) {
      if (!rows.length) return { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  }
  then(resolve, reject) { return this._exec().then(resolve, reject); }
}

function makeFakeSupabase(seed, opts) {
  const db = JSON.parse(JSON.stringify(seed || {}));
  const ctx = { opts: opts || {}, log: [] };
  return {
    _db: db,
    _log: ctx.log,
    from(table) { return new FakeQuery(db, table, ctx); },
    async rpc(name) {
      if (name === 'next_invoice_number') {
        db.counters = db.counters || [{ name: 'invoice', value: 0 }];
        const counter = db.counters.find(c => c.name === 'invoice');
        counter.value += 1;
        return { data: 'INV-' + String(counter.value).padStart(4, '0'), error: null };
      }
      return { data: null, error: { message: 'unknown rpc ' + name } };
    },
  };
}
module.exports = { makeFakeSupabase };
