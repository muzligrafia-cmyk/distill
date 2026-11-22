#!/usr/bin/env node
/*  distill.js  —  STEP 2 of 3  (run with Node.js — 2_RunDistill.bat does this for you)

    Usage:   node distill.js                    reads   <Desktop>\distill.json
             node distill.js  some_file.json    reads that file instead (drag & drop a .json onto the .bat)
    Output:  distill_result.json   next to the input  (3_DistillImport.jsx reads it from the Desktop)
             distill_preview.svg   next to the input  (open in a browser to check)

    Requires:  a node_modules folder with clipper-lib next to this file  (npm install clipper-lib)

    Rules used (colors are ignored completely):
      SHEET    = union of every filled shape.
      CUT      = outline of the sheet + any enclosed region painted by nothing.
      ENGRAVE  = every edge visible on the flattened sheet: boundaries between
                 visible fill regions, plus stroke lines minus the parts hidden
                 under higher objects. Edges lying on a cut line are removed.

    How curves survive: the boolean work is done on flattened polylines (the
    Clipper library only understands straight lines), but every flattened point
    remembers which original Bézier curve it came from and where on it. At the
    end, runs of points from the same curve are swapped back for the exact
    original curve piece, so the result has real anchors and handles again.   */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function fail(msg) { console.error('\nERROR: ' + msg + '\n'); process.exit(1); }

let ClipperLib;
try { ClipperLib = require('clipper-lib'); }
catch (e) { fail('The clipper-lib library is missing next to distill.js.\n  Open a command prompt in  ' + __dirname + '  and run:  npm install clipper-lib'); }

const OPT = {
    scale: 1000,            // integer units per pt (Clipper works on integers)
    curveTol: 0.05,         // pt  — curve flattening tolerance for the boolean work (0.05 pt ≈ 0.018 mm)
    snapTol: 0.02,          // pt  — points closer than this are considered identical
    minPieceLen: 0.3,       // pt  — engrave fragments shorter than this are dropped (≈0.1 mm)
    minRingArea: 4.0,       // pt² — cut rings smaller than this are dropped (≈0.5 mm²)
    compoundFillRule: 'evenodd', // how Illustrator compound paths are interpreted
    rebuildCurves: true,    // swap flattened runs back for the original Bézier curves
};

