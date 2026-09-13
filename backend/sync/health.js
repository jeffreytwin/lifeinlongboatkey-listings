import wixData from 'wix-data';
import { SITE_KEY, SITE_NAME, SITE_URL, CODE_VERSION, INCREMENTAL_EVERY_MINUTES, FULL_RUN_HOUR_UTC, RUN_LATE_AFTER_MINUTES } from 'backend/sync/site-config.js';

// Health feed for the external ops app (Frontlines). Served by
// GET /_functions/listingsHealth. Everything an operator needs to judge one
// site in one call, plus a server-computed `alerts` list so all four sites
// are judged by identical rules and the poller only renders.
//
// Every section is fault-isolated: a missing collection or a bad field on a
// freshly ported site produces a `feedErrors` entry and a MISCONFIGURED
// alert, never a 500. Alerts carry a stable `code`, a `key` (code, or
// code:listingId for per-listing ones), an always-populated `since`, and a
// `count` where one applies. Severity: critical | warning | info.

const RUNS = 'SyncRuns';
const EVENTS = 'SyncEvents';
const HOUSES = 'HousesforSale';
const STAGGING = 'Stagging';

export const SCHEMA_VERSION = 2;
const RECENT_RUNS = 24;
const STUCK_STAGGING_HOURS = 3;
const STAGGING_SCAN = 1000;
const STUCK_LIST_CAP = 20;
const EVENTS_DEFAULT = 50;
const EVENTS_MAX = 200;
const QUERY_EVENTS_MAX = 500;
const MLSGRID_VOLUME_HIGH = 3000;
const REPEATED_FAILURES = 2;
const RUN_INCOMPLETE_AFTER_MINUTES = 3;
const PHOTOS_FAILING_RUNS = 3;
const FULL_RUN_WARN_HOURS = 26;
const FULL_RUN_CRITICAL_HOURS = 50;
const PULL_DATE_MAX_HOURS = 12;
const STATS_STALE_HOURS = 6;
const MASS_DELETE_MIN = 10;
const MASS_DELETE_SHARE = 0.10;

const LEVELS = ['info', 'warn', 'error'];

function minutesBetween(later, earlier) {
    if (!later || !earlier) return null;
    return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / 6000) / 10;
}

function hoursBetween(later, earlier) {
    const m = minutesBetween(later, earlier);
    return m == null ? null : Math.round(m / 6) / 10;
}

function isPendingPhoto(item) {
    return !!(item && typeof item.src === 'string' && item.src.startsWith('http'));
}

// Same test as compare.jsw's isLivePipelineRow: rows this pipeline wrote
// carry isPublished; legacy Redfin-audit rows do not.
function isPipelineRow(row) {
    if (Object.prototype.hasOwnProperty.call(row, 'isPublished')) return true;
    const g = row.listingImageGallery;
    if (Array.isArray(g) && g.length) return typeof g[0].src === 'string';
    return false;
}

function trimRun(run) {
    if (!run) return null;
    const dur = run.durationMs != null ? run.durationMs
        : (run.finishedAt && run.startedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null);
    return {
        id: run._id,
        runKey: run.runKey || null,
        mode: run.mode,
        status: run.status,
        stage: run.stage || null,
        trigger: run.trigger || null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt || null,
        durationMs: dur,
        inserted: run.inserted || 0,
        updated: run.updated || 0,
        deleted: run.deleted || 0,
        unstaged: run.unstaged || 0,
        deletesSkipped: run.deletesSkipped || 0,
        promoted: run.promoted || 0,
        imagesUploaded: run.imagesUploaded || 0,
        imagesFailed: run.imagesFailed || 0,
        imagesTrashed: run.imagesTrashed || 0,
        datesRefreshed: run.datesRefreshed || 0,
        statsRefreshed: !!run.statsRefreshed,
        writesFailed: run.writesFailed || 0,
        drainErrors: run.drainErrors || 0,
        warnings: run.warnings || 0,
        errors: run.errors || 0,
        eventsStored: run.eventsStored || 0,
        eventsFailed: run.eventsFailed || 0,
        gapMinutes: run.gapMinutes != null ? run.gapMinutes : null,
        fetchWindowMinutes: run.fetchWindowMinutes != null ? run.fetchWindowMinutes : null,
        mlsGridRequestCount: run.mlsGridRequestCount || 0,
        mlsGridListingCount: run.mlsGridListingCount || 0,
        mlsGridItemsFetched: run.mlsGridItemsFetched || 0,
        errorStage: run.errorStage || null,
        errorMessage: run.errorMessage || null
    };
}

