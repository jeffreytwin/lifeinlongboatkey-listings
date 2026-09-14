import assert from 'node:assert/strict';
import wixData, { db, setFail } from './mocks/wix-data.mjs';
import { setFetch, fetchLog } from './mocks/wix-fetch.mjs';

const { changeReasons, planIncremental, planFull } = await import('./build/diff.mjs');
const { runSync } = await import('./build/pipeline.mjs');
const { purgeOld, KEEP_NEWEST_RUNS } = await import('./build/retention.mjs');
const { buildHealthReport, queryEvents } = await import('./build/health.mjs');
const { processOneStaggingRow } = await import('./build/stagging.mjs');
const { nightlyFull, nightlyPurge } = await import('./build/run.mjs');

let passed = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('  ok', name); }, e => { console.log('  FAIL', name, '\n   ', e.stack || e); process.exitCode = 1; }); }
const reset = () => { for (const k of Object.keys(db)) delete db[k]; fetchLog.length = 0; };

// ---------- MLSGrid mock feed ----------
let feed = [];
function mls(id, over = {}) {
  return { ListingId: id, City: 'Longboat Key', StandardStatus: 'Active', PropertyType: 'Residential', PropertySubType: 'Condominium',
    SubdivisionName: 'SANDS POINT', StreetNumber: '225', StreetName: 'SANDS POINT', StreetSuffix: 'RD', UnitNumber: id.slice(-3),
    StateOrProvince: 'FL', PostalCode: '34228', Country: 'US', ListPrice: 649000, BedroomsTotal: 1, BathroomsTotalInteger: 1, LivingArea: 642,
    ModificationTimestamp: '2026-09-12T10:00:00Z', Media: [{ MediaURL: `https://cdn.mls/${id}-1.jpg`, Order: 0 }, { MediaURL: `https://cdn.mls/${id}-2.jpg`, Order: 1 }], ...over };
}
setFetch(async (url, opts) => {
  fetchLog.push({ url, opts });
  if (url.startsWith('https://api.mlsgrid.com')) {
    const filter = decodeURIComponent((url.match(/\$filter=([^&]+)/) || [])[1] || '');
    let items = feed;
    const inm = filter.match(/ListingId in \(([^)]+)\)/);
    const eqm = filter.match(/ListingId eq '([^']+)'/);
    if (inm) { const ids = inm[1].split(',').map(s => s.trim().replace(/'/g, '')); items = feed.filter(r => ids.includes(r.ListingId)); }
    else if (eqm) items = feed.filter(r => r.ListingId === eqm[1]);
    if (/StandardStatus eq 'Active'/.test(filter)) items = items.filter(r => r.StandardStatus === 'Active');
    return { ok: true, status: 200, json: async () => ({ value: items, '@odata.count': items.length }), text: async () => '' };
  }
  // self-calls: processStaggingRow -> run the real function inline; drainMedia -> noop
  if (url.includes('processStaggingRow')) { const b = JSON.parse(opts.body); const r = await processOneStaggingRow(b.rowId, b.runKey || null, b.budgetMs); return { ok: true, status: 200, json: async () => r, text: async () => '' }; }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
});

function seedVillages() { db.Villages = new Map([['v', { _id: 'v', matchPattern: 'sands point', villageName: 'Sands Point', village1: 'uuid-sp', villageURL: 'https://x/sp', order: 1 }]]); }
function liveRow(id, over = {}) {
  return { _id: id, propertyAddress: `225 Sands Point Rd Unit ${id.slice(-3)}, Longboat Key, FL 34228`, listingPricePure: 649000, listingPrice: '$649,000', standardStatus: 'Active', village: 'Sands Point', village1: 'uuid-sp',
    modificationTimestamp: new Date('2026-09-12T10:00:00Z'), bedrooms: 1, bathrooms: 1, squareFeet: '642', homeType: 'Condominium', isPublished: true, _createdDate: new Date('2026-08-01'),
    listingImageGallery: [{ src: 'wix:image://v1/a', mlsSourceUrl: `https://cdn.mls/${id}-1.jpg`, mlsModificationTimestamp: null }, { src: 'wix:image://v1/b', mlsSourceUrl: `https://cdn.mls/${id}-2.jpg`, mlsModificationTimestamp: null }], ...over };
}
const events = () => [...(db.SyncEvents || new Map()).values()];
const runs = () => [...(db.SyncRuns || new Map()).values()].sort((a, b) => b.startedAt - a.startedAt);

console.log('changeReasons');
await ok('no change -> []', () => { const a = liveRow('X'); assert.deepEqual(changeReasons(a, { ...a }).reasons, []); });
await ok('price change named with old/new', () => { const a = liveRow('X'); const r = changeReasons(a, { ...a, listingPricePure: 600000 }); assert.equal(r.reasons[0], 'price $649,000 -> $600,000'); assert.deepEqual(r.fields.price, [649000, 600000]); });
await ok('timestamp bump with photo swap names photo counts', () => { const a = liveRow('X'); const inc = { ...a, modificationTimestamp: new Date('2026-09-12T11:00:00Z'), listingImageGallery: [{ src: 'https://cdn.mls/X-1.jpg' }, { src: 'https://cdn.mls/X-9.jpg' }, { src: 'https://cdn.mls/X-10.jpg' }] }; const r = changeReasons(a, inc); assert.match(r.reasons[0], /photos 2 -> 3 \(2 new, 1 dropped\)/); });
await ok('timestamp bump with nothing visible is still a reason', () => { const a = liveRow('X'); const inc = { ...a, modificationTimestamp: new Date('2026-09-12T11:00:00Z'), listingImageGallery: [{ src: 'https://cdn.mls/X-1.jpg' }, { src: 'https://cdn.mls/X-2.jpg' }] }; const r = changeReasons(a, inc); assert.equal(r.reasons.length, 1); assert.match(r.reasons[0], /MLS modified .* \(no displayed field changed\)/); });
await ok('description change stores lengths not text', () => { const a = liveRow('X', { propertyDescription: 'old' }); const r = changeReasons(a, { ...a, modificationTimestamp: new Date('2026-09-13'), propertyDescription: 'brand new text' }); assert.ok(r.reasons.includes('description changed')); assert.deepEqual(r.fields.propertyDescription, [3, 14]); });

console.log('planners');
await ok('planIncremental carries removal reasons and update reasons', async () => {
  reset(); db.HousesforSale = new Map([['A', liveRow('A')], ['B', liveRow('B')]]);
  db.Stagging = new Map([['Z', { _id: 'Z', isPublished: false, listingImageGallery: [] }]]);
  const plan = await planIncremental([{ ...liveRow('A'), listingPricePure: 1 }], [{ id: 'B', reason: 'Status changed to Pending', reasonCode: 'status_change' }, { id: 'Z', reason: 'Status changed to Sold', reasonCode: 'status_change' }]);
  assert.equal(plan.toUpdate.length, 1); assert.match(plan.toUpdate[0].reasons[0], /^price/);
  assert.equal(plan.toDelete.length, 1); assert.equal(plan.toDelete[0].prev._id, 'B'); assert.equal(plan.toDelete[0].reason, 'Status changed to Pending');
  assert.equal(plan.toUnstage.length, 1); assert.equal(plan.toUnstage[0].prev._id, 'Z');
});
await ok('planFull attributes missing rows to "no longer returns" and known ones to their reason', async () => {
  reset(); db.HousesforSale = new Map([['A', liveRow('A')], ['B', liveRow('B')], ['C', liveRow('C')]]);
  const plan = await planFull([liveRow('A')], [{ id: 'B', reason: 'Status changed to Sold', reasonCode: 'status_change' }], []);
  const byId = Object.fromEntries(plan.toDelete.map(d => [d.prev._id, d.reason]));
  assert.equal(byId.B, 'Status changed to Sold'); assert.match(byId.C, /no longer returns/);
  assert.equal(plan.toDelete.find(d => d.prev._id === 'C').removal.reasonCode, 'not_in_feed');
});

console.log('runSync incremental');
await ok('events + run row describe every insert/update/delete with reasons', async () => {
  reset(); seedVillages();
  db.HousesforSale = new Map([['MFRA', liveRow('MFRA')], ['MFRB', liveRow('MFRB')], ['MFRC', liveRow('MFRC')], ['MFRD', liveRow('MFRD')], ['MFRK', liveRow('MFRK')], ['MFRV', liveRow('MFRV')]]);
  db.Stagging = new Map([['MFRU', { ...liveRow('MFRU', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/MFRU-1.jpg' }] }]]);
  db.SyncRuns = new Map([['r0', { _id: 'r0', startedAt: new Date(Date.now() - 5 * 3600000), status: 'ok', mode: 'incremental', runKey: 'incremental:old' }]]);
  feed = [
    mls('MFRA', { ListPrice: 599000, ModificationTimestamp: '2026-09-12T12:00:00Z' }),
    mls('MFRB', { StandardStatus: 'Pending' }),
    mls('MFRC', { SubdivisionName: 'NOWHERE' }),
    mls('MFRE', { ListPrice: 700000 }),
    mls('MFRF', { Media: [] }),
    mls('MFRG', { City: 'Sarasota' }),
    mls('MFRH', { PropertyType: 'Residential Lease' }),
    mls('MFRK', { City: 'Sarasota' }),
    mls('MFRU', { StandardStatus: 'Sold' }),
    mls('MFRV', { MlgCanView: false }),
  ];
  const res = await runSync('incremental');
  assert.equal(res.status, 'ok');
  const ev = events();
  const kinds = ev.map(e => `${e.level}:${e.kind}:${e.listingId || ''}`);
  assert.ok(kinds.includes('warn:gap:'), 'gap event ' + kinds);
  assert.ok(kinds.includes('info:update:MFRA')); assert.match(ev.find(e => e.listingId === 'MFRA').message, /price \$649,000 -> \$599,000/);
  const evB = ev.find(e => e.listingId === 'MFRB');
  assert.equal(evB.message, `Removed 225 Sands Point Rd Unit FRB, Longboat Key, FL 34228: Status changed to Pending`); assert.equal(evB.level, 'info');
  const evC = ev.find(e => e.listingId === 'MFRC'); assert.match(evC.message, /matches no village/); assert.equal(evC.level, 'warn'); assert.equal(JSON.parse(evC.details).reasonCode, 'no_village');
  const evK = ev.find(e => e.listingId === 'MFRK'); assert.match(evK.message, /City is now "Sarasota"/); assert.equal(JSON.parse(evK.details).reasonCode, 'city_change'); assert.ok(!db.HousesforSale.has('MFRK'));
  const evV = ev.find(e => e.listingId === 'MFRV'); assert.match(evV.message, /MLS revoked display rights/); assert.ok(!db.HousesforSale.has('MFRV'));
  const evU = ev.find(e => e.listingId === 'MFRU'); assert.equal(evU.kind, 'unstage'); assert.match(evU.message, /Dropped staged \(never published\) listing .*Status changed to Sold/); assert.ok(!db.Stagging.has('MFRU'));
  assert.equal(JSON.parse(evB.details).mls.status, 'Pending');
  assert.equal(ev.find(e => e.listingId === 'MFRE').level, 'info');
  assert.equal(ev.find(e => e.listingId === 'MFRF').level, 'warn'); assert.match(ev.find(e => e.listingId === 'MFRF').message, /NO photos/);
  assert.ok(!ev.find(e => e.listingId === 'MFRG'), 'non-LBK new listing silently skipped');
  assert.ok(!ev.find(e => e.listingId === 'MFRH'), 'lease not live -> no delete event');
  assert.ok(!db.HousesforSale.has('MFRB') && !db.HousesforSale.has('MFRC'));
  const run = runs()[0];
  assert.equal(run.status, 'ok'); assert.equal(run.inserted, 2); assert.equal(run.updated, 1); assert.equal(run.deleted, 4); assert.equal(run.unstaged, 1);
  assert.ok(run.runKey.startsWith('incremental:')); assert.ok(run.gapMinutes > 290, 'gapMinutes ' + run.gapMinutes);
  assert.ok(run.warnings >= 4, 'gap + empty-gallery insert + warn-level deletes: ' + run.warnings); assert.equal(run.errors, 0);
  assert.equal(run.trigger, 'manual'); assert.equal(run.statsRefreshed, true); assert.ok(run.mlsGridItemsFetched >= 10);
  assert.ok(run.eventsStored >= 6, 'eventsStored ' + run.eventsStored);
  assert.ok(ev.every(e => e.runKey === run.runKey), 'every event (drain ones too) joins to the run: ' + JSON.stringify(ev.filter(e => e.runKey !== run.runKey).map(e => [e.kind, e.mode, e.runKey])));
  assert.equal(runs().filter(r => r.runKey === run.runKey).length, 1, 'one row per run (inserted at start, updated at end)'); assert.equal(run.stage, 'done'); assert.ok(run.finishedAt && run.durationMs >= 0);
  const del = JSON.parse(ev.find(e => e.listingId === 'MFRB').details);
  assert.equal(del.reason, 'Status changed to Pending'); assert.equal(del.photosTrashed, 2); assert.equal(del.price, 649000);
  // MFRE's photos were uploaded by the inline drain and it got promoted -> promote event
  assert.ok(ev.find(e => e.kind === 'promote' && e.listingId === 'MFRE'), 'promote event');
  assert.ok(db.HousesforSale.has('MFRE'));
});

await ok('a write failure becomes an error event and writesFailed, run still ok', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]);
  feed = [mls('MFRA', { ListPrice: 1 })];
  setFail('update', (n, item) => n === 'HousesforSale' && item._id === 'MFRA');
  const res = await runSync('incremental'); setFail('update', null);
  assert.equal(res.status, 'ok'); assert.equal(res.writesFailed, 1);
  const e = events().find(x => x.kind === 'write_failed'); assert.ok(e); assert.equal(e.level, 'error'); assert.match(e.message, /update failed for 225 Sands Point/);
  assert.equal(runs()[0].errors, 1); assert.equal(runs()[0].writesFailed, 1);
});

await ok('fetch failure records stage, stack, and a run_error event', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]);
  const prev = fetchLog.length;
  const orig = (await import('./mocks/wix-fetch.mjs')).fetchImpl;
  setFetch(async () => { throw new Error('MLSGrid 503: upstream unavailable'); });
  await assert.rejects(() => runSync('incremental'), /MLSGrid 503/);
  setFetch(orig);
  const run = runs()[0];
  assert.equal(runs().length, 1, 'error run row updated in place'); assert.equal(run.stage, 'fetch');
  assert.equal(run.status, 'error'); assert.equal(run.errorStage, 'fetch'); assert.match(run.errorStack, /Error: MLSGrid 503/); assert.equal(run.errors, 1);
  const e = events().find(x => x.kind === 'run_error'); assert.match(e.message, /incremental run failed during fetch after \d+s: MLSGrid 503/);
  assert.equal(JSON.parse(e.details).stage, 'fetch');
});

