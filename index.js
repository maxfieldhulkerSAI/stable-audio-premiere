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
  // Public pages opened in the system browser. Marketplace review requires working
  // privacy and terms links and a way to sign up; confirm these URLs before submitting.
  links: {
    getKey: "https://platform.stability.ai/account/keys",
    privacy: "https://stability.ai/privacy-policy",
    terms: "https://stability.ai/terms-of-use",
    credits: "https://platform.stability.ai/account/credits",
  },
  // Sign-in broker. UXP panels cannot receive a browser redirect, so the panel
  // asks this service for a session, opens its login page in the browser, and
  // polls until a key is attached (Adobe's oauth-workflow-sample pattern).
  // The stub is tools/stub-broker.js; the real one is a Stability-hosted https
  // service with the same three endpoints (see MARKETPLACE.md). Its origin must
  // be listed under requiredPermissions.network.domains in manifest.json.
  broker: "http://127.0.0.1:8787",
  signIn: {
    pollIntervalMs: 2000,
    timeoutMs: 3 * 60 * 1000,
    // The broker forgets sessions after this; the "Open sign-in page" link
    // reuses a session younger than this and starts a new one otherwise.
    sessionTtlMs: 10 * 60 * 1000,
  },
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
  closeSettings: $("closeSettings"),
  devBlock: $("devBlock"),
  testMode: $("testMode"),
  synthetic: $("synthetic"),
  accountState: $("accountState"),
  keyField: $("keyField"),
  signIn: $("signIn"),
  cancelSignIn: $("cancelSignIn"),
  reopenSignIn: $("reopenSignIn"),
  getKey: $("getKey"),
  signOut: $("signOut"),
  privacyLink: $("privacyLink"),
  termsLink: $("termsLink"),
  versionLabel: $("versionLabel"),
  settings: $("settings"),
  toggleSettings: $("toggleSettings"),
  strengthBlock: $("strengthBlock"),
  mode: $("mode"),
  modeSeg: $("modeSeg"),
  prompt: $("prompt"),
  a2aBlock: $("a2aBlock"),
  pickAudio: $("pickAudio"),
  refFromClip: $("refFromClip"),
  extendToOut: $("extendToOut"),
  pickPreset: $("pickPreset"),
  presetName: $("presetName"),
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
  presetPath: "", // optional .epr for rendering the selected range through Premiere's exporter
  referenceAudio: null, // { name, arrayBuffer, clip? }  clip = { startS, endS } of the reference window on the timeline
  takes: [], // { id, name, prompt, duration, nativePath, projectItem }
  busy: false,
  credits: null, // last balance from the API, or null when unknown
  keySource: "key", // "account" when the key came from Sign in with Stability, "key" when pasted
  login: null, // in-progress sign-in: { id, loginUrl, createdAt, deadline, cancelled, timer, wake }
  lastLogin: null, // last broker session, so "Open sign-in page" can reopen it after a timeout
  testMode: false, // developer: selftest.js polls .selftest/request.json
  synthetic: false, // developer: generateOne returns a generated tone instead of calling the API
  lastPlacement: null, // label of the placement combination that last succeeded
};

function setStatus(message, kind) {
  el.status.textContent = message;
  el.status.className = "status" + (kind ? " " + kind : "");
  console.log("[StableAudio] " + message);
}

function setBusy(busy) {
  state.busy = busy;
  setDisabled(el.generate, busy);
  el.generate.textContent = busy ? "Generating..." : "Generate →";
}

/* Buttons are styled divs (see index.html), so disabled is a class, not a property. */
function setDisabled(node, disabled) {
  const base = node.className.replace(/(^|\s)disabled(?=\s|$)/g, "");
  node.className = disabled ? base + " disabled" : base;
}

function isDisabled(node) {
  return /(^|\s)disabled(\s|$)/.test(node.className);
}

function setSettingsOpen(open) {
  el.settings.className = open ? "card" : "card hidden";
  el.toggleSettings.textContent = open ? "Close" : "Settings";
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
    state.keySource = s.apiKey && s.keySource === "account" ? "account" : "key";
    if (s.model) el.model.value = s.model;
    if (s.outputFormat) el.outputFormat.value = s.outputFormat;
    if (s.presetPath) setPreset(s.presetPath);
    el.testMode.checked = !!s.testMode;
    el.synthetic.checked = !!s.synthetic;
    applyDevToggles();
  } catch (e) {
    console.warn("Could not load settings", e);
  }
}

/** Developer toggles only take effect when selftest.js found the .selftest/DEV marker. */
function applyDevToggles() {
  const dev = el.devBlock.className.indexOf("hidden") < 0;
  state.testMode = dev && el.testMode.checked;
  state.synthetic = dev && el.synthetic.checked;
  if (window.SelfTest) window.SelfTest.setEnabled(state.testMode);
}

