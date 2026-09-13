// Per-site identity and schedule expectations. Everything here is the kind of
// value that changes when this codebase is deployed to another site
// (Lakewood Ranch, Wellen Park, Parrish), so keep it in one place.
//
// SITE_URL is used by the self-calling HTTP chains (media drain, Stagging
// fan-out) and by the health feed so the ops app can tell sites apart.

export const SITE_KEY = 'lifeinlongboatkey';
export const SITE_NAME = 'Life in Longboat Key';
export const SITE_URL = 'https://www.lifeinlongboatkey.com';

// Mirrors backend/jobs.config. The gap detector and the health feed use these
// to decide when "no run recorded" becomes an alert.
export const INCREMENTAL_EVERY_MINUTES = 60;
export const FULL_RUN_HOUR_UTC = 3; // 03:30 UTC; the purge follows at 04:30 UTC
// Bump on every deploy so the health feed shows which build each site runs.
export const CODE_VERSION = '2026.09.12-observability';

// How long before a scheduled run counts as missed. Wix cron drift of a few
// minutes is normal; a run that is more than one full interval late is not.
export const RUN_LATE_AFTER_MINUTES = 120;
