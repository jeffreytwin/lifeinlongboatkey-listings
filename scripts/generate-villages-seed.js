#!/usr/bin/env node
/*
 * Parses the legacy Wix dashboard page code and emits backend/sync/villages.seed.jsw,
 * the authoritative seed for the `Villages` collection used by sync/villages.jsw.
 *
 * The dashboard source encodes village matching as two parallel sections:
 *   1. `let isFoo = subDivisionName.search("pattern");`  -> match patterns
 *   2. `if (isFoo !== -1) { valData['Village'] = "..."; valData['villageSortHelp'] = "...";
 *        valData['VillageURL'] = `${baseURL}/neighborhood/...`; valData['village1'] = "...-uuid"; }`
 *
 * The original logic used sequential `if` blocks, so a *later* match in source order
 * overwrites an earlier one. We preserve that by assigning an ascending `order` field
 * to each entry in the order its `if` block appears; sync/villages.jsw then queries
 * `.descending('order')` and returns the first match, which matches the legacy semantics.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.resolve(__dirname, '..', 'Property Management - Dashboard Page Code.txt');
const DEST = path.resolve(__dirname, '..', 'backend', 'sync', 'villages.seed.jsw');

const src = fs.readFileSync(SOURCE, 'utf8');

// Scan from the character after an opening `{`, returning the body up to the matching `}`.
// Respects `${...}` inside template literals and single/double-quoted strings so we don't
// terminate early on stray braces or quotes in content.
function extractBlockBody(s, start) {
    // Stack of frames; a 'code' frame tracks its own brace depth.
    // Outer frame starts at depth 1 (the caller already consumed the opening `{`).
    const stack = [{ kind: 'code', depth: 1 }];
    let i = start;
    while (i < s.length) {
        const top = stack[stack.length - 1];
        const c = s[i];
        if (top.kind === 'code') {
            if (c === '{') { top.depth++; i++; continue; }
            if (c === '}') {
                top.depth--;
                if (top.depth === 0) {
                    if (stack.length === 1) return s.slice(start, i);
                    stack.pop(); // return to surrounding template literal
                }
                i++; continue;
            }
            if (c === '"' || c === "'") { stack.push({ kind: 'str', q: c }); i++; continue; }
            if (c === '`') { stack.push({ kind: 'tmpl' }); i++; continue; }
            if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
            if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
            i++; continue;
        }
        if (top.kind === 'str') {
            if (c === '\\') { i += 2; continue; }
            if (c === top.q) { stack.pop(); i++; continue; }
            i++; continue;
        }
        if (top.kind === 'tmpl') {
            if (c === '\\') { i += 2; continue; }
            if (c === '`') { stack.pop(); i++; continue; }
            if (c === '$' && s[i + 1] === '{') { stack.push({ kind: 'code', depth: 1 }); i += 2; continue; }
            i++; continue;
        }
    }
    return null;
}

// 1. Collect match patterns keyed by identifier (isFoo -> "pattern").
const patternRe = /let\s+(is[A-Za-z0-9_]+)\s*=\s*subDivisionName\.search\(\s*"([^"]+)"\s*\)\s*;/g;
const patterns = new Map();
for (const m of src.matchAll(patternRe)) {
    if (!patterns.has(m[1])) patterns.set(m[1], m[2]);
}

// 2. Walk the `if (isFoo !== -1) {` headers in source order and capture each block
// body by scanning braces manually - a lazy regex would terminate inside `${baseURL}`.
const headerRe = /if\s*\(\s*(is[A-Za-z0-9_]+)\s*!==\s*-1\s*\)\s*\{/g;
const entries = [];
const seen = new Set();
for (const m of src.matchAll(headerRe)) {
    const ident = m[1];
    const body = extractBlockBody(src, m.index + m[0].length);
    if (body == null) continue;
    if (seen.has(ident)) continue; // only take the first real assignment block per identifier.
    const village = /valData\[\s*['"]Village['"]\s*\]\s*=\s*"([^"]+)"/.exec(body);
    const sortHelp = /valData\[\s*['"]villageSortHelp['"]\s*\]\s*=\s*"([^"]+)"/.exec(body);
    const url = /valData\[\s*['"]VillageURL['"]\s*\]\s*=\s*`\$\{baseURL\}([^`]+)`/.exec(body);
    const village1 = /valData\[\s*['"]village1['"]\s*\]\s*=\s*"([^"]+)"/.exec(body);
    if (!village || !url || !village1) continue; // skip non-assignment blocks (e.g. the big truthy-or guard)
    if (!patterns.has(ident)) {
        console.warn(`warn: no match pattern found for ${ident}; skipping`);
        continue;
    }
    seen.add(ident);
    entries.push({
        matchPattern: patterns.get(ident).toLowerCase(),
        villageName: village[1],
        villageSortHelp: sortHelp ? sortHelp[1] : village[1],
        villageURL: 'https://www.lifeinlongboatkey.com' + url[1],
        village1: village1[1]
    });
}

if (entries.length === 0) {
    console.error('error: no village entries parsed; aborting');
    process.exit(1);
}

// 3. Assign ascending `order` so the last entry in source order wins under descending('order').
entries.forEach((e, i) => { e.order = i + 1; });

const header =
    '// AUTO-GENERATED by scripts/generate-villages-seed.js.\n' +
    '// Do not edit by hand - rerun the generator against the dashboard source.\n' +
    '// Source: Property Management - Dashboard Page Code.txt\n\n' +
    'export const VILLAGE_SEED = ';

const body = JSON.stringify(entries, null, 2) + ';\n';
fs.writeFileSync(DEST, header + body);
console.log(`wrote ${entries.length} villages to ${path.relative(process.cwd(), DEST)}`);
