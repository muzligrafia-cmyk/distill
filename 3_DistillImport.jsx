/*  3_DistillImport.jsx  —  STEP 3 of 3  (run inside Adobe Illustrator)

    Open the document the artwork came from (or an RGB document with the same
    artboards) and run this script. It reads  distill_result.json  from the
    Desktop — no file dialog — and creates two layers, CUT and ENGRAVE, at the
    original coordinates. If earlier Distill imports are found on those layers
    it asks whether to remove them first.
    Change the colours / stroke width in CFG to match your laser settings.      */

#target illustrator

(function () {
    var CFG = {
        resultName:   "distill_result.json",   // read from the Desktop
        cutLayer:     "CUT",
        engraveLayer: "ENGRAVE",
        cutRGB:       [255, 0, 0],             // exact RGB your laser software expects
        engraveRGB:   [0, 0, 0],
        strokeWidth:  0.25,                    // pt
        groupPrefix:  "Distill "               // imported groups are named "Distill CUT 2026-09-30 14:05"
    };

    if (app.documents.length === 0) { alert("Open the target document first."); return; }
    var doc = app.activeDocument;

    // ---- colour mode (== on purpose: strict === misfires on ExtendScript enums) ----
    if (doc.documentColorSpace != DocumentColorSpace.RGB) {
        if (!confirm("This document is CMYK, but the laser needs exact RGB colours.\n\nConvert the document to RGB now?")) return;
        try { app.executeMenuCommand("doc-color-rgb"); } catch (e0) {}
        if (doc.documentColorSpace != DocumentColorSpace.RGB) {
            alert("Could not convert. Use File > Document Color Mode > RGB Color, then run the script again.");
            return;
        }
    }

    // ---- read the result file -------------------------------------------
    var f = new File(Folder.desktop + "/" + CFG.resultName);
    if (!f.exists) {
        alert("Result file not found:\n" + f.fsName + "\n\nRun 1_DistillExport.jsx, then 2_RunDistill.bat first.");
        return;
    }
    f.encoding = "UTF-8";
    if (!f.open("r")) { alert("Could not open " + f.fsName + (f.error ? "  (" + f.error + ")" : "")); return; }
    var txt = f.read();
    f.close();

    var res;
    try { res = eval("(" + txt + ")"); } catch (e1) { alert("Could not read the result file: " + e1.message); return; }
    var cutPaths = res.cut || [], engPaths = res.engrave || [];
    if (cutPaths.length === 0 && engPaths.length === 0) {
        alert("The result file is empty — nothing to import.\n\nCheck step 1: was the whole illustration selected, and does it contain filled shapes?");
        return;
    }
    if (res.source && String(res.source).toLowerCase() !== String(doc.name).toLowerCase()) {
        if (!confirm("This result was exported from \"" + res.source + "\"" + (res.time ? " at " + res.time : "") +
                     ",\nbut \"" + doc.name + "\" is open now.\n\nImport into this document anyway?")) return;
    }

    // ---- helpers ----------------------------------------------------------
    function two(n) { return (n < 10 ? "0" : "") + n; }
    function stamp() {
        var d = new Date();
        return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
               " " + two(d.getHours()) + ":" + two(d.getMinutes());
    }
    function rgb(arr) { var c = new RGBColor(); c.red = arr[0]; c.green = arr[1]; c.blue = arr[2]; return c; }
    function findLayer(name) {
        for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === name) return doc.layers[i];
        return null;
    }
    function getLayer(name) {
        var L = findLayer(name);
        if (!L) { L = doc.layers.add(); L.name = name; }
        return L;
    }
    function isDistillGroup(g, layerName) {
        var n = String(g.name || "");
        if (g.note === "distill") return true;
        if (n.indexOf(CFG.groupPrefix) === 0) return true;
        return n.indexOf(layerName + " ") === 0 && /\d/.test(n);    // groups made by the old script version
    }
    function findOldImports(layerName) {
        var L = findLayer(layerName), out = [];
        if (!L) return out;
        for (var i = 0; i < L.pageItems.length; i++) {
            var it = L.pageItems[i];
            if (it.typename === "GroupItem" && isDistillGroup(it, layerName)) out.push(it);
        }
        return out;
    }
    function samePoint(a, b) { return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6; }
    function isNum(v) { return typeof v === "number" && isFinite(v); }
    function r1(v) { return Math.round(v * 10) / 10; }
    function describe(pts) {      // point count + coordinate range, for the failure report
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, badAt = -1;
        for (var k = 0; k < pts.length; k++) {
            var q = pts[k];
            if (!q || q.length < 2 || !isNum(q[0]) || !isNum(q[1])) { if (badAt < 0) badAt = k; continue; }
            if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
            if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
        }
        return pts.length + " points, x " + r1(x0) + ".." + r1(x1) + ", y " + r1(y0) + ".." + r1(y1) +
               (badAt >= 0 ? ", point " + badAt + " is not a valid number: " + pts[badAt] : "");
    }

    var failures = [], largest = 0;

    // setEntirePath refuses arrays longer than ~1000 points ("Illegal argument"),
    // so long paths get the first chunk that way and the rest appended point by point.
    var MAX_SET = 1000;
    function appendPoints(p, pts, from) {
        for (var k = from; k < pts.length; k++) {
            var pp = p.pathPoints.add();
            pp.anchor = pts[k];
            pp.leftDirection = pts[k];
            pp.rightDirection = pts[k];
            pp.pointType = PointType.CORNER;
        }
    }
    function setPoints(p, pts) {
        try {
            if (pts.length <= MAX_SET) { p.setEntirePath(pts); return; }
            p.setEntirePath(pts.slice(0, MAX_SET));
            appendPoints(p, pts, MAX_SET);
            return;
        } catch (e) { /* fall through to the slow way */ }
        p.setEntirePath([pts[0], pts[1]]);     // slow but bulletproof: two points, then one at a time
        appendPoints(p, pts, 2);
    }

    // Result format 2: each path is {c: closed, p: [[ax,ay, lx,ly, rx,ry], ...]} — anchors plus Bézier handles.
    function isSmooth(q) {      // handles in line on opposite sides of the anchor -> Illustrator "smooth" point
        var lx = q[2] - q[0], ly = q[3] - q[1], rx = q[4] - q[0], ry = q[5] - q[1];
        var ll = Math.sqrt(lx * lx + ly * ly), rl = Math.sqrt(rx * rx + ry * ry);
        if (ll < 1e-6 || rl < 1e-6) return false;
        var cross = (lx * ry - ly * rx) / (ll * rl), dot = (lx * rx + ly * ry) / (ll * rl);
        return Math.abs(cross) < 0.02 && dot < 0;
    }
    function fillPath(p, rec) {
        var pts = rec.p, n = pts.length, anchors = [], i;
        for (i = 0; i < n; i++) anchors.push([pts[i][0], pts[i][1]]);
        setPoints(p, anchors);
        p.closed = !!rec.c;
        for (i = 0; i < n; i++) {
            var q = pts[i];
            if (q.length < 6) continue;
            var hasL = q[2] !== q[0] || q[3] !== q[1], hasR = q[4] !== q[0] || q[5] !== q[1];
            if (!hasL && !hasR) continue;
            var pp = p.pathPoints[i];
            pp.leftDirection = [q[2], q[3]];
            pp.rightDirection = [q[4], q[5]];
            pp.pointType = isSmooth(q) ? PointType.SMOOTH : PointType.CORNER;
        }
    }

    function build(layerName, paths, closedRings, color) {
        var L = getLayer(layerName);
        L.locked = false; L.visible = true;
        var g = L.groupItems.add();
        g.name = CFG.groupPrefix + layerName + " " + stamp();
        try { g.note = "distill"; } catch (e) {}
        var n = 0;
        for (var i = 0; i < paths.length; i++) {
            var rec = paths[i];
            if (!rec) continue;
            if (!rec.p) {                                    // old flat format: a plain list of [x,y] points
                var pts = rec, closed = closedRings;
                if (!closed && pts.length > 3 && samePoint(pts[0], pts[pts.length - 1])) {
                    pts = pts.slice(0, pts.length - 1);
                    closed = true;
                }
                rec = { c: closed, p: pts };
            }
            if (rec.p.length < 2) continue;
            if (rec.p.length > largest) largest = rec.p.length;
            var p = g.pathItems.add();
            try {
                fillPath(p, rec);
            } catch (e1) {
                try { p.remove(); } catch (e2) {}
                failures.push(layerName + " path " + (i + 1) + " of " + paths.length + ": " + e1.message + " — " + describe(rec.p));
                continue;
            }
            p.filled = false;
            p.stroked = true;
            p.strokeColor = color;
            p.strokeWidth = CFG.strokeWidth;
            n++;
        }
        return { group: g, count: n };
    }

    // ---- earlier imports --------------------------------------------------
    var old = findOldImports(CFG.cutLayer).concat(findOldImports(CFG.engraveLayer));
    if (old.length > 0) {
        if (confirm("Found " + old.length + " earlier Distill import group(s) on the " + CFG.cutLayer + " / " +
                    CFG.engraveLayer + " layers.\n\nRemove them before importing the new result?\n\n" +
                    "Yes = replace them      No = keep them and add the new import as well")) {
            for (var k = 0; k < old.length; k++) { try { old[k].locked = false; old[k].remove(); } catch (e2) {} }
        }
    }

    // ---- build ------------------------------------------------------------
    var prevCS = null;
    try { prevCS = app.coordinateSystem; app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM; } catch (e3) {}
    var rc, re;
    try {
        rc = build(CFG.cutLayer, cutPaths, true, rgb(CFG.cutRGB));
        re = build(CFG.engraveLayer, engPaths, false, rgb(CFG.engraveRGB));
    } catch (err) {
        try { if (prevCS !== null) app.coordinateSystem = prevCS; } catch (e4) {}
        alert("Import failed: " + err.message + (err.line ? "  (line " + err.line + ")" : ""));
        return;
    }
    try { if (prevCS !== null) app.coordinateSystem = prevCS; } catch (e5) {}
    try { doc.selection = null; rc.group.selected = true; re.group.selected = true; } catch (e6) {}

    var msg = "Imported\n  " + rc.count + " cut path(s) on layer " + CFG.cutLayer +
              "\n  " + re.count + " engrave path(s) on layer " + CFG.engraveLayer +
              (res.stats && res.stats.anchors ? "\n  " + res.stats.anchors + " anchors in total (source art had " + res.stats.sourceAnchors + ")" : "") +
              "\n  largest path: " + largest + " points" +
              (res.stats && res.stats.outerPieces > 1 ? "\n\nNote: the sheet has " + res.stats.outerPieces + " separate pieces." : "");
    if (failures.length) {
        msg += "\n\n" + failures.length + " path(s) were REFUSED by Illustrator and skipped:\n";
        for (var w = 0; w < Math.min(failures.length, 6); w++) msg += "- " + failures[w] + "\n";
        if (failures.length > 6) msg += "...";
    }
    alert(msg);
})();