async function saveSettings() {
  const s = {
    apiKey: el.apiKey.value.trim(),
    keySource: state.keySource,
    model: el.model.value,
    outputFormat: el.outputFormat.value,
    presetPath: state.presetPath,
    testMode: el.testMode.checked,
    synthetic: el.synthetic.checked,
  };
  try {
    await secureStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    setStatus("Settings saved.", "ok");
    updateAccountState();
    refreshCredits();
  } catch (e) {
    setStatus("Could not save settings: " + e.message, "error");
  }
}

/** Clears the key from the field and from secure storage; other settings stay. */
async function signOut() {
  if (isDisabled(el.signOut)) return;
  const viaAccount = state.keySource === "account";
  el.apiKey.value = "";
  el.credits.textContent = "";
  state.keySource = "key";
  try {
    await saveSettings();
    setStatus(
      viaAccount
        ? "Signed out of your Stability account. Nothing from it stays on this machine."
        : "Signed out. The API key was removed from this machine.",
      "ok"
    );
  } catch (e) {
    setStatus("Could not remove the key: " + e.message, "error");
  }
}

function updateAccountState() {
  const key = el.apiKey.value.trim();
  const viaAccount = !!key && state.keySource === "account";
  el.accountState.textContent = !key
    ? "Signed out"
    : viaAccount
      ? "Signed in via Stability account"
      : "Signed in (key ending " + key.slice(-4) + ")";
  setDisabled(el.signOut, !key);
  // A key issued by the account flow is never shown; the paste field is the fallback.
  el.keyField.className = viaAccount ? "field hidden" : "field";
}

/* ------------------------------------------------------------------ */
/* Sign in with Stability                                              */
/* ------------------------------------------------------------------ */

