# lifeinlongboatkey-listings

Automated Longboat Key listings pipeline for Wix Velo. Replaces the former manual Redfin-CSV + dashboard-button workflow with a scheduled job that pulls directly from MLSGrid.

## How it works

Two scheduled jobs in `backend/jobs.config`:

- **Hourly incremental** (`0 * * * *`) - Pulls every Longboat Key record whose `ModificationTimestamp` is newer than the last successful run. Active + matched-village records upsert into `HousesforSale`; any other status (Pending, Sold, Withdrawn, etc.) triggers removal.
- **Nightly full reconcile** (`0 3 * * *`) - Pulls the authoritative set of Active Longboat Key listings and deletes anything in `HousesforSale` that isn't in the feed. Safety net for rare outright deletions and drift.

Every run appends a row to `SyncRuns` (audit log + dashboard source).

## Repo layout

```
backend/
  jobs.config                    scheduled cron entries
  http-functions.js              POST /_functions/{runSync,seedVillages}, GET /_functions/syncStatus
  Fetch.jsw                      back-compat shim (uploadImage, myMoveFilesToTrashFunction)
  seed-villages.jsw              idempotent Villages upsert
  sync/
    pipeline.jsw                 orchestrator (fetch -> classify -> diff -> images -> write -> log)
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

Three Wix Data collections. Create in the CMS before first run.

**HousesforSale** (already exists) - the live listings. No schema changes required.

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

**SyncRuns** - audit log. Columns:

| field | type |
| --- | --- |
| `startedAt`, `finishedAt` | Date |
| `mode` | Text (`incremental` or `full`) |
| `status` | Text (`ok`, `error`, or `partial`) |
| `inserted`, `updated`, `deleted` | Number |
| `imagesUploaded`, `imagesFailed` | Number |
| `mlsGridRequestCount`, `mlsGridListingCount` | Number |
| `errorMessage` | Text |

Permissions: admin read-only; backend writes.

## Secrets

Add via Wix Dashboard -> Settings -> Secrets Manager:

- `MLSGRID_API_KEY` - Bearer token for `https://api.mlsgrid.com/v2/`. Rotate the old hardcoded key after cutover.
- `SYNC_TRIGGER_SECRET` - shared secret for the `/_functions/runSync` HTTP route. Only needed for external callers; the dashboard page calls `runSync()` directly via a backend import and doesn't use this.
- `ADS_FEED_SECRET` - read-only secret for `GET /_functions/adsInventoryFeed`. It gets embedded in the Google Ads Script, so it must be a separate value from `SYNC_TRIGGER_SECRET` - rotating it never touches the mutating sync routes, and a script holding a stale value just gets 403 and aborts harmlessly.

## Deployment / rollout

1. **Install** the backend files (sync to Wix via Git integration or copy/paste into the Velo IDE). Do NOT wire up `backend/jobs.config` yet.
2. **Create** the `Villages` and `SyncRuns` collections (schemas above).
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
8. **Retire the old path** - delete the `MLS_id_list` and `Stagging` collections, rotate the old MLSGrid API key, and delete `backend/Fetch.jsw` once nothing imports from it.

## Regenerating the village seed

Source of truth is the original `Property Management - Dashboard Page Code.txt` in the repo root. To rebuild the seed after a dashboard change:

```bash
node scripts/generate-villages-seed.js
```

This rewrites `backend/sync/villages.seed.jsw`. Review the diff, commit, redeploy, then POST `/_functions/seedVillages` to apply.

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

## Verification checklist

- `wixData.query('SyncRuns').descending('startedAt').limit(1).find()` - newest row `status: ok`, `startedAt` within the last hour.
- `HousesforSale` count within +/- 2 of MLSGrid's `@odata.count` for `PostalCity eq 'Longboat Key' and StandardStatus eq 'Active'`.
- Spot-check 3 random listings: price, primary image, village, `dateOfMlsPull` all fresh.
- Wait for a natural status flip (Active -> Pending). Confirm the incremental job removes the listing and trashes its media within the hour.
- Leave `MLS_id_list` unpopulated for one week; confirm nothing breaks.

## Troubleshooting

- **`SyncRuns` shows `status: error`** - check `errorMessage`. MLSGrid auth errors usually mean `MLSGRID_API_KEY` secret is missing or wrong. Wix collection permission errors mean the job needs `suppressAuth: true` (already set everywhere).
- **Missing villages** - a subdivision name from MLSGrid doesn't match any `matchPattern`. Add a row to `Villages`, bump its `order` higher than any conflicting pattern, re-run incremental.
- **Image uploads failing** - check `imagesFailed` on recent runs; a small number is normal (broken MLSGrid URLs). If the number is high, MLSGrid may have rotated CDN hostnames - rerun a full reconcile.
- **Incremental missed a delisting** - the nightly full reconcile will catch it. If you want it sooner, trigger `mode=full` from the Property Management page.
