"""Discover or install ChatGit's pinned local toolchain (Node and mongod).

Downloads are pinned by version and SHA-256 so fresh orbs converge to the same
binaries. Nothing here starts a long-running process or prints credentials.

Usage:
  python3 scripts/chatgit_toolchain.py ensure   # install missing pinned tools
  python3 scripts/chatgit_toolchain.py status   # JSON summary, no downloads
"""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Optional, Tuple
import urllib.request


PROJECT = Path(__file__).resolve().parent.parent
APP = PROJECT / "app"

# Official nodejs.org tarballs for the version pinned in app/.nvmrc.
NODE_SHA256 = {
    ("linux", "x64"): "2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff",
    ("linux", "arm64"): "589f5b6dd4fcfee4dfda73013903c966abaa8abd93dbc9d436544e472b4f0e74",
    ("darwin", "x64"): "298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185",
    ("darwin", "arm64"): "39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6",
}
NODE_SHA256_VERSION = "24.16.0"

# MongoDB Community Server. Orbs are Debian 12 x86_64; elsewhere provide
# CHATGIT_MONGOD, a mongod on PATH, or an external MONGO_URI.
MONGOD_VERSION = "8.2.1"
MONGOD_DOWNLOADS = {
    ("linux", "x64"): (
        f"mongodb-linux-x86_64-debian12-{MONGOD_VERSION}",
        "547d8b1fc8a9344870cc3b916bac6c40e3206d43f9be56101903a9cb562556a9",
    ),
}


class ToolchainError(RuntimeError):
    pass


def pinned_node_version(project=PROJECT):
    root = (project / ".nvmrc").read_text().strip().lstrip("v")
    app_file = project / "app" / ".nvmrc"
    if app_file.is_file():
        upstream = app_file.read_text().strip().lstrip("v")
        if upstream != root:
            raise ToolchainError(f".nvmrc ({root}) 与上游 app/.nvmrc ({upstream}) 不一致。")
    return root


def host_platform():
    system = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system())
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower())
    if not system or not arch:
        raise ToolchainError(f"不支持的平台：{platform.system()} {platform.machine()}")
    return system, arch


def data_home():
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "chatgit"


def mongodb_cache():
    return Path(os.environ.get("CHATGIT_MONGODB_CACHE") or Path.home() / ".cache/mongodb-binaries")


def node_install_dir(version):
    system, arch = host_platform()
    return data_home() / "node" / f"node-v{version}-{system}-{arch}"


def probe_version(binary, args, pattern, timeout=5):
    try:
        output = subprocess.check_output(
            [str(binary), *args], text=True, timeout=timeout, stderr=subprocess.STDOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(pattern, output)
    return match.group(1) if match else None


def node_candidates(version):
    candidates = []
    if os.environ.get("CHATGIT_NODE"):
        candidates.append(Path(os.environ["CHATGIT_NODE"]))
    try:
        candidates.append(node_install_dir(version) / "bin/node")
    except ToolchainError:
        pass
    candidates.append(Path.home() / ".nvm/versions/node" / f"v{version}" / "bin/node")
    if os.environ.get("NVM_BIN"):
        candidates.append(Path(os.environ["NVM_BIN"]) / "node")
    found = shutil.which("node")
    if found:
        candidates.append(Path(found))
    return candidates


def find_node(version) -> Optional[Tuple[str, str]]:
    """Return the exact pinned Node; never silently fall back to another version."""
    for candidate in node_candidates(version):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            found = probe_version(candidate, ["-p", "process.versions.node"], r"^(\d+\.\d+\.\d+)\s*$")
            if found == version:
                return str(candidate), found
    return None


def mongod_candidates():
    candidates = []
    if os.environ.get("CHATGIT_MONGOD"):
        candidates.append(Path(os.environ["CHATGIT_MONGOD"]))
    try:
        download = MONGOD_DOWNLOADS.get(host_platform())
    except ToolchainError:
        download = None
    if download:
        candidates.append(mongodb_cache() / download[0] / "bin/mongod")
    # mongodb-memory-server's cache layout, if a compatible binary already exists.
    system, arch = host_platform()
    if system == "linux":
        candidates.append(mongodb_cache() / f"mongod-{arch}-debian-{MONGOD_VERSION}")
    found = shutil.which("mongod")
    if found:
        candidates.append(Path(found))
    return candidates


def find_mongod() -> Optional[Tuple[str, str]]:
    for candidate in mongod_candidates():
        if candidate.is_file() and os.access(candidate, os.X_OK):
            found = probe_version(candidate, ["--version"], r"db version v(\d+\.\d+\.\d+)")
            if found:
                return str(candidate), found
    return None


def download_verified(url, sha256, destination):
    digest = hashlib.sha256()
    request = urllib.request.Request(url, headers={"User-Agent": "chatgit-setup"})
    with urllib.request.urlopen(request, timeout=60) as response, open(destination, "wb") as out:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != sha256:
        raise ToolchainError(f"下载校验失败：{url}")


def safe_extract(archive, target, members=None):
    target = Path(target).resolve()
    with tarfile.open(archive, "r:*") as tar:
        selected = [m for m in tar.getmembers() if members is None or members(m)]
        if hasattr(tarfile, "data_filter"):
            # Rejects absolute/escaping paths and links (Python 3.8.17+/3.11.4+).
            tar.extractall(target, members=selected, filter="data")
            return
        for member in selected:
            resolved = (target / member.name).resolve()
            if target != resolved and target not in resolved.parents:
                raise ToolchainError(f"压缩包包含越界路径：{member.name}")
            if member.islnk() or (member.issym() and Path(member.linkname).is_absolute()):
                raise ToolchainError(f"压缩包包含不安全链接：{member.name}")
            if member.issym():
                link = (resolved.parent / member.linkname).resolve()
                if target not in link.parents:
                    raise ToolchainError(f"压缩包包含越界链接：{member.name}")
        tar.extractall(target, members=selected)


def install_node(version):
    if version != NODE_SHA256_VERSION:
        raise ToolchainError(f"脚本只固定了 Node {NODE_SHA256_VERSION} 的校验值，请同步更新。")
    system, arch = host_platform()
    sha = NODE_SHA256.get((system, arch))
    if not sha:
        raise ToolchainError(f"没有 {system}-{arch} 的 Node 校验值。")
    name = f"node-v{version}-{system}-{arch}"
    final = node_install_dir(version)
    final.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=final.parent) as scratch:
        archive = Path(scratch) / f"{name}.tar.gz"
        download_verified(f"https://nodejs.org/dist/v{version}/{name}.tar.gz", sha, archive)
        safe_extract(archive, scratch)
        if final.exists():
            shutil.rmtree(final)
        os.replace(Path(scratch) / name, final)
    return str(final / "bin/node")


