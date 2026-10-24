# Creative Cloud Marketplace checklist

What stands between this prototype and a public listing, in the order to do it.
Adobe's own pages: [distribution overview](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/overview),
[package](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/package),
[listing](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/listing),
[review guidelines](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/review-guidelines).

Stages, as agreed: a private `.ccx` for internal testers first (no review), then the public listing.

## Stage 1: private .ccx

- [ ] Open the plugin in UXP Developer Tools, package it (••• > Package), install the `.ccx` by double-click on a clean machine, and confirm the panel opens under Window > UXP Plugins. No review, no signing.
- [ ] Walk the "Known risks" table in README.md inside a real Premiere 25.6+ session and fix what breaks. Reviewers click every button, so each row must be green: placement on a new track, bin creation, in/out capture with and without a preset, inpaint, extend, copy path, reveal.
- [ ] Test with the Work Area Bar visible (Adobe bug DVAPR-4265965): the panel must at least report that the capture covered the wrong range instead of sending it silently.
- [ ] Test with no key, a wrong key, zero credits, and the network unplugged mid-poll. Each must end in a readable status line and a usable panel, not a hang.
- [ ] Test the minimum panel size (300 x 420) and a tall floating panel: nothing clipped, scrollbars appear, Generate reachable.

## Stage 2: listing in the Developer Distribution portal

### Done in this pass

