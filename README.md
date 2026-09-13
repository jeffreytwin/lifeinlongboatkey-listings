# lifeinlongboatkey-listings

Automated Longboat Key listings pipeline for Wix Velo. Replaces the former manual Redfin-CSV + dashboard-button workflow with a scheduled job that pulls directly from MLSGrid.

## How it works

Four scheduled jobs in `backend/jobs.config`:

- **Hourly incremental** (`0 * * * *`) - Pulls every Longboat Key record whose `ModificationTimestamp` is newer than the last successful run. Active + matched-village records upsert into `HousesforSale`; any other status (Pending, Sold, Withdrawn, etc.) triggers removal.
- **Nightly full reconcile** (`30 3 * * *` UTC) - Re-fetches every listing currently in `HousesforSale` (and every pipeline-staged row) by id and deletes anything MLSGrid no longer returns as an Active, matched-village listing. Safety net for rare outright deletions and drift. A run that would delete 10% or more of the inventory (min 10) stops itself and records the candidates instead (see "Mass-delete guard"). The hourly watermark comes from the newest successful incremental run only, so a full run never advances it.
- **Nightly retention purge** (`30 4 * * *` UTC) - Deletes `SyncRuns` older than 90 days (never below the newest 50) and `SyncEvents` older than 30 days.
- **Mid-hour photo drain** (`30 * * * *` UTC) - Uploads pending photos for staged listings and publishes them when complete. It was scheduled per-minute originally; SyncEvents showed Wix never fired it on this plan (no drain events without a run key), so it now runs at half past, giving two drains an hour with the hourly sync.

All cron times are UTC (03:30 UTC is 23:30 EDT).

Every run appends a row to `SyncRuns` (per-run summary) and one row per notable listing-level event to `SyncEvents` (what changed, what got deleted and why, what failed). `GET /_functions/listingsHealth` turns both into a single JSON health report with server-computed alerts for the ops app. See "Monitoring" below.

## Repo layout

```
backend/
  jobs.config                    scheduled cron entries
  permissions.json               web modules restricted to the site owner
  http-functions.js              POST /_functions/{runSync,seedVillages}, GET /_functions/syncStatus
  Fetch.jsw                      back-compat shim (uploadImage, myMoveFilesToTrashFunction)
  seed-villages.jsw              idempotent Villages upsert
  sync/
    site-config.js               per-site identity (URL, name, key, code version) + schedule expectations
    pipeline.jsw                 orchestrator (fetch -> classify -> diff -> images -> write -> log)
    events.js                    SyncEvents writer (plain module: rows in, counts out)
    health.js                    listingsHealth / syncEvents feed + alert rules
    retention.js                 nightly purge of SyncRuns / SyncEvents past retention
    mlsgrid.jsw                  OData client (pagination, retry, secret-backed auth)
    villages.jsw                 Villages collection lookup (order-based)
    villages.seed.jsw            auto-generated seed data (110 entries)
    transform.jsw                MLSGrid record -> HousesforSale shape
    diff.jsw                     incremental + full diff planners
    media.jsw                    image upload w/ change detection + retry
    run.jsw                      job entrypoints (hourlyIncremental, nightlyFull)
pages/
  Property Management.js         read-only monitoring dashboard
scripts/
  generate-villages-seed.js      regenerates villages.seed.jsw from dashboard source
```

## Collections

Five Wix Data collections. Create in the CMS before first run, with every column typed as listed: Wix stores fields the CMS has not defined, but the type an admin later assigns is permanent, and the health feed's date filters depend on the date columns being Date & Time.

**HousesforSale** (already exists) - the live listings. The pipeline adds `isPublished` (Boolean) and, on rows whose photos are failing, `lastPhotoFailAt` (Date & Time).

**Stagging** - the photo-upload waiting room. Same columns as `HousesforSale` plus `isPublished` (Boolean, always false here) and the failure bookkeeping the drain keeps per row: `photoFailStreak` (Number), `photoFailSignature` (Text), `lastPhotoFailAt` (Date & Time), `photoRetryAfter` (Date & Time, rate-limit cooldown), `rehydrateErrorSignature` (Text). New listings and photo swaps sit here until every photo is Wix-hosted, then promote. Rows are removed when their listing leaves the market (hourly, nightly, or by the drain itself when it re-checks a failing row).