def install_mongod():
    download = MONGOD_DOWNLOADS.get(host_platform())
    if not download:
        raise ToolchainError("此平台没有固定的 mongod 下载；请设置 CHATGIT_MONGOD、"
                             "把 mongod 放入 PATH，或在 .chatgit/local.env 配置 MONGO_URI。")
    name, sha = download
    final = mongodb_cache() / name
    final.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=final.parent) as scratch:
        archive = Path(scratch) / f"{name}.tgz"
        download_verified(f"https://fastdl.mongodb.org/linux/{name}.tgz", sha, archive)
        safe_extract(archive, scratch, lambda m: m.name in (name, f"{name}/bin", f"{name}/bin/mongod")
                     or m.name.startswith(f"{name}/LICENSE"))
        if final.exists():
            shutil.rmtree(final)
        os.replace(Path(scratch) / name, final)
    return str(final / "bin/mongod")


def status(project=PROJECT):
    version = pinned_node_version(project)
    node = find_node(version)
    mongod = find_mongod()
    return {
        "node_pinned": version,
        "node": node[0] if node else None,
        "mongod": mongod[0] if mongod else None,
        "mongod_version": mongod[1] if mongod else None,
        "mongod_pinned": MONGOD_VERSION,
    }


def ensure(project=PROJECT, need_mongod=True):
    version = pinned_node_version(project)
    if find_node(version):
        print(f"[toolchain] Node {version} 已就绪", flush=True)
    else:
        print(f"[toolchain] 安装 Node {version}（官方包，SHA-256 校验）", flush=True)
        install_node(version)
        if not find_node(version):
            raise ToolchainError(f"Node {version} 安装后仍无法运行。")
    if need_mongod:
        found = find_mongod()
        if found:
            print(f"[toolchain] mongod {found[1]} 已就绪", flush=True)
        else:
            print(f"[toolchain] 下载 mongod {MONGOD_VERSION}（官方包，SHA-256 校验）", flush=True)
            install_mongod()
            if not find_mongod():
                raise ToolchainError("mongod 安装后仍无法运行。")
    return status(project)


def main(args=None):
    args = sys.argv[1:] if args is None else args
    try:
        if args == ["ensure"]:
            ensure()
            return 0
        if args == ["status"]:
            print(json.dumps(status(), ensure_ascii=False))
            return 0
        print("用法：chatgit_toolchain.py ensure|status", file=sys.stderr)
        return 2
    except (OSError, ToolchainError) as error:
        print(f"[toolchain] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
