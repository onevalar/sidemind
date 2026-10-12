import fcntl
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from next_safe import (BUILD_STEPS, HEAP_MIB, Limits, Step, group_snapshot, heap_override,
                       parse_dev_args, resource_problem, stop_group, supervise, supervise_steps)


class SafetyTests(unittest.TestCase):
    def test_interrupt_during_probe_is_clean_and_stops_owned_group(self):
        groups = []
        def interrupted_probe(pgid):
            groups.append(pgid)
            os.kill(os.getpid(), signal.SIGINT)
            raise subprocess.SubprocessError("probe interrupted")
        with tempfile.TemporaryDirectory() as directory:
            with patch("next_safe.group_snapshot", side_effect=interrupted_probe):
                code = supervise([sys.executable, "-c", "import time; time.sleep(30)"],
                                 Path(directory), Limits(free_bytes=0), 0.05)
        self.assertEqual(code, 130)
        self.assertEqual(len(groups), 1)
        self.assertEqual(group_snapshot(groups[0]), [])

    def test_limits(self):
        limits = Limits(processes=2, rss_kib=1000, free_bytes=100)
        self.assertIsNone(resource_problem([(1, 400), (2, 500)], 101, limits))
        self.assertIn("进程数", resource_problem([(1, 1), (2, 1), (3, 1)], 101, limits))
        self.assertIn("RSS", resource_problem([(1, 1001)], 101, limits))
        self.assertIn("磁盘", resource_problem([], 99, limits))

    def test_reject_duplicate_and_low_disk_without_starting(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            with open(project / ".next-safe.lock", "a+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(supervise(["/does-not-exist"], project), 2)
            limits = Limits(free_bytes=shutil_disk_free(project) + 1)
            self.assertEqual(supervise(["/does-not-exist"], project, limits), 2)

    def test_process_limit_stops_group_not_other_process(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        try:
            with tempfile.TemporaryDirectory() as directory:
                project = Path(directory)
                pid_file = project / "child.pid"
                code = (
                    "import subprocess,sys,time,pathlib; "
                    "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                    f"pathlib.Path({str(pid_file)!r}).write_text(str(p.pid)); "
                    "time.sleep(30)"
                )
                started = time.monotonic()
                self.assertEqual(supervise([sys.executable, "-c", code], project,
                                          Limits(processes=1, free_bytes=0), 0.05), 2)
                self.assertLess(time.monotonic() - started, 8)
                self.assertIsNone(unrelated.poll())
                # A killed child can briefly be a zombie until launchd/init reaps it.
                pid = int(pid_file.read_text())
                result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
                self.assertTrue(result.returncode != 0 or result.stdout.strip().startswith("Z"))
        finally:
            stop_group(unrelated)

    def test_monitor_group_contains_only_owned_processes(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        try:
            rows = group_snapshot(child.pid)
            self.assertEqual([pid for pid, _ in rows], [child.pid])
            self.assertNotIn(os.getpid(), [pid for pid, _ in rows])
        finally:
            stop_group(child)


class StepTests(unittest.TestCase):
    def step(self, code, label="step"):
        return Step(label, [sys.executable, "-c", code])

    def test_steps_run_in_order_and_stop_at_first_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            log = project / "order.txt"
            write = "import pathlib; f=pathlib.Path({!r}); f.write_text(f.read_text() + {!r} if f.exists() else {!r})"
            steps = [
                self.step(write.format(str(log), "a", "a")),
                self.step(write.format(str(log), "b", "b") + "; raise SystemExit(3)"),
                self.step(write.format(str(log), "c", "c")),
            ]
            self.assertEqual(supervise_steps(steps, project, Limits(free_bytes=0), 0.05), 3)
            self.assertEqual(log.read_text(), "ab")

    def test_lock_is_held_for_the_whole_sequence(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            probe = (
                "import fcntl,sys; f=open({!r},'a+')\n"
                "try:\n fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:\n sys.exit(0)\n"
                "sys.exit(9)"
            ).format(str(project / ".next-safe.lock"))
            self.assertEqual(supervise_steps([self.step(probe), self.step(probe)], project,
                                             Limits(free_bytes=0), 0.05), 0)

    def test_finished_step_leaves_no_background_process_behind(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            pid_file = project / "bg.pid"
            code = ("import subprocess,sys,pathlib; "
                    "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                    f"pathlib.Path({str(pid_file)!r}).write_text(str(p.pid))")
            self.assertEqual(supervise_steps([self.step(code)], project, Limits(free_bytes=0), 0.05), 0)
            pid = int(pid_file.read_text())
            result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            self.assertTrue(result.returncode != 0 or result.stdout.strip().startswith("Z"))

    def test_heap_bound_is_appended_last_and_step_env_applied(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            out = project / "env.txt"
            code = (f"import os,pathlib; pathlib.Path({str(out)!r}).write_text("
                    "os.environ['NODE_OPTIONS'] + '|' + os.environ['HUSKY'] + '|' + os.environ['PATH'].split(os.pathsep)[0])")
            step = Step("env", [sys.executable, "-c", code], env={"HUSKY": "0"})
            with patch.dict(os.environ, {"NODE_OPTIONS": "--max-old-space-size=8192"}):
                self.assertEqual(supervise_steps([step], project, Limits(free_bytes=0), 0.05,
                                                 path_dir=project), 0)
            options, husky, first_path = out.read_text().split("|")
            self.assertTrue(options.endswith(f"--max-old-space-size={HEAP_MIB}"))
            self.assertEqual(HEAP_MIB, 2048)
            self.assertEqual(husky, "0")
            self.assertEqual(first_path, str(project))

    def test_failed_step_log_tail_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            log = project / "build.log"
            log.write_text("first\nlast-line\n")
            step = Step("fail", [sys.executable, "-c", "raise SystemExit(1)"], log_file=log)
            with patch("sys.stderr", new_callable=io.StringIO) as err:
                self.assertEqual(supervise_steps([step], project, Limits(free_bytes=0), 0.05), 1)
            self.assertIn("last-line", err.getvalue())


class EntrypointTests(unittest.TestCase):
    def test_limits_are_not_raised(self):
        self.assertEqual(Limits(), Limits(32, 6 * 1024 * 1024, 10 * 1024**3))

    def test_dev_args(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PORT", None)
            self.assertEqual(parse_dev_args([]), 3080)
            self.assertEqual(parse_dev_args(["--port", "4000"]), 4000)
            self.assertEqual(parse_dev_args(["--port=4001"]), 4001)
            for bad in (["--port", "x"], ["--turbo"], ["--port", "70000"]):
                with self.assertRaises(RuntimeError):
                    parse_dev_args(bad)

    def test_build_is_sequential_and_uses_heap_respecting_client_script(self):
        self.assertEqual([label for label, _, _ in BUILD_STEPS],
                         ["data-provider", "data-schemas", "api", "client-package", "client", "web"])
        self.assertEqual(dict((label, script) for label, _, script in BUILD_STEPS)["client"], "build:file")
        self.assertTrue(heap_override("cross-env NODE_OPTIONS=--max-old-space-size=8192 vite build"))
        self.assertFalse(heap_override("cross-env NODE_ENV=production vite build --debug"))


def shutil_disk_free(project):
    import shutil
    return shutil.disk_usage(project).free


if __name__ == "__main__":
    unittest.main()
