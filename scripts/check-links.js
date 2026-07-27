#!/usr/bin/env node
/*
 * Link audit for lifeinlongboatkey.com data.
 *
 * Usage:
 *   node scripts/check-links.js <NeighborhoodsCondos-export.csv> [--offline]
 *
 * Offline checks (always run):
 *   - every Nearby Neighborhood link resolves to a page that exists in the export
 *   - every villageURL in backend/sync/villages.seed.jsw resolves to a page in the export
 *   - every "YouTube Video" value is a well-formed YouTube URL (flags Vimeo/other)
 *
 * Network checks (skipped with --offline; needs normal internet access):
 *   - every neighborhood page URL returns HTTP 200 on the live site
 *   - every YouTube/Vimeo video still exists (oEmbed endpoints)
 *   - every static.wixstatic.com image referenced by the export or the dashboard
 *     source still loads
 *
 * Exit code 1 if anything is broken.
 */

const fs = require('fs');
const path = require('path');

const SITE = 'https://www.lifeinlongboatkey.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CONCURRENCY = 8;

function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift();
    return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] || ''])));
}

function normPath(url) {
    const p = url.startsWith('http') ? new URL(url).pathname : url;
    return decodeURIComponent(p).replace(/\/+$/, '');
}

async function checkUrl(url, opts = {}) {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA, ...(opts.headers || {}) },
            redirect: 'follow',
            signal: AbortSignal.timeout(20000)
        });
        return { url, status: res.status, ok: res.ok };
    } catch (err) {
        return { url, status: 0, ok: false, error: err.cause ? String(err.cause.message || err.cause) : err.message };
    }
}

async function runPool(jobs) {
    const results = [];
    let next = 0;
    async function worker() {
        while (next < jobs.length) {
            const i = next++;
            results[i] = await jobs[i]();
            process.stdout.write('.');
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    process.stdout.write('\n');
    return results;
}

async function main() {
    const args = process.argv.slice(2);
    const offline = args.includes('--offline');
    const csvPath = args.find(a => !a.startsWith('--'));
    if (!csvPath) {
        console.error('usage: node scripts/check-links.js <NeighborhoodsCondos-export.csv> [--offline]');
        process.exit(2);
    }

    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    const problems = [];

    // --- pages that exist, per the export's own dynamic-page link field
    const pagePaths = new Set(rows.map(r => normPath(r['Neighborhood Pages Main'])).filter(Boolean));
    console.log(`${rows.length} neighborhoods, ${pagePaths.size} page slugs`);

    // --- nearby-neighborhood cross links
    for (const r of rows) {
        for (const n of [1, 2, 3, 4]) {
            const v = (r[`Nearby Neighborhood ${n} Link`] || '').trim();
            if (!v) continue;
            if (!pagePaths.has(normPath(v))) {
                problems.push(`nearby link: ${r['Neighborhood Name']} -> ${v} (no such page)`);
            }
        }
    }

    // --- seed villageURLs
    const seedFile = path.resolve(__dirname, '..', 'backend', 'sync', 'villages.seed.jsw');
    const seedUrls = [...new Set(fs.readFileSync(seedFile, 'utf8').match(/https:\/\/www\.lifeinlongboatkey\.com[^\s'"]+/g) || [])];
    for (const u of seedUrls) {
        if (!pagePaths.has(normPath(u))) problems.push(`villages.seed.jsw: ${u} (no such page)`);
    }
    console.log(`offline: checked ${rows.length * 4} nearby links, ${seedUrls.length} seed URLs`);

    // --- video URL shapes
    const videos = rows.map(r => [r['Neighborhood Name'], (r['YouTube Video'] || '').trim()]).filter(([, v]) => v);
    const ytRe = /^https:\/\/(www\.youtube\.com\/watch\?v=[\w-]{11}|youtu\.be\/[\w-]{11})/;
    const vimeoRe = /^https:\/\/vimeo\.com\/\d+/;
    for (const [name, v] of videos) {
        if (vimeoRe.test(v)) problems.push(`video: ${name} has a Vimeo URL in the YouTube Video field: ${v}`);
        else if (!ytRe.test(v)) problems.push(`video: ${name} has a malformed video URL: ${v}`);
    }

    // --- image URLs from export map fields + dashboard amenity icons
    const imgUrls = new Set();
    for (const r of rows) {
        for (const c of ['Interactive Neighborhood Map URL', 'Neighborhood Map URL']) {
            const v = (r[c] || '').trim();
            if (v.startsWith('https://static.wixstatic.com')) imgUrls.add(v);
        }
    }
    const dashPath = path.resolve(__dirname, '..', 'Property Management - Dashboard Page Code.txt');
    if (fs.existsSync(dashPath)) {
        for (const u of fs.readFileSync(dashPath, 'utf8').match(/https:\/\/static\.wixstatic\.com\/[^\s'"`]+/g) || []) imgUrls.add(u);
    }

    if (offline) {
        console.log('(--offline: skipping live-site, video, and image checks)');
    } else {
        console.log(`live: checking ${pagePaths.size} site pages`);
        const pageResults = await runPool([...pagePaths].map(p => () => checkUrl(SITE + encodeURI(p))));
        for (const r of pageResults) {
            if (!r.ok) problems.push(`site page: ${r.url} -> ${r.status || r.error}`);
        }

        console.log(`live: checking ${videos.length} videos`);
        const videoResults = await runPool(videos.map(([name, v]) => async () => {
            const api = vimeoRe.test(v)
                ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(v)}`
                : `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(v)}`;
            return { name, v, ...(await checkUrl(api)) };
        }));
        for (const r of videoResults) {
            if (!r.ok) problems.push(`video: ${r.name} ${r.v} -> oEmbed ${r.status || r.error} (deleted/private/embed-disabled)`);
        }

        console.log(`live: checking ${imgUrls.size} wixstatic images`);
        const imgResults = await runPool([...imgUrls].map(u => () => checkUrl(u)));
        for (const r of imgResults) {
            if (!r.ok) problems.push(`image: ${r.url} -> ${r.status || r.error}`);
        }
    }

    if (problems.length) {
        console.log(`\n${problems.length} problem(s):`);
        for (const p of problems) console.log('  BROKEN  ' + p);
        process.exit(1);
    }
    console.log('\nall checks passed');
}

main().catch(err => { console.error(err); process.exit(2); });
