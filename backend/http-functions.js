import { ok, badRequest, forbidden, serverError, response } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import wixData from 'wix-data';
import { runSync } from 'backend/sync/pipeline';
import { processMediaQueueStep, triggerMediaDrain } from 'backend/sync/media';
import { processOneStaggingRow } from 'backend/sync/stagging';
import { seedVillages } from 'backend/sync/seed';
import { reclassifyHousesforSaleByVillage, reclassifyAllHousesforSale, refreshListings } from 'backend/sync/run';
import { refreshVillageActiveRanges } from 'backend/sync/village-stats';
import { compareStagingVsLive } from 'backend/sync/compare';
import { buildAdsInventoryFeed } from 'backend/sync/ads-feed';
import { buildHealthReport, queryEvents } from 'backend/sync/health.js';
import { purgeOld } from 'backend/sync/retention.js';

const CHAIN_DEADLINE_MS = 50 * 1000;

async function authorized(request) {
    try {
        const expected = await getSecret('SYNC_TRIGGER_SECRET');
        const provided = request.headers['x-sync-secret'] || request.headers['X-Sync-Secret'];
        return Boolean(expected) && provided === expected;
    } catch (err) {
        return false;
    }
}

// Separate credential for the read-only ads inventory feed. It gets embedded
// in the Google Ads Script, so it must never be (or accept) the mutating
// SYNC_TRIGGER_SECRET - rotating one never risks the other.
async function authorizedAdsFeed(request) {
    try {
        const expected = await getSecret('ADS_FEED_SECRET');
        const provided = request.headers['x-ads-feed-secret'] || request.headers['X-Ads-Feed-Secret'];
        return Boolean(expected) && provided === expected;
    } catch (err) {
        return false;
    }
}

// Read-only credential for the monitoring feed (listingsHealth, syncEvents).
// Separate from the sync and ads secrets for the same reason as ADS_FEED_SECRET:
// it lives in an external app (Frontlines), so rotating it must never touch
// the mutating routes, and it must never be able to trigger a sync.
// Rotation: set MONITOR_FEED_SECRET_PREV to the old value, MONITOR_FEED_SECRET
// to the new one, update the ops app, then clear _PREV. Either value is
// accepted while both are set.
async function authorizedMonitor(request) {
    const provided = request.headers['x-monitor-secret'] || request.headers['X-Monitor-Secret'];
    if (!provided) return false;
    for (const name of ['MONITOR_FEED_SECRET', 'MONITOR_FEED_SECRET_PREV']) {
        try {
            const expected = await getSecret(name);
            if (expected && provided === expected) return true;
        } catch (err) {
            // missing secret: try the next name
        }
    }
    return false;
}

