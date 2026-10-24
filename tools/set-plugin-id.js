#!/usr/bin/env node
// Writes the plugin ID into manifest.json.
//
// Adobe recommends one ID for the Creative Cloud Marketplace (issued by the
// Developer Distribution portal when you create the listing) and a separate ID
// for every other channel, so switch before packaging:
//
//   node tools/set-plugin-id.js <portal-plugin-id>     # before a Marketplace .ccx
//   node tools/set-plugin-id.js --dev                  # back to the developer ID
//
// The ID also keys the plugin-data folder and secure storage, so a build with a
// new ID starts with empty settings and an empty takes folder.
const fs = require("fs");
const path = require("path");

const DEV_ID = "ai.stability.stableaudio.premiere";
const manifestPath = path.join(__dirname, "..", "manifest.json");
const arg = process.argv[2];

if (!arg) {
  console.error("usage: node tools/set-plugin-id.js <portal-plugin-id> | --dev");
  process.exit(2);
}
const id = arg === "--dev" ? DEV_ID : arg.trim();
if (!/^[A-Za-z0-9._-]+$/.test(id)) {
  console.error("refusing an ID with characters outside [A-Za-z0-9._-]: " + id);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const previous = manifest.id;
manifest.id = id;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(previous + " -> " + id);