**Villages** - subdivision-to-village metadata. Columns:

| field | type | notes |
| --- | --- | --- |
| `matchPattern` | Text | lowercased substring; matcher tests `subdivisionName.includes(matchPattern)` |
| `villageName` | Text | display name |
| `villageSortHelp` | Text | sort key for UI (usually same as name) |
| `villageURL` | Text | full neighborhood page URL |
| `village1` | Text | UUID reference for cross-collection lookups |
| `blueTag1`, `purpleTag1`, `greenTag1` | Text | amenity icon URLs (optional; default empty) |
| `order` | Number | higher wins when multiple patterns match |

Permissions: admin read/write only.

**SyncRuns** - one row per run (the summary). Columns:

| field | type | notes |
| --- | --- | --- |
| `runKey` | Text | `<mode>:<startedAt ISO>`; joins to `SyncEvents.runKey` |
| `startedAt`, `finishedAt` | Date | |
| `durationMs` | Number | |
| `mode` | Text | `incremental` or `full` |
| `status` | Text | `running` (row is inserted at run start), then `ok` or `error`. A row left at `running` means the invocation was killed by the Wix timeout; `stage` says where |
| `stage` | Text | last persisted phase: `fetch` (row inserted), `write` (row writes, refreshed every 25 writes / 8s), `sweeps` (pull-date + stats sweeps), `photos` (drain), `done`. `errorStage` can additionally name `gap-check`, `classify`, `plan`, `dates`, `stats`, `record` |
| `inserted`, `updated`, `deleted`, `promoted` | Number | |
| `listingsChanged` | Number | inserted + updated + deleted |
| `imagesUploaded`, `imagesFailed`, `imagesTrashed` | Number | `imagesFailed` counts individual photo uploads that failed after retries; a stuck Stagging row is counted again every run until it clears |
| `datesRefreshed` | Number | |
| `mlsGridRequestCount`, `mlsGridListingCount` | Number | incremental: MLS-wide records modified since the last ok run (not just this site's) |
| `gapMinutes` | Number | minutes since the previous recorded run of any kind; > 120 also writes a `gap` event |
| `warnings`, `errors` | Number | SyncEvents rows of that level written by this run |
| `eventsStored`, `eventsFailed` | Number | SyncEvents rows persisted / that failed to persist for this run |
| `writesFailed` | Number | listing writes that threw (each is also a `write_failed` event) |
| `errorStage` | Text | phase that threw (same values as `stage`) |
| `errorMessage` | Text | |
| `errorStack` | Text | first 2000 chars of the stack |
| `trigger` | Text | `cron`, `http`, `page`, or `manual` |
| `unstaged` | Number | staged (never published) rows dropped because their listing left the market |
| `restaged` | Number | staged (never published) rows the nightly refreshed from MLSGrid (not counted as inserts) |
| `deletesSkipped` | Number | deletes the mass-delete guard refused to apply |
| `drainErrors` | Number | photo-drain self-calls that failed (wrong `SITE_URL` / secret) |
| `statsRefreshed` | Boolean | the neighborhood range stats sweep completed |
| `mlsGridItemsFetched`, `fetchWindowMinutes` | Number | records actually received vs `mlsGridListingCount`, and the incremental window |

Permissions: admin read-only; backend writes. Retention: 90 days, never fewer than the newest 50 rows.

**SyncEvents** - one row per notable listing-level thing (the detail behind the counts). Columns:

| field | type | notes |
| --- | --- | --- |
| `runKey` | Text | the run that wrote it. Drain/media events fired from a run carry that run's key (null only when fired by the standalone per-minute drain); purge events carry `retention:<startedAt ISO>`, which has no `SyncRuns` row |
| `mode` | Text | `incremental`, `full`, `drain` (Stagging HTTP fan-out), `media` (live-row queue), `retention` |
| `at` | Date & Time | |
| `level` | Text | `info`, `warn`, `error` |
| `kind` | Text | see table below |
| `listingId`, `address`, `village` | Text | the listing, when there is one |
| `message` | Text | one human-readable sentence |
| `details` | Text | JSON: field diffs (`fields`), reasons, sample URLs, error stack, counts |

Permissions: admin read-only; backend writes. Retention: 30 days.

| kind | level | when |
| --- | --- | --- |
| `insert` | info / warn | new listing staged; warn when MLSGrid sent no photos (it cannot publish until photos arrive) |
| `update` | info / warn | live row rewritten; message lists why (`price $1,395,000 -> $1,295,000; photos 24 -> 28 (4 new, 0 dropped)`); warn when MLSGrid sent no photos this fetch |
| `delete` | info / warn | live row removed; message ends with the reason and `details.reasonCode` is one of `status_change` (info), `property_type` (info), `no_village` (warn: fix `Villages`), `city_change` (warn), `mls_revoked` (warn: MLSGrid's `MlgCanView` is false), `not_in_feed` (warn: the nightly found MLSGrid no longer returns it), `manual_refresh` (a forced rebuild). `details.mls` carries the MLS status/subdivision/city/price at removal time |
| `unstage` | info / warn | a staged, never-published listing dropped for the same reasons |
| `restage` | info | the nightly refreshed a staged, never-published listing and it gained photos it had been staged without |
| `promote` | info | Stagging row published to HousesforSale (new listing or photo swap) |
| `photos_failed` | warn | photo uploads failed for one listing: how many, first error, sample URLs. Written on the first failure, then every 10th consecutive attempt or when the error changes (a row is attempted at most once per drain invocation), so one stuck row cannot flood the log |
| `photos_recovered` | info | uploads succeeded again after a failing streak |
| `rehydrate` | info / warn / error | every photo failed so fresh URLs were fetched from MLSGrid (warn if MLSGrid had none, error if the fetch failed); same throttle as `photos_failed` |
| `promote_failed` | error | HousesforSale write failed at promotion |
| `write_failed` | error | a listing insert/update/remove threw during the run |
| `drain_failed` | warn | the photo drain's self-calls to this site failed (missing `SYNC_TRIGGER_SECRET`, wrong `SITE_URL`, HTTP errors) |
| `drain_stalled` | warn | a drain wave made no progress and stopped early |
| `mass_delete_guard` | error | a full run wanted to delete 10%+ of the inventory and refused; `details.sample` lists candidates by reason |
| `stats_failed` | error | village range stats refresh threw (run still ok) |
| `sweep_failed` | error | the dateOfMlsPull sweep threw (run still ok) |
| `budget` | warn | the run ran out of time before the pull-date sweep or the stats refresh |
| `gap` | warn | more than 120 min passed with no run recorded (the scheduler was silent) |
| `run_error` | error | the run threw: stage, error, counts written so far |
| `events_dropped` | warn | a run produced more than 1500 events; the rest were counted, not stored |
| `purge` | info / error | nightly retention purge result (always written, even when nothing was purged) |

`details` is JSON; it may be a truncated non-JSON string when an event exceeds 8 KB. Manual paths (`reclassifyAll`, `reclassifyByVillage`, `refreshListings`) write `delete` events with `mode: manual` and `details.trigger`.

## Secrets

Add via Wix Dashboard -> Settings -> Secrets Manager:

- `MLSGRID_API_KEY` - Bearer token for `https://api.mlsgrid.com/v2/`. Rotate the old hardcoded key after cutover.
- `SYNC_TRIGGER_SECRET` - shared secret for the mutating `/_functions/*` routes. Required on every site: the pipeline calls its own `drainMedia` / `processStaggingRow` routes with it (the dashboard page calls `runSync()` directly via a backend import and doesn't use this).
- `ADS_FEED_SECRET` - read-only secret for `GET /_functions/adsInventoryFeed`. It gets embedded in the Google Ads Script, so it must be a separate value from `SYNC_TRIGGER_SECRET` - rotating it never touches the mutating sync routes, and a script holding a stale value just gets 403 and aborts harmlessly.
- `MONITOR_FEED_SECRET` - read-only secret for `GET /_functions/listingsHealth` and `GET /_functions/syncEvents` (header `x-monitor-secret`). Lives in the ops app (Frontlines); same separation rationale as the ads secret. Use a different value per site. To rotate without a false alarm: set `MONITOR_FEED_SECRET_PREV` to the old value, `MONITOR_FEED_SECRET` to the new one, update the ops app, then delete `_PREV` (either value is accepted while both exist).

`backend/permissions.json` restricts every backend web module (`*.jsw`) to the site owner. Without it, any visitor could invoke `runSync`, `seedVillages` and the rest from the browser. The Property Management page still works for a logged-in site owner; if operators sign in as members rather than owners, widen `siteMember` there.

## Deployment / rollout

1. **Install** the backend files (sync to Wix via Git integration or copy/paste into the Velo IDE). Do NOT wire up `backend/jobs.config` yet.
2. **Create** the `Villages`, `Stagging`, `SyncRuns` and `SyncEvents` collections (schemas above), and add `MONITOR_FEED_SECRET`. Existing installs: add the new `SyncRuns` columns, create `SyncEvents`, and set `CODE_VERSION` / the site constants in `backend/sync/site-config.js`.
3. **Seed villages** once:
   ```bash
   curl -X POST https://<site>/_functions/seedVillages \
     -H "x-sync-secret: $SYNC_TRIGGER_SECRET"
   ```
   Expect `{"total": 110, "inserted": 110, "updated": 0}` on first run.
4. **Smoke-test** with a full reconcile against a copy of `HousesforSale` (e.g. create `HousesforSale_Preview`, temporarily swap the collection name in `backend/sync/pipeline.jsw`, run once):
   ```bash
   curl -X POST "https://<site>/_functions/runSync?mode=full" \
     -H "x-sync-secret: $SYNC_TRIGGER_SECRET"
   ```
   Compare the resulting row count and a few listings against the MLSGrid feed (paste the same `$filter` into a browser to cross-check `@odata.count`).
5. **Flip to live** - revert the collection name to `HousesforSale`, run `mode=full` once more, verify counts on the site.
6. **Enable the schedule** - `backend/jobs.config` is already committed; once the code is deployed, Wix picks up the cron entries automatically.
7. **Monitor** the Property Management page for 48h. All rows in `SyncRuns` should show `status: ok` with sensible counts.
8. **Retire the old path** - delete the `MLS_id_list` collection and any legacy Redfin-loaded rows in `Stagging` (keep the collection: the pipeline needs it), rotate the old MLSGrid API key, and delete `backend/Fetch.jsw` once nothing imports from it.

## Regenerating the village seed

Source of truth is the original `Property Management - Dashboard Page Code.txt` in the repo root. To rebuild the seed after a dashboard change:

```bash
node scripts/generate-villages-seed.js
```

This rewrites `backend/sync/villages.seed.jsw`. Review the diff, commit, redeploy, then POST `/_functions/seedVillages` to apply.

## Checking links

Export the `NeighborhoodsCondos` collection from the Wix CMS, then:

```bash
node scripts/check-links.js path/to/NeighborhoodsCondos.csv
```

Verifies nearby-neighborhood cross links and every `villages.seed.jsw` URL against the pages that actually exist (per the export's dynamic-page link field), then hits the live site pages, YouTube/Vimeo oEmbed for each neighborhood video, and the wixstatic image URLs. `--offline` skips the network checks. Exit code 1 means something is broken.

## Auditing against a Redfin pull

To spot-check that the pipeline isn't silently dropping listings, load `Stagging` with a fresh Redfin active-listings file via the legacy dashboard process, then:

```bash
curl "https://<site>/_functions/compareStagingVsLive" \
  -H "x-sync-secret: $SYNC_TRIGGER_SECRET"
```

The response re-runs every staged subdivision through the live `Villages` matcher and buckets the results. The buckets that matter:

- `missingFromLive` - Active, matches a current village, but not in `HousesforSale`. Investigate each: these are the silent drops.
- `liveNotInStaging` - on the site but absent from the Redfin file: stale rows the sync should have removed, or gaps in the Redfin export.
- `unmatchedButOldProcessHadVillage` - the legacy matcher assigned a village the current one doesn't (removed villages, fixed match bugs). Confirm each removal was intentional.
- `villageNameMismatches` - informational; renames/merges between the legacy and current village lists.

The endpoint is read-only. Legacy-staged rows sit inert in `Stagging` (the drain skips them because their galleries hold raw MLS media objects, not upload items), but they still cost the hourly drain a wasted fan-out wave - bulk-delete the Redfin rows from `Stagging` when the audit is done.

## Google Ads inventory automation

Community ad groups in Google Ads pause automatically when their community runs out of inventory, and re-enable when inventory returns.

**Site side** (runs by itself once deployed):

- The hourly village stats write two extra fields onto `HousesforSale-DynamicPages`: `activeListingCount` (Number - published listings only, since that's what an ad click can actually see) and `zeroSince` (Date & Time - stamped when the count hits 0, cleared when it recovers). Create both fields in the CMS before deploying.
- `GET /_functions/adsInventoryFeed` (header `x-ads-feed-secret: $ADS_FEED_SECRET`) returns one entry per community: `villageName`, `villageUrl`, `activeListingCount`, `zeroSince`, and `advertise`. `advertise` flips to `false` only after a community has sat at zero for `PAUSE_AFTER_HOURS` (6h, set in `backend/sync/ads-feed.jsw`); anything ambiguous fails open to `true` and is listed under `anomalies`.

**Google Ads side** (`scripts/google-ads-inventory-sync.js` - reference copy; runs inside Google Ads):

1. In Google Ads, apply a label `auto-inventory` to each community ad group the script may manage. Unlabeled ad groups are never touched.
2. Tools & Settings > Bulk Actions > Scripts > new script; paste the file; fill in `FEED_SECRET`; authorize.
3. Preview with `DRY_RUN = true` (the default). The log shows planned pauses/enables, `unmatchedAdGroups` (fix via ad-group renames or `NAME_OVERRIDES`), and `communitiesWithoutAdGroups` (informational - communities you could be advertising).
4. When the preview looks right, set `DRY_RUN = false`, run once manually, then schedule Hourly.

Label contract: the script pauses with its own label `Paused: no inventory` and only ever enables ad groups carrying it - a human-paused ad group stays paused. To opt an ad group out entirely, remove `auto-inventory`. Guardrails: the script aborts with zero changes on any feed failure, a too-small feed, or a run that would pause more than half the managed ad groups. Worst-case latency: a returning listing can take ~3-4h to re-enable ads (media re-host -> promotion -> hourly stats -> hourly script).

## Monitoring

Three layers, cheapest first:

1. **`SyncRuns`** answers "did the last run work and what were the counts".
2. **`SyncEvents`** answers "which listing, what changed, why was it deleted, which photo URL failed with what error". Filter by `listingId` to get one listing's whole history; by `runKey` to see everything one run did; by `level = error` to see only failures.
3. **`GET /_functions/listingsHealth`** rolls both up into one JSON document with an `alerts` list, for the external ops app (Frontlines). Every site computes the alerts with the same rules, so the poller only has to render and notify.

### Health feed

```bash
curl "https://<site>/_functions/listingsHealth?events=50&level=warn" \
  -H "x-monitor-secret: $MONITOR_FEED_SECRET"
```

Query params: `events` (recent events to include, default 50, max 200), `level` (minimum level, default `warn`), `since` (ISO time; only events at/after it). Response:

| field | meaning |
| --- | --- |
| `schemaVersion` | currently 2; the poller should refuse unknown versions |
| `site` | `{ key, name, url, codeVersion }` from `backend/sync/site-config.js` - `key` is the poller's identity across sites, `codeVersion` shows which build each site runs |
| `polledUrl`, `selfUrlOk` | the URL Wix saw the request on, and whether its host matches `site.url` (false = a copy/pasted site-config that still names another site) |
| `status` | `ok`, `warning`, or `critical` (worst alert severity) |
| `schedule` | expected cadence and thresholds, so the poller does not hardcode them |
| `lastRun`, `lastOkRun`, `lastOkFullRun` | trimmed `SyncRuns` rows; `minutesSinceLastRun`, `minutesSinceLastOk`, `hoursSinceLastOkFull` alongside |
| `counts` | `housesForSale`, `published`, `stagging`, `staggingStuck`, `staggingLegacy`, `stalePullDates` |
| `stuckStagging` | pipeline rows in Stagging older than 3h (max 20; `stuckStaggingTotal` has the count) with `ageHours`, `pendingPhotos`, `galleryEmpty`, `failStreak`, `lastError` and a one-line `diagnosis` |
| `recentRuns` | last 24 runs (may include a `running` row; one older than 3 min was killed) |
| `events` | recent `SyncEvents` (details JSON already parsed); `eventsHasMore` / `eventsNewestAt` for paging via `syncEvents` |
| `feedErrors` | sections the feed could not read (missing collection or field); the feed still returns 200 |
| `alerts` | `[{ severity, code, key, message, since, count?, ... }]` |

Alert codes. Dedupe on `site.key + key` (`key` equals `code` today; per-listing detail such as `listingIds` rides in the alert data). `since` is always populated: for run- and row-derived alerts it marks when the condition started, so a clear-then-reappear is a new incident; for feed-level alerts (`MISCONFIGURED`, `SITE_IDENTITY_MISMATCH`, `NO_RUNS_RECORDED`) it is the poll time. Notify on transitions, not every poll.

| code | severity | rule |
| --- | --- | --- |
| `NO_RUNS_RECORDED` | critical | `SyncRuns` is empty |
| `NO_RECENT_RUN` | critical | no run started in the last 120 min - the scheduler is not firing or the backend is not deploying. This is the live half of the cron blind spot; the `gap` event / `gapMinutes` is the after-the-fact half |
| `RUN_INCOMPLETE` | critical | a run row is still `running` more than 3 min after it started: the invocation was killed (message names the stage). Runs are recorded at start so a kill can no longer leave no trace |
| `REPEATED_FAILURES` | critical | the newest 2 runs both failed or never finished |
| `ZERO_INVENTORY` | critical | `HousesforSale` is empty |
| `MASS_DELETE_BLOCKED` | critical | a run in the last 24h hit the mass-delete guard; nothing was deleted, review the `mass_delete_guard` event and re-run with `force=1` if the MLS is right |
| `MASS_DELETE` | critical | a run in the last 24h deleted >= max(10, 10% of inventory) (only possible via `force=1` or an incremental run) - read the `delete` events before trusting the MLS |
| `NO_RECENT_FULL_RUN` | warning / critical | no successful full reconcile for 26h / 50h; the full run is the only path that removes listings MLSGrid silently drops |
| `STALE_PULL_DATES` | warning / critical | live rows whose `dateOfMlsPull` is older than 12h (MLSGrid compliance); critical above 10% of inventory |
| `LAST_RUN_FAILED` | warning | newest run has `status: error` (message includes stage + error); a single transient failure self-clears within the hour |
| `NO_RECENT_OK_RUN` | warning | runs are happening but none succeeded in 120 min |
| `NO_OK_RUN_IN_WINDOW` | warning | none of the last 24 runs succeeded |
| `SCHEDULE_GAP` | warning | the newest run followed a > 120 min silence |
| `WRITES_FAILING` | warning | newest run had listing writes that threw |
| `ERRORS_IN_RUN` | warning | newest run completed but wrote error-level events |
| `DRAIN_FAILING` | warning | the photo drain's self-calls failed in the newest run (wrong `SITE_URL` / missing `SYNC_TRIGGER_SECRET`): nothing will publish |
| `EVENTS_NOT_STORED` | warning | the newest run could not persist its events (`SyncEvents` missing or mis-typed) |
| `PHOTOS_FAILING` | warning | on each of the last 3 successful runs photos failed and none uploaded or published |
| `STAGGING_STUCK` | warning | pipeline rows with pending photos stuck in Stagging for 3h+ (ids listed) |
| `STAGGING_NO_PHOTOS` | warning | staged rows with an empty gallery, which can never publish - delete them; they re-stage when the listing next changes |
| `STATS_STALE` | warning | no run in the last 6h completed the neighborhood range stats (the Google Ads feed depends on them) |
| `FEED_TRUNCATED` | warning | newest incremental received fewer records than MLSGrid said it had; paging stopped early |
| `MISCONFIGURED` | warning | a feed section failed to read (see `feedErrors`) |
| `SITE_IDENTITY_MISMATCH` | warning | `selfUrlOk` is false |
| `STAGGING_LEGACY_ROWS` | info | legacy Redfin-audit rows still in Stagging |
| `BUDGET_EXHAUSTED` | info | newest run skipped a sweep for lack of time; occasional is normal |
| `MLSGRID_VOLUME_HIGH` | info | newest incremental pulled > 3000 MLS-wide records |
| `UNPUBLISHED_LIVE_ROWS` | info | `published < housesForSale` |

### Event feed (paging)

```bash
curl "https://<site>/_functions/syncEvents?level=warn&limit=100&since=2026-09-01T00:00:00Z" \
  -H "x-monitor-secret: $MONITOR_FEED_SECRET"
```

Params: `since` and `before` (both inclusive), `skip` (exact paging offset; the response's `nextSkip` is the next page), `level` (minimum), `limit` (max 500), and exact-match `kind`, `listingId`, `runKey`, `mode`. Results are ordered by `at` then `id`, newest first. Response carries `newestAt` (use as the next `since`), `hasMore` / `truncated`, `nextSkip`, `nextBefore`, and every event's `id`. Page a window with `since` + `skip`; `before` is a coarse cursor only, because timestamps are not unique (events written back-to-back share a millisecond), so when using it dedupe on `id`. An unparsable `since` returns `{ error }` with no events.

### Frontlines integration (other repo)

Per site store `{ key, baseUrl, monitorSecret }` and poll `listingsHealth` from the server side every 10-15 minutes (the routes send no CORS headers and the secret must never reach a browser). Keep the last response per site; raise a notification when an alert `key` appears that was not in the previous response, and clear it when it disappears. Poll failures are alerts too: a 403 means the secret is not configured on that site; a 5xx, timeout, non-JSON body or unknown `schemaVersion` should raise `FEED_UNREACHABLE` after 2-3 consecutive misses (a backend build error takes down the jobs and the HTTP functions together, so this is the alert that catches a dead site). A failed poll leaves the previous alert state unchanged. Key alert state on the URL you polled, not on `site.key`, and raise `SITE_IDENTITY_MISMATCH` yourself if `site.url` differs from it. Show `stuckStagging` and `events` (warn+) as the drill-down; for a listing timeline call `syncEvents?listingId=...`. Nothing in the feed can trigger a sync; the mutating routes use a different secret.

### Mass-delete guard

A full reconcile that would delete `max(10, 10%)` of the live inventory does not apply the deletes, nor the staged-row drops planned in the same run. It records `deletesSkipped` on the run, writes a `mass_delete_guard` error event with the candidates grouped by reason, and the feed raises `MASS_DELETE_BLOCKED`. Read the candidates; if the MLS is right, apply them:

```bash
curl -X POST "https://<site>/_functions/runSync?mode=full&force=1" -H "x-sync-secret: $SYNC_TRIGGER_SECRET"
```

Incremental runs guard only data-driven removals (`city_change`, `no_village`, `mls_revoked`) as a group at the same threshold, since a burst of those is what a feed hiccup or a Villages mis-edit looks like; status-change removals always apply. A blank City on a held listing is ignored by the hourly run and only becomes a (guarded) removal in the nightly.

### Retention

The `nightlyPurge` job (04:30 UTC, its own cron entry so it never competes with the reconcile for invocation time) deletes `SyncRuns` older than 90 days (never below the newest 50 rows) and `SyncEvents` older than 30 days, in chunks of 500 within a 50s budget; a backlog converges over a few nights. It always writes a `purge` event with the counts, even when nothing was purged, so a starved purge is visible. Run it on demand:

```bash
curl -X POST "https://<site>/_functions/purgeOld" -H "x-sync-secret: $SYNC_TRIGGER_SECRET"
```

Constants live in `backend/sync/retention.js`. Test-panel helpers in `backend/sync/run.jsw`: `healthReport()`, `listingTimeline(listingId)`, `recentEvents(level, limit)`, `purgeOldAudit()`.

## Verification checklist

- `wixData.query('SyncRuns').descending('startedAt').limit(1).find()` - newest row `status: ok`, `startedAt` within the last hour.
- `HousesforSale` count within +/- 2 of MLSGrid's `@odata.count` for `PostalCity eq 'Longboat Key' and StandardStatus eq 'Active'`.
- Spot-check 3 random listings: price, primary image, village, `dateOfMlsPull` all fresh.
- Wait for a natural status flip (Active -> Pending). Confirm the incremental job removes the listing and trashes its media within the hour.
- Leave `MLS_id_list` unpopulated for one week; confirm nothing breaks.

## Troubleshooting

- **`SyncRuns` shows `status: error`** - `errorStage` says which phase threw and `errorStack` where; the matching `run_error` event carries the counts written before the failure and the incremental window it was pulling. MLSGrid auth errors usually mean `MLSGRID_API_KEY` secret is missing or wrong. Wix collection permission errors mean the job needs `suppressAuth: true` (already set everywhere).
- **Nothing publishes on a newly ported site** - `DRAIN_FAILING` / `drain_failed` events: `SITE_URL` in `site-config.js` still names another site, or `SYNC_TRIGGER_SECRET` is missing, so the photo drain's self-calls get 403.
- **A listing vanished from the site** - `SyncEvents` filtered by its `listingId`: the `delete` event names the reason.
- **`imagesFailed` is the same number run after run** - one Stagging row keeps failing; `listingsHealth.stuckStagging` names it, and its `photos_failed` events carry the URLs and the error. If the error is `HTTP 429`, MLSGrid's media server is rate-limiting a large gallery: the drain backs off, drops to 2 parallel uploads, and if still throttled pauses that listing (`photoRetryAfter` on the Stagging row: 5, 10, 20, 40, then 60 min per consecutive rate-limited attempt) so MLSGrid's limit can reset. The feed's `stuckStagging` diagnosis shows the pause.
- **`pausing this listing for NaN min` / `photoRetryAfter` empty** - a sync helper was called across a `.jsw` boundary. Wix wraps every exported `.jsw` function in a web-method proxy that returns a Promise when called from another module, so a sync helper's result is a truthy Promise and its arithmetic is NaN. Only awaited async functions and plain data may cross a `.jsw` boundary; sync helpers are copied into the module that uses them (`mergeGalleryLocal`, `isRateLimitedLocal`, `rateLimitCooldownMsLocal` in `stagging.jsw`) or live in a plain `.js` module.
- **`drain_failed` events** - a self-call to `processStaggingRow` returned an error. A 504 is not one of these: Wix's HTTP gateway gives up on a long child after a few seconds while the child keeps running (`lateChildren` in the run's drain details); its progress and events are durable.
- **A Stagging row weeks old with an empty gallery and no recent update** - staged while MLSGrid sent no media (the `insert`/`update` warn event says so, and the feed raises `STAGGING_NO_PHOTOS`). The live row is unaffected; delete the Stagging row.
- **`gap` events / `gapMinutes` > 120** - the Wix scheduler was silent; the `NO_RECENT_RUN` alert fires while it is still silent.
- **A `SyncRuns` row stuck at `status: running`** - the run was killed by the Wix invocation timeout in the phase named by `stage`; its events up to the last flush are in `SyncEvents`. Repeated kills in `photos` or `fetch` mean the run is too slow (see `MLSGRID_VOLUME_HIGH`).
- **Missing villages** - a subdivision name from MLSGrid doesn't match any `matchPattern`. Add a row to `Villages`, bump its `order` higher than any conflicting pattern, re-run incremental.
- **Image uploads failing** - check `imagesFailed` on recent runs; a small number is normal (broken MLSGrid URLs). If the number is high, MLSGrid may have rotated CDN hostnames - rerun a full reconcile.
- **Incremental missed a delisting** - the nightly full reconcile will catch it. If you want it sooner, trigger `mode=full` from the Property Management page.
