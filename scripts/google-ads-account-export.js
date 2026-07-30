// Read-only Google Ads account snapshot for auditing with Claude.
//
// This file lives in the repo for reference only - it runs inside Google Ads.
// Install like the inventory script: Google Ads > Tools & Settings > Bulk
// Actions > Scripts > "+", paste, authorize (it will ask for Drive/Sheets
// access - it writes the snapshot to a new Google Sheet), and click Run.
// No schedule needed; run it whenever you want a fresh audit.
//
// The script NEVER mutates the account - it only reads. Output is a new
// Google Sheet (URL printed in the log) with one tab per entity:
//   Campaigns, Ad Groups, Ads, Keywords, Negatives, Search Terms 30d
// Download it via File > Download > Microsoft Excel (.xlsx) and hand the
// file to Claude with whatever audit question you have.
//
// Notes:
//  - Stats are LAST_30_DAYS, in the account's currency.
//  - The Search Terms tab comes from the Google Ads reporting API; its
//    cost_micros column is cost x 1,000,000 (a script/API convention).
//  - AdsApp covers Search/Display. Performance Max campaigns, if any, are
//    not included in these iterators.

var SHEET_PREFIX = 'LBK Google Ads Snapshot';
var STATS_RANGE = 'LAST_30_DAYS';
var KEYWORD_LIMIT = 15000;   // safety cap; raise if the account outgrows it
var SEARCH_TERM_LIMIT = 5000;

function main() {
    var account = AdsApp.currentAccount();
    var name = SHEET_PREFIX + ' ' +
        Utilities.formatDate(new Date(), account.getTimeZone(), 'yyyy-MM-dd HH:mm');
    var ss = SpreadsheetApp.create(name);

    exportCampaigns(ss.insertSheet('Campaigns'));
    exportAdGroups(ss.insertSheet('Ad Groups'));
    exportAds(ss.insertSheet('Ads'));
    exportKeywords(ss.insertSheet('Keywords'));
    exportNegatives(ss.insertSheet('Negatives'));
    exportSearchTerms(ss.insertSheet('Search Terms 30d'));

    var def = ss.getSheetByName('Sheet1');
    if (def) ss.deleteSheet(def);

    Logger.log('Account: ' + account.getName() + ' (' + account.getCurrencyCode() + ', ' +
        account.getTimeZone() + ')');
    Logger.log('Snapshot ready - download as .xlsx and hand to Claude:');
    Logger.log(ss.getUrl());
}

function writeRows(sheet, header, rows) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    if (rows.length) {
        sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
    }
    sheet.setFrozenRows(1);
}

function statusOf(entity) {
    try {
        if (entity.isEnabled()) return 'ENABLED';
        if (entity.isPaused()) return 'PAUSED';
        return 'OTHER';
    } catch (e) {
        return '';
    }
}

function labelNames(entity) {
    try {
        var names = [];
        var it = entity.labels().get();
        while (it.hasNext()) names.push(it.next().getName());
        return names.join(', ');
    } catch (e) {
        return '';
    }
}

// impressions, clicks, ctr, cost, avg cpc, conversions
function statsCols(entity) {
    try {
        var s = entity.getStatsFor(STATS_RANGE);
        return [s.getImpressions(), s.getClicks(), s.getCtr(), s.getCost(),
            s.getAverageCpc(), s.getConversions()];
    } catch (e) {
        return ['', '', '', '', '', ''];
    }
}

var STATS_HEADER = ['Impr 30d', 'Clicks 30d', 'CTR 30d', 'Cost 30d', 'Avg CPC 30d', 'Conv 30d'];

function exportCampaigns(sheet) {
    var rows = [];
    var it = AdsApp.campaigns().withCondition('Status IN [ENABLED, PAUSED]').get();
    while (it.hasNext()) {
        var c = it.next();
        var budget = '';
        try { budget = c.getBudget().getAmount(); } catch (e) { }
        rows.push([c.getName(), statusOf(c), budget, labelNames(c)].concat(statsCols(c)));
    }
    writeRows(sheet, ['Campaign', 'Status', 'Daily budget', 'Labels'].concat(STATS_HEADER), rows);
}

