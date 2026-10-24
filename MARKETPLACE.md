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
- [x] Sign in / sign out inside the panel: Get a key opens the Stability key page, Sign out removes the key from secure storage, the Account header shows the state.
- [x] Privacy policy and Terms of use buttons in Settings, URLs in `CONFIG.links` in `index.js`.
- [x] `launchProcess` permission for `https` so the buttons above can open the browser. UXP asks the user for consent the first time.
- [x] `tools/set-plugin-id.js` to swap between the developer ID and the portal ID.
- [x] `version` bumped to 0.4.0 (major.minor.patch is required).

### Still to do before submitting

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

## Not required

- No code signing or notarization: the plugin has no native `.uxpaddon` binaries. Keep it that way; a hybrid plugin needs signed builds for macOS arm64, macOS x64 and Windows x64.
- No companion app: the panel talks to `api.stability.ai` directly. Do not add a local helper process; Adobe forbids launching external applications and scrutinizes companion installs.
