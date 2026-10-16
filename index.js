/*
 * Stable Audio for Premiere Pro (UXP) - prototype
 *
 * Flow: read duration from the sequence -> call the Stability API -> write the
 * audio to the plugin data folder -> import into a "Stable Audio" bin -> place
 * on a new audio track at the in point or playhead as one undoable step.
 *
 * Everything that talks to Premiere lives in the "Premiere" section so API
 * fixes land in one place. Written against the UXP for Premiere Pro reference
 * (25.6+) without a Premiere install to test on; see README for known risks.
 */

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const CONFIG = {
  apiBase: "https://api.stability.ai",
  // Two endpoint families. Stable Audio 3.0 is async (202 + poll); 2.x returns audio inline.
  // Docs: https://docs.stability.ai/api-reference/stable-audio/text-to-audio.md
  families: {
    "stable-audio-3": {
      base: "/v2beta/audio/stable-audio",
      maxDuration: 380,
      async: true,
      creditsPerTake: 8,
      inpaint: true,
      strengthDefault: 0.7,
    },
    "stable-audio-2.5": {
      base: "/v2beta/audio/stable-audio-2",
      maxDuration: 190,
      async: false,
      creditsPerTake: 9,
      inpaint: true,
      strengthDefault: 0.8,
    },
    "stable-audio-2": {
      base: "/v2beta/audio/stable-audio-2",
      maxDuration: 190,
      async: false,
      creditsPerTake: 20,
      inpaint: true,
      strengthDefault: 0.8,
    },
  },
  resultsPath: "/v2beta/audio/results/",
  balancePath: "/v1/user/balance",
  pollIntervalMs: 3000,
  pollTimeoutMs: 5 * 60 * 1000,
  binName: "Stable Audio",
  // Premiere ticks per second (used only if TickTime.seconds is unavailable).
  ticksPerSecond: 254016000000,
};

function family() {
  return CONFIG.families[el.model.value] || CONFIG.families["stable-audio-3"];
}

/* ------------------------------------------------------------------ */
/* UXP modules                                                         */
/* ------------------------------------------------------------------ */

const uxp = require("uxp");
const ppro = require("premierepro");
const { localFileSystem: fs, formats, types } = uxp.storage;
const secureStorage = uxp.storage.secureStorage;

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = {
  apiKey: $("apiKey"),
  model: $("model"),
  outputFormat: $("outputFormat"),
  saveSettings: $("saveSettings"),
  settings: $("settings"),
  toggleSettings: $("toggleSettings"),
  strengthBlock: $("strengthBlock"),
  mode: $("mode"),
  prompt: $("prompt"),
  a2aBlock: $("a2aBlock"),
  pickAudio: $("pickAudio"),
  audioName: $("audioName"),
  strength: $("strength"),
  strengthValue: $("strengthValue"),
  duration: $("duration"),
  durationHint: $("durationHint"),
  maskBlock: $("maskBlock"),
  maskStart: $("maskStart"),
  maskEnd: $("maskEnd"),
  cost: $("cost"),
  useSelection: $("useSelection"),
  useClip: $("useClip"),
  takes: $("takes"),
  loop: $("loop"),
  generate: $("generate"),
  placeTarget: $("placeTarget"),
  autoPlace: $("autoPlace"),
  status: $("status"),
  takesList: $("takesList"),
  credits: $("credits"),
};

const state = {
  referenceAudio: null, // { name, arrayBuffer }
  takes: [], // { id, name, prompt, duration, nativePath, projectItem }
  busy: false,
};

function setStatus(message, kind) {
  el.status.textContent = message;
  el.status.className = "status" + (kind ? " " + kind : "");
  console.log("[StableAudio] " + message);
}

function setBusy(busy) {
  state.busy = busy;
  el.generate.disabled = busy;
  el.generate.textContent = busy ? "Generating..." : "Generate";
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = "stableAudioSettings";

function bytesToString(bytes) {
  if (!bytes) return "";
  if (typeof bytes === "string") return bytes;
  let out = "";
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (let i = 0; i < arr.length; i++) out += String.fromCharCode(arr[i]);
  return out;
}

async function loadSettings() {
  try {
    const raw = bytesToString(await secureStorage.getItem(SETTINGS_KEY));
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.apiKey) el.apiKey.value = s.apiKey;
    if (s.model) el.model.value = s.model;
    if (s.outputFormat) el.outputFormat.value = s.outputFormat;
  } catch (e) {
    console.warn("Could not load settings", e);
  }
}

