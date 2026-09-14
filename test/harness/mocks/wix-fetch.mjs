export const fetchLog = [];
export let fetchImpl = async (url, opts) => { fetchLog.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ rowId: JSON.parse(opts.body || '{}').rowId, status: 'partial', processed: 0, failed: 0 }), text: async () => '' }; };
export function setFetch(fn) { fetchImpl = fn; }
export function fetch(url, opts) { return fetchImpl(url, opts); }