// ---------------------------------------------------------------- locate input / output
function desktopDir() {
    if (process.platform === 'win32') {
        try {   // ask Windows for the real Desktop (handles OneDrive-redirected desktops)
            const out = require('child_process').execSync(
                'powershell -NoProfile -NonInteractive -Command "[Environment]::GetFolderPath(\'Desktop\')"',
                { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (out && fs.existsSync(out)) return out;
        } catch (e) { /* fall through to the guesses below */ }
    }
    const home = os.homedir();
    for (const cand of [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')]) {
        if (fs.existsSync(cand)) return cand;
    }
    return path.join(home, 'Desktop');
}

const t0ms = Date.now();
const inFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(desktopDir(), 'distill.json');
if (!fs.existsSync(inFile)) {
    fail('Input file not found:\n  ' + inFile + '\nRun 1_DistillExport.jsx in Illustrator first — it writes distill.json to the Desktop.');
}
let data;
try { data = JSON.parse(fs.readFileSync(inFile, 'utf8')); }
catch (e) { fail('Could not read ' + inFile + '\n  ' + e.message); }
if (!data || !Array.isArray(data.items)) fail('This file does not look like a distill.json made by 1_DistillExport.jsx.');

const outDir = path.dirname(inFile);
const base = path.basename(inFile).replace(/\.json$/i, '');
const resultFile = path.join(outDir, base + '_result.json');
const previewFile = path.join(outDir, base + '_preview.svg');

console.log(`Input  : ${inFile}`);
console.log(`         exported from "${data.source || '?'}"${data.time ? ' at ' + data.time : ''}`);
if (data.items.length === 0) {
    console.log('WARNING: the export contains no objects at all. Was the illustration selected when 1_DistillExport.jsx ran?');
}

const S = OPT.scale;
const ftNZ = ClipperLib.PolyFillType.pftNonZero;
const ftEO = ClipperLib.PolyFillType.pftEvenOdd;
const CT = ClipperLib.ClipType;

// ---------------------------------------------------------------- point keys + curve registry
const q = Math.max(1, Math.round(OPT.snapTol * S));          // snap grid in integer units
const keyOf = (X, Y) => (Math.round(X / q) * q) + ',' + (Math.round(Y / q) * q);
const keyOfPt = p => keyOf(Math.round(p[0] * S), Math.round(p[1] * S));

const curves = [];            // id -> [p0, p1, p2, p3] original Bézier in pt
const tagMap = new Map();     // point key -> [{c: curve id, t: parameter}, ...]
function addTag(p, c, t) {
    const k = keyOfPt(p);
    let list = tagMap.get(k);
    if (!list) tagMap.set(k, list = []);
    list.push({ c, t });
}

// ---------------------------------------------------------------- curve flattening (tagged)
function flatEnough(p0, p1, p2, p3, tol) {
    const dx = p3[0] - p0[0], dy = p3[1] - p0[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) {
        return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < tol && Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) < tol;
    }
    const d1 = Math.abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx);
    const d2 = Math.abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx);
    return (d1 * d1 <= tol * tol * len2) && (d2 * d2 <= tol * tol * len2);
}
function flattenCubic(p0, p1, p2, p3, tol, out, depth, ta, tb, cid) {
    if (depth > 14 || flatEnough(p0, p1, p2, p3, tol)) { out.push(p3); addTag(p3, cid, tb); return; }
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
    const p012 = mid(p01, p12), p123 = mid(p12, p23), pm = mid(p012, p123);
    const tm = (ta + tb) / 2;
    flattenCubic(p0, p01, p012, pm, tol, out, depth + 1, ta, tm, cid);
    flattenCubic(pm, p123, p23, p3, tol, out, depth + 1, tm, tb, cid);
}
// subpath = {c: closed, p: [[ax,ay,lx,ly,rx,ry], ...]}  -> polyline in pt (curves flattened + tagged)
function subpathToPolyline(sub) {
    const pts = sub.p || [], n = pts.length, out = [];
    if (n === 0) return out;
    out.push([pts[0][0], pts[0][1]]);
    const segs = sub.c ? n : n - 1;
    for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const p0 = [a[0], a[1]], c1 = [a[4], a[5]], c2 = [b[2], b[3]], p3 = [b[0], b[1]];
        const straight = c1[0] === p0[0] && c1[1] === p0[1] && c2[0] === p3[0] && c2[1] === p3[1];
        if (straight) { out.push(p3); continue; }
        const cid = curves.length;
        curves.push([p0, c1, c2, p3]);
        addTag(p0, cid, 0);
        flattenCubic(p0, c1, c2, p3, OPT.curveTol, out, 0, 0, 1, cid);
    }
    if (sub.c && out.length > 1) {
        const f = out[0], l = out[out.length - 1];
        if (f[0] === l[0] && f[1] === l[1]) out.pop();     // Clipper closed paths don't repeat the first point
    }
    return out;
}

// ---------------------------------------------------------------- Clipper helpers
const toC = poly => poly.map(p => ({ X: Math.round(p[0] * S), Y: Math.round(p[1] * S) }));

function normalizeFill(rings, rule) {
    const paths = rings.filter(r => r.length >= 3).map(toC);
    if (!paths.length) return [];
    return ClipperLib.Clipper.SimplifyPolygons(paths, rule === 'evenodd' ? ftEO : ftNZ);
}
function closedOp(type, subj, clip) {
    if (!subj.length) return type === CT.ctUnion ? clip : [];
    if (!clip.length) return type === CT.ctIntersection ? [] : subj;
    const c = new ClipperLib.Clipper();
    c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    const out = new ClipperLib.Paths();
    c.Execute(type, out, ftNZ, ftNZ);
    return out;
}
function openOp(type, lines, clip) {
    if (!lines.length) return [];
    if (!clip.length) return type === CT.ctIntersection ? [] : lines;
    const c = new ClipperLib.Clipper();
    c.AddPaths(lines, ClipperLib.PolyType.ptSubject, false);
    c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    const tree = new ClipperLib.PolyTree();
    c.Execute(type, tree, ftNZ, ftNZ);
    return ClipperLib.Clipper.OpenPathsFromPolyTree(tree);
}
const union = (a, b) => closedOp(CT.ctUnion, a, b);
const diff = (a, b) => closedOp(CT.ctDifference, a, b);
const inter = (a, b) => closedOp(CT.ctIntersection, a, b);

