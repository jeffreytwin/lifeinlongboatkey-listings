import { ok, badRequest, forbidden, serverError, response } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import wixData from 'wix-data';
import { runSync } from 'backend/sync/pipeline';
import { seedVillages } from 'backend/seed-villages';

async function authorized(request) {
    try {
        const expected = await getSecret('SYNC_TRIGGER_SECRET');
        const provided = request.headers['x-sync-secret'] || request.headers['X-Sync-Secret'];
        return Boolean(expected) && provided === expected;
    } catch (err) {
        return false;
    }
}

function jsonResponse(status, body) {
    return response({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function post_runSync(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    const mode = (request.query && request.query.mode) || 'incremental';
    if (mode !== 'incremental' && mode !== 'full') return badRequest({ body: 'mode must be incremental|full' });
    try {
        const result = await runSync(mode);
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

export async function post_seedVillages(request) {
    if (!(await authorized(request))) return forbidden({ body: 'forbidden' });
    try {
        const result = await seedVillages();
        return jsonResponse(200, result);
    } catch (err) {
        return serverError({ body: err && err.message ? err.message : String(err) });
    }
}
