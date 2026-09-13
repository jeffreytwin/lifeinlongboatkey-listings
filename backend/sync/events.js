import wixData from 'wix-data';

// Listing-level event log. One SyncEvents row per notable thing the pipeline
// does or sees: a listing inserted/updated/deleted (with the reason and the
// field diff), a photo batch that failed (with the URLs and error), a run
// that errored (with the stage and stack), a scheduling gap, a purge.
//
// SyncRuns stays the per-run summary (counts); SyncEvents is the detail
// behind those counts. Rows join on runKey.
//
// Only plain data crosses this module's boundary (rows in, counts out).
// This codebase has been bitten by Wix's module cache / web-method proxying
// when an export returned an object carrying functions (see the inlined
// transform note in pipeline.jsw), so the per-run buffer lives as a closure
// in pipeline.jsw and calls flushEvents(rows) here. Nothing here throws.

const EVENTS = 'SyncEvents';
const FLUSH_CHUNK = 200;
const STACK_LIMIT = 2000;

// Build a SyncEvents row. fields: { runKey, mode, listingId, address,
// village, details (any JSON-able value), at (Date) }.
export function buildEventRow(level, kind, message, fields) {
    const f = fields || {};
    const row = {
        runKey: f.runKey || null,
        mode: f.mode || null,
        at: f.at instanceof Date ? f.at : new Date(),
        level,
        kind,
        message: message == null ? '' : String(message).slice(0, 1000),
        listingId: f.listingId != null ? String(f.listingId) : null,
        address: f.address != null ? String(f.address).slice(0, 300) : null,
        village: f.village != null ? String(f.village).slice(0, 200) : null,
        details: null
    };
    if (f.details !== undefined && f.details !== null) {
        try {
            row.details = JSON.stringify(f.details).slice(0, 8000);
        } catch (err) {
            row.details = String(f.details).slice(0, 8000);
        }
    }
    return row;
}

// Normalize an Error (or anything thrown) into plain fields safe to store.
export function describeError(err) {
    if (!err) return { message: 'unknown error' };
    if (typeof err === 'string') return { message: err };
    const out = { message: err.message || String(err) };
    if (err.name && err.name !== 'Error') out.name = err.name;
    if (err.stack) out.stack = String(err.stack).slice(0, STACK_LIMIT);
    if (err.code != null) out.code = err.code;
    if (err.status != null) out.status = err.status;
    return out;
}

// Persist prepared rows in bulk. Returns { inserted, failed }. Never throws;
// no retries (a retry would burn budget the sync needs more).
export async function flushEvents(rows) {
    let inserted = 0;
    let failed = 0;
    if (!Array.isArray(rows) || !rows.length) return { inserted, failed };
    for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
        const chunk = rows.slice(i, i + FLUSH_CHUNK);
        try {
            const res = await wixData.bulkInsert(EVENTS, chunk, { suppressAuth: true });
            const n = res && typeof res.inserted === 'number' ? res.inserted : chunk.length;
            inserted += n;
            failed += chunk.length - n;
            if (res && Array.isArray(res.errors) && res.errors.length) {
                console.log('SyncEvents bulkInsert partial failure:', res.errors.length, 'rows');
            }
        } catch (err) {
            failed += chunk.length;
            console.log('SyncEvents bulkInsert failed:', err && err.message);
        }
    }
    return { inserted, failed };
}

// Immediate single write for contexts that don't run inside runSync (the
// per-row Stagging HTTP calls, the media queue, the retention purge).
// Returns the inserted row or null; never throws.
export async function logEvent(level, kind, message, fields) {
    const row = buildEventRow(level, kind, message, fields);
    try {
        return await wixData.insert(EVENTS, row, { suppressAuth: true });
    } catch (err) {
        console.log('logEvent failed:', err && err.message, kind, row.listingId);
        return null;
    }
}