// ---------------------------------------------------------------- build geometry
let sourceAnchors = 0;
const clipPolys = {};
for (const c of data.clips || []) {
    clipPolys[c.id] = normalizeFill((c.sub || []).map(subpathToPolyline), 'evenodd');
}

const items = data.items.map(it => {
    for (const sub of it.sub || []) sourceAnchors += (sub.p || []).length;
    const polylines = (it.sub || []).map(sub => ({ closed: sub.c, pts: subpathToPolyline(sub) }));
    let fill = [], lines = [];
    if (it.fill) {
        const rule = polylines.length > 1 ? OPT.compoundFillRule : 'nonzero';
        fill = normalizeFill(polylines.map(p => p.pts), rule);
    }
    if (it.stroke) {
        lines = polylines.filter(p => p.pts.length >= 2).map(p => {
            const pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;   // closed stroke -> open loop
            return toC(pts);
        });
    }
    for (const cid of it.clips || []) {
        const cp = clipPolys[cid] || [];
        fill = inter(fill, cp);
        lines = openOp(CT.ctIntersection, lines, cp);
    }
    return { id: it.id, z: it.z, fill, lines };
}).sort((a, b) => b.z - a.z);   // top-most first

const nStroked = items.filter(i => i.lines.length).length, nFilled = items.filter(i => i.fill.length).length;
const nStrokedIn = data.items.filter(i => i.stroke).length, nFilledIn = data.items.filter(i => i.fill).length;
console.log(`[1] exported: ${data.items.length} objects — ${nFilledIn} with fill, ${nStrokedIn} with stroke, ${sourceAnchors} anchors, ${curves.length} curved segments`);
console.log(`[2] after clipping masks: ${nFilled} fills, ${nStroked} stroked objects with ${items.reduce((n, i) => n + i.lines.length, 0)} line pieces`);

// ---------------------------------------------------------------- visibility pass (top-down)
let covered = [];                 // union of all fills above the current object
const regionRings = [];           // boundaries of visible fill regions
const visibleLines = [];          // visible stroke pieces
for (const it of items) {
    if (it.lines.length) visibleLines.push(...openOp(CT.ctDifference, it.lines, covered));
    if (it.fill.length) {
        regionRings.push(...diff(it.fill, covered));
        covered = union(covered, it.fill);
    }
}

console.log(`[3] visible: ${regionRings.length} fill-region rings, ${visibleLines.length} stroke pieces (hidden parts removed)`);

// ---------------------------------------------------------------- CUT rings
let material = ClipperLib.Clipper.CleanPolygons(covered, OPT.snapTol * S);
const minArea = OPT.minRingArea * S * S;
const droppedRings = material.filter(r => Math.abs(ClipperLib.Clipper.Area(r)) < minArea).length;
material = material.filter(r => r.length >= 3 && Math.abs(ClipperLib.Clipper.Area(r)) >= minArea);
const outerCount = material.filter(r => ClipperLib.Clipper.Orientation(r)).length;
const holeCount = material.length - outerCount;

// ---------------------------------------------------------------- snap, split, dedupe
const pointIndex = new Map();     // key -> [X, Y]
function snapKey(p) {
    const k = keyOf(p.X, p.Y);
    if (!pointIndex.has(k)) pointIndex.set(k, [Math.round(p.X / q) * q, Math.round(p.Y / q) * q]);
    return k;
}
const rawSegs = [];               // {a, b, cut}
function addPolyline(path, closed, cut) {
    const keys = path.map(snapKey);
    const n = keys.length;
    const count = closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
        const a = keys[i], b = keys[(i + 1) % n];
        if (a !== b) rawSegs.push({ a, b, cut });
    }
    return keys;
}
const cutKeyRings = material.map(r => {
    const keys = addPolyline(r, true, true).filter((k, i, arr) => i === 0 || k !== arr[i - 1]);
    if (keys.length > 1 && keys[0] === keys[keys.length - 1]) keys.pop();
    return keys;
}).filter(k => k.length >= 3);
for (const r of regionRings) addPolyline(r, true, false);
for (const l of visibleLines) addPolyline(l, false, false);