function brokerFetch(path, init) {
  return fetch(CONFIG.broker + path, init);
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

/** Sleeps, but wakes early when cancelSignIn() is called. */
function loginSleep(login, ms) {
  return new Promise((resolve) => {
    login.wake = resolve;
    login.timer = setTimeout(resolve, ms);
  });
}

function showSignInButtons(mode) {
  // mode: "idle" | "waiting" | "retry"
  setDisabled(el.signIn, mode === "waiting");
  el.signIn.textContent = mode === "waiting" ? "Waiting for the browser..." : "Sign in with Stability";
  el.cancelSignIn.className = mode === "waiting" ? "btn ghost" : "btn ghost hidden";
  el.reopenSignIn.className = mode === "retry" ? "btn ghost" : "btn ghost hidden";
}

function cancelSignIn() {
  const login = state.login;
  if (!login) return;
  login.cancelled = true;
  clearTimeout(login.timer);
  if (login.wake) login.wake();
}

/** POST /session on the broker. Throws with a readable message when it is unreachable. */
async function createLoginSession() {
  let res;
  try {
    res = await brokerFetch("/session", { method: "POST", headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error("Could not reach the Stability sign-in service. Check your connection, or paste an API key instead.");
  }
  if (!res.ok) throw new Error("The sign-in service answered HTTP " + res.status + ". Try again later, or paste an API key.");
  const data = await res.json();
  if (!data || !data.id || !data.loginUrl) throw new Error("The sign-in service sent an unexpected reply. Paste an API key instead.");
  return { id: String(data.id), loginUrl: String(data.loginUrl), createdAt: Date.now() };
}

/** Stores a key delivered by the broker through the normal settings path. */
async function acceptAccountKey(apiKeyValue) {
  el.apiKey.value = apiKeyValue;
  state.keySource = "account";
  await saveSettings(); // persists, updates the Account line, refreshes credits
  onModelChange();
  setSettingsOpen(false);
  setStatus("Signed in with your Stability account.", "ok");
}

/**
 * Sign in with Stability: create a broker session, open its login page in the
 * system browser, and poll until the key arrives, the user cancels, or three
 * minutes pass. The panel stays usable throughout; on timeout the
 * "Open sign-in page" link reopens the browser and polls again.
 */
async function signInWithStability(reuse) {
  if (state.login) return;
  const login = { cancelled: false, timer: null, wake: null };
  state.login = login;
  showSignInButtons("waiting");
  try {
    const last = state.lastLogin;
    const fresh = last && Date.now() - last.createdAt < CONFIG.signIn.sessionTtlMs - 15000;
    let session;
    if (reuse && fresh) {
      session = last;
    } else {
      setStatus("Contacting the Stability sign-in service...");
      session = await createLoginSession();
    }
    Object.assign(login, session);
    state.lastLogin = session;

    const opened = await openExternal(session.loginUrl);
    if (login.cancelled) throw new Error("cancelled");
    if (!opened) {
      // UXP refused to launch the browser (user declined the launchProcess consent,
      // or the scheme is missing from the manifest). Leave the link available.
      state.login = null;
      showSignInButtons("retry");
      setStatus("Could not open the browser for sign-in. Allow Premiere to open links, then click Open sign-in page, or paste an API key.", "error");
      return;
    }

    const deadline = Date.now() + CONFIG.signIn.timeoutMs;
    let nextPoll = Date.now() + CONFIG.signIn.pollIntervalMs;
    let unreachable = 0;
    while (!login.cancelled && Date.now() < deadline) {
      const left = formatCountdown(deadline - Date.now());
      setStatus(
        (unreachable ? "Sign-in service not responding, retrying. " : "Finish signing in in your browser. ") +
          "Waiting " + left + ". Cancel is under Settings."
      );
      await loginSleep(login, 1000);
      if (login.cancelled || Date.now() < nextPoll) continue;
      nextPoll = Date.now() + CONFIG.signIn.pollIntervalMs;

      let res;
      try {
        res = await brokerFetch("/session/" + encodeURIComponent(session.id), { headers: { Accept: "application/json" } });
      } catch (e) {
        unreachable++;
        continue;
      }
      if (login.cancelled) break;
      if (res.status === 404 || res.status === 410) {
        state.lastLogin = null;
        throw new Error("The sign-in link expired or was already used. Click Sign in with Stability to get a new one.");
      }
      if (!res.ok) {
        unreachable++;
        continue;
      }
      unreachable = 0;
      let data;
      try {
        data = await res.json();
      } catch (e) {
        continue;
      }
      if (data && data.status === "ready" && data.apiKey) {
        state.lastLogin = null;
        state.login = null;
        showSignInButtons("idle");
        await acceptAccountKey(String(data.apiKey));
        return;
      }
    }
    if (login.cancelled) throw new Error("cancelled");
    // Timed out. Keep the session so the link can reopen it; the panel is fully usable meanwhile.
    state.login = null;
    showSignInButtons("retry");
    setStatus("Login not completed. Click Open sign-in page under Settings to try again, or paste an API key.", "error");
  } catch (e) {
    state.login = null;
    if (e && e.message === "cancelled") {
      showSignInButtons(state.lastLogin ? "retry" : "idle");
      setStatus("Sign-in cancelled. You can paste an API key under Settings instead.");
    } else {
      showSignInButtons("idle");
      setStatus(e && e.message ? e.message : String(e), "error");
    }
  }
}

/** Opens a public page in the system browser (needs launchProcess in the manifest). */
async function openExternal(url) {
  try {
    await uxp.shell.openExternal(url);
    return true;
  } catch (e) {
    setStatus("Could not open the browser. Visit " + url, "error");
    return false;
  }
}

function apiKey() {
  const key = el.apiKey.value.trim();
  if (!key) throw new Error("Add your Stability API key under Settings, or click Get a key.");
  return key;
}

function setPreset(path) {
  state.presetPath = path || "";
  el.presetName.textContent = path ? path.split(/[\\/]/).pop() : "None";
}

async function pickPreset() {
  const file = await fs.getFileForOpening({ types: ["epr"] });
  if (!file) return;
  setPreset(file.nativePath);
  await saveSettings();
}

/* ------------------------------------------------------------------ */
/* Stability API                                                       */
/* ------------------------------------------------------------------ */

function formatCredits(n) {
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + " credits";
}

/**
 * Reads the balance and always leaves the header in a known state:
 * a number (including 0), a short reason the API refused, or blank with no key.
 */
async function refreshCredits() {
  let key;
  try {
    key = apiKey();
  } catch (e) {
    state.credits = null;
    el.credits.textContent = "";
    return;
  }
  try {
    const res = await fetch(CONFIG.apiBase + CONFIG.balancePath, {
      headers: { Authorization: "Bearer " + key },
    });
    if (res.status === 401 || res.status === 403) {
      state.credits = null;
      el.credits.textContent = "Key rejected";
      setStatus("The API rejected this key. Check it under Settings or click Get a key.", "error");
      return;
    }
    if (!res.ok) {
      state.credits = null;
      el.credits.textContent = "Balance unavailable";
      console.warn("[StableAudio] balance HTTP " + res.status);
      return;
    }
    const data = await res.json();
    const n = Number(data.credits);
    if (!isFinite(n)) {
      state.credits = null;
      el.credits.textContent = "Balance unavailable";
      return;
    }
    state.credits = n;
    el.credits.textContent = formatCredits(n);
    if (n <= 0) setStatus("No credits left. Click the balance to buy credits.", "error");
  } catch (e) {
    state.credits = null;
    el.credits.textContent = "Offline";
    console.warn("[StableAudio] balance", e);
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
  if (state.synthetic && window.SelfTest) return window.SelfTest.synth(opts, onTick);
  const fam = CONFIG.families[opts.model];
  const path = fam.base + "/" + opts.mode; // text-to-audio | audio-to-audio | inpaint
  const res = await fetch(CONFIG.apiBase + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey(),
      Accept: "audio/*",
      "stability-client-id": "stable-audio-premiere",
      "stability-client-version": "0.3.0",
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

/**
 * The first selected clip on the timeline, with its media path and timing.
 * Returns { trackItem, projectItem, mediaPath, name, startS, endS, sourceInS, durationS }.
 */
async function selectedClipInfo(trackItemOverride) {
  let trackItem = trackItemOverride || null;
  if (!trackItem) {
    const { sequence } = await activeProjectAndSequence();
    const selection = await sequence.getSelection();
    const items = await selection.getTrackItems();
    if (!items || !items.length) throw new Error("Select a clip on the timeline first.");
    trackItem = items[0];
  }

  const read = async (fn) => {
    try { return tickSeconds(await trackItem[fn]()); } catch (e) { return NaN; }
  };
  const startS = await read("getStartTime");
  const endS = await read("getEndTime");
  const sourceInS = await read("getInPoint");
  let durationS = await read("getDuration");
  if (!isFinite(durationS) && isFinite(startS) && isFinite(endS)) durationS = endS - startS;

  let projectItem = null;
  try { projectItem = await trackItem.getProjectItem(); } catch (e) { /* older builds */ }
  let name = "clip";
  try { name = (await trackItem.getName()) || (projectItem && projectItem.name) || name; } catch (e) { if (projectItem && projectItem.name) name = projectItem.name; }

  let mediaPath = null;
  if (projectItem) {
    const clip = asClip(projectItem);
    try { mediaPath = await clip.getMediaFilePath(); } catch (e) { console.warn("getMediaFilePath failed", e); }
  }
  return { trackItem, projectItem, mediaPath, name, startS, endS, sourceInS, durationS };
}

/** Reads a file anywhere on disk (needs localFileSystem: fullAccess). */
async function readFileBytes(nativePath) {
  let p = nativePath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // Windows drive letter
  const entry = await fs.getEntryWithUrl("file://" + p);
  return entry.read({ format: formats.binary });
}

/** Sequence in/out as seconds, or throws when not set. */
async function sequenceInOut() {
  const { sequence } = await activeProjectAndSequence();
  const inS = tickSeconds(await sequence.getInPoint());
  const outS = tickSeconds(await sequence.getOutPoint());
  if (!isFinite(inS) || !isFinite(outS) || outS <= inS || outS > 60 * 60 * 24) {
    throw new Error("Set in and out points on the timeline first.");
  }
  return { inS, outS };
}

/* ---- WAV slicing ------------------------------------------------- */

function parseWavHeader(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null;
  const h = { format: 0, channels: 0, sampleRate: 0, byteRate: 0, blockAlign: 0, bits: 0, dataPos: -1, dataLen: 0, fmtPos: -1, fmtLen: 0 };
  let pos = 12;
  while (pos + 8 <= buf.byteLength) {
    const id = dv.getUint32(pos, false);
    const size = dv.getUint32(pos + 4, true);
    if (id === 0x666d7420) { // "fmt "
      h.fmtPos = pos; h.fmtLen = size;
      h.format = dv.getUint16(pos + 8, true);
      h.channels = dv.getUint16(pos + 10, true);
      h.sampleRate = dv.getUint32(pos + 12, true);
      h.byteRate = dv.getUint32(pos + 16, true);
      h.blockAlign = dv.getUint16(pos + 20, true);
      h.bits = dv.getUint16(pos + 22, true);
    } else if (id === 0x64617461) { // "data"
      h.dataPos = pos + 8;
      h.dataLen = Math.min(size, buf.byteLength - h.dataPos);
      break;
    }
    pos += 8 + size + (size & 1);
  }
  return h.dataPos >= 0 && h.byteRate > 0 ? h : null;
}

/** Parses a PCM WAV header for its duration. Returns -1 for anything else (mp3). */
function wavDurationSeconds(buf) {
  try {
    const h = parseWavHeader(buf);
    return h ? h.dataLen / h.byteRate : -1;
  } catch (e) {
    return -1;
  }
}

/** Cuts [startS, endS] out of a PCM WAV and returns a new standalone WAV. */
function sliceWav(buf, startS, endS) {
  const h = parseWavHeader(buf);
  if (!h) throw new Error("Not a WAV file.");
  if (h.format !== 1 && h.format !== 3 && h.format !== 0xFFFE) throw new Error("Compressed WAV cannot be cut in place. Set a WAV export preset in Settings.");
  const total = h.dataLen / h.byteRate;
  const a = Math.max(0, Math.min(startS, total));
  const b = Math.max(a, Math.min(endS, total));
  const align = h.blockAlign || 1;
  const from = Math.floor((a * h.byteRate) / align) * align;
  const to = Math.floor((b * h.byteRate) / align) * align;
  const data = new Uint8Array(buf, h.dataPos + from, to - from);
  const fmt = new Uint8Array(buf, h.fmtPos, 8 + h.fmtLen + (h.fmtLen & 1));
  const out = new ArrayBuffer(12 + fmt.byteLength + 8 + data.byteLength);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x52494646, false);
  dv.setUint32(4, out.byteLength - 8, true);
  dv.setUint32(8, 0x57415645, false);
  u8.set(fmt, 12);
  let p = 12 + fmt.byteLength;
  dv.setUint32(p, 0x64617461, false);
  dv.setUint32(p + 4, data.byteLength, true);
  u8.set(data, p + 8);
  return out;
}

/* ---- Range capture ------------------------------------------------ */

/**
 * Returns the audio between startS and endS on the timeline as WAV bytes.
 * Preferred: render through Premiere's exporter with the user's WAV preset (hears exactly the mix).
 * Fallback: cut the range out of the selected clip's WAV media.
 */
async function captureRange(startS, endS, label, clipInfo) {
  if (state.presetPath) {
    try {
      return await exportRange(startS, endS, label);
    } catch (e) {
      console.warn("Export path failed, trying media slice", e);
      try {
        return await sliceFromClipMedia(startS, endS, label, clipInfo);
      } catch (e2) {
        throw new Error("Export failed (" + e.message + ") and the clip media could not be cut (" + e2.message + ").");
      }
    }
  }
  return sliceFromClipMedia(startS, endS, label, clipInfo);
}

async function setSequenceInOut(project, sequence, startS, endS) {
  let err = null;
  project.lockedAccess(() => {
    project.executeTransaction((compound) => {
      try {
        compound.addAction(sequence.createSetInPointAction(ppro.TickTime.createWithSeconds(startS)));
        compound.addAction(sequence.createSetOutPointAction(ppro.TickTime.createWithSeconds(endS)));
      } catch (e) { err = e; }
    }, "Stable Audio: set range");
  });
  if (err) throw err;
}

async function exportRange(startS, endS, label) {
  const { project, sequence } = await activeProjectAndSequence();
  const encoder = ppro.EncoderManager.getManager();
  const origIn = tickSeconds(await sequence.getInPoint());
  const origOut = tickSeconds(await sequence.getOutPoint());
  const changed = Math.abs(origIn - startS) > 0.0005 || Math.abs(origOut - endS) > 0.0005;
  if (changed) await setSequenceInOut(project, sequence, startS, endS);

  const folder = await takesFolder();
  const base = "SA_ref_" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "_" + slug(label || "range");
  const sep = folder.nativePath.indexOf("\\") >= 0 ? "\\" : "/";
  const outPath = folder.nativePath + sep + base + ".wav";
  let ok = false;
  try {
    ok = await encoder.exportSequence(sequence, ppro.Constants.ExportType.IMMEDIATELY, outPath, state.presetPath, false);
  } finally {
    if (changed && isFinite(origIn) && isFinite(origOut) && origOut > origIn && origOut < 60 * 60 * 24) {
      try { await setSequenceInOut(project, sequence, origIn, origOut); } catch (e) { console.warn("Could not restore in/out", e); }
    }
  }
  if (!ok) throw new Error("Premiere refused the export. Check the preset is a Waveform Audio preset.");

  // The exporter may add its own extension or suffix; find the newest file with our prefix.
  const entries = await folder.getEntries();
  const hits = entries.filter((e) => e.isFile && e.name.indexOf(base) === 0);
  if (!hits.length) throw new Error("Export reported success but no file appeared.");
  const file = hits[hits.length - 1];
  const bytes = await file.read({ format: formats.binary });
  if (wavDurationSeconds(bytes) <= 0) throw new Error("Exported file is not a WAV. Use a Waveform Audio preset.");
  return { name: file.name, arrayBuffer: bytes };
}

async function sliceFromClipMedia(startS, endS, label, clipInfo) {
  const info = clipInfo || (await selectedClipInfo());
  if (!info.mediaPath) throw new Error("Could not read the media path of the selected clip.");
  const ext = (info.mediaPath.split(".").pop() || "").toLowerCase();
  if (ext !== "wav") {
    throw new Error("The clip's media is ." + ext + ". Without a WAV export preset only WAV media can be cut. Add a preset under Settings.");
  }
  if (!isFinite(info.startS) || !isFinite(info.endS)) throw new Error("Could not read the clip's position on the timeline.");
  if (startS < info.startS - 0.01 || endS > info.endS + 0.01) {
    throw new Error("The in/out range must sit inside the selected clip (" + info.startS.toFixed(1) + " to " + info.endS.toFixed(1) + " s). Add a WAV export preset to capture across clips.");
  }
  const media = await readFileBytes(info.mediaPath);
  const offset = (isFinite(info.sourceInS) ? info.sourceInS : 0) - info.startS;
  const cut = sliceWav(media, startS + offset, endS + offset);
  const name = (info.name || "clip").replace(/\.[^.]+$/, "") + "_" + startS.toFixed(1) + "-" + endS.toFixed(1) + "s.wav";
  return { name, arrayBuffer: cut };
}

/**
 * Audio to audio: the in/out range is the reference and the duration.
 * Inpaint: the whole selected clip (up to the model's max) is the reference, in/out is the mask.
 */
async function referenceFromSelection() {
  const mode = el.mode.value;
  const { inS, outS } = await sequenceInOut();
  const maxLen = family().maxDuration;

  if (mode === "audio-to-audio") {
    if (outS - inS < 6) throw new Error("The range must be at least 6 seconds for audio to audio.");
    if (outS - inS > maxLen) throw new Error("The range is longer than " + maxLen + " s. Shorten it.");
    const ref = await captureRange(inS, outS, "a2a");
    state.referenceAudio = { name: ref.name, arrayBuffer: ref.arrayBuffer, clip: { startS: inS, endS: outS } };
    el.duration.value = Math.round(outS - inS);
    el.audioName.textContent = ref.name + " (" + (outS - inS).toFixed(1) + " s from the timeline)";
    el.placeTarget.value = "clip";
    return;
  }

  // Inpaint: context window around the selection.
  const info = await selectedClipInfo();
  if (!isFinite(info.startS) || !isFinite(info.endS)) throw new Error("Select the clip that contains the in/out range.");
  if (inS < info.startS - 0.01 || outS > info.endS + 0.01) throw new Error("Set in and out inside the selected clip.");
  let winStart = info.startS;
  let winEnd = info.endS;
  if (winEnd - winStart > maxLen) {
    // Center the window on the selection, clamp to the clip.
    const mid = (inS + outS) / 2;
    winStart = Math.max(info.startS, mid - maxLen / 2);
    winEnd = Math.min(info.endS, winStart + maxLen);
    winStart = Math.max(info.startS, winEnd - maxLen);
  }
  if (winEnd - winStart < 6) throw new Error("The clip is shorter than 6 seconds; the API needs at least 6 s of context.");
  const ref = await captureRange(winStart, winEnd, "inpaint");
  state.referenceAudio = { name: ref.name, arrayBuffer: ref.arrayBuffer, clip: { startS: winStart, endS: winEnd, info } };
  el.maskStart.value = (inS - winStart).toFixed(1);
  el.maskEnd.value = (outS - winStart).toFixed(1);
  el.duration.value = Math.round(winEnd - winStart);
  el.audioName.textContent = ref.name + " (" + (winEnd - winStart).toFixed(1) + " s context, regenerating " + (inS - winStart).toFixed(1) + " to " + (outS - winStart).toFixed(1) + " s)";
  el.placeTarget.value = "clip";
}

/**
 * Extend: reference is the tail of the selected clip, mask starts where it ends,
 * duration grows to the sequence out point.
 */
async function extendToOut() {
  const { sequence } = await activeProjectAndSequence();
  const info = await selectedClipInfo();
  const outS = tickSeconds(await sequence.getOutPoint());
  if (!isFinite(outS) || !isFinite(info.endS) || outS <= info.endS || outS > 60 * 60 * 24) {
    throw new Error("Set the sequence out point after the end of the selected clip.");
  }
  const maxLen = family().maxDuration;
  const gap = outS - info.endS;
  if (gap >= maxLen - 6) throw new Error("The gap is too long to extend in one pass (max " + maxLen + " s total).");
  const ctx = Math.min(info.endS - info.startS, maxLen - gap);
  const winStart = info.endS - ctx;
  const ref = await captureRange(winStart, info.endS, "extend");
  state.referenceAudio = { name: ref.name, arrayBuffer: ref.arrayBuffer, clip: { startS: winStart, endS: info.endS, info } };
  const newTotal = Math.min(maxLen, Math.ceil(ctx + gap));
  el.maskStart.value = ctx.toFixed(1);
  el.maskEnd.value = newTotal.toFixed(1);
  el.duration.value = newTotal;
  el.audioName.textContent = ref.name + " (" + ctx.toFixed(1) + " s of context)";
  el.placeTarget.value = "clip";
  setStatus("Extend: " + ctx.toFixed(1) + " s of context, regenerate from " + ctx.toFixed(1) + " to " + newTotal + " s (" + gap.toFixed(1) + " s gap).", "ok");
}

/** Where to place the cue, in seconds. */
/** Returns { seconds, tick } where tick is Premiere's own TickTime when it supplied one. */
async function placementTime(target) {
  const { sequence } = await activeProjectAndSequence();
  if (target === "clip" && state.referenceAudio && state.referenceAudio.clip && isFinite(state.referenceAudio.clip.startS)) {
    return { seconds: state.referenceAudio.clip.startS, tick: null };
  }
  if (target === "in" || target === "clip") {
    const tick = await sequence.getInPoint();
    const inS = tickSeconds(tick);
    if (isFinite(inS) && inS >= 0 && inS < 60 * 60 * 24) return { seconds: inS, tick };
  }
  const tick = await sequence.getPlayerPosition();
  const pos = tickSeconds(tick);
  return { seconds: isFinite(pos) ? pos : 0, tick: isFinite(pos) ? tick : null };
}

async function placementSeconds(target) {
  return (await placementTime(target)).seconds;
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
  return item; // plain ProjectItem; SequenceEditor actions take ProjectItem, not the ClipProjectItem cast
}

/** Counts clips across all audio tracks, or -1 if the API is unavailable. */
async function countAudioClips(sequence) {
  try {
    const n = await sequence.getAudioTrackCount();
    let total = 0;
    for (let i = 0; i < n; i++) {
      const track = await sequence.getAudioTrack(i);
      let items = null;
      try { items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false); } catch (e) { items = await track.getTrackItems(); }
      total += items ? items.length : 0;
    }
    return total;
  } catch (e) {
    console.warn("countAudioClips unavailable", e);
    return -1;
  }
}

/** Runs one placement action inside a transaction; errors thrown inside the callback are rethrown. */
function runAction(project, makeAction, undoLabel) {
  let err = null;
  let ok = false;
  project.lockedAccess(() => {
    // executeTransaction returns false when Premiere rejects the action without throwing
    // (Adobe's premiere-api sample relies on this), so the boolean is the real result.
    ok = project.executeTransaction((compound) => {
      try {
        compound.addAction(makeAction());
      } catch (e) {
        err = e;
      }
    }, undoLabel);
  });
  if (err) throw err;
  if (ok === false) throw new Error("Premiere rejected the edit (executeTransaction returned false)");
}

/**
 * Places the clip at `seconds` as one undo step. Tries, in order: overwrite on a new track,
 * overwrite on the last track, insert on the last track. Verifies that a clip was added.
 */
async function placeTake(take, target) {
  const { project, sequence } = await activeProjectAndSequence();
  const { seconds, tick } = await placementTime(target);
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const audioTracks = await sequence.getAudioTrackCount();
  const before = await countAudioClips(sequence);

  const describe = (o) => (o && o.constructor ? o.constructor.name : typeof o);
  // Verified in Premiere 26 (self-test, 2026-10-23): the plain ProjectItem from the bin works;
  // the ClipProjectItem cast makes every SequenceEditor action fail with "Invalid parameter".
  const items = [{ label: "ProjectItem", value: take.projectItem }];
  const times = [];
  if (tick) times.push({ label: "native TickTime", value: tick });
  times.push({ label: "createWithSeconds", value: ppro.TickTime.createWithSeconds(seconds) });
  // "overwrite, new track" (audio index = track count) is the verified path and creates the track.
  const strategies = [
    { label: "overwrite, new track", run: (it, t) => editor.createOverwriteItemAction(it, t, 0, audioTracks) },
    { label: "overwrite, last track", run: (it, t) => editor.createOverwriteItemAction(it, t, 0, Math.max(0, audioTracks - 1)) },
    { label: "insert, last track", run: (it, t) => editor.createInsertProjectItemAction(it, t, 0, Math.max(0, audioTracks - 1), true) },
  ];
  console.log("[StableAudio] placeTake: at " + seconds + " s, audio tracks " + audioTracks + ", clips before " + before +
    ", item " + describe(take.projectItem) + " \"" + (take.projectItem && take.projectItem.name) + "\"" +
    ", tick " + describe(tick) + " " + JSON.stringify(tick && { seconds: tick.seconds, ticks: tick.ticks, ticksNumber: tick.ticksNumber }));

  const errors = [];
  for (const it of items) {
    for (const t of times) {
      for (const st of strategies) {
        const label = st.label + " [" + it.label + ", " + t.label + "]";
        try {
          runAction(project, () => st.run(it.value, t.value), "Stable Audio: place " + take.name);
        } catch (e) {
          const msg = label + ": " + (e.message || e);
          console.warn("[StableAudio] " + msg);
          errors.push(msg);
          continue;
        }
        state.lastPlacement = label;
        if (before < 0) {
          console.log("[StableAudio] placed via " + label + " (unverified: track item count unavailable)");
          setStatus("Edit accepted via " + label + ", but the panel could not verify a clip appeared.", "ok");
          return seconds;
        }
        const after = await countAudioClips(sequence);
        if (after > before) {
          console.log("[StableAudio] placed via " + label);
          return seconds;
        }
        const msg = label + ": no clip appeared";
        console.warn("[StableAudio] " + msg);
        errors.push(msg);
      }
    }
  }
  const distinct = Array.from(new Set(errors.map((e) => e.replace(/^.*?: /, ""))));
  throw new Error("Could not place the clip on the timeline after " + errors.length + " attempts. Premiere said: " +
    distinct.join(" | ") + ". See Debug in UXP Developer Tools for each attempt.");
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
      card.className = "card take";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = take.name;

      const meta = document.createElement("div");
      meta.className = "meta2";
      meta.textContent = take.duration + " s  ·  " + take.prompt;

      const row = document.createElement("div");
      row.className = "inline";

      const placeIn = document.createElement("div");
      placeIn.className = "btn small";
      placeIn.textContent = "In point";
      placeIn.onclick = () => onPlace(take, "in");

      const placeHead = document.createElement("div");
      placeHead.className = "btn small";
      placeHead.textContent = "Playhead";
      placeHead.onclick = () => onPlace(take, "playhead");

      const reveal = document.createElement("div");
      reveal.className = "btn small";
      reveal.textContent = "Path";
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
  el.durationHint.textContent = "max " + fam.maxDuration;
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

  const cost = count * fam.creditsPerTake;
  if (!state.synthetic && state.credits !== null && state.credits < cost) {
    return setStatus(
      "This run needs " + cost + " credits and the balance is " + formatCredits(state.credits) + ". Click the balance to buy credits.",
      "error"
    );
  }

  setBusy(true);
  try {
    if (!state.synthetic) apiKey();
    const label = (state.synthetic ? "Synthesizing " : "Generating ") + count + " take" + (count > 1 ? "s" : "") + " of " + duration + " s";
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

    let placeError = null;
    if (el.autoPlace.checked && newTakes[0]) {
      try {
        const at = await placeTake(newTakes[0], el.placeTarget.value);
        msg += " First take placed at " + at.toFixed(2) + " s.";
      } catch (e) {
        placeError = e.message || String(e);
        msg += " " + placeError;
      }
    }
    setStatus(msg, failures.length || placeError ? "error" : "ok");
  } catch (e) {
    setStatus(e.message || String(e), "error");
  } finally {
    setBusy(false);
    refreshCredits();
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
  el.a2aBlock.className = needsAudio ? "card" : "card hidden";
  el.strengthBlock.className = mode === "audio-to-audio" ? "field" : "field hidden";
  el.maskBlock.className = mode === "inpaint" ? "stack" : "stack hidden";
  const buttons = el.modeSeg.querySelectorAll(".btn");
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].className = buttons[i].getAttribute("data-mode") === mode ? "btn active" : "btn";
  }
}

function onModeButton(evt) {
  const mode = evt.currentTarget.getAttribute("data-mode");
  if (!mode) return;
  el.mode.value = mode;
  onModeChange();
}

async function onRefFromClip() {
  try {
    setStatus(state.presetPath ? "Rendering the selected range..." : "Cutting the selected range from the clip media...");
    await referenceFromSelection();
    setStatus("Reference set from the timeline: " + el.audioName.textContent, "ok");
  } catch (e) {
    setStatus(e.message || String(e), "error");
  }
}

async function onExtendToOut() {
  try { await extendToOut(); } catch (e) { setStatus(e.message || String(e), "error"); }
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
  setSettingsOpen(el.settings.className.indexOf("hidden") >= 0);
}

/* ------------------------------------------------------------------ */
/* Wire up                                                             */
/* ------------------------------------------------------------------ */

el.saveSettings.addEventListener("click", async () => {
  await saveSettings();
  onModelChange();
  // Collapse once a key is in place so the panel fits at its minimum size.
  if (el.apiKey.value.trim()) setSettingsOpen(false);
});
el.toggleSettings.addEventListener("click", toggleSettings);
el.closeSettings.addEventListener("click", () => setSettingsOpen(false));
el.testMode.addEventListener("change", () => { applyDevToggles(); saveSettings(); });
el.synthetic.addEventListener("change", () => { applyDevToggles(); saveSettings(); });
el.apiKey.addEventListener("input", () => {
  state.keySource = "key"; // typing in the field makes it a pasted key
  updateAccountState();
});
el.signIn.addEventListener("click", () => { if (!isDisabled(el.signIn)) signInWithStability(false); });
el.reopenSignIn.addEventListener("click", () => signInWithStability(true));
el.cancelSignIn.addEventListener("click", cancelSignIn);
el.getKey.addEventListener("click", () => openExternal(CONFIG.links.getKey));
el.signOut.addEventListener("click", signOut);
el.credits.addEventListener("click", () => openExternal(CONFIG.links.credits));
el.privacyLink.addEventListener("click", () => openExternal(CONFIG.links.privacy));
el.termsLink.addEventListener("click", () => openExternal(CONFIG.links.terms));
el.model.addEventListener("change", onModelChange);
el.takes.addEventListener("change", updateCost);
el.mode.addEventListener("change", onModeChange);
(function wireModeButtons() {
  const buttons = el.modeSeg.querySelectorAll(".btn");
  for (let i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", onModeButton);
})();
el.refFromClip.addEventListener("click", onRefFromClip);
el.extendToOut.addEventListener("click", onExtendToOut);
el.pickPreset.addEventListener("click", () => pickPreset().catch((e) => setStatus(e.message, "error")));
el.pickAudio.addEventListener("click", () => pickReferenceAudio().catch((e) => setStatus(e.message, "error")));
el.strength.addEventListener("input", () => (el.strengthValue.textContent = Number(el.strength.value).toFixed(2)));
el.useSelection.addEventListener("click", onUseSelection);
el.useClip.addEventListener("click", onUseClip);
el.generate.addEventListener("click", onGenerate);

loadSettings().then(() => {
  // Open Settings on first run so the key field is visible.
  setSettingsOpen(!el.apiKey.value);
  updateAccountState();
  try {
    const v = (uxp.versions && uxp.versions.plugin) ? String(uxp.versions.plugin) : "";
    el.versionLabel.textContent = v ? "v" + v : "";
  } catch (e) { /* older runtimes */ }
  onModeChange();
  updateCost();
  renderTakes();
  refreshCredits();
  if (window.SelfTest) window.SelfTest.onReady();
});