function exportAdGroups(sheet) {
    var rows = [];
    var it = AdsApp.adGroups().withCondition('Status IN [ENABLED, PAUSED]').get();
    while (it.hasNext()) {
        var g = it.next();
        var cpc = '';
        try { cpc = g.bidding().getCpc(); } catch (e) { }
        rows.push([g.getCampaign().getName(), g.getName(), statusOf(g), labelNames(g), cpc]
            .concat(statsCols(g)));
    }
    writeRows(sheet,
        ['Campaign', 'Ad group', 'Status', 'Labels', 'Max CPC'].concat(STATS_HEADER), rows);
}

function exportAds(sheet) {
    var rows = [];
    var it = AdsApp.ads().withCondition('Status IN [ENABLED, PAUSED]').get();
    while (it.hasNext()) {
        var a = it.next();
        var type = '', approval = '';
        try { type = a.getType(); } catch (e) { }
        try { approval = a.getPolicyApprovalStatus(); } catch (e) { }
        rows.push([a.getAdGroup().getCampaign().getName(), a.getAdGroup().getName(),
            type, statusOf(a), approval].concat(statsCols(a)));
    }
    writeRows(sheet,
        ['Campaign', 'Ad group', 'Type', 'Status', 'Approval'].concat(STATS_HEADER), rows);
}

function exportKeywords(sheet) {
    var rows = [];
    var it = AdsApp.keywords().withCondition('Status IN [ENABLED, PAUSED]')
        .withLimit(KEYWORD_LIMIT).get();
    while (it.hasNext()) {
        var k = it.next();
        var qs = '', cpc = '';
        try { qs = k.getQualityScore(); } catch (e) { }
        try { cpc = k.bidding().getCpc(); } catch (e) { }
        rows.push([k.getAdGroup().getCampaign().getName(), k.getAdGroup().getName(),
            k.getText(), k.getMatchType(), statusOf(k), qs, cpc].concat(statsCols(k)));
    }
    writeRows(sheet,
        ['Campaign', 'Ad group', 'Keyword', 'Match type', 'Status', 'QS', 'Max CPC']
            .concat(STATS_HEADER), rows);
}

function exportNegatives(sheet) {
    var rows = [];
    var campIt = AdsApp.campaigns().withCondition('Status IN [ENABLED, PAUSED]').get();
    while (campIt.hasNext()) {
        var c = campIt.next();
        var negIt = c.negativeKeywords().get();
        while (negIt.hasNext()) {
            var n = negIt.next();
            rows.push(['CAMPAIGN', c.getName(), '', n.getText(), n.getMatchType()]);
        }
    }
    var groupIt = AdsApp.adGroups().withCondition('Status IN [ENABLED, PAUSED]').get();
    while (groupIt.hasNext()) {
        var g = groupIt.next();
        var gNegIt = g.negativeKeywords().get();
        while (gNegIt.hasNext()) {
            var gn = gNegIt.next();
            rows.push(['AD GROUP', g.getCampaign().getName(), g.getName(),
                gn.getText(), gn.getMatchType()]);
        }
    }
    var listIt = AdsApp.negativeKeywordLists().get();
    while (listIt.hasNext()) {
        var list = listIt.next();
        var itemIt = list.negativeKeywords().get();
        while (itemIt.hasNext()) {
            var item = itemIt.next();
            rows.push(['SHARED LIST: ' + list.getName(), '', '',
                item.getText(), item.getMatchType()]);
        }
    }
    writeRows(sheet, ['Scope', 'Campaign', 'Ad group', 'Negative keyword', 'Match type'], rows);
}

function exportSearchTerms(sheet) {
    try {
        var query = 'SELECT campaign.name, ad_group.name, search_term_view.search_term, ' +
            'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ' +
            'FROM search_term_view ' +
            'WHERE segments.date DURING LAST_30_DAYS ' +
            'ORDER BY metrics.cost_micros DESC ' +
            'LIMIT ' + SEARCH_TERM_LIMIT;
        AdsApp.report(query).exportToSheet(sheet);
        sheet.setFrozenRows(1);
    } catch (e) {
        sheet.getRange(1, 1).setValue('Search terms report failed: ' + e);
        Logger.log('Search terms export failed (rest of the snapshot is fine): ' + e);
    }
}
