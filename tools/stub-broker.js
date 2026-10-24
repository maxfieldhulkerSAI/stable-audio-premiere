#!/usr/bin/env node
// Local stand-in for the Stability sign-in broker the Premiere panel talks to.
//
// UXP panels cannot receive a browser redirect, so sign-in follows Adobe's
// oauth-workflow-sample pattern: the panel asks this server for a session id,
// opens the browser at loginUrl, and polls the session until a key is attached.
//
//   node tools/stub-broker.js            # listens on http://127.0.0.1:8787
//   PORT=9000 node tools/stub-broker.js  # another port (update CONFIG.broker too)
//
// Endpoints (the real Stability-hosted broker must expose the same three):
//   POST /session          -> { id, loginUrl }
//   GET  /login?id=...     -> HTML page with a "Sign in" button (POST /login completes it)
//   GET  /session/:id      -> { status: "pending" } | { status: "ready", apiKey } once,
//                             then the session is forgotten (404 afterwards)
//
// Sessions expire 10 minutes after creation. Keys are fake ("sk-stub-...") and
// never leave this process except through GET /session/:id. Development only:
// this file must not ship inside the .ccx (see MARKETPLACE.md).

const http = require("http");
const crypto = require("crypto");

const DEFAULTS = {
  host: "127.0.0.1",
  port: Number(process.env.PORT) || 8787,
  ttlMs: 10 * 60 * 1000,
  sweepMs: 60 * 1000,
  log: (line) => console.log("[stub-broker] " + line),
};

function page(title, body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' + title + "</title>" +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "font-family:Archivo,Inter,-apple-system,sans-serif;background:#1E1E1E;color:#EEEEEE}" +
    ".card{width:320px;padding:28px 32px;border-radius:8px;background:#262626;border:1px solid rgba(255,255,255,.08)}" +
    "h1{font-size:18px;margin:0 0 6px}.a{color:#888}.b{color:#EEE}p{color:#B6A9C6;font-size:14px;line-height:1.45}" +
    "button{width:100%;height:40px;margin-top:14px;border:0;border-radius:6px;background:#A381FF;color:#1A0F36;" +
    "font-size:15px;font-weight:600;cursor:pointer}.tag{display:inline-block;margin-top:16px;padding:2px 8px;" +
    "border-radius:8px;border:1px solid rgba(255,255,255,.1);color:#888;font-size:12px}</style></head>" +
    '<body><div class="card"><h1><span class="a">Stable</span> <span class="b">Audio</span></h1>' + body +
    '<span class="tag">local stub broker</span></div></body></html>'
  );
}

function loginPage(id) {
  return page(
    "Sign in to Stability",
    "<p>Premiere Pro is asking to use your Stability account for Stable Audio.</p>" +
      '<form method="post" action="/login"><input type="hidden" name="id" value="' + id + '">' +
      '<button type="submit">Sign in and return to Premiere</button></form>' +
      "<p>This is a development stub. No account is contacted; a fake API key is issued.</p>"
  );
}

const donePage = page(
  "Signed in",
  '<p><strong style="color:#EEE">Signed in.</strong> You can close this tab and return to Premiere Pro. ' +
    "The panel finishes on its own within a couple of seconds.</p>"
);

const expiredPage = page(
  "Sign-in link expired",
  "<p>This sign-in link has expired or was already used. Go back to the Stable Audio panel in Premiere Pro " +
    'and click <strong style="color:#EEE">Sign in with Stability</strong> again.</p>'
);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseBody(req, raw) {
  const type = String(req.headers["content-type"] || "");
  if (type.indexOf("application/json") >= 0) {
    try { return JSON.parse(raw || "{}"); } catch (e) { return {}; }
  }
  const out = {};
  new URLSearchParams(raw).forEach((v, k) => { out[k] = v; });
  return out;
}

/**
 * Starts the broker. Resolves to { server, url, close } once it is listening.
 * Options: host, port (0 picks a free port), ttlMs, sweepMs, log.
 */
function start(options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const sessions = new Map(); // id -> { createdAt, apiKey | null }

  function alive(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.createdAt > opts.ttlMs) {
      sessions.delete(id);
      return null;
    }
    return s;
  }

  function sweep() {
    for (const id of Array.from(sessions.keys())) alive(id);
  }

  function send(res, status, body, type) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": type || "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(text);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + req.headers.host);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");

      if (req.method === "POST" && path === "/session") {
        const id = crypto.randomUUID();
        sessions.set(id, { createdAt: Date.now(), apiKey: null });
        const base = "http://" + req.headers.host;
        opts.log("session " + id.slice(0, 8) + " created");
        return send(res, 200, { id, loginUrl: base + "/login?id=" + id });
      }

      if (req.method === "GET" && path === "/login") {
        const id = url.searchParams.get("id") || "";
        if (!alive(id)) return send(res, 404, expiredPage, "text/html; charset=utf-8");
        return send(res, 200, loginPage(id), "text/html; charset=utf-8");
      }

      if (req.method === "POST" && path === "/login") {
        const body = parseBody(req, await readBody(req));
        const id = String(body.id || url.searchParams.get("id") || "");
        const s = alive(id);
        if (!s) return send(res, 404, expiredPage, "text/html; charset=utf-8");
        s.apiKey = "sk-stub-" + crypto.randomBytes(16).toString("hex");
        opts.log("session " + id.slice(0, 8) + " signed in");
        return send(res, 200, donePage, "text/html; charset=utf-8");
      }

      const m = req.method === "GET" && /^\/session\/([^/]+)$/.exec(path);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const s = alive(id);
        if (!s) return send(res, 404, { status: "unknown", error: "Unknown or expired session" });
        if (!s.apiKey) return send(res, 200, { status: "pending" });
        const apiKey = s.apiKey;
        sessions.delete(id); // one delivery only
        opts.log("session " + id.slice(0, 8) + " key delivered and forgotten");
        return send(res, 200, { status: "ready", apiKey });
      }

      return send(res, 404, { error: "Not found" });
    } catch (e) {
      opts.log("error: " + (e && e.message ? e.message : e));
      return send(res, 500, { error: "Broker error" });
    }
  });

  const sweeper = setInterval(sweep, opts.sweepMs);
  if (sweeper.unref) sweeper.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const url = "http://" + opts.host + ":" + addr.port;
      resolve({
        server,
        url,
        close: () =>
          new Promise((done) => {
            clearInterval(sweeper);
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { start, DEFAULTS };

if (require.main === module) {
  start().then(
    ({ url }) => {
      console.log("[stub-broker] listening on " + url);
      console.log('[stub-broker] CONFIG.broker in index.js must be "' + url + '"; Ctrl+C to stop.');
    },
    (e) => {
      console.error("[stub-broker] could not start: " + e.message);
      process.exit(1);
    }
  );
}
