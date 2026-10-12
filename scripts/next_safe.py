"""Bound ChatGit local install/build/runtime resources on macOS and Linux.

The October 7 incident spawned over 1,200 Node processes. Every heavy task
runs through npm scripts so an independent supervisor owns a fresh process
group per step, samples it, and stops the entire group on exit or when a limit
is crossed. One project-wide lock keeps install, build and dev mutually
exclusive. (The original Next.js-only copy lives in legacy/chatgit/scripts/.)

  python3 scripts/next_safe.py --check            # npm run check:safety
  python3 scripts/next_safe.py install [--force]  # npm run setup:app (npm ci)
  python3 scripts/next_safe.py build              # npm run build
  python3 scripts/next_safe.py dev [--port N]     # npm run dev -- --port N
"""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence


PROJECT = Path(__file__).resolve().parent.parent
APP = PROJECT / "app"
HEAP_MIB = 2048
INSTALL_STAMP = "node_modules/.chatgit-install.json"


@dataclass(frozen=True)
class Limits:
    processes: int = 32
    rss_kib: int = 6 * 1024 * 1024
    free_bytes: int = 10 * 1024**3


@dataclass(frozen=True)
class Step:
    """One command run in its own process group under the shared lock."""
    label: str
    command: Sequence[str]
    cwd: Optional[Path] = None
    env: Optional[Mapping[str, str]] = None
    log_file: Optional[Path] = None


# Sequential, never turbo/parallel: each package build is a separate group.
BUILD_STEPS = (
    ("data-provider", "packages/data-provider", "build"),
    ("data-schemas", "packages/data-schemas", "build"),
    ("api", "packages/api", "build"),
    ("client-package", "packages/client", "build"),
    # build:file keeps the supervisor heap bound; `build` forces 8 GiB.
    ("client", "client", "build:file"),
    # ChatGit canvas UI (React 19 + Arc): one esbuild process, separate package and lock.
    ("web", "web", "build"),
)
BUILD_OUTPUTS = (
    "packages/data-provider/dist",
    "packages/data-schemas/dist",
    "packages/api/dist",
    "packages/client/dist",
    "client/dist/index.html",
    "web/dist/index.html",
)
# Packages installed with `npm ci`, each with its own lock and stamp (relative to app/).
INSTALL_DIRS = (".", "web")


def node_runtime():
    """Use the exact pinned Node (app/.nvmrc), never silently Node 26 or 22."""
    import chatgit_toolchain as toolchain
    version = toolchain.pinned_node_version(PROJECT)
    found = toolchain.find_node(version)
    if not found:
        raise RuntimeError(f"需要 Node {version}；请先运行 .agents/setup（或 nvm install）。")
    return found


def npm_command(node):
    cli = Path(node).resolve().parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
    if not cli.is_file():
        raise RuntimeError(f"找不到与 {node} 配套的 npm。")
    return [node, str(cli)]


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


def step_env(step, path_dir):
    env = os.environ.copy()
    env.update(step.env or {})
    env["PATH"] = str(path_dir) + os.pathsep + env.get("PATH", "")
    # This is a per-process JS heap bound, not a substitute for group RSS.
    # Appended last so it wins over any inherited --max-old-space-size.
    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + f" --max-old-space-size={HEAP_MIB}").strip()
    env["npm_config_update_notifier"] = "false"
    env["npm_config_fund"] = "false"
    env["npm_config_audit"] = "false"
    return env


def tail(path, lines=40):
    try:
        content = Path(path).read_text(errors="replace").splitlines()
    except OSError:
        return
    print(f"[next-safe] {path} 最后 {min(lines, len(content))} 行：", file=sys.stderr)
    for line in content[-lines:]:
        print(f"  {line}", file=sys.stderr)


def supervise_steps(steps, project=PROJECT, limits=Limits(), sample_interval=0.5, path_dir=None):
    """Run steps one at a time; stop at the first failure, signal or breach."""
    lock = open(project / ".next-safe.lock", "a+")
    old_handlers = {}
    requested_signal = []
    parent_pid = os.getppid()
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("[next-safe] 已有安装/开发/构建任务在运行，请先停止它。", file=sys.stderr)
            return 2
        problem = resource_problem([], shutil.disk_usage(project).free, limits)
        if problem:
            print(f"[next-safe] 拒绝启动：{problem}", file=sys.stderr)
            return 2
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            old_handlers[sig] = signal.signal(sig, lambda number, _frame: requested_signal.append(number))
        for index, step in enumerate(steps, 1):
            if len(steps) > 1:
                print(f"[next-safe] 步骤 {index}/{len(steps)}：{step.label}", flush=True)
            code = _run_step(step, project, limits, sample_interval, path_dir,
                             requested_signal, parent_pid)
            if code != 0:
                if step.log_file and not requested_signal:
                    tail(step.log_file)
                return code
        return 0
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        lock.close()


def _run_step(step, project, limits, sample_interval, path_dir, requested_signal, parent_pid):
    child = None
    try:
        if requested_signal:
            return 128 + requested_signal[0]
        env = step_env(step, path_dir or Path(step.command[0]).parent)
        child = subprocess.Popen(list(step.command), cwd=step.cwd or project, env=env,
                                 start_new_session=True)
        print(f"[next-safe] PGID={child.pid}; 上限 {limits.processes} 个进程 / "
              f"{limits.rss_kib / 1024**2:g} GiB RSS；磁盘保护线 "
              f"{limits.free_bytes / 1024**3:g} GiB；Node 堆 {HEAP_MIB} MiB", flush=True)
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
        print(f"[next-safe] 监测失败，停止本次任务：{error}", file=sys.stderr)
        return 2
    finally:
        # Also reaps stragglers (e.g. esbuild services) after a normal exit.
        if child is not None:
            stop_group(child)


