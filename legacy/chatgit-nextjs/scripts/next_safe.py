"""Bound local Next.js development/build resources on macOS and Linux.

The October 7 incident spawned over 1,200 Node processes. Run through npm
scripts so an independent supervisor can stop the entire owned process group.
"""

import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass


PROJECT = Path(__file__).resolve().parent.parent
MIN_NODE = (22, 23, 1)


@dataclass(frozen=True)
class Limits:
    processes: int = 32
    rss_kib: int = 6 * 1024 * 1024
    free_bytes: int = 10 * 1024**3


def node_runtime():
    """Use the pinned installed LTS, never silently select Node 26 or old 22."""
    pinned = (PROJECT / ".nvmrc").read_text().strip()
    candidates = [Path.home() / ".nvm/versions/node" / f"v{pinned}" / "bin/node"]
    if os.environ.get("NVM_BIN"):
        candidates.append(Path(os.environ["NVM_BIN"]) / "node")
    found = shutil.which("node")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            version = subprocess.check_output(
                [str(candidate), "-p", "process.versions.node"],
                text=True, timeout=3, stderr=subprocess.DEVNULL,
            ).strip()
            parsed = tuple(int(x) for x in version.split("."))
            if parsed[0] == 22 and parsed >= MIN_NODE:
                return str(candidate), version
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    raise RuntimeError(f"需要 Node {pinned} LTS；请先运行 nvm install && nvm use。")


def group_snapshot(pgid):
    # Read numeric fields only: no command arguments, credentials or user data.
    output = subprocess.check_output(
        ["ps", "-axo", "pid=,pgid=,rss="], text=True, timeout=3,
    )
    rows = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) == 3 and int(fields[1]) == pgid:
            rows.append((int(fields[0]), int(fields[2])))
    return rows


def resource_problem(rows, free_bytes, limits=Limits()):
    if len(rows) > limits.processes:
        return f"进程数 {len(rows)} 超过上限 {limits.processes}"
    rss = sum(kib for _, kib in rows)
    if rss > limits.rss_kib:
        return f"进程组 RSS {rss / 1024:.0f} MB 超过上限 {limits.rss_kib / 1024:.0f} MB"
    if free_bytes < limits.free_bytes:
        return f"磁盘只剩 {free_bytes / 1024**3:.1f} GiB，低于保护线 {limits.free_bytes / 1024**3:.0f} GiB"
    return None


def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


def stop_group(child):
    """Target only the new session created for this particular invocation."""
    signal_group(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    # The leader may exit before its workers; still clean up the owned group.
    signal_group(child.pid, signal.SIGKILL)
    child.wait(timeout=3)


def supervise(command, project=PROJECT, limits=Limits(), sample_interval=0.5):
    lock = open(project / ".next-safe.lock", "a+")
    child = None
    old_handlers = {}
    requested_signal = []
    parent_pid = os.getppid()
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("[next-safe] 已有开发/构建任务在运行，请先停止它。", file=sys.stderr)
            return 2
        problem = resource_problem([], shutil.disk_usage(project).free, limits)
        if problem:
            print(f"[next-safe] 拒绝启动：{problem}", file=sys.stderr)
            return 2
        env = os.environ.copy()
        env["PATH"] = str(Path(command[0]).parent) + os.pathsep + env.get("PATH", "")
        # This is a per-process JS heap bound, not a substitute for group RSS.
        env["NODE_OPTIONS"] = env.get("NODE_OPTIONS", "") + " --max-old-space-size=2048"
        env["NEXT_TELEMETRY_DISABLED"] = "1"
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            old_handlers[sig] = signal.signal(sig, lambda number, _frame: requested_signal.append(number))
        child = subprocess.Popen(command, cwd=project, env=env, start_new_session=True)
        print(f"[next-safe] PGID={child.pid}; 上限 {limits.processes} 个进程 / "
              f"{limits.rss_kib / 1024**2:g} GiB RSS；磁盘保护线 "
              f"{limits.free_bytes / 1024**3:g} GiB", flush=True)
        while True:
            if requested_signal:
                return 128 + requested_signal[0]
            if os.getppid() != parent_pid:
                print("[next-safe] 启动终端已退出，清理本次服务。", file=sys.stderr)
                return 2
            code = child.poll()
            if code is not None:
                return code if code >= 0 else 128 - code
            problem = resource_problem(
                group_snapshot(child.pid), shutil.disk_usage(project).free, limits,
            )
            if problem:
                print(f"[next-safe] 已触发保护，停止本次进程组：{problem}", file=sys.stderr)
                return 2
            time.sleep(sample_interval)
    except (OSError, subprocess.SubprocessError) as error:
        if requested_signal:
            return 128 + requested_signal[0]
        print(f"[next-safe] 监测失败，停止本次服务：{error}", file=sys.stderr)
        return 2
    finally:
        if child is not None:
            stop_group(child)
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        lock.close()


def main(args=None):
    args = sys.argv[1:] if args is None else args
    try:
        node, version = node_runtime()
        cli = PROJECT / "node_modules/next/dist/bin/next"
        if not cli.is_file():
            raise RuntimeError("缺少 Next.js 依赖，请先运行 npm ci。")
        if args == ["--check"]:
            free = shutil.disk_usage(PROJECT).free
            print(json.dumps({"node": node, "version": version, "bundler": "webpack",
                              "max_processes": 32, "max_rss_gib": 6, "min_free_gib": 10,
                              "free_gib": round(free / 1024**3, 1)}, ensure_ascii=False))
            return 2 if resource_problem([], free) else 0
        if not args or args[0] not in ("dev", "build"):
            raise RuntimeError("用法：next_safe.py dev|build [Next 参数]，或 --check")
        if any(arg.split("=", 1)[0] in ("--turbo", "--turbopack") for arg in args[1:]):
            raise RuntimeError("本项目已停用 Turbopack，以避免编译子进程失控。")
        command = [node, str(cli), args[0], "--webpack", *args[1:]]
        print(f"[next-safe] 使用 Node {version} / Webpack", flush=True)
        return supervise(command)
    except (OSError, RuntimeError) as error:
        print(f"[next-safe] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