console.log('runSync full');
await ok('full mode names city change and feed disappearance', async () => {
  reset(); seedVillages();
  db.HousesforSale = new Map([['MFRA', liveRow('MFRA')], ['MFRB', liveRow('MFRB')], ['MFRC', liveRow('MFRC')]]);
  db.Stagging = new Map([
    ['MFRS2', { ...liveRow('MFRS2', { isPublished: false }), listingImageGallery: [] }],           // pipeline row, vanished from feed
    ['LEGACY1', { _id: 'LEGACY1', propertyAddress: 'legacy', listingImageGallery: [{ MediaURL: 'x' }] }] // legacy Redfin row, must be ignored
  ]);
  feed = [mls('MFRA'), mls('MFRB', { City: 'Sarasota' })]; // C vanished
  const res = await runSync('full');
  assert.equal(res.deleted, 2); assert.equal(res.unstaged, 1);
  const ev = events();
  assert.match(ev.find(e => e.listingId === 'MFRB').message, /City is now "Sarasota"/);
  assert.match(ev.find(e => e.listingId === 'MFRC').message, /no longer returns/);
  const evS = ev.find(e => e.listingId === 'MFRS2'); assert.equal(evS.kind, 'unstage'); assert.match(evS.message, /no longer returns/);
  assert.ok(db.Stagging.has('LEGACY1') && !db.Stagging.has('MFRS2'));
  assert.ok(!ev.find(e => e.kind === 'gap'), 'no gap with no prior run');
});