- [x] Panel icons for dark and light themes (`icons/dark*.png`, `icons/light*.png`, 23 px at 1x and 2x) and the Plugins panel icon (`icons/plugin-icon*.png`, 48 px with a 2x file, matching Adobe's Premiere samples). Regenerate with `python tools/make_icons.py`.
- [x] Marketplace listing icons at 48, 96 and 192 px and a 250 px publisher logo in `icons/marketplace-*.png` and `icons/publisher-250.png`. These are uploaded in the portal, not read from the manifest.
- [x] Sign in / sign out inside the panel: Sign in with Stability runs the browser flow below, Get a key opens the Stability key page, Sign out removes the key from secure storage, the Account header shows the state ("Signed in via Stability account" or "Signed in (key ending ...)").
- [x] Plugin side of Sign in with Stability, built against `tools/stub-broker.js`: session, browser hand-off, 2 s polling with a countdown, Cancel, a 3 minute timeout that ends in "Login not completed" plus an Open sign-in page link, clear status text when the service is unreachable. The paste-a-key field stays as the fallback.
- [x] Privacy policy and Terms of use buttons in Settings, URLs in `CONFIG.links` in `index.js`.
- [x] `launchProcess` permission for `https` so the buttons above can open the browser. UXP asks the user for consent the first time.
- [x] `tools/set-plugin-id.js` to swap between the developer ID and the portal ID.
- [x] `version` bumped to 0.4.0 (major.minor.patch is required).

### Still to do before submitting

- [ ] **Sign-in broker.** Stand up the Stability-hosted service described under "Sign-in broker service" below, point `CONFIG.broker` at its `https` origin, replace `http://127.0.0.1:8787` in `requiredPermissions.network.domains` with that origin, and remove `http` from `launchProcess.schemes`. `tools/stub-broker.js` and its test must not be in the `.ccx` (package from a checkout without `tools/`, or exclude the folder). Until the product decision on which account signs in and whose credits are spent is made, the button works only against the stub.
- [ ] **Publisher profile.** Create it once in the portal: public name, website, description, the 250 px logo. An enterprise Adobe ID may need the Developer role; a personal Adobe ID also works. Add DSA trader information or the listing is hidden in the EU.
- [ ] **Plugin ID.** Create the listing (Creative Cloud desktop plugin > Premiere Pro), copy the generated ID, run `node tools/set-plugin-id.js <id>`, then package. Run `node tools/set-plugin-id.js --dev` afterwards so developer builds keep their settings.
- [ ] **Confirm the three URLs** in `CONFIG.links`: key page, privacy policy, terms. The listing form also asks for Privacy Policy URL, Terms of Service URL, Help URL and a support email; all must open.
- [ ] **Icons are generated placeholders.** Have design replace them with the real Stable Audio mark at the same sizes and file names. Adobe rejects default or placeholder-looking icons, and each must read in light and dark themes.
- [ ] **Screenshot.** One 1360 x 800 capture of the panel docked in Premiere with real takes in the list, under 5 MB. Up to four more are optional.
- [ ] **Listing text.** Name "Stable Audio" (45 char max, no Adobe product names, ASCII only), subtitle (30), description (5000) that states: free plugin, needs a Stability account, 8 credits per take on Stable Audio 3.0, audio goes to the plugin data folder. Disclose the Stability API as a third-party dependency. Do not name competitors.
- [ ] **Notes to reviewer.** A test API key with credits on it (missing credentials are an immediate rejection), a one-paragraph test script (open a sequence, set in/out, type a prompt, Generate, Place), the note that keyboard shortcuts are not supported in 25.6 panels, and a sentence on content safety (prompts and outputs are moderated server-side by the Stability API).
- [ ] **Generative AI statement.** The guidelines say generative features need filtering and may need a compliance certification. Have the policy wording ready.
- [ ] **Permissions review.** `localFileSystem: "fullAccess"` is only needed to read clip media when no export preset is set (`sliceFromClipMedia`). Decide: keep it and justify in reviewer notes, or drop that fallback and use `"request"` plus a folder picker for takes. Adobe warns users may refuse full access at install.
- [ ] **Bundle an export preset** or make the no-preset path obviously correct. Reviewers will not create a `.epr` first. Shipping a Waveform Audio preset inside the plugin and selecting it by default removes the setup step.
- [ ] **No developer output in production.** The `[StableAudio]` console lines are fine; make sure no debug UI or alert is left on.
- [ ] **Package from a clean checkout.** `.selftest/` is gitignored and must not be in the `.ccx`: without its `DEV` marker the Developer toggles stay hidden and `selftest.js` does nothing. Run `python tools/selftest.py --disable` or clone fresh before packaging.
- [ ] **Pricing field.** Free. Say in the description that generation is billed by Stability, not through Adobe.

### Submission

- [ ] Upload the `.ccx` with the listing (first submission needs both together), add reviewer notes and the test key, choose manual publish, Submit for review. Adobe targets 10 business days. Questions: ccintrev@adobe.com.

## Sign-in broker service

UXP panels cannot receive a browser redirect, so "Sign in with Stability" uses Adobe's documented pattern (`AdobeDocs/uxp-premiere-pro-samples`, `sample-panels/oauth-workflow-sample`): the panel gets a session id from a server, sends the user to that server's login page in the system browser, and polls the server until a credential is attached to the session. Stability has to host that server. The panel talks to it through `CONFIG.broker` in `index.js` and expects exactly these three endpoints, which `tools/stub-broker.js` implements locally:

| Endpoint | Response | Notes |
| --- | --- | --- |
| `POST /session` | `200 { "id": "...", "loginUrl": "https://..." }` | `id` is an unguessable random token; `loginUrl` is the page to open in the browser and must carry the id. |
| `GET /login?id=...` | HTML | The real Stability login (and, if required, a consent step naming Premiere Pro). On success it attaches an API key, or another credential the API accepts as a bearer token, to the session and tells the user to return to Premiere. Unknown or expired ids get a page that says so. |
| `GET /session/{id}` | `200 { "status": "pending" }` until the login finishes, then `200 { "status": "ready", "apiKey": "..." }` exactly once; `404` for unknown, expired or already delivered sessions | The key is handed out once and then dropped server-side. The panel polls every 2 s for up to 3 minutes per attempt. |

Requirements for the real service:

- `https` only, on a fixed origin that goes into `requiredPermissions.network.domains`. macOS refuses plain `http` to anything but localhost, and Adobe review checks the domain list.
- Sessions expire server-side (the stub uses 10 minutes). The panel reuses a session for its "Open sign-in page" link until then.
- No cookies or redirects are involved on the panel side: the panel only ever does `fetch` to the two JSON endpoints, and the browser does the rest.
- CORS is not needed for the panel (UXP sends no browser origin) but is harmless.
- The credential returned must work against `api.stability.ai` with `Authorization: Bearer`, since the panel uses it for generation and `GET /v1/user/balance`. Decide whether that is a per-user API key minted for the plugin, or a scoped token, and whose credits it draws on.
- Sign out in the panel only forgets the credential locally. If the credential should be revoked, add a `DELETE /session`-style endpoint and call it from `signOut()`.

The stub (`tools/stub-broker.js`, `tools/stub-broker.test.js`) is development tooling: it issues fake `sk-stub-...` keys that the API rejects, runs on `http://127.0.0.1:8787`, and must not ship in the `.ccx`.

## Not required

- No code signing or notarization: the plugin has no native `.uxpaddon` binaries. Keep it that way; a hybrid plugin needs signed builds for macOS arm64, macOS x64 and Windows x64.
- No companion app: the panel talks to `api.stability.ai` directly. Do not add a local helper process; Adobe forbids launching external applications and scrutinizes companion installs.