// spatial hash of all snapped points
const CELL = 2 * S;
const grid = new Map();
for (const [k, p] of pointIndex) {
    const ck = Math.floor(p[0] / CELL) + ':' + Math.floor(p[1] / CELL);
    if (!grid.has(ck)) grid.set(ck, []);
    grid.get(ck).push(k);
}
function pointsNear(ax, ay, bx, by) {
    const out = [];
    const x0 = Math.floor(Math.min(ax, bx) / CELL) - 1, x1 = Math.floor(Math.max(ax, bx) / CELL) + 1;
    const y0 = Math.floor(Math.min(ay, by) / CELL) - 1, y1 = Math.floor(Math.max(ay, by) / CELL) + 1;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const cell = grid.get(x + ':' + y);
        if (cell) out.push(...cell);
    }
    return out;
}
// split every segment at any snapped point that lies on it
const splitSegs = [];
for (const s of rawSegs) {
    const A = pointIndex.get(s.a), B = pointIndex.get(s.b);
    const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy;
    const hits = [];
    for (const k of pointsNear(A[0], A[1], B[0], B[1])) {
        if (k === s.a || k === s.b) continue;
        const P = pointIndex.get(k);
        const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2;
        if (t <= 0 || t >= 1) continue;
        const px = A[0] + t * dx - P[0], py = A[1] + t * dy - P[1];
        if (px * px + py * py <= q * q) hits.push({ t, k });
    }
    hits.sort((u, v) => u.t - v.t);
    let prev = s.a;
    for (const h of hits) { if (h.k !== prev) { splitSegs.push({ a: prev, b: h.k, cut: s.cut }); prev = h.k; } }
    if (prev !== s.b) splitSegs.push({ a: prev, b: s.b, cut: s.cut });
}
// dedupe
const segMap = new Map();
for (const s of splitSegs) {
    const key = s.a < s.b ? s.a + '|' + s.b : s.b + '|' + s.a;
    const e = segMap.get(key);
    if (e) e.cut = e.cut || s.cut; else segMap.set(key, { a: s.a, b: s.b, cut: s.cut });
}
const engraveSegs = [...segMap.values()].filter(s => !s.cut);
console.log(`[4] segments: ${rawSegs.length} raw -> ${splitSegs.length} split -> ${segMap.size} unique, ${engraveSegs.length} engrave after removing cut edges`);
const removedOnCut = splitSegs.filter(s => !s.cut).length - engraveSegs.length;

// ---------------------------------------------------------------- chain segments into polylines
const adj = new Map();
engraveSegs.forEach((s, i) => {
    for (const k of [s.a, s.b]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); }
});
const used = new Array(engraveSegs.length).fill(false);
const chains = [];
function walkFrom(startKey) {
    let cur = startKey, chain = [cur];
    for (;;) {
        const next = (adj.get(cur) || []).find(i => !used[i]);
        if (next === undefined) break;
        used[next] = true;
        const s = engraveSegs[next];
        cur = s.a === cur ? s.b : s.a;
        chain.push(cur);
        if ((adj.get(cur) || []).length !== 2) break;     // stop at junctions / ends
    }
    return chain;
}
for (const [k, list] of adj) if (list.length !== 2) {
    while (list.some(i => !used[i])) chains.push(walkFrom(k));
}
engraveSegs.forEach((s, i) => { if (!used[i]) chains.push(walkFrom(s.a)); });   // remaining closed loops

const toPt = k => { const p = pointIndex.get(k); return [p[0] / S, p[1] / S]; };
const chainLen = ch => { let L = 0; for (let i = 1; i < ch.length; i++) { const a = toPt(ch[i - 1]), b = toPt(ch[i]); L += Math.hypot(b[0] - a[0], b[1] - a[1]); } return L; };
let droppedFragments = 0;
const engraveKeyChains = [];      // {keys, closed}
for (const ch of chains) {
    if (ch.length < 2) continue;
    if (chainLen(ch) < OPT.minPieceLen) { droppedFragments++; continue; }
    const closed = ch.length > 3 && ch[0] === ch[ch.length - 1];
    engraveKeyChains.push({ keys: closed ? ch.slice(0, -1) : ch, closed });
}
console.log(`[5] chains: ${chains.length}, kept ${engraveKeyChains.length}, dropped ${droppedFragments} short ones`);