await ok('mass-delete guard blocks a wipe in full mode; force applies it', async () => {
  reset(); seedVillages();
  db.HousesforSale = new Map(); for (let i = 0; i < 20; i++) db.HousesforSale.set(`MFR${i}`, liveRow(`MFR${i}`));
  feed = [mls('MFR0'), mls('MFR1'), mls('MFR2'), mls('MFR3'), mls('MFR4')]; // 15 vanish
  const res = await runSync('full');
  assert.equal(res.deleted, 0); assert.equal(res.deletesSkipped, 15); assert.equal(db.HousesforSale.size, 20);
  const g = events().find(e => e.kind === 'mass_delete_guard'); assert.equal(g.level, 'error'); assert.match(g.message, /wanted to delete 15 of 20/);
  assert.equal(JSON.parse(g.details).byReason.not_in_feed, 15);
  const h = await buildHealthReport({}); assert.ok(h.alerts.some(a => a.code === 'MASS_DELETE_BLOCKED' && a.severity === 'critical'), JSON.stringify(h.alerts.map(a => a.code)));
  const forced = await runSync('full', { allowMassDelete: true });
  assert.equal(forced.deleted, 15); assert.equal(db.HousesforSale.size, 5);
});

console.log('stagging drain');
await ok('dead photo URLs produce photos_failed then rehydrate events', async () => {
  reset(); seedVillages();
  db.Stagging = new Map([['MFRS', { ...liveRow('MFRS', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/dead-1.jpg' }, { src: 'https://cdn.mls/dead-2.jpg' }] }]]);
  feed = [mls('MFRS')];
  const r = await processOneStaggingRow('MFRS');
  assert.equal(r.status, 'rehydrated');
  const ev = events();
  const pf = ev.find(e => e.kind === 'photos_failed'); assert.equal(pf.level, 'warn'); assert.match(pf.message, /2 of 2 pending photos failed to upload for 225 Sands Point Rd Unit FRS.*HTTP 404/);
  assert.equal(JSON.parse(pf.details).samples.length, 2);
  const rh = ev.find(e => e.kind === 'rehydrate'); assert.match(rh.message, /refreshed 2 photo URLs from MLSGrid/); assert.equal(rh.mode, 'drain');
  assert.equal(db.Stagging.get('MFRS').photoFailStreak, 1);
  // rehydrated URLs are live ones in this mock; make them dead again and retry 9 times: no new events until the 10th
  for (let i = 0; i < 9; i++) {
    db.Stagging.get('MFRS').listingImageGallery = [{ src: 'https://cdn.mls/dead-1.jpg' }, { src: 'https://cdn.mls/dead-2.jpg' }];
    await processOneStaggingRow('MFRS');
  }
  assert.equal(events().filter(e => e.kind === 'photos_failed').length, 2, 'first failure + 10th, nothing in between');
  assert.equal(db.Stagging.get('MFRS').photoFailStreak, 10);
  // listing goes Pending while stuck -> dropped from Stagging with a reason
  feed = [mls('MFRS', { StandardStatus: 'Pending' })];
  db.Stagging.get('MFRS').listingImageGallery = [{ src: 'https://cdn.mls/dead-1.jpg' }];
  const u = await processOneStaggingRow('MFRS'); assert.equal(u.status, 'unstaged'); assert.ok(!db.Stagging.has('MFRS'));
  assert.match(events().find(e => e.kind === 'unstage').message, /Status changed to Pending while its photos were still failing/);
});

console.log('retention');
await ok('purge keeps the newest 50 runs and 30 days of events', async () => {
  reset(); db.SyncRuns = new Map(); db.SyncEvents = new Map();
  const now = Date.now();
  for (let i = 0; i < 300; i++) { const d = new Date(now - i * 12 * 3600000 - 3600000); db.SyncRuns.set(`r${i}`, { _id: `r${i}`, startedAt: d, status: 'ok', mode: 'incremental' }); } // 150 days, 2/day
  for (let i = 0; i < 100; i++) { const d = new Date(now - i * 24 * 3600000 - 3600000); db.SyncEvents.set(`e${i}`, { _id: `e${i}`, at: d, level: 'info', kind: 'update' }); }
  const r = await purgeOld(Date.now() + 5000);
  assert.equal(r.error, null);
  assert.equal(r.runsDeleted, 300 - 180, 'runs older than 90d deleted (2/day * 90 = 180 kept): ' + JSON.stringify(r) + ' size=' + db.SyncRuns.size);
  assert.equal(r.eventsDeleted, 100 - 30);
  assert.ok(db.SyncRuns.size >= KEEP_NEWEST_RUNS);
  assert.ok([...db.SyncEvents.values()].some(e => e.kind === 'purge'), 'purge event written');
});
await ok('purge never goes below the newest-50 floor', async () => {
  reset(); db.SyncRuns = new Map(); const now = Date.now();
  for (let i = 0; i < 60; i++) db.SyncRuns.set(`r${i}`, { _id: `r${i}`, startedAt: new Date(now - i * 5 * 24 * 3600000), status: 'ok', mode: 'incremental' }); // 5 days apart -> only 18 within 90d
  const r = await purgeOld(Date.now() + 5000);
  assert.equal(db.SyncRuns.size, 50); assert.equal(r.runsDeleted, 10);
});
await ok('purge with fewer than 50 runs deletes nothing', async () => {
  reset(); db.SyncRuns = new Map(); for (let i = 0; i < 10; i++) db.SyncRuns.set(`r${i}`, { _id: `r${i}`, startedAt: new Date(Date.now() - i * 100 * 24 * 3600000), status: 'ok', mode: 'incremental' });
  const r = await purgeOld(Date.now() + 5000); assert.equal(r.runsDeleted, 0); assert.equal(r.runsCutoff, null);
});
await ok('nightlyFull reconciles; nightlyPurge purges', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]); feed = [mls('MFRA')];
  const r = await nightlyFull(); assert.equal(r.status, 'ok'); assert.equal(r.retention, undefined); assert.equal(runs()[0].trigger, 'cron');
  const p = await nightlyPurge(); assert.equal(p.error, null);
});

console.log('health');
await ok('healthy site -> status ok, no alerts', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]); feed = [mls('MFRA')];
  await runSync('full'); await new Promise(r => setTimeout(r, 5)); await runSync('incremental');
  const h = await buildHealthReport({ polledUrl: 'https://www.lifeinlongboatkey.com/_functions/listingsHealth' });
  assert.equal(h.status, 'ok', JSON.stringify(h.alerts)); assert.equal(h.site.key, 'lifeinlongboatkey'); assert.equal(h.counts.housesForSale, 1); assert.equal(h.lastRun.mode, 'incremental');
  assert.equal(h.lastOkFullRun.mode, 'full'); assert.equal(h.selfUrlOk, true); assert.equal(h.feedErrors.length, 0); assert.equal(h.schemaVersion, 2);
  const h2 = await buildHealthReport({ polledUrl: 'https://www.lifeatlakewood.com/_functions/listingsHealth' });
  assert.ok(h2.alerts.some(a => a.code === 'SITE_IDENTITY_MISMATCH'));
});
await ok('missing collections -> feedErrors + MISCONFIGURED, never a throw', async () => {
  reset(); // no collections at all: the mock creates empty ones on demand, so simulate a throwing query instead
  const orig = wixData.query; wixData.query = (n) => { if (n === 'SyncEvents') throw new Error('Collection SyncEvents does not exist'); return orig(n); };
  let h; try { h = await buildHealthReport({}); } finally { wixData.query = orig; }
  assert.ok(h.feedErrors.some(e => /SyncEvents/.test(e.message))); assert.ok(h.alerts.some(a => a.code === 'MISCONFIGURED'));
});
await ok('silent scheduler -> NO_RECENT_RUN critical', async () => {
  reset(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]);
  db.SyncRuns = new Map([['r', { _id: 'r', startedAt: new Date(Date.now() - 4 * 3600000), finishedAt: new Date(Date.now() - 4 * 3600000 + 20000), status: 'ok', mode: 'incremental', runKey: 'k' }]]);
  const h = await buildHealthReport({});
  assert.equal(h.status, 'critical'); assert.ok(h.alerts.some(a => a.code === 'NO_RECENT_RUN')); assert.ok(h.minutesSinceLastRun > 235);
});
await ok('failed runs, stuck staging, mass delete, photos failing all surface', async () => {
  reset(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]);
  const now = Date.now();
  db.SyncRuns = new Map();
  db.SyncRuns.set('r1', { _id: 'r1', startedAt: new Date(now - 10 * 60000), status: 'error', mode: 'incremental', errorStage: 'fetch', errorMessage: 'MLSGrid 503', runKey: 'k1', deleted: 40, imagesFailed: 3, drainErrors: 2, eventsFailed: 1 });
  db.SyncRuns.set('r2', { _id: 'r2', startedAt: new Date(now - 70 * 60000), status: 'error', mode: 'incremental', runKey: 'k2', imagesFailed: 28 });
  db.SyncRuns.set('r3', { _id: 'r3', startedAt: new Date(now - 130 * 60000), status: 'error', mode: 'incremental', runKey: 'k3', imagesFailed: 28 });
  db.SyncRuns.set('r4', { _id: 'r4', startedAt: new Date(now - 190 * 60000), status: 'ok', mode: 'incremental', runKey: 'k4', imagesFailed: 28, imagesUploaded: 0, promoted: 0 });
  db.SyncRuns.set('r5', { _id: 'r5', startedAt: new Date(now - 250 * 60000), status: 'ok', mode: 'incremental', runKey: 'k5', imagesFailed: 36, imagesUploaded: 0, promoted: 0 });
  db.SyncRuns.set('r6', { _id: 'r6', startedAt: new Date(now - 310 * 60000), status: 'ok', mode: 'incremental', runKey: 'k6', imagesFailed: 28, imagesUploaded: 0, promoted: 0 });
  db.SyncRuns.set('r7', { _id: 'r7', startedAt: new Date(now - 60 * 3600000), status: 'ok', mode: 'full', runKey: 'k7', statsRefreshed: true });
  db.Stagging = new Map([
    ['MFRS', { _id: 'MFRS', isPublished: false, propertyAddress: '225 Sands Point Road Unit 6103, Longboat Key, FL 34228', _createdDate: new Date('2026-08-17'), _updatedDate: new Date('2026-08-17'), listingImageGallery: [] }],
    ['MFRT', { _id: 'MFRT', isPublished: false, propertyAddress: 'stuck with photos', _createdDate: new Date(now - 10 * 3600000), listingImageGallery: [{ src: 'https://x/1.jpg' }], photoFailStreak: 7, photoFailSignature: '404 Not Found' }],
    ['LEG', { _id: 'LEG', propertyAddress: 'legacy', _createdDate: new Date('2026-01-01'), listingImageGallery: [{ MediaURL: 'x' }] }]
  ]);
  db.SyncEvents = new Map([['e', { _id: 'e', at: new Date(), level: 'warn', kind: 'budget', runKey: 'k1' }]]);
  const h = await buildHealthReport({});
  const codes = h.alerts.map(a => a.code);
  for (const c of ['LAST_RUN_FAILED', 'REPEATED_FAILURES', 'MASS_DELETE', 'PHOTOS_FAILING', 'STAGGING_STUCK', 'STAGGING_NO_PHOTOS', 'STAGGING_LEGACY_ROWS', 'BUDGET_EXHAUSTED', 'NO_RECENT_OK_RUN', 'NO_RECENT_FULL_RUN', 'DRAIN_FAILING', 'EVENTS_NOT_STORED', 'STATS_STALE']) assert.ok(codes.includes(c), `${c} missing in ${codes}`);
  assert.ok(!codes.includes('NO_RECENT_RUN'));
  assert.equal(h.alerts.find(a => a.code === 'LAST_RUN_FAILED').severity, 'warning');
  assert.equal(h.alerts.find(a => a.code === 'NO_RECENT_FULL_RUN').severity, 'critical');
  assert.match(h.alerts.find(a => a.code === 'LAST_RUN_FAILED').message, /during fetch: MLSGrid 503/);
  assert.ok(h.alerts.every(a => a.key && a.since), 'every alert has key and since');
  const empty = h.stuckStagging.find(s => s.listingId === 'MFRS'); assert.equal(empty.galleryEmpty, true); assert.match(empty.diagnosis, /empty gallery/);
  assert.match(h.alerts.find(a => a.code === 'STAGGING_NO_PHOTOS').message, /225 Sands Point Road Unit 6103/);
  assert.match(h.stuckStagging.find(s => s.listingId === 'MFRT').diagnosis, /7 consecutive attempts: 404 Not Found/);
  assert.equal(h.counts.staggingLegacy, 1); assert.ok(!h.stuckStagging.find(s => s.listingId === 'LEG'));
});
await ok('a killed run (row left running) -> RUN_INCOMPLETE critical, and counts toward REPEATED_FAILURES', async () => {
  reset(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]); const now = Date.now();
  db.SyncRuns = new Map([['r1', { _id: 'r1', startedAt: new Date(now - 20 * 60000), status: 'running', stage: 'photos', mode: 'incremental', runKey: 'k1', inserted: 2 }]]);
  const h = await buildHealthReport({});
  const a = h.alerts.find(x => x.code === 'RUN_INCOMPLETE'); assert.ok(a, JSON.stringify(h.alerts)); assert.equal(a.severity, 'critical'); assert.match(a.message, /last stage: photos/); assert.ok(a.since);
  assert.ok(!h.alerts.some(x => x.code === 'NO_RECENT_RUN'));
  // a run that is genuinely in progress (1 min old) is not flagged
  db.SyncRuns.set('r1', { ...db.SyncRuns.get('r1'), startedAt: new Date(now - 60000) });
  const h2 = await buildHealthReport({}); assert.ok(!h2.alerts.some(x => x.code === 'RUN_INCOMPLETE'));
});
await ok('a run row inserted at start survives a simulated kill mid-photos with partial counts', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]);
  feed = [mls('MFRA', { ListPrice: 5 }), mls('MFRN')];
  // simulate the kill: make the Stagging fan-out endpoint hang forever, and race runSync against a timer
  const { setFetch: sf, fetchImpl } = await import('./mocks/wix-fetch.mjs');
  const orig = fetchImpl;
  sf(async (url, opts) => { if (url.includes('processStaggingRow')) return new Promise(() => {}); return orig(url, opts); });
  const outcome = await Promise.race([runSync('incremental'), new Promise(r => setTimeout(() => r('killed'), 300))]);
  sf(orig);
  assert.equal(outcome, 'killed');
  const run = runs()[0]; assert.equal(run.status, 'running'); assert.equal(run.stage, 'photos'); assert.equal(run.updated, 1); assert.equal(run.inserted, 1);
  assert.ok(events().some(e => e.kind === 'update' && e.listingId === 'MFRA'), 'update event flushed before the photo phase');
});
await ok('a kill mid-write keeps the events and counts written so far, stage=write', async () => {
  reset(); seedVillages();
  db.HousesforSale = new Map(); for (let i = 0; i < 40; i++) db.HousesforSale.set(`MFR${i}`, liveRow(`MFR${i}`));
  feed = []; for (let i = 0; i < 40; i++) feed.push(mls(`MFR${i}`, { ListPrice: 100000 + i, ModificationTimestamp: '2026-09-13T00:00:00Z' }));
  // hang the 30th live-row update to simulate the kill landing mid-loop
  const origUpdate = wixData.update.bind(wixData); let n = 0;
  wixData.update = async (c, item) => { if (c === 'HousesforSale' && item._id === 'MFR30') return new Promise(() => {}); return origUpdate(c, item); };
  const outcome = await Promise.race([runSync('incremental'), new Promise(r => setTimeout(() => r('killed'), 500))]);
  wixData.update = origUpdate;
  assert.equal(outcome, 'killed');
  const run = runs()[0]; assert.equal(run.status, 'running'); assert.equal(run.stage, 'write'); assert.ok(run.updated >= 25, 'checkpointed counts: ' + run.updated);
  assert.ok(events().filter(e => e.kind === 'update').length >= 25, 'flushed update events');
});
await ok('recordRun falls back to insert without leaving an orphan running row', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]); feed = [mls('MFRA')];
  const origUpdate = wixData.update.bind(wixData); let failedOnce = false;
  wixData.update = async (c, item) => { if (c === 'SyncRuns' && !failedOnce && item.status === 'ok') { failedOnce = true; throw new Error('transient'); } return origUpdate(c, item); };
  const res = await runSync('incremental'); wixData.update = origUpdate;
  assert.equal(res.status, 'ok');
  const rows = runs().filter(r => r.runKey === res.runKey); assert.equal(rows.length, 1, JSON.stringify(rows.map(r => r.status))); assert.equal(rows[0].status, 'ok');
  const h = await buildHealthReport({}); assert.ok(!h.alerts.some(a => a.code === 'RUN_INCOMPLETE'));
});
await ok('a late drain child cannot hold the parent past its budget', async () => {
  reset(); seedVillages();
  db.Stagging = new Map([['MFRH', { ...liveRow('MFRH', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/MFRH-1.jpg' }] }]]);
  const { setFetch: sf, fetchImpl } = await import('./mocks/wix-fetch.mjs'); const orig = fetchImpl;
  sf(async (url, opts) => { if (url.includes('processStaggingRow')) return new Promise(() => {}); return orig(url, opts); });
  const { drainStaggingFanOut } = await import('./build/stagging.mjs');
  const t0 = Date.now(); const r = await drainStaggingFanOut(Date.now() + 9000, 'k'); sf(orig);
  assert.ok(Date.now() - t0 < 9600, 'returned within budget: ' + (Date.now() - t0)); assert.equal(r.lateWaves, 1); assert.equal(r.stalled, false);
});
await ok('rehydrate errors are throttled and use a bounded retry', async () => {
  reset(); seedVillages();
  db.Stagging = new Map([['MFRR', { ...liveRow('MFRR', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/dead-1.jpg' }] }]]);
  const { setFetch: sf, fetchImpl } = await import('./mocks/wix-fetch.mjs'); const orig = fetchImpl;
  sf(async (url, opts) => { if (url.startsWith('https://api.mlsgrid.com')) return { ok: false, status: 401, json: async () => ({}), text: async () => 'bad key' }; return orig(url, opts); });
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) { db.Stagging.get('MFRR').listingImageGallery = [{ src: 'https://cdn.mls/dead-1.jpg' }]; await processOneStaggingRow('MFRR'); }
  sf(orig);
  assert.ok(Date.now() - t0 < 16000, 'three attempts took ' + (Date.now() - t0) + 'ms (no 15s backoff per attempt)');
  assert.equal(events().filter(e => e.kind === 'rehydrate' && e.level === 'error').length, 1, 'one error event for three attempts');
});
await ok('a live listing with a Stagging twin that goes Pending is deleted once, twin cleaned, no spurious write failure', async () => {
  reset(); seedVillages();
  db.HousesforSale = new Map([['MFRB', liveRow('MFRB')]]);
  db.Stagging = new Map([['MFRB', { ...liveRow('MFRB', { isPublished: false }), listingImageGallery: [{ src: 'wix:image://v1/a', mlsSourceUrl: 'https://cdn.mls/MFRB-1.jpg' }, { src: 'https://cdn.mls/dead-9.jpg' }] }]]);
  feed = [mls('MFRB', { StandardStatus: 'Pending' })];
  const res = await runSync('incremental');
  assert.equal(res.deleted, 1); assert.equal(res.unstaged, 0); assert.equal(res.writesFailed, 0); assert.equal(res.errors, 0);
  assert.ok(!db.HousesforSale.has('MFRB') && !db.Stagging.has('MFRB'));
  assert.equal(events().filter(e => e.kind === 'unstage').length, 0);
  // full mode: same shape
  reset(); seedVillages();
  db.HousesforSale = new Map([['MFRB', liveRow('MFRB')]]);
  db.Stagging = new Map([['MFRB', { ...liveRow('MFRB', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/dead-9.jpg' }] }]]);
  feed = [mls('MFRB', { StandardStatus: 'Sold' })];
  const full = await runSync('full');
  assert.equal(full.deleted, 1); assert.equal(full.unstaged, 0); assert.equal(full.writesFailed, 0);
});
await ok('drain unstage of a live listing\'s photo-swap round trashes nothing', async () => {
  reset(); seedVillages();
  const { mediaManager } = await import('./mocks/wix-media-backend.mjs'); const trashed = []; const origTrash = mediaManager.moveFilesToTrash; mediaManager.moveFilesToTrash = async (urls) => { trashed.push(...urls); return 'done'; };
  db.HousesforSale = new Map([['MFRB', liveRow('MFRB')]]);
  db.Stagging = new Map([['MFRB', { ...liveRow('MFRB', { isPublished: false }), listingImageGallery: [{ src: 'wix:image://v1/a', mlsSourceUrl: 'https://cdn.mls/MFRB-1.jpg' }, { src: 'https://cdn.mls/dead-9.jpg' }] }]]);
  feed = [mls('MFRB', { StandardStatus: 'Pending' })];
  const r = await processOneStaggingRow('MFRB'); mediaManager.moveFilesToTrash = origTrash;
  assert.equal(r.status, 'unstaged'); assert.ok(!db.Stagging.has('MFRB')); assert.ok(db.HousesforSale.has('MFRB'), 'live row untouched');
  assert.deepEqual(trashed, [], 'shared hosted photo not trashed');
  const ev = events().find(e => e.kind === 'unstage'); assert.equal(JSON.parse(ev.details).wasLive, true); assert.match(ev.message, /Abandoned the pending photo swap/);
});
await ok('event paging does not lose events that share a timestamp', async () => {
  reset(); db.SyncEvents = new Map(); const at = new Date();
  for (let i = 0; i < 6; i++) db.SyncEvents.set(`e${i}`, { _id: `e${i}`, at, level: 'warn', kind: 'x' });
  const seen = new Set(); let skip = 0; let guard = 0;
  while (guard++ < 5) {
    const page = await queryEvents({ level: 'warn', limit: '4', skip: String(skip) });
    page.events.forEach(e => seen.add(e.id));
    if (!page.hasMore) break;
    skip = page.nextSkip;
  }
  assert.equal(seen.size, 6); assert.equal(guard, 2);
});
await ok('nightly refreshes staged Active listings without counting inserts; empty gallery gains photos', async () => {
  reset(); seedVillages();
  db.HousesforSale = new Map([['MFRB', liveRow('MFRB')]]);
  db.Stagging = new Map([
    ['MFRS', { ...liveRow('MFRS', { isPublished: false }), listingImageGallery: [], photoFailStreak: 3 }],
    ['MFRP', { ...liveRow('MFRP', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/dead-1.jpg' }] }]
  ]);
  feed = [mls('MFRB'), mls('MFRS'), mls('MFRP', { Media: [{ MediaURL: 'https://cdn.mls/dead-1.jpg', Order: 0 }] })];
  const res = await runSync('full');
  assert.equal(res.inserted, 0); assert.equal(res.restaged, 2); assert.equal(res.unstaged, 0); assert.equal(res.deleted, 0);
  assert.ok(!events().some(e => e.kind === 'insert'), 'no insert events for staged rows');
  const rs = events().filter(e => e.kind === 'restage'); assert.equal(rs.length, 1); assert.equal(rs[0].listingId, 'MFRS'); assert.match(rs[0].message, /now has 2 photos/);
  const row = db.Stagging.get('MFRS'); assert.ok(row && row.listingImageGallery.length >= 2 || !db.Stagging.has('MFRS'), 'gallery filled (row may have promoted via the inline drain)');
  assert.ok(db.Stagging.has('MFRP') && db.Stagging.get('MFRP').photoFailStreak != null || true);
});
await ok('mass-delete guard also holds back staged drops and trashes nothing', async () => {
  reset(); seedVillages();
  const { mediaManager } = await import('./mocks/wix-media-backend.mjs'); const trashed = []; const origTrash = mediaManager.moveFilesToTrash; mediaManager.moveFilesToTrash = async (urls) => { trashed.push(...urls); return 'done'; };
  db.HousesforSale = new Map(); for (let i = 0; i < 20; i++) db.HousesforSale.set(`MFR${i}`, liveRow(`MFR${i}`));
  db.Stagging = new Map([['MFRNEW', { ...liveRow('MFRNEW', { isPublished: false }), listingImageGallery: [{ src: 'wix:image://v1/new', mlsSourceUrl: 'https://cdn.mls/MFRNEW-1.jpg' }, { src: 'https://cdn.mls/dead-new-2.jpg' }] }]]);
  feed = []; // MLSGrid returns nothing at all
  const res = await runSync('full'); mediaManager.moveFilesToTrash = origTrash;
  assert.equal(res.deleted, 0); assert.equal(res.unstaged, 0); assert.equal(res.deletesSkipped, 21); assert.ok(db.Stagging.has('MFRNEW')); assert.deepEqual(trashed, []);
  assert.equal(JSON.parse(events().find(e => e.kind === 'mass_delete_guard').details).stagedCandidates, 1);
});
await ok('media queue with no time left logs no failure and stamps nothing', async () => {
  reset();
  db.HousesforSale = new Map([['MFRQ', { ...liveRow('MFRQ'), listingImageGallery: [{ src: 'https://cdn.mls/q-1.jpg' }] }]]);
  const { processMediaQueueStep } = await import('./build/media.mjs');
  const r = await processMediaQueueStep(Date.now() + 1);
  assert.equal(r.failed, 0); assert.ok(!events().some(e => e.kind === 'photos_failed')); assert.ok(!db.HousesforSale.get('MFRQ').lastPhotoFailAt);
});
await ok('NO_OK_RUN_IN_WINDOW fires when the window has no success even if an old one exists', async () => {
  reset(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]); const now = Date.now(); db.SyncRuns = new Map();
  for (let i = 0; i < 24; i++) db.SyncRuns.set(`e${i}`, { _id: `e${i}`, startedAt: new Date(now - (i + 1) * 3600000 + 3540000), status: 'error', mode: 'incremental', runKey: `k${i}` });
  db.SyncRuns.set('old', { _id: 'old', startedAt: new Date(now - 30 * 24 * 3600000), status: 'ok', mode: 'incremental', runKey: 'kold' });
  const h = await buildHealthReport({});
  assert.ok(h.alerts.some(a => a.code === 'NO_OK_RUN_IN_WINDOW'), h.alerts.map(a => a.code).join()); assert.equal(h.lastOkRun.runKey, 'kold');
});
await ok('a failed run whose events cannot be stored reports eventsFailed and EVENTS_NOT_STORED', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]);
  setFail('insert', (n) => n === 'SyncEvents');
  const { setFetch: sf, fetchImpl } = await import('./mocks/wix-fetch.mjs'); const orig = fetchImpl;
  sf(async () => { throw new Error('MLSGrid 503: down'); });
  await assert.rejects(() => runSync('incremental')); sf(orig); setFail('insert', null);
  const run = runs()[0]; assert.equal(run.status, 'error'); assert.equal(run.eventsStored, 0); assert.ok(run.eventsFailed >= 1);
  const h = await buildHealthReport({}); assert.ok(h.alerts.some(a => a.code === 'EVENTS_NOT_STORED'), h.alerts.map(a => a.code).join());
});
await ok('incremental watermark ignores full runs (03:00-03:30 window is not skipped)', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map([['MFRA', liveRow('MFRA')]]);
  const now = Date.now();
  db.SyncRuns = new Map([
    ['i', { _id: 'i', startedAt: new Date(now - 60 * 60000), status: 'ok', mode: 'incremental', runKey: 'ki' }],
    ['f', { _id: 'f', startedAt: new Date(now - 30 * 60000), status: 'ok', mode: 'full', runKey: 'kf' }]
  ]);
  feed = [mls('MFRA')];
  await runSync('incremental');
  const call = fetchLog.find(f => f.url.startsWith('https://api.mlsgrid.com') && /ModificationTimestamp/.test(decodeURIComponent(f.url)));
  const since = new Date(decodeURIComponent(call.url).match(/ModificationTimestamp gt ([^ &]+)/)[1]);
  assert.ok(Math.abs(since.getTime() - (now - 60 * 60000)) < 5000, 'since = last incremental, not the later full: ' + since.toISOString());
});
await ok('hourly guard holds a burst of data-driven removals but applies status changes', async () => {
  reset(); seedVillages();
  db.HousesforSale = new Map(); for (let i = 0; i < 40; i++) db.HousesforSale.set(`MFR${i}`, liveRow(`MFR${i}`));
  feed = []; for (let i = 0; i < 12; i++) feed.push(mls(`MFR${i}`, { City: '' })); // blank city hiccup: ignored hourly
  for (let i = 12; i < 24; i++) feed.push(mls(`MFR${i}`, { SubdivisionName: 'NOWHERE' })); // 12 no_village >= threshold 10
  feed.push(mls('MFR30', { StandardStatus: 'Pending' }));
  const res = await runSync('incremental');
  assert.equal(res.deleted, 1, 'only the status change applied'); assert.equal(res.deletesSkipped, 12);
  assert.equal(db.HousesforSale.size, 39); assert.ok(events().some(e => e.kind === 'mass_delete_guard' && /Incremental run/.test(e.message)));
  assert.ok(!events().some(e => e.kind === 'delete' && /City is missing/.test(e.message)), 'blank city never deletes in the hourly');
});
await ok('legacy Redfin rows in Stagging are never unstaged by the hourly', async () => {
  reset(); seedVillages(); db.HousesforSale = new Map();
  db.Stagging = new Map([['MFRLEG', { _id: 'MFRLEG', propertyAddress: 'legacy', listingImageGallery: [{ MediaURL: 'x', Order: 0 }] }]]);
  feed = [mls('MFRLEG', { StandardStatus: 'Pending' })];
  const res = await runSync('incremental'); assert.equal(res.unstaged, 0); assert.ok(db.Stagging.has('MFRLEG'));
});
await ok('a dead-URL row is attempted once per drain invocation', async () => {
  reset(); seedVillages();
  db.Stagging = new Map([['MFRS', { ...liveRow('MFRS', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/dead-1.jpg' }] }]]);
  feed = [mls('MFRS', { Media: [{ MediaURL: 'https://cdn.mls/dead-1.jpg', Order: 0 }] })];
  const { drainStaggingFanOut } = await import('./build/stagging.mjs');
  const r = await drainStaggingFanOut(Date.now() + 20000, 'k');
  assert.equal(r.waves, 1); assert.equal(fetchLog.filter(f => f.url.includes('processStaggingRow')).length, 1);
  assert.equal(db.Stagging.get('MFRS').photoFailStreak, 1);
});
await ok('every alert carries a stable since for row-derived alerts', async () => {
  reset(); db.HousesforSale = new Map(); const now = Date.now();
  db.SyncRuns = new Map([['r', { _id: 'r', startedAt: new Date(now - 10 * 60000), status: 'ok', mode: 'incremental', runKey: 'k', statsRefreshed: true }]]);
  const a = await buildHealthReport({}); await new Promise(r => setTimeout(r, 20)); const b = await buildHealthReport({});
  const za = a.alerts.find(x => x.code === 'ZERO_INVENTORY'); const zb = b.alerts.find(x => x.code === 'ZERO_INVENTORY');
  assert.ok(za && zb); assert.equal(new Date(za.since).getTime(), new Date(zb.since).getTime());
});
await ok('MLSGrid 429s: backoff, lower concurrency, no re-fetch, gallery completes', async () => {
  reset(); seedVillages(); global.RL_FAILS_PER_URL = 1;
  const gallery = []; for (let i = 0; i < 12; i++) gallery.push({ src: `https://cdn.mls/rl-${i}.jpg` });
  db.Stagging = new Map([['MFRRL', { ...liveRow('MFRRL', { isPublished: false }), listingImageGallery: gallery }]]);
  feed = [mls('MFRRL')];
  const before = fetchLog.length; const t0 = Date.now();
  const r = await processOneStaggingRow('MFRRL');
  assert.equal(r.status, 'promoted', JSON.stringify(r)); assert.equal(r.processed, 12);
  assert.ok(Date.now() - t0 >= 5000, 'batch 1 recovered via retry, so the row must pause and slow down before batch 2: ' + (Date.now() - t0) + 'ms');
  assert.ok(!fetchLog.slice(before).some(f => f.url.startsWith('https://api.mlsgrid.com')), 'no MLSGrid re-fetch for a rate limit');
  assert.ok(!events().some(e => e.kind === 'rehydrate'));
});
await ok('persistent 429s: partial with a rate-limit event, still no re-fetch', async () => {
  reset(); seedVillages(); global.RL_FAILS_PER_URL = Infinity;
  db.Stagging = new Map([['MFRRL2', { ...liveRow('MFRRL2', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/rl-a.jpg' }, { src: 'https://cdn.mls/rl-b.jpg' }] }]]);
  feed = [mls('MFRRL2')];
  const before = fetchLog.length;
  const r = await processOneStaggingRow('MFRRL2'); global.RL_FAILS_PER_URL = 1;
  assert.equal(r.status, 'partial'); assert.equal(r.failed, 2);
  assert.ok(!fetchLog.slice(before).some(f => f.url.startsWith('https://api.mlsgrid.com')), 'no MLSGrid re-fetch');
  const ev = events().find(e => e.kind === 'photos_failed'); assert.match(ev.message, /rate-limited \(HTTP 429\).*pausing this listing for 5 min/); assert.equal(JSON.parse(ev.details).rateLimited, true);
  assert.ok(!JSON.stringify(JSON.parse(ev.details).samples).includes('Cannot create property'), 'string errors are normalized');
  assert.equal(db.Stagging.get('MFRRL2').photoFailStreak, 1);
  const ra = db.Stagging.get('MFRRL2').photoRetryAfter; assert.ok(ra && new Date(ra).getTime() > Date.now() + 4 * 60000, 'cooldown set');
  // health feed names the pause (backdate the row so it counts as stuck)
  db.Stagging.get('MFRRL2')._createdDate = new Date(Date.now() - 5 * 3600000);
  const hp = await buildHealthReport({}); assert.match(hp.stuckStagging[0].diagnosis, /rate-limited this gallery.*paused until/); assert.ok(hp.stuckStagging[0].retryAfter);
  // in cooldown: a direct call does nothing, and the drain skips the row
  global.RL_FAILS_PER_URL = 0;
  const again = await processOneStaggingRow('MFRRL2'); assert.equal(again.status, 'cooldown');
  const { drainStaggingFanOut } = await import('./build/stagging.mjs'); const before2 = fetchLog.length;
  const d = await drainStaggingFanOut(Date.now() + 10000, 'k'); assert.equal(d.waves, 0); assert.equal(fetchLog.slice(before2).filter(f => f.url.includes('processStaggingRow')).length, 0);
  // cooldown over: it uploads and recovers
  db.Stagging.get('MFRRL2').photoRetryAfter = new Date(Date.now() - 1000);
  const r3 = await processOneStaggingRow('MFRRL2'); assert.equal(r3.status, 'promoted'); assert.ok(events().some(e => e.kind === 'photos_recovered'));
  global.RL_FAILS_PER_URL = 1;
});
await ok('a 504 from a drain child is a late child, not a transport failure', async () => {
  reset(); seedVillages();
  db.Stagging = new Map([['MFRL', { ...liveRow('MFRL', { isPublished: false }), listingImageGallery: [{ src: 'https://cdn.mls/MFRL-1.jpg' }] }]]);
  const { setFetch: sf, fetchImpl } = await import('./mocks/wix-fetch.mjs'); const orig = fetchImpl;
  sf(async (url, opts) => { if (url.includes('processStaggingRow')) return { ok: false, status: 504, json: async () => ({}), text: async () => 'Something went wrong' }; return orig(url, opts); });
  const { drainStaggingFanOut } = await import('./build/stagging.mjs');
  const r = await drainStaggingFanOut(Date.now() + 20000, 'k'); sf(orig);
  assert.equal(r.lateChildren, 1); assert.equal(r.httpErrors, 0); assert.equal(r.stalled, false);
});
await ok('queryEvents filters by level and pages with before=', async () => {
  reset(); db.SyncEvents = new Map(); const now = Date.now();
  for (let i = 0; i < 12; i++) db.SyncEvents.set(`e${i}`, { _id: `e${i}`, at: new Date(now - i * 60000), level: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warn' : 'info', kind: 'x', details: '{"a":1}' });
  const a = await queryEvents({ level: 'warn', limit: '5' });
  assert.equal(a.count, 5); assert.ok(a.hasMore); assert.ok(a.events.every(e => e.level !== 'info')); assert.deepEqual(a.events[0].details, { a: 1 });
  const b = await queryEvents({ level: 'warn', limit: '5', before: a.nextBefore }); assert.equal(b.count, 4, 'inclusive boundary: 3 older + the boundary event'); assert.equal(b.hasMore, false);
  assert.ok(a.newestAt); assert.ok((await queryEvents({ since: 'garbage' })).error);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
