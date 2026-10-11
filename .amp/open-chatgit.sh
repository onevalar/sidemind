#!/usr/bin/env bash
set -euo pipefail

# Desktop supplies the display environment. Keep the browser in the foreground.
exec python3 - "$(dirname "$(dirname "$(realpath "$0")")")" <<'PY'
import os
import sys
from pathlib import Path

project = Path(sys.argv[1])
sys.path.insert(0, str(project / "scripts"))
from chatgit_open import LaunchError, read_origin, read_launch_key, request_ticket

if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
    sys.exit("Open this launcher through Amp's Desktop portal.")

browsers = sorted((Path.home() / ".agent-browser/browsers").glob("chrome-*/chrome"))
if not browsers:
    sys.exit("The orb's Chrome browser is missing. Run agent-browser install first.")

directory = project / ".chatgit/local-preview"
try:
    origin = read_origin(directory)
    ticket = request_ticket(origin, read_launch_key(directory))
except LaunchError as error:
    sys.exit(str(error))

# The ticket stays in memory, is consumed once, and is stripped by the app.
os.execv(str(browsers[-1]), [
    str(browsers[-1]),
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    f"--user-data-dir={directory / 'browser'}",
    f"--app={origin}/api/local/open#ticket={ticket}",
])
PY
