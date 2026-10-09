"""Open the running local ChatGit in this device's browser (`npm run open`).

Contract (see scripts/chatgit_runtime.py for the runtime side):
  1. Read the origin from .chatgit/runtime.json (no secret; must be
     http://127.0.0.1:<port>) and the key from .chatgit/launch.key (must be a
     regular, owner-only file).
  2. POST <origin>/api/local/launch with `Authorization: Bearer <key>`, directly
     (no proxy, no redirects). The loopback-only endpoint creates the single
     local owner on an empty database and returns a 60-second single-use ticket.
  3. Open <origin>/api/local/open#ticket=<ticket> in the default browser. The
     fragment never reaches the server; the bootstrap page strips it, exchanges
     the ticket for the normal session cookie and continues to /c/new.
The key and the ticket are never printed. Without a graphical browser this
fails closed instead of showing the link.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request


PROJECT = Path(__file__).resolve().parent.parent
ORIGIN_RE = re.compile(r"^http://127\.0\.0\.1:(\d{1,5})$")
TICKET_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{32,}$")

MESSAGES = {
    "LOCAL_DATABASE_HAS_ACCOUNTS": (
        "本地数据库里已经有账号，免账号模式不会接管或修改它们。继续使用这些账号请用 "
        "CHATGIT_LOCAL_MODE=false 启动；要新的本地空间请把 CHATGIT_STATE_DIR 指向一个新目录。"),
    "LOCAL_OWNER_MISSING": "绑定的本地所有者已不存在，而数据库里还有其他账号；已拒绝打开。",
    "LOCAL_OWNER_BINDING_INVALID": "本地所有者绑定文件（local-owner.json）无法读取或已损坏。",
    "LOCAL_LAUNCH_KEY_INVALID": "启动密钥与正在运行的 ChatGit 不一致；确认运行的是本目录的 npm run dev。",
    "LOCAL_LAUNCH_KEY_UNAVAILABLE": "服务读不到私有启动密钥（缺失或权限过宽）；重启 npm run dev。",
    "LOCAL_MODE_DISABLED": "正在运行的 ChatGit 不是本地免账号模式（CHATGIT_LOCAL_MODE=false）。",
    "LOCAL_MODE_MISCONFIGURED": "本地模式配置不一致，服务已保持关闭；查看 npm run dev 的日志。",
    "LOCAL_ACCESS_DENIED": "请求被拒绝：只能在本机直接访问 127.0.0.1。",
}


class LaunchError(Exception):
    pass


def state_dir(project=PROJECT):
    return Path(os.environ.get("CHATGIT_STATE_DIR") or Path(project) / ".chatgit")


def read_origin(directory):
    path = Path(directory) / "runtime.json"
    try:
        origin = json.loads(path.read_text()).get("origin", "")
    except FileNotFoundError:
        raise LaunchError("ChatGit 没有在本地模式运行：先在本目录运行 npm run dev。")
    except (OSError, ValueError, AttributeError):
        raise LaunchError(f"{path} 无法读取。")
    match = ORIGIN_RE.match(origin if isinstance(origin, str) else "")
    if not match or not 0 < int(match.group(1)) < 65536 or int(match.group(1)) == 80:
        raise LaunchError(f"{path} 中的地址不是 http://127.0.0.1:<端口>，拒绝使用。")
    return origin


def read_launch_key(directory):
    path = Path(directory) / "launch.key"
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise LaunchError("缺少启动密钥：先运行 npm run dev（本地模式会生成它）。")
    if not path.is_file() or path.is_symlink():
        raise LaunchError(f"{path} 不是普通文件，拒绝使用。")
    if os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
        raise LaunchError(f"{path} 必须只属于当前用户且权限为 600，拒绝使用。")
    key = path.read_text().strip()
    if not KEY_RE.match(key):
        raise LaunchError(f"{path} 内容无效。")
    return key


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request_ticket(origin, key, timeout=10.0):
    """Ask the loopback-only endpoint for a ticket; never through a proxy or a redirect."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    request = urllib.request.Request(
        f"{origin}/api/local/launch", data=b"{}", method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "Accept": "application/json"})
    try:
        with opener.open(request, timeout=timeout) as response:
            body = json.loads(response.read(4096).decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            code = json.loads(error.read(4096).decode("utf-8")).get("code", "")
        except (ValueError, AttributeError, UnicodeDecodeError):
            code = ""
        raise LaunchError(MESSAGES.get(code, f"ChatGit 拒绝了打开请求（HTTP {error.code}）。"))
    except (urllib.error.URLError, OSError):
        raise LaunchError(f"连不上 {origin}：ChatGit 可能尚未启动完成或已停止，确认 npm run dev 正在运行。")
    except ValueError:
        raise LaunchError("ChatGit 返回了无法识别的响应。")
    ticket = body.get("ticket") if isinstance(body, dict) else None
    if not isinstance(ticket, str) or not TICKET_RE.match(ticket):
        raise LaunchError("ChatGit 返回了无法识别的响应。")
    return ticket


def open_in_browser(url):
    """Hand the URL to the desktop's browser without echoing it; False when none is available."""
    quiet = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if sys.platform == "win32":
        os.startfile(url)  # noqa: S606 - the default handler for http URLs
        return True
    if sys.platform == "darwin":
        command = ["open", url]
    else:
        if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            return False
        opener = shutil.which("xdg-open")
        if not opener:
            return False
        command = [opener, url]
    process = subprocess.Popen(command, start_new_session=True, **quiet)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        code = process.poll()
        if code is not None:
            return code == 0
        time.sleep(0.1)
    return True


def open_chatgit(project=PROJECT, opener=open_in_browser):
    directory = state_dir(project)
    try:
        origin = read_origin(directory)
        key = read_launch_key(directory)
        ticket = request_ticket(origin, key)
    except LaunchError as error:
        print(f"[open] {error}", file=sys.stderr)
        return 2
    if not opener(f"{origin}/api/local/open#ticket={ticket}"):
        print("[open] 这台设备上没有可用的图形浏览器，已放弃（不会显示一次性链接）。"
              "请在装有浏览器的本机上运行 npm run open。", file=sys.stderr)
        return 2
    print(f"[open] 已在浏览器中打开 ChatGit（{origin}）。一次性入口 60 秒内有效；"
          "以后随时可再次运行 npm run open。", flush=True)
    return 0


def main(args=None):
    parser = argparse.ArgumentParser(description="Open the local ChatGit in this device's browser")
    parser.add_argument("--project", default=str(PROJECT))
    options = parser.parse_args(args)
    return open_chatgit(Path(options.project))


if __name__ == "__main__":
    sys.exit(main())
