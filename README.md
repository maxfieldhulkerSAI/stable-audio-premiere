# Stable Audio for Premiere Pro (UXP prototype)

A Premiere Pro panel that generates music and sound design with the Stability API and places the result on the timeline.

## What it does

- Text to audio, audio to audio (restyle a reference), and inpaint (regenerate a section)
- Reference audio from the selected timeline clip (reads its wav or mp3 media directly) or from a file
- Inpaint mask from the sequence in/out set inside the selected clip; "Extend to out point" fills a gap after a clip
- Duration from the sequence in/out range or the selected clip
- 1 to 4 takes per run, each imported into a "Stable Audio" bin
- One click places a take on a new audio track at the in point or playhead, as a single undo step
- Seamless loop toggle (prompt-level for now)
- API key stored in UXP secure storage, credit balance shown in the header

## Load it in Premiere (developer mode)

1. Premiere Pro 25.6 or later.
2. Install **UXP Developer Tools** from the Creative Cloud desktop app (v2.2.1 or later).
3. In UXP Developer Tools, turn on developer mode if asked, then **Add Plugin** and pick `manifest.json` in this folder.
4. Click **Load**. The panel appears under **Window > UXP Plugins > Stable Audio**.
5. Open **Settings** in the panel, paste a Stability API key, click **Save settings**.
6. Open a sequence, set in and out, type a prompt, click **Generate**.

Use **Debug** in UXP Developer Tools to see console output. Every status message is also logged with a `[StableAudio]` prefix.

## Where files go

Generated audio is written to the plugin's data folder (`plugin-data:/takes`), which is a per-user folder Premiere manages. The project links to those files, so do not delete the folder while a project uses them. **Copy path** on a take copies the full path if you want to move it. A later version should write next to the project file or to a user-chosen folder (`localFileSystem: "fullAccess"` or a folder picker).

## Known risks (first-load checklist)

These are the calls most likely to need a fix on first run. Each is isolated in `index.js` under the "Premiere" section.

| Area | What might break | Where to look |
| --- | --- | --- |
| Timeline placement | `createOverwriteItemAction(item, time, 0, audioTrackIndex)` argument order or whether `audioTrackIndex = trackCount` creates a new track. Fallback tries the last existing track. | `placeTake()` |
| Transactions | Actions must be created inside `executeTransaction`, which must run inside `lockedAccess`. The code does this; if it still fails, check the undo string and that the project item is a `ClipProjectItem`. | `placeTake()`, `stableAudioBin()` |
| TickTime | `tickSeconds()` reads `.seconds`, then `.ticksNumber`, then `.ticks`. If none exist, log the object and adjust. | `tickSeconds()` |
| Bin creation | `root.createBinAction(name, makeUnique)` is used. If it throws, takes land in the project root. | `stableAudioBin()` |
| Selected clip duration | `getSelection().getTrackItems()[0].getDuration()`. Pre-26.x builds may differ. | `selectedClipDuration()` |
| Import lookup | After `importFiles`, the item is found by name in the bin. If Premiere strips extensions differently, widen the match. | `importTake()` |
| Network | Only `https://api.stability.ai` is allowed in the manifest. A `TypeError: Failed to fetch` means the domain list, not the key. | `manifest.json` |
| Selected clip as reference | `getSelection().getTrackItems()`, then `getStartTime` / `getInPoint` / `getProjectItem` on the track item and `getMediaFilePath` on the clip item. Each is wrapped; missing ones fall back or produce a clear message. | `selectedClipInfo()` |
| Reading media from disk | `fs.getEntryWithUrl("file:///...")` needs `fullAccess`. If it throws, check the manifest permission and the path separators (Windows paths are converted). | `readFileBytes()` |
| Binary writes | `file.write(arrayBuffer, { format: formats.binary })`. If the WAV is 0 bytes, check this call. | `writeTake()` |

## API notes

- Default model is **Stable Audio 3.0** on `POST /v2beta/audio/stable-audio/{text-to-audio|audio-to-audio|inpaint}`. These endpoints are async: the POST returns 202 with an `id`, and the panel polls `GET /v2beta/audio/results/{id}` every 3 s until it gets 200 with the audio bytes. Flat 8 credits per take, max 380 s, `steps` 4 to 8, `cfg_scale` default 1. Docs: https://docs.stability.ai/api-reference/stable-audio/text-to-audio.md
- Stable Audio 2.5 and 2.0 are still selectable. They use `/v2beta/audio/stable-audio-2/...` with a `model` field, answer inline, and cap at 190 s.
- Audio-to-audio sends the reference as `audio` (mp3 or wav, 6 to 380 s) plus `strength`: 0 keeps the input, 1 ignores it. The panel defaults to 0.7 for 3.0.
- Inpaint sends `audio`, `prompt`, `mask_start`, `mask_end` and `duration`. The docs do not spell out how `duration` beyond the source length behaves, so "extend" is a convention here (mask start = source length, duration = new total) until it is tested.
- Each take gets a random non-zero seed so takes differ.
- Rate limit is 150 requests per 10 s. Polling four takes at once stays far under it.

## Timeline reference (audio to audio and inpaint)

**Selected clip** reads the selected track item's media path (`ClipProjectItem.getMediaFilePath`) and loads the file from disk, which is why the manifest asks for `localFileSystem: "fullAccess"`. Only wav and mp3 media can be sent; for anything else (AAC in an MP4, for example) export the clip as WAV first or use Choose file.

Mask math for inpaint: `mask = sequenceTime - clipStartOnTimeline + clipSourceInPoint`, so trimmed clips map correctly onto the source media. Extend sets the mask to start at the media's end (read from the WAV header) and grows Duration to the sequence out point.

**Place at: Reference clip start** drops the result on a new track aligned with the clip it was made from, so an inpainted take lines up under the original for A/B.

## Visual style

Stability AI brand tokens: Studio Black `#1E1E1E` canvas, Black Obsidian `#262626` cards with `rgba(255,255,255,0.08)` hairlines, Canvas White `#EEEEEE` text, Desaturated Violet `#B6A9C6` labels, Grey Ash `#888888` hints. Artist Purple `#A381FF` appears only on the Generate pill, focus rings, and the active mode. 14px type floor, uppercase labels at +4% tracking, capsule section tags, no em dashes. Archivo is requested first and falls back to the system font because UXP cannot load web fonts.

## UXP layout notes

UXP ignores `display: block`, `<details>`, and does not show a `<select>` value unless an option carries `selected`. Every container in `index.html` is an explicit flex column, Settings toggles from JS, and the content is capped at 400 px wide so a wide floating panel stays readable. Dock the panel (drag its tab next to Project) to keep it narrow.

## Not in the prototype

- Extend as a first-class action (needs source-length detection and a replace-media step on the timeline)
- Audition inside the panel (UXP has no `<audio>` playback; takes are auditioned in the Source monitor)
- Account login and shared credits with the web app and DAW plugin (uses an API key instead)
- Custom styles via Audio LoRA
- Writing files next to the project