def supervise(command, project=PROJECT, limits=Limits(), sample_interval=0.5):
    return supervise_steps([Step("command", list(command))], project, limits, sample_interval)


def lock_digest(node_version, directory="."):
    digest = hashlib.sha256((APP / directory / "package-lock.json").read_bytes()).hexdigest()
    return {"package_lock_sha256": digest, "node": node_version}


def package_current(node_version, directory="."):
    try:
        stamp = json.loads((APP / directory / INSTALL_STAMP).read_text())
    except (OSError, ValueError):
        return False
    return stamp == lock_digest(node_version, directory)


def install_current(node_version):
    return all(package_current(node_version, directory) for directory in INSTALL_DIRS)


def heap_override(script):
    return "max-old-space-size" in (script or "")


def parse_dev_args(args):
    port = os.environ.get("PORT") or "3080"
    rest = list(args)
    while rest:
        arg = rest.pop(0)
        if arg == "--port" and rest:
            port = rest.pop(0)
        elif arg.startswith("--port="):
            port = arg.split("=", 1)[1]
        else:
            raise RuntimeError(f"dev 不支持参数 {arg}；用法：npm run dev -- --port <端口>")
    if not port.isdigit() or not 0 < int(port) < 65536:
        raise RuntimeError(f"无效端口：{port}")
    return int(port)


def check(node, version):
    import chatgit_toolchain as toolchain
    free = shutil.disk_usage(PROJECT).free
    mongod = toolchain.find_mongod()
    report = {
        "node": node, "version": version, "app": str(APP),
        "max_processes": Limits.processes, "max_rss_gib": Limits.rss_kib / 1024**2,
        "min_free_gib": Limits.free_bytes / 1024**3, "node_heap_mib": HEAP_MIB,
        "free_gib": round(free / 1024**3, 1),
        "deps_installed": install_current(version),
        "build_outputs_present": all((APP / item).exists() for item in BUILD_OUTPUTS),
        "mongod": mongod[0] if mongod else None,
        "state_dir_exists": (PROJECT / ".chatgit").is_dir(),
    }
    print(json.dumps(report, ensure_ascii=False), flush=True)
    if resource_problem([], free):
        return 2
    if not report["deps_installed"]:
        print("[next-safe] app 依赖未安装或与 package-lock.json 不一致：运行 .agents/setup 或 npm run setup:app。",
              file=sys.stderr)
        return 2
    return 0


def install(node, version, force=False):
    stale = [d for d in INSTALL_DIRS if force or not package_current(version, d)]
    if not stale:
        print("[next-safe] app 与 app/web 依赖已与 package-lock.json 一致，跳过 npm ci。", flush=True)
        return 0
    steps = []
    for directory in stale:
        stamp = APP / directory / INSTALL_STAMP
        if stamp.exists():
            stamp.unlink()
        label = "npm ci" if directory == "." else f"npm ci ({directory})"
        steps.append(Step(label, [*npm_command(node), "ci", "--no-audit", "--no-fund"], APP / directory,
                          {"HUSKY": "0"}))
    code = supervise_steps(steps, path_dir=Path(node).parent)
    if code == 0:
        for directory in stale:
            (APP / directory / INSTALL_STAMP).write_text(json.dumps(lock_digest(version, directory)))
    return code


def build(node, version):
    if not install_current(version):
        raise RuntimeError("app 依赖未安装或已过期：先运行 .agents/setup 或 npm run setup:app。")
    npm = npm_command(node)
    steps = []
    for label, directory, script in BUILD_STEPS:
        scripts = json.loads((APP / directory / "package.json").read_text()).get("scripts", {})
        if script not in scripts:
            raise RuntimeError(f"{directory} 缺少 {script} 脚本")
        if heap_override(scripts[script]):
            raise RuntimeError(f"{directory} 的 {script} 会覆盖 Node 堆上限，拒绝运行。")
        log = APP / "client/vite-output.log" if script == "build:file" else None
        steps.append(Step(label, [*npm, "run", script], APP / directory, log_file=log))
    print("[next-safe] client 构建日志写入 app/client/vite-output.log", flush=True)
    return supervise_steps(steps, path_dir=Path(node).parent)


def dev(node, args):
    import chatgit_toolchain as toolchain
    port = parse_dev_args(args)
    missing = [item for item in BUILD_OUTPUTS if not (APP / item).exists()]
    if missing:
        raise RuntimeError(f"缺少构建产物 {', '.join(missing)}；先运行 npm run build。")
    mongod = toolchain.find_mongod()
    command = [sys.executable, str(PROJECT / "scripts/chatgit_runtime.py"),
               "--port", str(port), "--node", node, "--mongod", mongod[0] if mongod else ""]
    return supervise_steps([Step("runtime", command, PROJECT)], path_dir=Path(node).parent)


def main(args=None):
    args = sys.argv[1:] if args is None else args
    try:
        node, version = node_runtime()
        if not (APP / "package.json").is_file():
            raise RuntimeError("缺少 app/（LibreChat 源码）。")
        if args == ["--check"]:
            return check(node, version)
        if args and args[0] == "install" and set(args[1:]) <= {"--force"}:
            return install(node, version, force="--force" in args[1:])
        if args == ["build"]:
            print(f"[next-safe] 使用 Node {version}；按顺序构建 {len(BUILD_STEPS)} 个步骤", flush=True)
            return build(node, version)
        if args and args[0] == "dev":
            print(f"[next-safe] 使用 Node {version}；Express 服务已构建的前端", flush=True)
            return dev(node, args[1:])
        raise RuntimeError("用法：next_safe.py --check | install [--force] | build | dev [--port N]")
    except (OSError, RuntimeError, ValueError) as error:
        print(f"[next-safe] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
