#!/usr/bin/env bash
set -euo pipefail

# Desktop supplies the display environment. Reuse its visible browser.
exec python3 - "$(dirname "$(dirname "$(realpath "$0")")")" <<'PY'
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

project = Path(sys.argv[1])
sys.path.insert(0, str(project / "scripts"))
from chatgit_open import LaunchError, read_origin, read_launch_key, request_ticket

if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
    sys.exit("Open this launcher through Amp's Desktop portal.")

browser = shutil.which("google-chrome")
if not browser:
    sys.exit("The orb's Desktop Chrome browser is missing.")

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open("http://127.0.0.1:9222/json/version", timeout=2):
        desktop_running = True
except OSError:
    desktop_running = False

directory = project / ".chatgit/local-preview"
try:
    origin = read_origin(directory)
    ticket = request_ticket(origin, read_launch_key(directory))
except LaunchError as error:
    sys.exit(str(error))

# The ticket stays in memory, is consumed once, and is stripped by the app.
url = f"{origin}/api/local/open#ticket={ticket}"
if desktop_running:
    try:
        result = subprocess.run([
            "agent-browser", "--session", "chatgit-desktop", "--cdp", "9222", "open", url,
        ], capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        sys.exit("Could not reach the Desktop browser. Reopen Desktop and try again.")
    if result.returncode:
        sys.exit("Could not open ChatGit in the Desktop browser. Reopen Desktop and try again.")
    sys.exit(0)

# If Desktop has not started Chrome yet, use its browser and profile, not a
# separate Chrome-for-Testing window that the portal may not display.
os.execv(browser, [
    browser,
    "--ozone-platform=wayland",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    f"--user-data-dir={Path.home() / '.config/google-chrome-amp'}",
    url,
])
PY
