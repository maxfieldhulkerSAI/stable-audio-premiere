#!/usr/bin/env node
// End-to-end test for tools/stub-broker.js using only node's http module.
//
//   node tools/stub-broker.test.js
//
// Starts the broker in-process on a free port and walks the panel's flow:
// create a session, poll (pending), load the login page, press the button,
// poll (ready with a key), poll again (forgotten). Then checks expiry on a
// second instance with a very short TTL.

const http = require("http");
const assert = require("assert");
const { start } = require("./stub-broker.js");

function request(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: Object.assign({}, headers || {}),
    };
    if (data != null) opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        const type = res.headers["content-type"] || "";
        let json = null;
        if (type.indexOf("application/json") >= 0) {
          try { json = JSON.parse(text); } catch (e) { /* leave null */ }
        }
        resolve({ status: res.statusCode, type, text, json });
      });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("ok   " + name);
    });
}

async function main() {
  const quiet = () => {};
  const broker = await start({ port: 0, log: quiet });
  const base = broker.url;
  let id = "";
  let loginUrl = "";
  let apiKey = "";

  try {
    await ok("POST /session returns an id and a loginUrl on this host", async () => {
      const r = await request("POST", base + "/session");
      assert.strictEqual(r.status, 200);
      assert.ok(r.json && typeof r.json.id === "string" && r.json.id.length >= 16, "id");
      assert.ok(r.json.loginUrl.indexOf(base + "/login?id=" + r.json.id) === 0, "loginUrl " + r.json.loginUrl);
      id = r.json.id;
      loginUrl = r.json.loginUrl;
    });

    await ok("GET /session/:id is pending before the browser step", async () => {
      const r = await request("GET", base + "/session/" + id);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json, { status: "pending" });
    });

    await ok("GET /login?id= serves a page with a sign-in form", async () => {
      const r = await request("GET", loginUrl);
      assert.strictEqual(r.status, 200);
      assert.ok(r.type.indexOf("text/html") === 0, "html");
      assert.ok(r.text.indexOf('action="/login"') >= 0, "form posts to /login");
      assert.ok(r.text.indexOf('value="' + id + '"') >= 0, "form carries the id");
      assert.ok(r.text.indexOf("<button") >= 0, "has a button");
    });

    await ok("GET /login with an unknown id shows the expired page", async () => {
      const r = await request("GET", base + "/login?id=nope");
      assert.strictEqual(r.status, 404);
      assert.ok(r.text.indexOf("expired") >= 0);
    });

    await ok("POST /login (form submit) attaches a key and says signed in", async () => {
      const r = await request("POST", base + "/login", "id=" + encodeURIComponent(id), {
        "Content-Type": "application/x-www-form-urlencoded",
      });
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.indexOf("Signed in") >= 0);
    });

    await ok("GET /session/:id is ready once, with an sk-stub- key", async () => {
      const r = await request("GET", base + "/session/" + id);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.status, "ready");
      assert.ok(/^sk-stub-[0-9a-f]{32}$/.test(r.json.apiKey), "key " + r.json.apiKey);
      apiKey = r.json.apiKey;
    });

    await ok("GET /session/:id a second time has forgotten the key", async () => {
      const r = await request("GET", base + "/session/" + id);
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json.status, "unknown");
      assert.ok(r.text.indexOf(apiKey) < 0, "key not leaked");
    });

    await ok("POST /login for a consumed session is refused", async () => {
      const r = await request("POST", base + "/login", { id }, { "Content-Type": "application/json" });
      assert.strictEqual(r.status, 404);
    });

    await ok("GET /session/unknown is 404", async () => {
      const r = await request("GET", base + "/session/does-not-exist");
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json.status, "unknown");
    });

    await ok("POST /login accepts a JSON body too", async () => {
      const c = await request("POST", base + "/session");
      const r = await request("POST", base + "/login", { id: c.json.id }, { "Content-Type": "application/json" });
      assert.strictEqual(r.status, 200);
      const s = await request("GET", base + "/session/" + c.json.id);
      assert.strictEqual(s.json.status, "ready");
    });

    await ok("two sessions get different keys", async () => {
      const keys = [];
      for (let i = 0; i < 2; i++) {
        const c = await request("POST", base + "/session");
        await request("POST", base + "/login", "id=" + c.json.id, {
          "Content-Type": "application/x-www-form-urlencoded",
        });
        keys.push((await request("GET", base + "/session/" + c.json.id)).json.apiKey);
      }
      assert.notStrictEqual(keys[0], keys[1]);
    });

    await ok("unknown paths are 404 JSON", async () => {
      const r = await request("GET", base + "/nothing");
      assert.strictEqual(r.status, 404);
      assert.ok(r.json && r.json.error);
    });
  } finally {
    await broker.close();
  }

  const short = await start({ port: 0, ttlMs: 40, sweepMs: 10, log: quiet });
  try {
    await ok("sessions expire after the TTL (pending and signed-in alike)", async () => {
      const a = await request("POST", short.url + "/session");
      const b = await request("POST", short.url + "/session");
      await request("POST", short.url + "/login", "id=" + b.json.id, {
        "Content-Type": "application/x-www-form-urlencoded",
      });
      await sleep(120);
      const ra = await request("GET", short.url + "/session/" + a.json.id);
      const rb = await request("GET", short.url + "/session/" + b.json.id);
      assert.strictEqual(ra.status, 404);
      assert.strictEqual(rb.status, 404);
      const page = await request("GET", short.url + "/login?id=" + a.json.id);
      assert.strictEqual(page.status, 404);
    });
  } finally {
    await short.close();
  }

  console.log("\n" + passed + " tests passed");
}

main().catch((e) => {
  console.error("FAIL " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