// ---------------------------------------------------------------- rebuild real curves
const projTol = OPT.curveTol + 2 * OPT.snapTol + 0.01;   // a point this close to a curve counts as lying on it
const chordTol = 2 * OPT.curveTol + 2 * OPT.snapTol;     // a straight chain step must hug the curve this closely

const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
function bez(c, t) {
    const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, cc = 3 * mt * t * t, d = t * t * t;
    return [a * c[0][0] + b * c[1][0] + cc * c[2][0] + d * c[3][0], a * c[0][1] + b * c[1][1] + cc * c[2][1] + d * c[3][1]];
}
function distToSeg(P, A, B) {
    const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(A[0] + t * dx - P[0], A[1] + t * dy - P[1]);
}
function splitCubic(c, t) {          // -> [left, right]
    const l = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const p01 = l(c[0], c[1]), p12 = l(c[1], c[2]), p23 = l(c[2], c[3]);
    const p012 = l(p01, p12), p123 = l(p12, p23), pm = l(p012, p123);
    return [[c[0], p01, p012, pm], [pm, p123, p23, c[3]]];
}
function subCurve(c, ta, tb) {       // exact piece of c between parameters ta < tb
    let cur = c;
    if (ta > 0) cur = splitCubic(cur, ta)[1];
    if (tb < 1) cur = splitCubic(cur, (tb - ta) / (1 - ta))[0];
    return cur;
}
function project(c, P) {             // nearest parameter on c to point P
    const N = 24;
    let bestT = 0, bestD = Infinity;
    for (let k = 0; k <= N; k++) { const t = k / N, d = dist2(bez(c, t), P); if (d < bestD) { bestD = d; bestT = t; } }
    let lo = Math.max(0, bestT - 1 / N), hi = Math.min(1, bestT + 1 / N);
    for (let it = 0; it < 30; it++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (dist2(bez(c, m1), P) < dist2(bez(c, m2), P)) hi = m2; else lo = m1;
    }
    const t = (lo + hi) / 2;
    return { t, dist: Math.sqrt(dist2(bez(c, t), P)) };
}
function chordOk(c, ta, tb, A, B) {  // the curve between ta..tb must be nearly the straight step A->B
    for (let k = 1; k <= 6; k++) {
        if (distToSeg(bez(c, ta + (tb - ta) * k / 7), A, B) > chordTol) return false;
    }
    return true;
}
const tagsAt = (keys, i) => tagMap.get(keys[i]) || [];
// parameters at which point i may sit on curve c (tags first; a point without a tag is projected)
function tCandidates(c, keys, pts, i) {
    const ts = [];
    for (const tg of tagsAt(keys, i)) if (tg.c === c) ts.push(tg.t);
    if (ts.length) return ts;
    const pr = project(curves[c], pts[i]);
    return pr.dist <= projTol ? [pr.t] : [];
}
// longest run of chain points starting at i that lie along curve c in one direction
function extendRun(c, keys, pts, i) {
    if (i + 1 >= pts.length) return null;
    const cv = curves[c];
    let start = null;
    for (const ta of tCandidates(c, keys, pts, i)) for (const tb of tCandidates(c, keys, pts, i + 1)) {
        if (ta === tb || !chordOk(cv, ta, tb, pts[i], pts[i + 1])) continue;
        if (!start || Math.abs(tb - ta) < Math.abs(start.tb - start.ta)) start = { ta, tb };
    }
    if (!start) return null;
    const dir = start.tb > start.ta ? 1 : -1;
    let j = i + 1, tj = start.tb;
    while (j + 1 < pts.length) {
        let next = null;
        for (const t of tCandidates(c, keys, pts, j + 1)) {
            if ((t - tj) * dir <= 0 || !chordOk(cv, tj, t, pts[j], pts[j + 1])) continue;
            if (next === null || Math.abs(t - tj) < Math.abs(next - tj)) next = t;
        }
        if (next === null) break;
        tj = next; j++;
    }
    return { c, j, ta: start.ta, tb: tj, dir };
}
function candidateCurves(keys, i) {
    const set = new Set();
    for (let d = 0; d <= 2 && i + d < keys.length; d++) for (const tg of tagsAt(keys, i + d)) set.add(tg.c);
    return set;
}
function isMidRun(keys, a, b, c) {   // does some curve run straight through point b?
    const k3 = [keys[a], keys[b], keys[c]], p3 = k3.map(toPt);
    for (const cv of candidateCurves(k3, 0)) { const r = extendRun(cv, k3, p3, 0); if (r && r.j === 2) return true; }
    return false;
}
function rebuild(keysIn, closed) {
    let keys = keysIn;
    if (closed) {                     // start a ring where a curve run does NOT pass straight through
        const n = keys.length;
        let s = 0;
        for (let i = 0; i < n; i++) if (!isMidRun(keys, (i - 1 + n) % n, i, (i + 1) % n)) { s = i; break; }
        keys = keys.slice(s).concat(keys.slice(0, s));
        keys = keys.concat([keys[0]]);
    }
    const pts = keys.map(toPt), m = pts.length;
    const mk = p => ({ a: p, l: p, r: p });
    const out = [mk(pts[0])];
    let i = 0;
    while (i < m - 1) {
        let best = null;
        if (OPT.rebuildCurves) for (const c of candidateCurves(keys, i)) {
            const run = extendRun(c, keys, pts, i);
            if (run && (!best || run.j > best.j)) best = run;
        }
        if (best) {
            let sub = subCurve(curves[best.c], Math.min(best.ta, best.tb), Math.max(best.ta, best.tb));
            if (best.dir < 0) sub = [sub[3], sub[2], sub[1], sub[0]];
            out[out.length - 1].r = sub[1];
            const np = mk(pts[best.j]); np.l = sub[2];
            out.push(np);
            i = best.j;
        } else {
            out.push(mk(pts[i + 1]));
            i++;
        }
    }
    if (closed) { out[0].l = out[out.length - 1].l; out.pop(); }
    // drop straight-run points that add nothing (e.g. junction splits whose partner edge was a cut line)
    const isStraightPt = p => same(p.l, p.a) && same(p.r, p.a);
    for (let k = closed ? 0 : 1; k < out.length - (closed ? 0 : 1); k++) {
        if (out.length < (closed ? 4 : 3)) break;
        const prev = out[(k - 1 + out.length) % out.length], cur = out[k], next = out[(k + 1) % out.length];
        if (!isStraightPt(cur) || !same(prev.r, prev.a) || !same(next.l, next.a)) continue;
        if (distToSeg(cur.a, prev.a, next.a) < OPT.snapTol) { out.splice(k, 1); k--; }
    }
    return { c: closed, p: out };
}

