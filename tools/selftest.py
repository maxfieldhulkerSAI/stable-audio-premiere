"""Drive the in-plugin self-test harness (selftest.js) from the command line.

    python tools/selftest.py --enable            create .selftest/DEV, then Reload the plugin once
    python tools/selftest.py                     run import, place, capture
    python tools/selftest.py env                 describe the open project and sequence
    python tools/selftest.py place capture --in-point 3 --capture-seconds 2
    python tools/selftest.py --disable           remove the marker (do this before packaging)

Premiere must be open with a sequence, the plugin loaded, and Test mode on in Settings.
Exit codes: 0 all passed, 1 a test failed, 2 not enabled, 3 timed out waiting for results.
"""
import argparse
import json
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / ".selftest"
DEV = DIR / "DEV"
REQUEST = DIR / "request.json"
RESULTS = DIR / "results.json"
DEFAULT_TESTS = ["import", "place", "capture"]


def load_results():
    try:
        return json.loads(RESULTS.read_text(encoding="utf-8"))
    except Exception:
        return None


def report(r):
    env = r.get("env") or {}
    print("plugin v%s  project %r  sequence %r  tracks V%s/A%s  in/out %s/%s  audio clips %s  synthetic %s" % (
        env.get("pluginVersion"), env.get("project"), env.get("sequence"), env.get("videoTracks"),
        env.get("audioTracks"), env.get("inS"), env.get("outS"), env.get("audioClips"), env.get("synthetic")))
    if env.get("error"):
        print("env error:", env["error"])
    if r.get("error"):
        print("RUN ERROR:", r["error"])
    all_ok = not r.get("error")
    for t in r.get("tests", []):
        mark = "PASS" if t.get("ok") else "FAIL"
        all_ok = all_ok and t.get("ok", False)
        print("%s  %-8s %6d ms  %s" % (mark, t.get("name"), t.get("ms", 0), t.get("error", "")))
        if t.get("details") is not None:
            print("      " + json.dumps(t["details"], indent=2).replace("\n", "\n      "))
        if t.get("stack"):
            print("      stack: " + t["stack"])
    if not all_ok:
        print("--- console during run ---")
        for line in r.get("log", [])[-40:]:
            print("  " + line)
    print("%s/%s passed" % (r.get("passed", 0), r.get("total", 0)))
    return 0 if all_ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tests", nargs="*", help="env, import, place, capture (default: import place capture)")
    ap.add_argument("--enable", action="store_true")
    ap.add_argument("--disable", action="store_true")
    ap.add_argument("--timeout", type=float, default=180, help="seconds to wait for results")
    ap.add_argument("--seconds", type=float, default=5, help="length of the synthetic take")
    ap.add_argument("--in-point", type=float, default=1, help="where the place test sets the in point")
    ap.add_argument("--capture-seconds", type=float, default=2)
    ap.add_argument("--no-stop", action="store_true", help="keep going after a failed test")
    a = ap.parse_args()

    if a.enable:
        DIR.mkdir(exist_ok=True)
        DEV.write_text("Marker: reveals the Developer toggles in the panel. Never ship or commit.\n", encoding="utf-8")
        print("enabled:", DIR)
        print("Now Reload the plugin once in UXP Developer Tools and turn on Test mode under Settings > Developer.")
        if not a.tests:
            return 0
    if a.disable:
        if DEV.exists():
            DEV.unlink()
        print("disabled")
        return 0
    if not DEV.exists():
        print("Not enabled. Run: python tools/selftest.py --enable, then Reload the plugin.")
        return 2

    req = {
        "id": time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4],
        "tests": a.tests or DEFAULT_TESTS,
        "options": {"seconds": a.seconds, "inS": a.in_point, "captureSeconds": a.capture_seconds, "stopOnFail": not a.no_stop},
    }
    REQUEST.write_text(json.dumps(req, indent=2), encoding="utf-8")
    print("request %s: %s" % (req["id"], " ".join(req["tests"])))

    deadline = time.time() + a.timeout
    seen_running = False
    while time.time() < deadline:
        r = load_results()
        if r and r.get("id") == req["id"]:
            if r.get("status") == "done":
                return report(r)
            if not seen_running:
                print("running...")
                seen_running = True
        time.sleep(1)
    print("TIMEOUT after %.0fs: no results for %s." % (a.timeout, req["id"]))
    print("Is Premiere open with a sequence, the plugin loaded, and Test mode on? Check Debug in UXP Developer Tools for [StableAudio] lines.")
    return 3


if __name__ == "__main__":
    sys.exit(main())
