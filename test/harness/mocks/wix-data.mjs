// Minimal in-memory wix-data mock: query(eq/ne/lt/ge/hasSome/descending/ascending/limit/skip/fields/find/count),
// get/insert/update/remove/bulkInsert/bulkUpdate/bulkRemove.
export const db = {};
export const ops = [];
let idc = 0;
function coll(name) { if (!db[name]) db[name] = new Map(); return db[name]; }
function cmp(a, b) { const x = a instanceof Date ? a.getTime() : a; const y = b instanceof Date ? b.getTime() : b; return x < y ? -1 : x > y ? 1 : 0; }
class Query {
  constructor(name) { this.name = name; this.filters = []; this.sorts = []; this._limit = 50; this._skip = 0; }
  eq(f, v) { this.filters.push(i => i[f] === v); return this; }
  ne(f, v) { this.filters.push(i => i[f] !== v); return this; }
  lt(f, v) { this.filters.push(i => i[f] != null && cmp(i[f], v) < 0); return this; }
  ge(f, v) { this.filters.push(i => i[f] != null && cmp(i[f], v) >= 0); return this; }
  le(f, v) { this.filters.push(i => i[f] != null && cmp(i[f], v) <= 0); return this; }
  gt(f, v) { this.filters.push(i => i[f] != null && cmp(i[f], v) > 0); return this; }
  hasSome(f, vs) { this.filters.push(i => Array.isArray(i[f]) ? i[f].some(x => vs.includes(x)) : vs.includes(i[f])); return this; }
  descending(f) { this.sorts.push({ f, d: -1 }); return this; }
  ascending(f) { this.sorts.push({ f, d: 1 }); return this; }
  limit(n) { this._limit = n; return this; }
  skip(n) { this._skip = n; return this; }
  fields() { return this; }
  _all() {
    let items = [...coll(this.name).values()].filter(i => this.filters.every(f => f(i)));
    if (this.sorts.length) items.sort((a, b) => { for (const s of this.sorts) { const c = cmp(a[s.f], b[s.f]) * s.d; if (c) return c; } return 0; });
    return items;
  }
  async find() { const all = this._all(); const page = all.slice(this._skip, this._skip + this._limit).map(i => ({ ...i })); const more = all.length > this._skip + this._limit; return { items: page, totalCount: all.length, hasNext: () => more }; }
  async count() { return this._all().length; }
}
const failOn = { insert: null, update: null };
export function setFail(op, fn) { failOn[op] = fn; }
const wixData = {
  query: (n) => new Query(n),
  async get(n, id) { const i = coll(n).get(id); if (!i) throw new Error('not found'); return { ...i }; },
  async insert(n, item) { ops.push(['insert', n, item._id]); if (failOn.insert && failOn.insert(n, item)) throw new Error(`mock insert failure ${n}`); const row = { ...item, _id: item._id || `id${++idc}`, _createdDate: item._createdDate || new Date(), _updatedDate: new Date() }; coll(n).set(row._id, row); return row; },
  async update(n, item) { ops.push(['update', n, item._id]); if (failOn.update && failOn.update(n, item)) throw new Error(`mock update failure ${n}`); const prev = coll(n).get(item._id) || {}; const row = { ...item, _createdDate: prev._createdDate || new Date(), _updatedDate: new Date() }; coll(n).set(row._id, row); return row; },
  async remove(n, id) { ops.push(['remove', n, id]); if (!coll(n).has(id)) throw new Error('not found'); coll(n).delete(id); return { _id: id }; },
  async bulkInsert(n, items) { let inserted = 0; for (const it of items) { await this.insert(n, it); inserted++; } return { inserted }; },
  async bulkUpdate(n, items) { let updated = 0; for (const it of items) { await this.update(n, it); updated++; } return { updated }; },
  async bulkRemove(n, ids) { let removed = 0; for (const id of ids) { if (coll(n).delete(id)) removed++; } return { removed }; },
};
export default wixData;