const cutPaths = cutKeyRings.map(r => rebuild(r, true));
const engravePaths = engraveKeyChains.map(ch => rebuild(ch.keys, ch.closed));
const resultAnchors = cutPaths.concat(engravePaths).reduce((n, p) => n + p.p.length, 0);
const curvedAnchors = cutPaths.concat(engravePaths).reduce((n, p) => n + p.p.filter(x => !same(x.l, x.a) || !same(x.r, x.a)).length, 0);
console.log(`[6] curves rebuilt: ${resultAnchors} anchors in the result (${curvedAnchors} with handles) — source had ${sourceAnchors}`);

// ---------------------------------------------------------------- sanity check
let largest = 0, badPts = 0;
let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
for (const pth of cutPaths.concat(engravePaths)) {
    if (pth.p.length > largest) largest = pth.p.length;
    for (const p of pth.p) {
        for (const v of [p.a, p.l, p.r]) if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) badPts++;
        if (p.a[0] < bx0) bx0 = p.a[0]; if (p.a[0] > bx1) bx1 = p.a[0];
        if (p.a[1] < by0) by0 = p.a[1]; if (p.a[1] > by1) by1 = p.a[1];
    }
}
if (badPts) fail(`${badPts} value(s) came out as NaN/Infinity — that is a bug in distill.js. Please send distill.json so it can be fixed.`);