function jsonResponse(status, body) {
    return response({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
}

// ?mode=incremental|full  ?force=1 applies a full run's deletes even past
// the mass-delete guard (see pipeline.jsw MASS_DELETE_*).
export async function post_runSync(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    const mode = (request.query && request.query.mode) || 'incremental';
    if (mode !== 'incremental' && mode !== 'full') return badRequest({ body: 'mode must be incremental|full' });
    const force = !!(request.query && (request.query.force === '1' || request.query.force === 'true'));
    try {
        const result = await runSync(mode, { trigger: 'http', allowMassDelete: force });
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

export async function get_syncStatus(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const res = await wixData.query('SyncRuns').descending('startedAt').limit(10).find({ suppressAuth: true });
        return jsonResponse(200, { runs: res.items });
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Read-only audit: diffs a Redfin-loaded Stagging snapshot against
// HousesforSale, re-running every staged subdivision through the live
// Villages matcher. Returns bucketed listing-level results; writes nothing.
// See README "Auditing against a Redfin pull".
export async function get_compareStagingVsLive(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await compareStagingVsLive();
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

export async function post_seedVillages(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await seedVillages();
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Drains photo-upload queue for one ~50s budget, then if the queue still has
// pending items fires off the next link of the chain. Each link gets a fresh
// Wix invocation budget, so a long backlog drains continuously without any
// single function exceeding the per-call timeout.
export async function post_drainMedia(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await processMediaQueueStep(Date.now() + CHAIN_DEADLINE_MS);
        if (result.remaining) await triggerMediaDrain();
        return jsonResponse(200, { ...result, chained: !!result.remaining });
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Process one Stagging row: upload all its pending photos via internal
// Promise.all parallelism, promote to HousesforSale when the gallery is
// fully wix-hosted. Called concurrently by the hourly cron's drain fan-out -
// each invocation here gets its own ~59s Wix budget, which is the whole point
// of doing this via HTTP instead of a single backend loop.
export async function post_processStaggingRow(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const body = await request.body.json();
        if (!body || !body.rowId) return badRequest({ body: 'rowId required' });
        const result = await processOneStaggingRow(body.rowId, body.runKey || null, typeof body.budgetMs === 'number' ? body.budgetMs : null);
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Forced rebuild of specific listings: trashes each row's media, deletes the
// row, and re-stages it from MLSGrid so every photo re-uploads fresh. Use for
// listings whose images are broken (the steady-state sync preserves existing
// wix-hosted images and won't repair them). Body: {"ids": ["MFRA4...", ...]}
export async function post_refreshListings(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const body = await request.body.json();
        if (!body || !Array.isArray(body.ids) || !body.ids.length) {
            return badRequest({ body: 'ids array required' });
        }
        const result = await refreshListings(body.ids);
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Recompute per-neighborhood active range stats (price/sqft/beds/garage) on
// HousesforSale-DynamicPages. The hourly sync also does this; this is for
// on-demand runs. Re-run if the response reports remaining: true.
export async function post_refreshVillageRanges(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await refreshVillageActiveRanges(Date.now() + CHAIN_DEADLINE_MS);
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Read-only per-community inventory feed for the Google Ads pause/enable
// script (scripts/google-ads-inventory-sync.js). Authenticated with
// ADS_FEED_SECRET, not the sync secret. See README "Google Ads inventory
// automation".
export async function get_adsInventoryFeed(request) {
    if (!(await authorizedAdsFeed(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await buildAdsInventoryFeed();
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Full-collection variant of reclassify: rewrites the village fields on every
// HousesforSale row from the current Villages data. Use after bulk Villages
// corrections (names/URLs). Re-run if the response reports remaining: true.
export async function post_reclassifyAll(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await reclassifyAllHousesforSale();
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// One-shot cleanup: re-runs the village matcher against every HousesforSale
// row currently assigned to ?villageName=... and either reassigns it to its
// correct village or removes it (and trashes its photos) if no village
// matches the current subdivision. Use after deleting a Villages row or
// adjusting matchPatterns.
export async function post_reclassifyByVillage(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    const villageName = request.query && request.query.villageName;
    if (!villageName) return badRequest({ body: 'villageName query param required' });
    try {
        const result = await reclassifyHousesforSaleByVillage(villageName);
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Health feed for the external ops app (Frontlines). One call returns the
// site's identity, the newest runs, stuck Stagging rows, recent events and
// a server-computed list of alerts, so every site is judged by the same
// rules and the poller only has to render. Query params:
//   events=<n>     number of recent SyncEvents to include (default 50, max 200)
//   level=<lvl>    minimum event level: info | warn | error (default warn)
//   since=<iso>    only events at/after this time
// See README "Monitoring feed".
export async function get_listingsHealth(request) {
    if (!(await authorizedMonitor(request))) return forbidden({ body: 'forbidden' });
    try {
        const q = request.query || {};
        const result = await buildHealthReport({
            eventsLimit: q.events,
            level: q.level,
            since: q.since,
            // Echoed so the poller can detect a copy/paste site-config that
            // still names another site.
            polledUrl: request.baseUrl || null
        });
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// Paged event query for the ops app: ?since=<iso>&level=<lvl>&limit=<n>&kind=<kind>&listingId=<id>&runKey=<key>
export async function get_syncEvents(request) {
    if (!(await authorizedMonitor(request))) return forbidden({ body: 'forbidden' });
    try {
        const q = request.query || {};
        const result = await queryEvents(q);
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}

// On-demand retention purge (the nightly job also runs this).
export async function post_purgeOld(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await purgeOld(Date.now() + CHAIN_DEADLINE_MS);
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}