function trimEvent(ev) {
    let details = null;
    if (ev.details) {
        try { details = JSON.parse(ev.details); } catch (err) { details = ev.details; }
    }
    return {
        id: ev._id,
        at: ev.at,
        level: ev.level,
        kind: ev.kind,
        mode: ev.mode || null,
        runKey: ev.runKey || null,
        listingId: ev.listingId || null,
        address: ev.address || null,
        village: ev.village || null,
        message: ev.message,
        details
    };
}

function parseTime(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

function clampInt(v, dflt, max) {
    const n = parseInt(v, 10);
    if (!isFinite(n) || n <= 0) return dflt;
    return Math.min(n, max);
}

function levelsAtOrAbove(level) {
    const idx = LEVELS.indexOf(String(level || '').toLowerCase());
    return idx === -1 ? LEVELS.slice(1) : LEVELS.slice(idx);
}

function hostOf(url) {
    const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : null;
}

// Paged event query (newest first). Options (strings, from the query string):
//   since / before  ISO timestamps; both inclusive. `before` is inclusive
//                   because `at` is not unique (events pushed back-to-back
//                   share a millisecond); an exclusive bound would skip the
//                   rest of a tie group at a page boundary. The poller
//                   dedupes on event id and stops when a page adds nothing.
//   skip            exact paging offset within the filtered, totally ordered
//                   (at desc, _id desc) result; the response's nextSkip is
//                   the value for the next page. Prefer this to `before`
//                   when a page must be exact.
//   level           minimum level, default info
//   limit           default 100, max 500
//   kind, listingId, runKey, mode   exact-match filters
// Returns { events, count, hasMore, nextBefore, nextSkip, newestAt }. The
// poller keeps newestAt as its next `since` and dedupes on event id.
export async function queryEvents(opts) {
    const o = opts || {};
    const limit = clampInt(o.limit, 100, QUERY_EVENTS_MAX);
    const skip = Math.max(0, parseInt(o.skip, 10) || 0);
    let q = wixData.query(EVENTS).descending('at').descending('_id').limit(limit).skip(skip);
    const since = parseTime(o.since);
    const before = parseTime(o.before);
    if (o.since && !since) return { site: SITE_KEY, error: 'since is not a valid ISO timestamp', count: 0, hasMore: false, nextBefore: null, newestAt: null, events: [] };
    if (since) q = q.ge('at', since);
    if (before) q = q.le('at', before);
    const levels = levelsAtOrAbove(o.level || 'info');
    if (levels.length < LEVELS.length) q = q.hasSome('level', levels);
    for (const f of ['kind', 'listingId', 'runKey', 'mode']) {
        if (o[f]) q = q.eq(f, String(o[f]));
    }
    const res = await q.find({ suppressAuth: true });
    const events = res.items.map(trimEvent);
    const hasMore = !!res.hasNext();
    return {
        site: SITE_KEY,
        count: events.length,
        hasMore,
        truncated: hasMore,
        nextBefore: events.length && hasMore ? events[events.length - 1].at : null,
        nextSkip: hasMore ? skip + events.length : null,
        newestAt: events.length ? events[0].at : null,
        events
    };
}

async function stuckStagging(now) {
    const res = await wixData.query(STAGGING)
        .ascending('_createdDate')
        .limit(STAGGING_SCAN)
        .find({ suppressAuth: true });
    let legacy = 0;
    let oldestLegacyAt = null;
    const rows = [];
    for (const row of res.items) {
        if (!isPipelineRow(row)) {
            legacy += 1;
            if (row._createdDate && (!oldestLegacyAt || new Date(row._createdDate) < new Date(oldestLegacyAt))) oldestLegacyAt = row._createdDate;
            continue;
        }
        const gallery = Array.isArray(row.listingImageGallery) ? row.listingImageGallery : [];
        const pending = gallery.filter(isPendingPhoto).length;
        const ageHours = row._createdDate ? hoursBetween(now, row._createdDate) : null;
        const failStreak = typeof row.photoFailStreak === 'number' ? row.photoFailStreak : 0;
        const lastFailHours = row.lastPhotoFailAt ? hoursBetween(now, row.lastPhotoFailAt) : null;
        const retryAfter = row.photoRetryAfter && new Date(row.photoRetryAfter).getTime() > now.getTime() ? row.photoRetryAfter : null;
        let diagnosis;
        if (retryAfter) diagnosis = `MLSGrid media rate-limited this gallery (HTTP 429, ${failStreak} consecutive attempts); paused until ${new Date(retryAfter).toISOString()} and then retried`;
        else if (gallery.length === 0) diagnosis = 'empty gallery: staged when MLSGrid sent no photos; nothing to upload so it never publishes (delete the row, or wait for the listing to change in the MLS)';
        else if (pending === 0) diagnosis = 'all photos hosted but not promoted: promotion is failing, see promote_failed events';
        else if (failStreak > 0 && /\b429\b|too many requests/i.test(row.photoFailSignature || '')) diagnosis = `MLSGrid media is rate-limiting this gallery (HTTP 429, ${failStreak} consecutive attempts); the drain retries at lower concurrency and it should complete on its own`;
        else if (failStreak > 0) diagnosis = `photos keep failing to upload (${failStreak} consecutive attempts${row.photoFailSignature ? `: ${row.photoFailSignature}` : ''}); see photos_failed events`;
        else if (lastFailHours != null && lastFailHours < 2) diagnosis = 'some photos failing, retrying';
        else diagnosis = 'pending photos never attempted: the drain is not reaching this row (check drain_failed events / SYNC_TRIGGER_SECRET / SITE_URL)';
        rows.push({
            listingId: row._id,
            address: row.propertyAddress || null,
            village: row.village || null,
            price: row.listingPricePure != null ? row.listingPricePure : null,
            createdAt: row._createdDate || null,
            updatedAt: row._updatedDate || null,
            ageHours,
            photos: gallery.length,
            pendingPhotos: pending,
            galleryEmpty: gallery.length === 0,
            failStreak,
            retryAfter,
            lastFailAt: row.lastPhotoFailAt || null,
            lastError: row.photoFailSignature || null,
            diagnosis
        });
    }
    const stuck = rows.filter(r => r.ageHours != null && r.ageHours >= STUCK_STAGGING_HOURS);
    return {
        scanned: res.items.length,
        pipelineRows: rows.length,
        legacyRows: legacy,
        oldestLegacyAt,
        stuck
    };
}

function buildAlerts(ctx) {
    const { now, runs, lastRun, lastOkRun, lastOkFullRun, counts, stuck, budgetWarnings, feedErrors, selfUrlOk } = ctx;
    const alerts = [];
    const add = (severity, code, message, data) => {
        const d = data || {};
        alerts.push({
            severity,
            code,
            key: d.key || code,
            message,
            since: d.since || now,
            ...(d.count != null ? { count: d.count } : {}),
            ...(d.extra || {})
        });
    };

    if (feedErrors.length) {
        add('warning', 'MISCONFIGURED', `The health feed could not read ${feedErrors.map(e => e.section).join(', ')}: ${feedErrors[0].message}. Collections or fields are probably missing on this site`, { count: feedErrors.length, extra: { sections: feedErrors } });
    }
    if (selfUrlOk === false) {
        add('warning', 'SITE_IDENTITY_MISMATCH', `This site's code says SITE_URL is ${SITE_URL} but it was polled at a different host; a copy/paste site-config would send its photo drain to the wrong site`, {});
    }

    if (!lastRun) {
        add('critical', 'NO_RUNS_RECORDED', 'No sync runs have ever been recorded on this site');
        return alerts;
    }

    const sinceLast = minutesBetween(now, lastRun.startedAt);
    if (sinceLast != null && sinceLast > RUN_LATE_AFTER_MINUTES) {
        add('critical', 'NO_RECENT_RUN', `No sync run for ${Math.round(sinceLast)} min (expected every ${INCREMENTAL_EVERY_MINUTES}); the scheduler is not firing or the backend is not deploying`, { since: lastRun.startedAt, count: Math.round(sinceLast) });
    }

    const isKilled = r => r.status === 'running' && (minutesBetween(now, r.startedAt) || 0) > RUN_INCOMPLETE_AFTER_MINUTES;
    const isFailed = r => r.status === 'error' || isKilled(r);
    const killed = runs.find(isKilled);
    if (killed) {
        add('critical', 'RUN_INCOMPLETE', `${killed.mode} run started ${Math.round(minutesBetween(now, killed.startedAt))} min ago never finished (last stage: ${killed.stage || 'unknown'}); it was most likely killed by the Wix invocation timeout`, { since: killed.startedAt, extra: { runKey: killed.runKey || null, stage: killed.stage || null } });
    }

    if (lastRun.status === 'error') {
        add('warning', 'LAST_RUN_FAILED', `Latest ${lastRun.mode} run failed${lastRun.errorStage ? ` during ${lastRun.errorStage}` : ''}: ${lastRun.errorMessage || 'no message'}`, { since: lastRun.startedAt, extra: { runKey: lastRun.runKey || null, mode: lastRun.mode } });
    }

    const newest = runs.slice(0, REPEATED_FAILURES);
    if (newest.length === REPEATED_FAILURES && newest.every(isFailed)) {
        add('critical', 'REPEATED_FAILURES', `The last ${REPEATED_FAILURES} runs both failed or never finished (${newest.map(r => r.errorMessage || r.status).join(' | ')})`, { since: newest[newest.length - 1].startedAt, count: REPEATED_FAILURES });
    }

    const sinceOk = minutesBetween(now, lastOkRun && lastOkRun.startedAt);
    if (lastOkRun && sinceOk != null && sinceOk > RUN_LATE_AFTER_MINUTES && !(sinceLast != null && sinceLast > RUN_LATE_AFTER_MINUTES)) {
        add('warning', 'NO_RECENT_OK_RUN', `Runs are happening but none has succeeded for ${Math.round(sinceOk)} min`, { since: lastOkRun.startedAt, count: Math.round(sinceOk) });
    }
    if (!runs.some(r => r.status === 'ok')) {
        add('warning', 'NO_OK_RUN_IN_WINDOW', `None of the last ${runs.length} run${runs.length === 1 ? '' : 's'} succeeded`, { since: runs[runs.length - 1].startedAt, count: runs.length });
    }

    const fullAgeHours = lastOkFullRun ? hoursBetween(now, lastOkFullRun.startedAt) : null;
    if (!lastOkFullRun) {
        add('warning', 'NO_RECENT_FULL_RUN', 'No successful nightly full reconcile on record; listings MLSGrid silently drops are only removed by the full run', {});
    } else if (fullAgeHours != null && fullAgeHours > FULL_RUN_CRITICAL_HOURS) {
        add('critical', 'NO_RECENT_FULL_RUN', `Last successful full reconcile was ${Math.round(fullAgeHours)}h ago (expected nightly)`, { since: lastOkFullRun.startedAt, count: Math.round(fullAgeHours) });
    } else if (fullAgeHours != null && fullAgeHours > FULL_RUN_WARN_HOURS) {
        add('warning', 'NO_RECENT_FULL_RUN', `Last successful full reconcile was ${Math.round(fullAgeHours)}h ago (expected nightly)`, { since: lastOkFullRun.startedAt, count: Math.round(fullAgeHours) });
    }

    if (typeof lastRun.gapMinutes === 'number' && lastRun.gapMinutes > RUN_LATE_AFTER_MINUTES) {
        add('warning', 'SCHEDULE_GAP', `The latest run followed a ${Math.round(lastRun.gapMinutes)} min gap with no runs recorded`, { since: lastRun.startedAt, count: Math.round(lastRun.gapMinutes) });
    }

    if (counts.housesForSale === 0) {
        add('critical', 'ZERO_INVENTORY', 'HousesforSale is empty: the site is showing no listings', { since: lastRun.startedAt });
    }

    // Mass delete: any run in the last 24h, not just the newest, so a wipe
    // on the nightly is still visible at mid-morning.
    const live = counts.housesForSale != null ? counts.housesForSale : 0;
    const dayAgo = now.getTime() - 24 * 3600000;
    for (const r of runs) {
        if (!r.startedAt || new Date(r.startedAt).getTime() < dayAgo) continue;
        if ((r.deletesSkipped || 0) > 0) {
            add('critical', 'MASS_DELETE_BLOCKED', `A ${r.mode} run wanted to delete ${r.deletesSkipped} listings and was stopped by the mass-delete guard; review the mass_delete_guard event and re-run with force=1 if the MLS is right`, { since: r.startedAt, count: r.deletesSkipped, extra: { runKey: r.runKey || null } });
            break;
        }
        const threshold = Math.max(MASS_DELETE_MIN, Math.ceil((live + (r.deleted || 0)) * MASS_DELETE_SHARE));
        if ((r.deleted || 0) >= threshold) {
            add('critical', 'MASS_DELETE', `A ${r.mode} run deleted ${r.deleted} listings (threshold ${threshold}); read its delete events before assuming the MLS is right`, { since: r.startedAt, count: r.deleted, extra: { runKey: r.runKey || null } });
            break;
        }
    }

    if ((lastRun.writesFailed || 0) > 0) {
        add('warning', 'WRITES_FAILING', `${lastRun.writesFailed} listing write${lastRun.writesFailed === 1 ? '' : 's'} failed in the latest run; see write_failed events`, { since: lastRun.startedAt, count: lastRun.writesFailed });
    } else if ((lastRun.errors || 0) > 0 && lastRun.status !== 'error') {
        add('warning', 'ERRORS_IN_RUN', `${lastRun.errors} error event${lastRun.errors === 1 ? '' : 's'} in the latest run (it completed); see error-level events`, { since: lastRun.startedAt, count: lastRun.errors });
    }

    if ((lastRun.drainErrors || 0) > 0) {
        add('warning', 'DRAIN_FAILING', `The photo drain's self-calls failed in the latest run (${lastRun.drainErrors}); nothing will publish until SITE_URL / SYNC_TRIGGER_SECRET are right. See drain_failed events`, { since: lastRun.startedAt, count: lastRun.drainErrors });
    }

    if ((lastRun.eventsFailed || 0) > 0 || (((lastRun.warnings || 0) + (lastRun.errors || 0)) > 0 && (lastRun.eventsStored || 0) === 0)) {
        add('warning', 'EVENTS_NOT_STORED', `The latest run could not persist its events (${lastRun.eventsFailed || 0} failed, ${lastRun.eventsStored || 0} stored); check that the SyncEvents collection exists with the documented fields`, { since: lastRun.startedAt, count: lastRun.eventsFailed || 0 });
    }

    const okRuns = runs.filter(r => r.status === 'ok');
    const recentOk = okRuns.slice(0, PHOTOS_FAILING_RUNS);
    if (recentOk.length === PHOTOS_FAILING_RUNS && recentOk.every(r => (r.imagesFailed || 0) > 0 && (r.imagesUploaded || 0) === 0 && (r.promoted || 0) === 0)) {
        add('warning', 'PHOTOS_FAILING', `Photo uploads failed on each of the last ${PHOTOS_FAILING_RUNS} runs with nothing getting through (${recentOk.map(r => r.imagesFailed).join(', ')} failed)`, { since: recentOk[recentOk.length - 1].startedAt, count: recentOk.reduce((a, r) => a + (r.imagesFailed || 0), 0) });
    }

    const noPhotos = stuck.stuck.filter(s => s.galleryEmpty);
    const failing = stuck.stuck.filter(s => !s.galleryEmpty);
    if (failing.length) {
        add('warning', 'STAGGING_STUCK', `${failing.length} listing${failing.length === 1 ? '' : 's'} stuck in Stagging for ${STUCK_STAGGING_HOURS}h+ with photos still pending; oldest: ${failing[0].address || failing[0].listingId} (${failing[0].ageHours}h, ${failing[0].diagnosis})`, {
            since: failing[0].createdAt, count: failing.length, extra: { listingIds: failing.slice(0, STUCK_LIST_CAP).map(s => s.listingId) }
        });
    }
    if (noPhotos.length) {
        add('warning', 'STAGGING_NO_PHOTOS', `${noPhotos.length} staged listing${noPhotos.length === 1 ? '' : 's'} ${noPhotos.length === 1 ? 'has' : 'have'} an empty gallery and can never publish; oldest: ${noPhotos[0].address || noPhotos[0].listingId} (${noPhotos[0].ageHours}h). Delete the row(s); they re-stage when the listing next changes`, {
            since: noPhotos[0].createdAt, count: noPhotos.length, extra: { listingIds: noPhotos.slice(0, STUCK_LIST_CAP).map(s => s.listingId) }
        });
    }
    if (stuck.legacyRows > 0) {
        add('info', 'STAGGING_LEGACY_ROWS', `${stuck.legacyRows} legacy (Redfin-audit) rows sit in Stagging; the drain skips them but they cost a wasted wave each hour. Bulk-delete when the audit is done`, { since: stuck.oldestLegacyAt || undefined, count: stuck.legacyRows });
    }

    if (counts.stalePullDates != null && counts.stalePullDates > 0) {
        const share = live ? counts.stalePullDates / live : 1;
        add(share > MASS_DELETE_SHARE ? 'critical' : 'warning', 'STALE_PULL_DATES', `${counts.stalePullDates} live listing${counts.stalePullDates === 1 ? '' : 's'} carry a dateOfMlsPull older than ${PULL_DATE_MAX_HOURS}h (MLSGrid compliance); the end-of-run sweep is not completing`, { since: lastOkRun ? lastOkRun.startedAt : lastRun.startedAt, count: counts.stalePullDates });
    }

    const sixHoursAgo = now.getTime() - STATS_STALE_HOURS * 3600000;
    const okInWindow = okRuns.filter(r => r.startedAt && new Date(r.startedAt).getTime() >= sixHoursAgo);
    if (okInWindow.length && !okInWindow.some(r => r.statsRefreshed)) {
        add('warning', 'STATS_STALE', `No run in the last ${STATS_STALE_HOURS}h completed the neighborhood range stats refresh; the Google Ads inventory feed may be pausing/enabling on stale counts`, { since: okInWindow[okInWindow.length - 1].startedAt, count: okInWindow.length });
    }

    if (budgetWarnings > 0) {
        add('info', 'BUDGET_EXHAUSTED', `The latest run ran out of time before ${budgetWarnings} of its sweeps; occasional is normal, constant means the run is too slow`, { since: lastRun.startedAt, count: budgetWarnings });
    }

    if (lastRun.mode === 'incremental' && (lastRun.mlsGridListingCount || 0) > (lastRun.mlsGridItemsFetched || 0) && (lastRun.mlsGridItemsFetched || 0) > 0) {
        add('warning', 'FEED_TRUNCATED', `Latest incremental expected ${lastRun.mlsGridListingCount} MLS records but received ${lastRun.mlsGridItemsFetched}; paging stopped early, so changes may have been missed until the nightly full`, { since: lastRun.startedAt, count: lastRun.mlsGridListingCount - lastRun.mlsGridItemsFetched });
    }
    if (lastRun.mode === 'incremental' && (lastRun.mlsGridListingCount || 0) > MLSGRID_VOLUME_HIGH) {
        add('info', 'MLSGRID_VOLUME_HIGH', `Latest incremental pulled ${lastRun.mlsGridListingCount} MLS-wide records over a ${lastRun.fetchWindowMinutes != null ? lastRun.fetchWindowMinutes + ' min' : 'unknown'} window (${lastRun.mlsGridRequestCount} requests); large windows slow the run`, { since: lastRun.startedAt, count: lastRun.mlsGridListingCount });
    }

    if (counts.published != null && counts.housesForSale != null && counts.published < counts.housesForSale) {
        add('info', 'UNPUBLISHED_LIVE_ROWS', `${counts.housesForSale - counts.published} HousesforSale rows are not flagged published`, { since: lastRun.startedAt, count: counts.housesForSale - counts.published });
    }

    return alerts;
}

async function section(name, feedErrors, fn, fallback) {
    try {
        return await fn();
    } catch (err) {
        feedErrors.push({ section: name, message: err && err.message ? err.message : String(err) });
        return fallback;
    }
}

export async function buildHealthReport(opts) {
    const o = opts || {};
    const now = new Date();
    const feedErrors = [];

    const runs = await section('SyncRuns', feedErrors, async () => {
        const res = await wixData.query(RUNS).descending('startedAt').limit(RECENT_RUNS + 4).find({ suppressAuth: true });
        // One row per runKey, preferring a terminal status over 'running',
        // in case a run had to re-insert its row after a failed update.
        const byKey = new Map();
        const out = [];
        for (const r of res.items) {
            const k = r.runKey || r._id;
            const prev = byKey.get(k);
            if (!prev) { byKey.set(k, r); out.push(r); continue; }
            if (prev.status === 'running' && r.status !== 'running') {
                out[out.indexOf(prev)] = r;
                byKey.set(k, r);
            }
        }
        return out.slice(0, RECENT_RUNS);
    }, []);
    const lastRun = runs[0] || null;
    let lastOkRun = runs.find(r => r.status === 'ok') || null;
    if (!lastOkRun && runs.length) {
        lastOkRun = await section('SyncRuns (last ok)', feedErrors, async () => {
            const okRes = await wixData.query(RUNS).eq('status', 'ok').descending('startedAt').limit(1).find({ suppressAuth: true });
            return okRes.items[0] || null;
        }, null);
    }
    const lastOkFullRun = await section('SyncRuns (last full)', feedErrors, async () => {
        const res = await wixData.query(RUNS).eq('mode', 'full').eq('status', 'ok').descending('startedAt').limit(1).find({ suppressAuth: true });
        return res.items[0] || null;
    }, null);

    const pullCutoff = new Date(now.getTime() - PULL_DATE_MAX_HOURS * 3600000);
    const [housesForSale, published, stagging, stalePullDates] = await Promise.all([
        section('HousesforSale count', feedErrors, () => wixData.query(HOUSES).count({ suppressAuth: true }), null),
        section('HousesforSale published count', feedErrors, () => wixData.query(HOUSES).eq('isPublished', true).count({ suppressAuth: true }), null),
        section('Stagging count', feedErrors, () => wixData.query(STAGGING).count({ suppressAuth: true }), null),
        section('HousesforSale stale pull dates', feedErrors, () => wixData.query(HOUSES).lt('dateOfMlsPull', pullCutoff).count({ suppressAuth: true }), null)
    ]);
    const counts = { housesForSale, published, stagging, stalePullDates };

    const stuck = await section('Stagging scan', feedErrors, () => stuckStagging(now), { scanned: 0, pipelineRows: 0, legacyRows: 0, stuck: [] });
    counts.staggingStuck = stuck.stuck.length;
    counts.staggingLegacy = stuck.legacyRows;

    let budgetWarnings = 0;
    if (lastRun && lastRun.runKey) {
        budgetWarnings = await section('SyncEvents (budget)', feedErrors, () => wixData.query(EVENTS).eq('runKey', lastRun.runKey).eq('kind', 'budget').count({ suppressAuth: true }), 0);
    }

    const eventsLimit = clampInt(o.eventsLimit, EVENTS_DEFAULT, EVENTS_MAX);
    const eventsRes = await section('SyncEvents', feedErrors, () => queryEvents({ limit: eventsLimit, level: o.level || 'warn', since: o.since }), { events: [], hasMore: false, newestAt: null });

    const polledHost = hostOf(o.polledUrl);
    const selfUrlOk = polledHost ? polledHost === hostOf(SITE_URL) : null;

    const alerts = buildAlerts({ now, runs, lastRun, lastOkRun, lastOkFullRun, counts, stuck, budgetWarnings, feedErrors, selfUrlOk });
    const worst = alerts.some(a => a.severity === 'critical') ? 'critical'
        : alerts.some(a => a.severity === 'warning') ? 'warning'
            : 'ok';

    return {
        schemaVersion: SCHEMA_VERSION,
        site: { key: SITE_KEY, name: SITE_NAME, url: SITE_URL, codeVersion: CODE_VERSION },
        polledUrl: o.polledUrl || null,
        selfUrlOk,
        generatedAt: now,
        status: worst,
        schedule: {
            incrementalEveryMinutes: INCREMENTAL_EVERY_MINUTES,
            fullRunHourUtc: FULL_RUN_HOUR_UTC,
            lateAfterMinutes: RUN_LATE_AFTER_MINUTES,
            stuckStaggingHours: STUCK_STAGGING_HOURS
        },
        lastRun: trimRun(lastRun),
        lastOkRun: trimRun(lastOkRun),
        lastOkFullRun: trimRun(lastOkFullRun),
        minutesSinceLastRun: lastRun ? minutesBetween(now, lastRun.startedAt) : null,
        minutesSinceLastOk: lastOkRun ? minutesBetween(now, lastOkRun.startedAt) : null,
        hoursSinceLastOkFull: lastOkFullRun ? hoursBetween(now, lastOkFullRun.startedAt) : null,
        counts,
        stuckStagging: stuck.stuck.slice(0, STUCK_LIST_CAP),
        stuckStaggingTotal: stuck.stuck.length,
        recentRuns: runs.map(trimRun),
        events: eventsRes.events || [],
        eventsError: eventsRes.error || null,
        eventsHasMore: !!eventsRes.hasMore,
        eventsNewestAt: eventsRes.newestAt || null,
        feedErrors,
        alerts
    };
}
