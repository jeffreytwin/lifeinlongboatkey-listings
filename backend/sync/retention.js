import wixData from 'wix-data';
import { logEvent } from 'backend/sync/events.js';

// Retention for the audit collections. SyncRuns gets ~25 rows a day and
// SyncEvents anywhere from a handful to a few hundred, so without a purge
// they grow forever. Runs from nightlyFull after the reconcile, and on demand
// via POST /_functions/purgeOld or the purgeOldAudit test-panel function.

const RUNS = 'SyncRuns';
const EVENTS = 'SyncEvents';

export const RUNS_RETENTION_DAYS = 90;
export const EVENTS_RETENTION_DAYS = 30;
// Never purge below this many runs, whatever their age. The incremental
// job's "since" watermark is the newest ok run, and the health feed reads
// the newest 24, so the recent tail must always survive.
export const KEEP_NEWEST_RUNS = 50;

const CHUNK = 500;
const DEFAULT_BUDGET_MS = 20 * 1000;

function daysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d;
}

// Delete rows in `collection` whose `dateField` is older than `cutoff`, in
// bulkRemove chunks, until none remain or the deadline passes.
async function purgeBefore(collection, dateField, cutoff, deadline) {
    let deleted = 0;
    let remaining = false;
    while (true) {
        if (Date.now() >= deadline) { remaining = true; break; }
        const res = await wixData.query(collection)
            .lt(dateField, cutoff)
            .ascending(dateField)
            .fields('_id')
            .limit(CHUNK)
            .find({ suppressAuth: true });
        if (!res.items.length) break;
        const ids = res.items.map(i => i._id);
        const r = await wixData.bulkRemove(collection, ids, { suppressAuth: true });
        const n = r && typeof r.removed === 'number' ? r.removed : ids.length;
        deleted += n;
        if (n === 0) break; // nothing removable; avoid a hot loop
        if (res.items.length < CHUNK) break;
    }
    return { deleted, remaining };
}

// The runs cutoff is the retention age, pulled earlier if that would leave
// fewer than KEEP_NEWEST_RUNS rows.
async function runsCutoff() {
    const ageCutoff = daysAgo(RUNS_RETENTION_DAYS);
    const newest = await wixData.query(RUNS)
        .descending('startedAt')
        .fields('startedAt')
        .limit(KEEP_NEWEST_RUNS)
        .find({ suppressAuth: true });
    if (newest.items.length < KEEP_NEWEST_RUNS) return null; // too few rows to purge anything
    const oldestKept = newest.items[newest.items.length - 1].startedAt;
    const floor = oldestKept ? new Date(oldestKept) : null;
    if (floor && floor < ageCutoff) return floor;
    return ageCutoff;
}

export async function purgeOld(deadline) {
    const effectiveDeadline = deadline || (Date.now() + DEFAULT_BUDGET_MS);
    const startedAt = new Date();
    const result = {
        startedAt,
        runsCutoff: null,
        eventsCutoff: daysAgo(EVENTS_RETENTION_DAYS),
        runsDeleted: 0,
        eventsDeleted: 0,
        remaining: false,
        error: null
    };
    try {
        const cutoff = await runsCutoff();
        result.runsCutoff = cutoff;
        if (cutoff) {
            const r = await purgeBefore(RUNS, 'startedAt', cutoff, effectiveDeadline);
            result.runsDeleted = r.deleted;
            result.remaining = result.remaining || r.remaining;
        }
        const e = await purgeBefore(EVENTS, 'at', result.eventsCutoff, effectiveDeadline);
        result.eventsDeleted = e.deleted;
        result.remaining = result.remaining || e.remaining;
    } catch (err) {
        result.error = err && err.message ? err.message : String(err);
    }

    // Always written, so a starved or failing purge is visible, not silent.
    await logEvent(result.error ? 'error' : 'info', 'purge',
        result.error
            ? `Retention purge failed: ${result.error}`
            : `Purged ${result.runsDeleted} SyncRuns (older than ${result.runsCutoff ? new Date(result.runsCutoff).toISOString().slice(0, 10) : 'nothing to purge'}) and ${result.eventsDeleted} SyncEvents (older than ${result.eventsCutoff.toISOString().slice(0, 10)})${result.remaining ? '; more remain for the next pass' : ''}`,
        { mode: 'retention', runKey: `retention:${startedAt.toISOString()}`, details: result });
    return result;
}
