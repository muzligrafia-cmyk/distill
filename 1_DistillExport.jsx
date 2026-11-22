/*  1_DistillExport.jsx  —  STEP 1 of 3  (run inside Adobe Illustrator)

    Select the whole illustration, then run this script.
    It duplicates the selection onto a temporary layer (no clipboard involved,
    so "Paste Remembers Layers" can't interfere), expands appearance, outlines
    text, then walks every path bottom-to-top and records:
      - stacking order (z)
      - whether it has a fill / a stroke
      - its Bezier geometry (anchor + handles)
      - which clipping masks enclose it
    Result:  distill.json  on the Desktop — always the same name, the previous
             one is overwritten. Works for unsaved documents too.
    The original artwork is never modified.

    Next step: double-click  2_RunDistill.bat                                 */

#target illustrator

(function () {
    var OUT_NAME  = "distill.json";     // always this name, always on the Desktop
    var TMP_LAYER = "_distill_tmp";
    var DECIMALS  = 4;

    if (app.documents.length === 0) { alert("Open a document first."); return; }
    var doc = app.activeDocument;
    var selection = doc.selection;
    if (!selection || selection.length === 0 || selection.typename === "TextRange") {
        alert("Select the whole illustration with the Selection tool first, then run the script.");
        return;
    }

    var outFile = new File(Folder.desktop + "/" + OUT_NAME);

    var warnings = [];
    var records  = [];      // exported paths, as JSON text
    var clips    = [];      // clipping mask geometry, as JSON text
    var zCounter = 0;
    var sel = [], dups = [], tmp = null, prevCS = null, i;

    // ---- helpers --------------------------------------------------------
    function num(v) {
        var s = v.toFixed(DECIMALS);
        if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
        if (s === "-0") s = "0";
        return s;
    }
    function jsonStr(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
    function two(n) { return (n < 10 ? "0" : "") + n; }
    function stamp() {
        var d = new Date();
        return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
               " " + two(d.getHours()) + ":" + two(d.getMinutes());
    }
    function isFilled(p) {
        try { return p.filled && p.fillColor.typename !== "NoColor"; } catch (e) { return false; }
    }
    function isStroked(p) {
        try { return p.stroked && p.strokeColor.typename !== "NoColor"; } catch (e) { return false; }
    }
    function isInvisible(it) {
        try { if (it.hidden) return true; } catch (e1) {}
        try { if (it.opacity === 0) return true; } catch (e2) {}     // 0 % opacity covers nothing
        return false;
    }

    function subpathOf(p) {
        var pts = p.pathPoints, arr = [];
        for (var k = 0; k < pts.length; k++) {
            var a = pts[k].anchor, l = pts[k].leftDirection, r = pts[k].rightDirection;
            arr.push("[" + num(a[0]) + "," + num(a[1]) + "," + num(l[0]) + "," + num(l[1]) +
                     "," + num(r[0]) + "," + num(r[1]) + "]");
        }
        return '{"c":' + (p.closed ? "true" : "false") + ',"p":[' + arr.join(",") + "]}";
    }

    function subpathsOf(item) {
        var out = [];
        if (item.typename === "PathItem") {
            out.push(subpathOf(item));
        } else if (item.typename === "CompoundPathItem") {
            for (var k = 0; k < item.pathItems.length; k++) out.push(subpathOf(item.pathItems[k]));
        }
        return out;
    }

    function addRecord(subs, filled, stroked, clipStack) {
        if (subs.length === 0) return;
        if (!filled && !stroked) return;                 // invisible geometry, ignore
        records.push('{"id":' + records.length + ',"z":' + (zCounter++) +
                     ',"fill":' + (filled ? "true" : "false") +
                     ',"stroke":' + (stroked ? "true" : "false") +
                     ',"clips":[' + clipStack.join(",") + "]" +
                     ',"sub":[' + subs.join(",") + "]}");
    }

    function findMask(group) {
        for (var k = 0; k < group.pageItems.length; k++) {
            var c = group.pageItems[k];
            if (c.typename === "PathItem" && c.clipping) return c;
            if (c.typename === "CompoundPathItem" && c.pathItems.length > 0 && c.pathItems[0].clipping) return c;
        }
        return null;
    }

    function walk(container, clipStack) {
        var kids = container.pageItems, arr = [], k;
        for (k = 0; k < kids.length; k++) arr.push(kids[k]);      // snapshot (stable while recursing)
        for (k = arr.length - 1; k >= 0; k--) visit(arr[k], clipStack);   // bottom -> top
    }

    function visit(it, clipStack) {
        if (isInvisible(it)) return;
        var t = it.typename;
        if (t === "GroupItem") {
            var stack = clipStack;
            if (it.clipped) {
                var mask = findMask(it);
                if (mask) {
                    stack = clipStack.concat([clips.length]);
                    clips.push('{"id":' + clips.length + ',"sub":[' + subpathsOf(mask).join(",") + "]}");
                }
            }
            walk(it, stack);
        } else if (t === "PathItem") {
            if (it.clipping || it.guides) return;
            addRecord(subpathsOf(it), isFilled(it), isStroked(it), clipStack);
        } else if (t === "CompoundPathItem") {
            if (it.pathItems.length === 0) return;
            if (it.pathItems[0].clipping) return;
            var f = false, s = false;
            for (var k = 0; k < it.pathItems.length; k++) {
                if (isFilled(it.pathItems[k])) f = true;
                if (isStroked(it.pathItems[k])) s = true;
            }
            addRecord(subpathsOf(it), f, s, clipStack);
        } else if (t === "TextFrame") {
            warnings.push("A text object could not be outlined and was skipped.");
        } else {
            warnings.push("Skipped unsupported object: " + t + (it.name ? " (" + it.name + ")" : "") +
                          " — expand it first (Object > Expand).");
        }
    }

    function removeLayerNamed(name) {
        for (var k = doc.layers.length - 1; k >= 0; k--) {
            if (doc.layers[k].name === name) {
                try { doc.layers[k].locked = false; doc.layers[k].remove(); } catch (e) {}
            }
        }
    }

    function cleanup() {
        try { if (tmp) tmp.remove(); } catch (e1) {}
        tmp = null;
        try { if (prevCS !== null) app.coordinateSystem = prevCS; } catch (e2) {}
        try {
            doc.selection = null;
            for (var k = 0; k < sel.length; k++) sel[k].selected = true;   // give the user their selection back
        } catch (e3) {}
    }

    // ---- main -----------------------------------------------------------
    for (i = 0; i < selection.length; i++) sel.push(selection[i]);

    // same coordinate system in export and import, whatever the document/artboard setup
    try { prevCS = app.coordinateSystem; app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM; } catch (e0) {}
    removeLayerNamed(TMP_LAYER);   // leftover from an interrupted run

    try {
        tmp = doc.layers.add();
        tmp.name = TMP_LAYER;

        // Duplicate the selection onto the temp layer. doc.selection lists items
        // front-to-back and PLACEATEND appends at the back, so stacking order survives.
        doc.selection = null;
        for (i = 0; i < sel.length; i++) dups.push(sel[i].duplicate(tmp, ElementPlacement.PLACEATEND));
        for (i = 0; i < dups.length; i++) dups[i].selected = true;

        try { app.executeMenuCommand("expandStyle"); } catch (e1) {}   // Object > Expand Appearance
        try { app.executeMenuCommand("expandStyle"); } catch (e2) {}   // once more, for stacked effects
        try { app.executeMenuCommand("outline"); } catch (e3) {}       // Type > Create Outlines
        doc.selection = null;

        walk(tmp, []);

        var json = '{"units":"pt","source":"' + jsonStr(doc.name) + '","time":"' + stamp() + '",' +
                   '"clips":[' + clips.join(",") + '],' +
                   '"items":[' + records.join(",") + "]}";

        outFile.encoding = "UTF-8";
        if (!outFile.open("w")) {
            throw new Error("Could not write " + outFile.fsName + (outFile.error ? "  (" + outFile.error + ")" : ""));
        }
        outFile.write(json);
        outFile.close();
    } catch (err) {
        cleanup();
        alert("Export failed: " + err.message + (err.line ? "  (line " + err.line + ")" : ""));
        return;
    }
    cleanup();

    var nF = 0, nS = 0, r;
    for (r = 0; r < records.length; r++) {
        if (records[r].indexOf('"fill":true') >= 0) nF++;
        if (records[r].indexOf('"stroke":true') >= 0) nS++;
    }
    var msg;
    if (records.length === 0) {
        msg = "WARNING: nothing exportable was found in the selection, so distill.json on the Desktop is now empty.\n\n" +
              "Only paths with a fill or a stroke count. Blends, Live Paint, symbols and images must be expanded first (Object > Expand).";
    } else {
        msg = "Exported " + records.length + " path objects (" + nF + " with fill, " + nS + " with stroke) and " +
              clips.length + " clipping mask(s) to:\n" + outFile.fsName + "\n\nNext: double-click 2_RunDistill.bat";
    }
    if (warnings.length) {
        msg += "\n\nWarnings (" + warnings.length + "):\n";
        for (var w = 0; w < Math.min(warnings.length, 8); w++) msg += "- " + warnings[w] + "\n";
        if (warnings.length > 8) msg += "...";
    }
    alert(msg);
})();
