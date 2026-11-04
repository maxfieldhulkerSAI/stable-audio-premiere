/*
 * Self-test harness for the Stable Audio panel. Loaded after index.js and shares
 * its globals (state, el, ppro, fs, and the pipeline functions).
 *
 * Inert unless the plugin folder contains .selftest/DEV (created by
 * `python tools/selftest.py --enable`) and Test mode is on in Settings. Then it
 * polls .selftest/request.json every 2 s and, for each new request id, runs the
 * named tests inside Premiere and writes .selftest/results.json.
 *
 * Request:  { "id": "...", "tests": ["env", "import", "place", "capture", "cleanup"],
 *             "options": { "seconds": 5, "inS": 1, "captureSeconds": 2, "stopOnFail": true } }
 * Results:  { "id", "status": "running" | "done", "startedAt", "finishedAt", "env",
 *             "tests": [{ "name", "ok", "ms", "details", "error" }], "log": [...] }
 */
(function () {
  "use strict";

  const POLL_MS = 2000;
  const BS = String.fromCharCode(92);
  const harness = { dir: null, enabled: false, timer: null, running: false, lastId: null, log: [] };

  /* ---- console capture during a run ------------------------------- */

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  function capture(level, args) {
    if (!harness.running) return;
    try {
      const text = args.map((a) => (typeof a === "string" ? a : (a && a.message) || JSON.stringify(a))).join(" ");
      harness.log.push(level + " " + text);
    } catch (e) { /* never let logging break a run */ }
  }
  console.log = (...a) => { capture("log", a); origLog(...a); };
  console.warn = (...a) => { capture("warn", a); origWarn(...a); };
  console.error = (...a) => { capture("error", a); origError(...a); };

  /* ---- files ------------------------------------------------------- */

  function fileUrl(nativePath) {
    let p = nativePath.split(BS).join("/");
    if (p.charAt(0) !== "/") p = "/" + p; // Windows drive letter
    return "file://" + p;
  }

  async function findDir() {
    const plugin = await fs.getPluginFolder();
    const sep = plugin.nativePath.indexOf(BS) >= 0 ? BS : "/";
    const dir = await fs.getEntryWithUrl(fileUrl(plugin.nativePath + sep + ".selftest")); // throws when missing
    if (!dir.isFolder) throw new Error(".selftest is not a folder");
    await dir.getEntry("DEV"); // throws when the marker is missing
    return dir;
  }

  async function readText(name) {
    try {
      const entry = await harness.dir.getEntry(name);
      return await entry.read();
    } catch (e) {
      return null;
    }
  }

  async function writeText(name, text) {
    const file = await harness.dir.createFile(name, { overwrite: true });
    await file.write(text);
  }

  /* ---- synthetic audio --------------------------------------------- */

  /** 16-bit stereo WAV: a tone with a 2 Hz tremolo and 50 ms fades. Pitch follows the seed. */
  function makeWav(seconds, seed) {
    const rate = 44100;
    const channels = 2;
    const frames = Math.max(1, Math.round((Number(seconds) || 5) * rate));
    const buf = new ArrayBuffer(44 + frames * channels * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + frames * channels * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, frames * channels * 2, true);
    const freq = 220 * Math.pow(2, ((Number(seed) || 0) % 12) / 12);
    const fade = Math.min(0.05 * rate, frames / 4);
    let o = 44;
    for (let i = 0; i < frames; i++) {
      const env = Math.min(1, i / fade, (frames - i) / fade);
      const pulse = 0.6 + 0.4 * Math.sin((2 * Math.PI * 2 * i) / rate);
      const sample = Math.round(0.5 * 32767 * env * pulse * Math.sin((2 * Math.PI * freq * i) / rate));
      v.setInt16(o, sample, true);
      v.setInt16(o + 2, sample, true);
      o += 4;
    }
    return buf;
  }

  /** Drop-in for generateOne when Synthetic audio is on. */
  async function synth(opts, onTick) {
    await sleep(300);
    if (onTick) onTick(0);
    console.log("[StableAudio] synthetic take: " + opts.mode + ", " + opts.duration + " s, seed " + opts.seed);
    return makeWav(opts.duration, opts.seed);
  }

  /* ---- tests ------------------------------------------------------- */

  async function envInfo() {
    const info = {
      pluginVersion: (uxp.versions && uxp.versions.plugin) || null,
      synthetic: state.synthetic,
      presetPath: state.presetPath || null,
      takesInPanel: state.takes.length,
    };
    try {
      const { project, sequence } = await activeProjectAndSequence();
      info.project = project.name;
      info.sequence = sequence.name;
      info.videoTracks = await sequence.getVideoTrackCount();
      info.audioTracks = await sequence.getAudioTrackCount();
      info.inS = tickSeconds(await sequence.getInPoint());
      info.outS = tickSeconds(await sequence.getOutPoint());
      info.playheadS = tickSeconds(await sequence.getPlayerPosition());
      info.audioClips = await countAudioClips(sequence);
      try {
        const sel = await sequence.getSelection();
        info.selectedTrackItems = (await sel.getTrackItems()).length;
        info.hasSetSelection = typeof sequence.setSelection === "function";
        info.hasSelectionAddItem = !!(sel && typeof sel.addItem === "function");
      } catch (e) {
        info.selectionError = String((e && e.message) || e);
      }
    } catch (e) {
      info.error = String((e && e.message) || e);
    }
    return info;
  }

  async function testImport(ctx, options) {
    const seconds = Number(options.seconds) || 5;
    const buf = makeWav(seconds, 7);
    const file = await writeTake(buf, "selftest tone", 0, "wav");
    const { project } = await activeProjectAndSequence();
    const projectItem = await importTake(project, file.nativePath, file.name);
    const take = { id: file.name, name: file.name, prompt: "selftest tone", duration: seconds, nativePath: file.nativePath, projectItem };
    state.takes.push(take);
    renderTakes();
    ctx.take = take;
    return {
      file: file.nativePath,
      bytes: buf.byteLength,
      itemName: projectItem && projectItem.name,
      itemType: projectItem && projectItem.constructor ? projectItem.constructor.name : typeof projectItem,
    };
  }

  function fail(message, details) {
    const e = new Error(message);
    e.details = details;
    return e;
  }

  async function testPlace(ctx, options) {
    const take = ctx.take || state.takes[state.takes.length - 1];
    if (!take) throw new Error("No take to place; run import first.");
    const { project, sequence } = await activeProjectAndSequence();
    const inS = isFinite(Number(options.inS)) ? Number(options.inS) : 1;
    await setSequenceInOut(project, sequence, inS, inS + take.duration);
    const before = await countAudioClips(sequence);
    const r = { inPointS: inS, clipsBefore: before };
    r.placedAtS = await placeTake(take, "in");
    r.viaIn = state.lastPlacement;
    r.clipsAfterIn = await countAudioClips(sequence);
    r.playheadS = await placeTake(take, "playhead");
    r.viaPlayhead = state.lastPlacement;
    r.clipsAfterPlayhead = await countAudioClips(sequence);
    // "Reference range start" has no native TickTime, so this exercises createWithSeconds.
    const savedRef = state.referenceAudio;
    const refStart = inS + take.duration + 1;
    state.referenceAudio = { name: "selftest", arrayBuffer: null, clip: { startS: refStart, endS: refStart + 1 } };
    try {
      r.refStartS = await placeTake(take, "clip");
      r.viaRef = state.lastPlacement;
    } finally {
      state.referenceAudio = savedRef;
    }
    r.clipsAfterRef = await countAudioClips(sequence);
    ctx.placed = { startS: r.placedAtS, endS: r.placedAtS + take.duration };
    if (before >= 0 && !(r.clipsAfterIn > before)) throw fail("No clip appeared after placing at the in point", r);
    if (Math.abs(r.placedAtS - inS) > 0.02) throw fail("Placed at " + r.placedAtS + " s, expected the in point " + inS, r);
    if (r.clipsAfterRef >= 0 && !(r.clipsAfterRef > r.clipsAfterPlayhead)) throw fail("No clip appeared when placing at the reference range start", r);
    return r;
  }

  async function findTrackItem(sequence, take) {
    const base = take.name.replace(/\.[^.]+$/, "");
    const n = await sequence.getAudioTrackCount();
    for (let i = 0; i < n; i++) {
      const track = await sequence.getAudioTrack(i);
      let items;
      try { items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false); } catch (e) { items = await track.getTrackItems(); }
      for (const ti of items || []) {
        let name = null;
        try { name = await ti.getName(); } catch (e) { /* fall through */ }
        if (!name) {
          try { const pi = await ti.getProjectItem(); name = pi && pi.name; } catch (e) { /* ignore */ }
        }
        if (name === take.name || name === base) return { trackItem: ti, trackIndex: i };
      }
    }
    return null;
  }

  async function testCapture(ctx, options) {
    const take = ctx.take || state.takes[state.takes.length - 1];
    if (!take) throw new Error("No take; run import and place first.");
    const { sequence } = await activeProjectAndSequence();
    const hit = await findTrackItem(sequence, take);
    if (!hit) throw new Error("Could not find the placed take on any audio track; run place first.");
    const info = await selectedClipInfo(hit.trackItem);
    const r = {
      trackIndex: hit.trackIndex,
      clip: { name: info.name, mediaPath: info.mediaPath, startS: info.startS, endS: info.endS, sourceInS: info.sourceInS, durationS: info.durationS },
    };
    if (!isFinite(info.startS) || !isFinite(info.endS)) throw fail("Track item times unreadable", r);
    const len = Math.min(Number(options.captureSeconds) || 2, info.endS - info.startS - 0.5);
    const s = info.startS + 0.25;
    const ref = await captureRange(s, s + len, "selftest", info);
    const got = wavDurationSeconds(ref.arrayBuffer);
    r.capture = { requestedS: len, gotS: got, bytes: ref.arrayBuffer.byteLength, name: ref.name, path: state.presetPath ? "export preset" : "media slice" };
    if (Math.abs(got - len) > 0.05) throw fail("Captured " + got.toFixed(3) + " s, expected " + len.toFixed(3), r);

    // Probe the real selection path too, when the API lets a script select a clip.
    try {
      if (typeof sequence.setSelection !== "function") {
        r.selectionPath = { ok: false, reason: "Sequence.setSelection unavailable" };
      } else {
        const sel = await sequence.getSelection();
        if (!sel || typeof sel.addItem !== "function") {
          r.selectionPath = { ok: false, reason: "TrackItemSelection.addItem unavailable" };
        } else {
          await sel.addItem(hit.trackItem, false);
          await sequence.setSelection(sel);
          const info2 = await selectedClipInfo();
          r.selectionPath = { ok: true, name: info2.name };
        }
      }
    } catch (e) {
      r.selectionPath = { ok: false, reason: String((e && e.message) || e) };
    }
    return r;
  }

  /** Track items on audio tracks whose name marks them as harness output. */
  async function findHarnessItems(sequence) {
    const found = [];
    const n = await sequence.getAudioTrackCount();
    for (let i = 0; i < n; i++) {
      const track = await sequence.getAudioTrack(i);
      let items;
      try { items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false); } catch (e) { items = await track.getTrackItems(); }
      for (const ti of items || []) {
        let name = null;
        try { name = await ti.getName(); } catch (e) { /* fall through */ }
        if (!name) {
          try { const pi = await ti.getProjectItem(); name = pi && pi.name; } catch (e) { /* ignore */ }
        }
        if (name && name.indexOf("SA_") === 0 && name.indexOf("_selftest-tone_") > 0) found.push({ trackItem: ti, trackIndex: i, name });
      }
    }
    return found;
  }

  /**
   * Removes every clip the harness placed (names SA_*_selftest-tone_*), as one undo step.
   * Sequence has no track-removal API, so the audio tracks the place test created stay, empty.
   */
  async function testCleanup(ctx, options) {
    const { project, sequence } = await activeProjectAndSequence();
    const before = await countAudioClips(sequence);
    const hits = await findHarnessItems(sequence);
    const r = { clipsBefore: before, harnessClipsFound: hits.length, tracks: await sequence.getAudioTrackCount() };
    if (!hits.length) {
      r.clipsAfter = before;
      return r;
    }
    const editor = ppro.SequenceEditor.getEditor(sequence);
    let err = null;
    let built = false;
    // The selection is only valid inside the callback and must not cross an await.
    const created = ppro.TrackItemSelection.createEmptySelection((sel) => {
      try {
        let added = 0;
        for (const h of hits) if (sel.addItem(h.trackItem, false)) added++;
        r.addedToSelection = added;
        built = true;
        runAction(project, () => editor.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.AUDIO, false), "Stable Audio: self-test cleanup");
      } catch (e) {
        err = e;
      }
    });
    r.createEmptySelection = created;
    if (err) throw fail("Remove failed: " + String((err && err.message) || err), r);
    if (!built) throw fail("createEmptySelection never ran its callback", r);
    r.clipsAfter = await countAudioClips(sequence);
    r.removed = before >= 0 && r.clipsAfter >= 0 ? before - r.clipsAfter : null;
    if (r.removed !== null && r.removed < hits.length) throw fail("Removed " + r.removed + " of " + hits.length + " harness clips", r);
    const left = await findHarnessItems(sequence);
    r.harnessClipsLeft = left.length;
    if (left.length) throw fail(left.length + " harness clips still on the timeline", r);
    return r;
  }

  const TESTS = {
    env: async (ctx) => (ctx.env = await envInfo()),
    import: testImport,
    place: testPlace,
    capture: testCapture,
    cleanup: testCleanup,
  };

  /* ---- runner ------------------------------------------------------ */

  async function run(req) {
    harness.running = true;
    harness.log = [];
    const names = Array.isArray(req.tests) && req.tests.length ? req.tests : ["import", "place", "capture"];
    const options = req.options || {};
    const results = { id: req.id, status: "running", startedAt: new Date().toISOString(), tests: [] };
    await writeText("results.json", JSON.stringify(results, null, 2));
    results.env = await envInfo();
    const ctx = {};
    let passed = 0;
    for (const name of names) {
      const fn = TESTS[name];
      const t0 = Date.now();
      const entry = { name, ok: false, ms: 0 };
      if (!fn) {
        entry.error = "unknown test";
        results.tests.push(entry);
        continue;
      }
      setStatus("Self-test " + req.id + ": " + name + "...");
      try {
        entry.details = await fn(ctx, options);
        entry.ok = true;
        passed++;
      } catch (e) {
        entry.error = String((e && e.message) || e);
        if (e && e.details) entry.details = e.details;
        if (e && e.stack) entry.stack = String(e.stack).split("\n").slice(0, 4).join(" | ");
      }
      entry.ms = Date.now() - t0;
      results.tests.push(entry);
      if (!entry.ok && options.stopOnFail !== false) break;
    }
    results.status = "done";
    results.finishedAt = new Date().toISOString();
    results.passed = passed;
    results.total = names.length;
    results.log = harness.log.slice(-200);
    harness.running = false;
    await writeText("results.json", JSON.stringify(results, null, 2));
    setStatus("Self-test " + req.id + ": " + passed + "/" + names.length + " passed.", passed === names.length ? "ok" : "error");
  }

  async function pollOnce() {
    if (!harness.enabled || harness.running || !harness.dir) return;
    const text = await readText("request.json");
    if (!text) return;
    let req;
    try { req = JSON.parse(text); } catch (e) { return; }
    if (!req || !req.id || req.id === harness.lastId) return;
    harness.lastId = req.id;
    try {
      await run(req);
    } catch (e) {
      harness.running = false;
      console.error("[StableAudio] selftest run failed", e);
      try {
        await writeText("results.json", JSON.stringify({ id: req.id, status: "done", error: String((e && e.message) || e), tests: [] }, null, 2));
      } catch (e2) { /* nothing left to report to */ }
    }
  }

  function setEnabled(on) {
    harness.enabled = !!on && !!harness.dir;
    if (harness.enabled && !harness.timer) {
      harness.timer = setInterval(() => { pollOnce().catch((e) => console.warn("[StableAudio] selftest poll", e)); }, POLL_MS);
    }
    if (!harness.enabled && harness.timer) {
      clearInterval(harness.timer);
      harness.timer = null;
    }
  }

  /** Called by index.js once settings are loaded. Reveals the Developer toggles on dev checkouts. */
  async function onReady() {
    try {
      harness.dir = await findDir();
    } catch (e) {
      harness.dir = null;
      return;
    }
    // Do not rerun a request that already has results from before this reload.
    try {
      const req = JSON.parse((await readText("request.json")) || "null");
      const res = JSON.parse((await readText("results.json")) || "null");
      if (req && res && res.id === req.id && res.status === "done") harness.lastId = req.id;
    } catch (e) { /* no prior state */ }
    el.devBlock.className = "stack";
    applyDevToggles();
    console.log("[StableAudio] selftest ready at " + harness.dir.nativePath + (state.testMode ? ", test mode on" : ", test mode off"));
  }

  window.SelfTest = { onReady, setEnabled, synth, makeWav };
})();