async function saveSettings() {
  const s = {
    apiKey: el.apiKey.value.trim(),
    model: el.model.value,
    outputFormat: el.outputFormat.value,
  };
  try {
    await secureStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    setStatus("Settings saved.", "ok");
    refreshCredits();
  } catch (e) {
    setStatus("Could not save settings: " + e.message, "error");
  }
}

function apiKey() {
  const key = el.apiKey.value.trim();
  if (!key) throw new Error("Add your Stability API key under Settings.");
  return key;
}

/* ------------------------------------------------------------------ */
/* Stability API                                                       */
/* ------------------------------------------------------------------ */

async function refreshCredits() {
  try {
    const res = await fetch(CONFIG.apiBase + CONFIG.balancePath, {
      headers: { Authorization: "Bearer " + apiKey() },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.credits === "number") {
      el.credits.textContent = data.credits.toFixed(1) + " credits";
    }
  } catch (e) {
    /* no key yet, ignore */
  }
}

function buildForm(opts) {
  const form = new FormData();
  form.append("prompt", opts.prompt);
  form.append("duration", String(opts.duration));
  form.append("output_format", opts.outputFormat);
  form.append("model", opts.model);
  if (opts.seed) form.append("seed", String(opts.seed));
  if (opts.mode === "audio-to-audio" || opts.mode === "inpaint") {
    const name = opts.referenceAudio.name || "reference.wav";
    const type = /\.mp3$/i.test(name) ? "audio/mpeg" : "audio/wav";
    form.append("audio", new Blob([opts.referenceAudio.arrayBuffer], { type }), name);
  }
  if (opts.mode === "audio-to-audio") form.append("strength", String(opts.strength));
  if (opts.mode === "inpaint") {
    form.append("mask_start", String(opts.maskStart));
    form.append("mask_end", String(opts.maskEnd));
  }
  return form;
}

async function apiError(res) {
  let detail = "";
  try {
    const j = await res.json();
    detail = j.errors ? j.errors.join("; ") : j.message || JSON.stringify(j);
  } catch (e) {
    detail = await res.text().catch(() => "");
  }
  return new Error("API " + res.status + ": " + detail);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls GET /v2beta/audio/results/{id} until the audio is ready. */
async function pollResult(id, onTick) {
  const started = Date.now();
  while (Date.now() - started < CONFIG.pollTimeoutMs) {
    await sleep(CONFIG.pollIntervalMs);
    const res = await fetch(CONFIG.apiBase + CONFIG.resultsPath + id, {
      headers: { Authorization: "Bearer " + apiKey(), Accept: "audio/*" },
    });
    if (res.status === 202) {
      if (onTick) onTick(Math.round((Date.now() - started) / 1000));
      continue;
    }
    if (!res.ok) throw await apiError(res);
    return res.arrayBuffer();
  }
  throw new Error("Timed out waiting for generation " + id.slice(0, 8));
}

/** Calls the API once and returns the audio as an ArrayBuffer. */
async function generateOne(opts, onTick) {
  const fam = CONFIG.families[opts.model];
  const path = fam.base + "/" + opts.mode; // text-to-audio | audio-to-audio | inpaint
  const res = await fetch(CONFIG.apiBase + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey(),
      Accept: "audio/*",
      "stability-client-id": "stable-audio-premiere",
      "stability-client-version": "0.1.0",
    },
    body: buildForm(opts),
  });
  if (res.status === 202) {
    // Async family: body is JSON { id }. Poll for the audio.
    const { id } = await res.json();
    return pollResult(id, onTick);
  }
  if (!res.ok) throw await apiError(res);
  // Sync family (2.x) or an async endpoint that answered inline.
  const type = res.headers.get("content-type") || "";
  if (type.indexOf("application/json") === 0) {
    const j = await res.json();
    if (j.id && !j.audio) return pollResult(j.id, onTick);
    const bin = atob(j.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  return res.arrayBuffer();
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

async function takesFolder() {
  try {
    return await fs.getEntryWithUrl("plugin-data:/takes");
  } catch (e) {
    return fs.createEntryWithUrl("plugin-data:/takes", { type: types.folder });
  }
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function writeTake(arrayBuffer, prompt, index, ext) {
  const folder = await takesFolder();
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const name = "SA_" + stamp + "_" + (slug(prompt) || "cue") + "_t" + (index + 1) + "." + ext;
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(arrayBuffer, { format: formats.binary });
  return { name, nativePath: file.nativePath };
}

async function pickReferenceAudio() {
  const file = await fs.getFileForOpening({ types: ["wav", "mp3", "aif", "aiff", "flac", "m4a"] });
  if (!file) return;
  const arrayBuffer = await file.read({ format: formats.binary });
  state.referenceAudio = { name: file.name, arrayBuffer };
  el.audioName.textContent = file.name;
}

/* ------------------------------------------------------------------ */
/* Premiere                                                            */
/* ------------------------------------------------------------------ */

function tickSeconds(tickTime) {
  if (!tickTime) return NaN;
  if (typeof tickTime.seconds === "number") return tickTime.seconds;
  if (typeof tickTime.ticksNumber === "number") return tickTime.ticksNumber / CONFIG.ticksPerSecond;
  if (typeof tickTime.ticks === "string") return Number(tickTime.ticks) / CONFIG.ticksPerSecond;
  return NaN;
}

async function activeProjectAndSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Open a project first.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("Open a sequence first.");
  return { project, sequence };
}

/** Duration between sequence in and out points, or null if not set. */
async function selectionDuration() {
  const { sequence } = await activeProjectAndSequence();
  const inS = tickSeconds(await sequence.getInPoint());
  const outS = tickSeconds(await sequence.getOutPoint());
  if (!isFinite(inS) || !isFinite(outS)) return null;
  const d = outS - inS;
  // Premiere reports a huge or zero out point when none is set.
  if (d <= 0 || d > 60 * 60 * 24) return null;
  return d;
}

/** Duration of the first selected clip on the timeline, or null. */
async function selectedClipDuration() {
  const { sequence } = await activeProjectAndSequence();
  const selection = await sequence.getSelection();
  const items = await selection.getTrackItems();
  if (!items || !items.length) return null;
  const item = items[0];
  const d = tickSeconds(await item.getDuration());
  return isFinite(d) && d > 0 ? d : null;
}

/** Where to place the cue, in seconds. */
async function placementSeconds(target) {
  const { sequence } = await activeProjectAndSequence();
  if (target === "in") {
    const inS = tickSeconds(await sequence.getInPoint());
    if (isFinite(inS) && inS >= 0 && inS < 60 * 60 * 24) return inS;
  }
  const pos = tickSeconds(await sequence.getPlayerPosition());
  return isFinite(pos) ? pos : 0;
}

/** Items from getItems() are plain ProjectItems; folder methods need a FolderItem. */
function asFolder(item) {
  if (!item) return null;
  if (typeof item.getItems === "function") return item;
  try {
    return ppro.FolderItem.cast(item);
  } catch (e) {
    console.warn("FolderItem.cast failed for " + item.name, e);
    return null;
  }
}

/** Likewise, timeline actions want a ClipProjectItem. */
function asClip(item) {
  if (!item) return null;
  try {
    return ppro.ClipProjectItem.cast(item) || item;
  } catch (e) {
    return item;
  }
}

/** Returns the "Stable Audio" bin, creating it if needed. Falls back to root. */
async function stableAudioBin(project) {
  const root = await project.getRootItem();
  const find = async () => {
    const items = await root.getItems();
    const hit = items.find((i) => i.name === CONFIG.binName);
    return hit ? asFolder(hit) : null;
  };
  let bin = await find();
  if (bin) return bin;
  try {
    project.lockedAccess(() => {
      project.executeTransaction((compound) => {
        compound.addAction(root.createBinAction(CONFIG.binName, true));
      }, "Stable Audio: create bin");
    });
    bin = await find();
  } catch (e) {
    console.warn("Could not create bin, importing to root", e);
  }
  return bin || root;
}

/** Imports a file and returns its ProjectItem. */
async function importTake(project, nativePath, fileName) {
  const bin = await stableAudioBin(project);
  const ok = await project.importFiles([nativePath], true, bin, false);
  if (!ok) throw new Error("Premiere refused the import of " + fileName);
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const items = await bin.getItems();
  const item = items.find((i) => i.name === fileName || i.name === baseName);
  if (!item) throw new Error("Imported but could not find " + fileName + " in the bin.");
  return asClip(item);
}

/** Overwrites the clip onto a new audio track at `seconds`, as one undo step. */
async function placeTake(take, target) {
  const { project, sequence } = await activeProjectAndSequence();
  const seconds = await placementSeconds(target);
  const time = ppro.TickTime.createWithSeconds(seconds);
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const audioTracks = await sequence.getAudioTrackCount();

  // Track index equal to the current count asks Premiere for a new track
  // (the reference says an index past the existing tracks creates one).
  const tryPlace = (audioTrackIndex) => {
    project.lockedAccess(() => {
      project.executeTransaction((compound) => {
        compound.addAction(
          editor.createOverwriteItemAction(take.projectItem, time, 0, audioTrackIndex)
        );
      }, "Stable Audio: place " + take.name);
    });
  };

  try {
    tryPlace(audioTracks);
  } catch (e) {
    console.warn("New-track placement failed, using last existing track", e);
    tryPlace(Math.max(0, audioTracks - 1));
  }
  return seconds;
}

/* ------------------------------------------------------------------ */
/* Takes list                                                          */
/* ------------------------------------------------------------------ */

function renderTakes() {
  el.takesList.innerHTML = "";
  if (!state.takes.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No takes yet.";
    el.takesList.appendChild(empty);
    return;
  }
  state.takes
    .slice()
    .reverse()
    .forEach((take) => {
      const card = document.createElement("div");
      card.className = "take";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = take.name;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = take.duration + " s  ·  " + take.prompt;

      const row = document.createElement("div");
      row.className = "inline";

      const placeIn = document.createElement("button");
      placeIn.className = "small";
      placeIn.textContent = "Place at in point";
      placeIn.onclick = () => onPlace(take, "in");

      const placeHead = document.createElement("button");
      placeHead.className = "small";
      placeHead.textContent = "Place at playhead";
      placeHead.onclick = () => onPlace(take, "playhead");

      const reveal = document.createElement("button");
      reveal.className = "small";
      reveal.textContent = "Copy path";
      reveal.onclick = () => {
        try {
          navigator.clipboard.writeText(take.nativePath);
          setStatus("Path copied.", "ok");
        } catch (e) {
          setStatus(take.nativePath);
        }
      };

      row.appendChild(placeIn);
      row.appendChild(placeHead);
      row.appendChild(reveal);
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(row);
      el.takesList.appendChild(card);
    });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function onUseSelection() {
  try {
    const d = await selectionDuration();
    if (d === null) {
      setStatus("No in/out points set on the active sequence.", "error");
      return;
    }
    applyDuration(d, "in/out range");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function onUseClip() {
  try {
    const d = await selectedClipDuration();
    if (d === null) {
      setStatus("Select a clip on the timeline first.", "error");
      return;
    }
    applyDuration(d, "selected clip");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function applyDuration(seconds, source) {
  const max = family().maxDuration;
  const rounded = Math.ceil(seconds * 10) / 10;
  if (rounded > max) {
    el.duration.value = max;
    setStatus("The " + source + " is " + rounded.toFixed(1) + " s. Capped at " + max + " s for this model.", "error");
  } else {
    el.duration.value = Math.max(1, Math.round(rounded));
    setStatus("Duration set from the " + source + ": " + rounded.toFixed(1) + " s.", "ok");
  }
  updateCost();
}

function updateCost() {
  const fam = family();
  const count = Number(el.takes.value) || 1;
  el.cost.textContent = count * fam.creditsPerTake + " credits";
  el.duration.max = fam.maxDuration;
  el.durationHint.textContent = "Max " + fam.maxDuration + " s per request on " + el.model.value + ".";
}

async function onGenerate() {
  if (state.busy) return;
  const prompt = el.prompt.value.trim();
  if (!prompt) return setStatus("Type a prompt.", "error");
  const mode = el.mode.value;
  const fam = family();
  if ((mode === "audio-to-audio" || mode === "inpaint") && !state.referenceAudio) {
    return setStatus("Choose a reference audio file (mp3 or wav, 6 to " + fam.maxDuration + " s).", "error");
  }
  let duration = Number(el.duration.value);
  if (!isFinite(duration) || duration < 1) duration = 30;
  duration = Math.min(Math.round(duration), fam.maxDuration);

  let maskStart = 0;
  let maskEnd = 0;
  if (mode === "inpaint") {
    maskStart = Number(el.maskStart.value);
    maskEnd = Number(el.maskEnd.value);
    if (!isFinite(maskStart) || !isFinite(maskEnd) || maskEnd <= maskStart) {
      return setStatus("Set a mask range: end must be after start.", "error");
    }
  }

  const count = Number(el.takes.value) || 1;
  const loop = el.loop.checked;
  const outputFormat = el.outputFormat.value;
  const fullPrompt = loop ? prompt + ", seamless loop, loopable, consistent start and end" : prompt;

  setBusy(true);
  try {
    apiKey();
    const label = "Generating " + count + " take" + (count > 1 ? "s" : "") + " of " + duration + " s";
    setStatus(label + "...");

    const requests = [];
    for (let i = 0; i < count; i++) {
      requests.push(
        generateOne(
          {
            mode,
            prompt: fullPrompt,
            duration,
            outputFormat,
            model: el.model.value,
            strength: Number(el.strength.value),
            maskStart,
            maskEnd,
            referenceAudio: state.referenceAudio,
            // Different seeds per take so the four are not identical.
            seed: Math.floor(Math.random() * 4294967293) + 1,
          },
          (secs) => setStatus(label + "... " + secs + " s")
        ).then((buf) => ({ buf, index: i }))
      );
    }
    const results = await Promise.allSettled(requests);
    const failures = results.filter((r) => r.status === "rejected");
    const successes = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!successes.length) {
      throw new Error(failures[0] ? failures[0].reason.message : "No audio returned.");
    }

    setStatus("Importing " + successes.length + " take" + (successes.length > 1 ? "s" : "") + "...");
    const { project } = await activeProjectAndSequence();
    const newTakes = [];
    for (const { buf, index } of successes) {
      const file = await writeTake(buf, prompt, index, outputFormat);
      const projectItem = await importTake(project, file.nativePath, file.name);
      const take = {
        id: file.name,
        name: file.name,
        prompt,
        duration,
        nativePath: file.nativePath,
        projectItem,
      };
      state.takes.push(take);
      newTakes.push(take);
    }
    renderTakes();

    let msg = successes.length + " take" + (successes.length > 1 ? "s" : "") + " in the \"" + CONFIG.binName + "\" bin.";
    if (failures.length) msg += " " + failures.length + " failed: " + failures[0].reason.message;

    if (el.autoPlace.checked && newTakes[0]) {
      const at = await placeTake(newTakes[0], el.placeTarget.value);
      msg += " First take placed at " + at.toFixed(2) + " s.";
    }
    setStatus(msg, failures.length ? "error" : "ok");
    refreshCredits();
  } catch (e) {
    setStatus(e.message || String(e), "error");
  } finally {
    setBusy(false);
  }
}

async function onPlace(take, target) {
  try {
    const at = await placeTake(take, target);
    setStatus(take.name + " placed at " + at.toFixed(2) + " s on a new audio track.", "ok");
  } catch (e) {
    setStatus("Could not place: " + (e.message || e), "error");
  }
}

function onModeChange() {
  const mode = el.mode.value;
  const needsAudio = mode === "audio-to-audio" || mode === "inpaint";
  el.a2aBlock.className = needsAudio ? "" : "hidden";
  el.strengthBlock.className = mode === "audio-to-audio" ? "row" : "row hidden";
  el.maskBlock.className = mode === "inpaint" ? "row" : "row hidden";
}

function onModelChange() {
  const fam = family();
  if (!CONFIG.families[el.model.value] || !fam.inpaint) {
    if (el.mode.value === "inpaint") {
      el.mode.value = "text-to-audio";
      onModeChange();
    }
  }
  el.strength.value = fam.strengthDefault;
  el.strengthValue.textContent = Number(fam.strengthDefault).toFixed(2);
  updateCost();
}

function toggleSettings() {
  const open = el.settings.className.indexOf("hidden") >= 0;
  el.settings.className = open ? "box" : "box hidden";
}

/* ------------------------------------------------------------------ */
/* Wire up                                                             */
/* ------------------------------------------------------------------ */

el.saveSettings.addEventListener("click", () => {
  saveSettings();
  onModelChange();
});
el.toggleSettings.addEventListener("click", toggleSettings);
el.model.addEventListener("change", onModelChange);
el.takes.addEventListener("change", updateCost);
el.mode.addEventListener("change", onModeChange);
el.pickAudio.addEventListener("click", () => pickReferenceAudio().catch((e) => setStatus(e.message, "error")));
el.strength.addEventListener("input", () => (el.strengthValue.textContent = Number(el.strength.value).toFixed(2)));
el.useSelection.addEventListener("click", onUseSelection);
el.useClip.addEventListener("click", onUseClip);
el.generate.addEventListener("click", onGenerate);

loadSettings().then(() => {
  // Open Settings on first run so the key field is visible.
  if (!el.apiKey.value) el.settings.className = "box";
  onModeChange();
  updateCost();
  renderTakes();
  refreshCredits();
});
