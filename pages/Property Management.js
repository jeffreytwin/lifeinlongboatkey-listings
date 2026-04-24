// Property Management - monitor-only page.
//
// Replaces the previous human-triggered Fetch / Upload Galleries workflow with
// a read-only dashboard driven by the SyncRuns collection. All MLSGrid ingest
// runs automatically via backend/jobs.config (hourly incremental + nightly
// full). Operators can optionally trigger an ad-hoc run via the buttons below.
//
// Element IDs assumed to exist on the page (rename in Wix Editor if needed):
//   #lastRunMode, #lastRunStatus, #lastRunStarted, #lastRunDuration,
//   #lastRunInserted, #lastRunUpdated, #lastRunDeleted,
//   #lastRunImagesUploaded, #lastRunImagesFailed, #lastRunError,
//   #runsRepeater, #btnRunIncremental, #btnRunFull, #statusMessage

import wixData from 'wix-data';
import { runSync } from 'backend/sync/pipeline';

function formatDuration(startedAt, finishedAt) {
    if (!startedAt || !finishedAt) return '-';
    const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    if (ms < 0) return '-';
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
}

async function refreshStatus() {
    const res = await wixData.query('SyncRuns').descending('startedAt').limit(20).find();
    const latest = res.items[0];

    if (!latest) {
        $w('#statusMessage').text = 'No sync runs recorded yet.';
        $w('#runsRepeater').data = [];
        return;
    }

    $w('#lastRunMode').text = latest.mode || '-';
    $w('#lastRunStatus').text = latest.status || '-';
    $w('#lastRunStarted').text = latest.startedAt ? new Date(latest.startedAt).toLocaleString() : '-';
    $w('#lastRunDuration').text = formatDuration(latest.startedAt, latest.finishedAt);
    $w('#lastRunInserted').text = String(latest.inserted ?? 0);
    $w('#lastRunUpdated').text = String(latest.updated ?? 0);
    $w('#lastRunDeleted').text = String(latest.deleted ?? 0);
    $w('#lastRunImagesUploaded').text = String(latest.imagesUploaded ?? 0);
    $w('#lastRunImagesFailed').text = String(latest.imagesFailed ?? 0);
    $w('#lastRunError').text = latest.errorMessage || '';

    $w('#runsRepeater').data = res.items.map(item => ({
        ...item,
        _id: item._id || String(item.startedAt),
        durationText: formatDuration(item.startedAt, item.finishedAt),
        startedText: item.startedAt ? new Date(item.startedAt).toLocaleString() : ''
    }));
    $w('#statusMessage').text = '';
}

async function triggerRun(mode) {
    $w('#btnRunIncremental').disable();
    $w('#btnRunFull').disable();
    $w('#statusMessage').text = `Triggering ${mode} run - this may take a while...`;

    try {
        const result = await runSync(mode);
        $w('#statusMessage').text = `Run ${result.status || 'ok'}: inserted ${result.inserted || 0}, updated ${result.updated || 0}, deleted ${result.deleted || 0}.`;
    } catch (err) {
        $w('#statusMessage').text = `Run failed: ${err && err.message ? err.message : err}`;
    } finally {
        await refreshStatus();
        $w('#btnRunIncremental').enable();
        $w('#btnRunFull').enable();
    }
}

$w.onReady(async () => {
    $w('#runsRepeater').onItemReady(($item, itemData) => {
        if ($item('#runMode')) $item('#runMode').text = itemData.mode || '-';
        if ($item('#runStatus')) $item('#runStatus').text = itemData.status || '-';
        if ($item('#runStarted')) $item('#runStarted').text = itemData.startedText || '';
        if ($item('#runDuration')) $item('#runDuration').text = itemData.durationText || '-';
        if ($item('#runInserted')) $item('#runInserted').text = String(itemData.inserted ?? 0);
        if ($item('#runUpdated')) $item('#runUpdated').text = String(itemData.updated ?? 0);
        if ($item('#runDeleted')) $item('#runDeleted').text = String(itemData.deleted ?? 0);
        if ($item('#runError')) $item('#runError').text = itemData.errorMessage || '';
    });

    $w('#btnRunIncremental').onClick(() => triggerRun('incremental'));
    $w('#btnRunFull').onClick(() => triggerRun('full'));

    await refreshStatus();
    setInterval(refreshStatus, 60_000);
});