// ---------------------------------------------------------------- output
// format 2: each path = {c: closed, p: [[ax,ay, lx,ly, rx,ry], ...]} — same layout as the export, one path per line
const r3 = v => { const s = v.toFixed(3).replace(/\.?0+$/, ''); return (s === '-0' || s === '') ? '0' : s; };
const fmtPt = p => '[' + [p.a[0], p.a[1], p.l[0], p.l[1], p.r[0], p.r[1]].map(r3).join(',') + ']';
const fmtPath = pth => '{"c":' + (pth.c ? 'true' : 'false') + ',"p":[' + pth.p.map(fmtPt).join(',') + ']}';
const stats = { cutRings: cutPaths.length, outerPieces: outerCount, holes: holeCount, engravePaths: engravePaths.length,
                anchors: resultAnchors, sourceAnchors, largestPath: largest,
                bounds: [bx0, by0, bx1, by1].map(v => isFinite(v) ? Math.round(v * 10) / 10 : 0) };
const json = '{"units":"pt","format":2,"source":' + JSON.stringify(data.source || '') + ',"time":' + JSON.stringify(data.time || '') +
    ',\n"cut":[\n' + cutPaths.map(fmtPath).join(',\n') + '\n],\n"engrave":[\n' + engravePaths.map(fmtPath).join(',\n') +
    '\n],\n"stats":' + JSON.stringify(stats) + '\n}\n';
fs.writeFileSync(resultFile, json);

// preview SVG with real curves (y flipped because Illustrator's y axis points up)
const f3 = v => v.toFixed(3);
const svgD = pth => {
    const P = pth.p, n = P.length;
    let d = 'M' + f3(P[0].a[0]) + ' ' + f3(-P[0].a[1]);
    const segs = pth.c ? n : n - 1;
    for (let i = 0; i < segs; i++) {
        const A = P[i], B = P[(i + 1) % n];
        if (same(A.r, A.a) && same(B.l, B.a)) d += 'L' + f3(B.a[0]) + ' ' + f3(-B.a[1]);
        else d += 'C' + f3(A.r[0]) + ' ' + f3(-A.r[1]) + ' ' + f3(B.l[0]) + ' ' + f3(-B.l[1]) + ' ' + f3(B.a[0]) + ' ' + f3(-B.a[1]);
    }
    return d + (pth.c ? 'Z' : '');
};
let [minX, minY, maxX, maxY] = isFinite(bx0) ? [bx0, -by1, bx1, -by0] : [0, 0, 100, 100];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - 10} ${minY - 10} ${maxX - minX + 20} ${maxY - minY + 20}">
<rect x="${minX - 10}" y="${minY - 10}" width="${maxX - minX + 20}" height="${maxY - minY + 20}" fill="#fff"/>
<g id="CUT" fill="none" stroke="#f00" stroke-width="0.5">${cutPaths.map(p => `<path d="${svgD(p)}"/>`).join('')}</g>
<g id="ENGRAVE" fill="none" stroke="#000" stroke-width="0.35">${engravePaths.map(p => `<path d="${svgD(p)}"/>`).join('')}</g>
</svg>`;
fs.writeFileSync(previewFile, svg);

console.log('');
console.log(`Objects processed : ${items.length}`);
console.log(`CUT               : ${outerCount} outer contour(s), ${holeCount} hole(s)` + (droppedRings ? `  (${droppedRings} micro rings dropped)` : ''));
console.log(`ENGRAVE           : ${engravePaths.length} paths` + (droppedFragments ? `  (${droppedFragments} fragments < ${OPT.minPieceLen} pt dropped)` : ''));
console.log(`Anchors           : ${resultAnchors} in the result, ${sourceAnchors} in the source`);
console.log(`Edges on cut line removed from engrave: ${removedOnCut}`);
console.log(`Largest path      : ${largest} points`);
console.log(`Coordinate range  : x ${stats.bounds[0]} .. ${stats.bounds[2]} pt,  y ${stats.bounds[1]} .. ${stats.bounds[3]} pt`);
if (largest > 32000) console.log('WARNING: a path has more than 32000 points — Illustrator will refuse it.');
if (outerCount > 1) console.log(`WARNING: the sheet is ${outerCount} disconnected pieces. Check the preview — you may need to connect them in the source.`);
if (outerCount === 0) console.log('WARNING: no filled shapes found — nothing to cut. Give your outline shapes a fill.');
console.log('');
console.log(`Result  : ${resultFile}`);
console.log(`Preview : ${previewFile}`);
console.log(`Took ${((Date.now() - t0ms) / 1000).toFixed(1)} s`);
