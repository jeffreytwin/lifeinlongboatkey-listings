// Inventory-driven ad group pause/enable for lifeinlongboatkey.com.
//
// This file lives in the repo for reference only - it runs inside Google Ads.
// Install: Google Ads > Tools & Settings > Bulk Actions > Scripts > "+", paste
// this file, paste the ADS_FEED_SECRET value below, authorize, and schedule
// Hourly. Keep DRY_RUN = true until a Preview run's log shows sensible
// planned changes, then flip it to false.
//
// How it decides: it fetches the site's inventory feed
// (GET /_functions/adsInventoryFeed, built by backend/sync/ads-feed.jsw).
// Each community in the feed carries advertise: true/false - false only after
// the community has had zero published listings for the feed's grace window.
//
// Safety contract:
//  - The script only ever touches ad groups carrying the human-applied label
//    'auto-inventory'. Apply it to each community ad group you want managed;
//    remove it to opt an ad group out. The script never applies that label.
//  - Ad groups are matched to communities by normalized name (case and
//    punctuation insensitive), with NAME_OVERRIDES for exceptions. Unmatched
//    ad groups are reported in the log and never touched.
//  - When the script pauses an ad group it applies its own label
//    'Paused: no inventory', and it only ever ENABLES ad groups carrying that
//    label - so an ad group a human paused stays paused. If you manually
//    re-enable a script-paused ad group while its community is still empty,
//    the script will pause it again next run; remove the 'auto-inventory'
//    label instead if you want it left alone.
//  - If the feed is unreachable, malformed, or suspiciously small, or a run
//    would pause more than MAX_PAUSE_FRACTION of the managed ad groups, the
//    script aborts without changing anything.
//  - Only Search/Display ad groups are managed (AdsApp.adGroups());
//    Performance Max campaigns are not controllable this way.

var FEED_URL = 'https://www.lifeinlongboatkey.com/_functions/adsInventoryFeed';
var FEED_SECRET = 'PASTE_ADS_FEED_SECRET_HERE'; // Wix Secrets Manager: ADS_FEED_SECRET
var DRY_RUN = true;              // log planned changes without applying them
var OPT_IN_LABEL = 'auto-inventory';
var PAUSED_LABEL = 'Paused: no inventory';
var MAX_PAUSE_FRACTION = 0.5;    // abort if a run would pause more than this share of managed ad groups
var MIN_FEED_COMMUNITIES = 50;   // abort if the feed returns fewer communities (expect ~111)
var NAME_OVERRIDES = {
    // normalized ad group name -> exact feed villageName, for names that
    // normalization alone can't reconcile. Example:
    // 'lambiance': "L'Ambiance"
};

function main() {
    var feed = fetchFeed();
    var communities = buildCommunityMap(feed);
    var summary = {
        dryRun: DRY_RUN,
        feedGeneratedAt: feed.generatedAt,
        matched: 0,
        paused: [],
        enabled: [],
        labelOnlyFixes: [],
        skippedHumanPaused: [],
        unmatchedAdGroups: [],
        communitiesWithoutAdGroups: [],
        nameCollisions: communities.collisions,
        anomaliesFromFeed: feed.anomalies
    };

    var optInLabel = getLabel(OPT_IN_LABEL);
    if (!optInLabel) {
        Logger.log('No "' + OPT_IN_LABEL + '" label exists in this account - nothing is opted in, nothing to do.');
        return;
    }

    // Plan first, mutate later, so the circuit breaker sees the whole run.
    var plan = [];
    var matchedVillages = {};
    var it = optInLabel.adGroups().withCondition('Status IN [ENABLED, PAUSED]').get();
    while (it.hasNext()) {
        var adGroup = it.next();
        var community = lookupCommunity(communities, adGroup.getName());
        if (!community) {
            summary.unmatchedAdGroups.push(adGroup.getName());
            continue;
        }
        summary.matched++;
        matchedVillages[community.villageName] = true;

        var paused = adGroup.isPaused();
        var scriptPaused = hasLabel(adGroup, PAUSED_LABEL);
        if (!community.advertise && !paused) {
            plan.push({ action: 'pause', adGroup: adGroup, community: community });
        } else if (community.advertise && paused && scriptPaused) {
            plan.push({ action: 'enable', adGroup: adGroup, community: community });
        } else if (community.advertise && paused && !scriptPaused) {
            // Paused by a human, not by this script - never re-enable.
            summary.skippedHumanPaused.push(adGroup.getName());
        } else if (community.advertise && !paused && scriptPaused) {
            // Human re-enabled it and inventory is back - just clean up our label.
            plan.push({ action: 'unlabel', adGroup: adGroup, community: community });
        }
    }

    var pauses = 0;
    for (var i = 0; i < plan.length; i++) {
        if (plan[i].action === 'pause') pauses++;
    }
    if (summary.matched > 0 && pauses > MAX_PAUSE_FRACTION * summary.matched) {
        Logger.log('CIRCUIT BREAKER: run would pause ' + pauses + ' of ' + summary.matched +
            ' managed ad groups (limit ' + MAX_PAUSE_FRACTION + '). Aborting with no changes - ' +
            'check the site sync before raising MAX_PAUSE_FRACTION.');
        return;
    }

    applyPlan(plan, summary);

    for (var c = 0; c < feed.communities.length; c++) {
        if (!matchedVillages[feed.communities[c].villageName]) {
            summary.communitiesWithoutAdGroups.push(feed.communities[c].villageName);
        }
    }

    Logger.log(JSON.stringify(summary, null, 2));
}

