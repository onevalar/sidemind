import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from next_safe import Limits, group_snapshot, resource_problem, stop_group, supervise


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


def shutil_disk_free(project):
    import shutil
    return shutil.disk_usage(project).free


if __name__ == "__main__":
    unittest.main()