function fetchFeed() {
    var resp = UrlFetchApp.fetch(FEED_URL, {
        headers: { 'x-ads-feed-secret': FEED_SECRET },
        muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
        throw new Error('Feed returned HTTP ' + resp.getResponseCode() + ' - aborting, no changes made. ' +
            '(403 usually means ADS_FEED_SECRET was rotated; update FEED_SECRET in this script.)');
    }
    var feed = JSON.parse(resp.getContentText());
    if (!feed || !feed.communities || feed.communities.length < MIN_FEED_COMMUNITIES) {
        throw new Error('Feed has ' + (feed && feed.communities ? feed.communities.length : 0) +
            ' communities, expected at least ' + MIN_FEED_COMMUNITIES + ' - aborting, no changes made.');
    }
    return feed;
}

// Case- and punctuation-insensitive: "L'Ambiance" -> "l ambiance",
// "Bay Isles - Harbor Section" -> "bay isles harbor section".
function normalizeName(s) {
    return String(s).toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildCommunityMap(feed) {
    var byName = {};
    var collisions = [];
    for (var i = 0; i < feed.communities.length; i++) {
        var community = feed.communities[i];
        var key = normalizeName(community.villageName);
        if (byName[key] && byName[key].villageName !== community.villageName) {
            collisions.push(byName[key].villageName + ' / ' + community.villageName);
            continue; // keep the first; collisions are surfaced in the log
        }
        byName[key] = community;
    }
    return { byName: byName, collisions: collisions };
}

function lookupCommunity(communities, adGroupName) {
    var key = normalizeName(adGroupName);
    var override = NAME_OVERRIDES[key];
    if (override) key = normalizeName(override);
    return communities.byName[key] || null;
}

function applyPlan(plan, summary) {
    if (plan.length && !DRY_RUN) ensurePausedLabelExists();
    for (var i = 0; i < plan.length; i++) {
        var entry = plan[i];
        var name = entry.adGroup.getName();
        if (entry.action === 'pause') {
            if (!DRY_RUN) {
                entry.adGroup.pause();
                entry.adGroup.applyLabel(PAUSED_LABEL);
            }
            summary.paused.push(name + ' (zero inventory since ' + entry.community.zeroSince + ')');
        } else if (entry.action === 'enable') {
            if (!DRY_RUN) {
                entry.adGroup.enable();
                entry.adGroup.removeLabel(PAUSED_LABEL);
            }
            summary.enabled.push(name + ' (' + entry.community.activeListingCount + ' listings)');
        } else if (entry.action === 'unlabel') {
            if (!DRY_RUN) {
                entry.adGroup.removeLabel(PAUSED_LABEL);
            }
            summary.labelOnlyFixes.push(name);
        }
    }
}

function ensurePausedLabelExists() {
    if (!getLabel(PAUSED_LABEL)) {
        AdsApp.createLabel(PAUSED_LABEL,
            'Applied by the inventory sync script; removed automatically when inventory returns.');
    }
}

// Name lookups iterate rather than using withCondition string matching so
// label names with punctuation (like the colon in PAUSED_LABEL) are safe.
function getLabel(name) {
    var it = AdsApp.labels().get();
    while (it.hasNext()) {
        var label = it.next();
        if (label.getName() === name) return label;
    }
    return null;
}

function hasLabel(adGroup, name) {
    var it = adGroup.labels().get();
    while (it.hasNext()) {
        if (it.next().getName() === name) return true;
    }
    return false;
}
