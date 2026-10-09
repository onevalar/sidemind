from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import chatgit_open as launcher
import chatgit_runtime as runtime


TICKET = "T" * 43


class FakeLaunchServer:
    """Stands in for POST /api/local/launch and records what the launcher sent."""

    def __init__(self, status=200, body=None, redirect=None):
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                outer.requests.append({"path": self.path, "headers": dict(self.headers),
                                       "body": self.rfile.read(length)})
                if redirect:
                    self.send_response(307)
                    self.send_header("Location", redirect)
                    self.end_headers()
                    return
                payload = json.dumps(body if body is not None else {"ticket": TICKET, "expiresIn": 60})
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload.encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        self.state = self.project / ".chatgit"
        with patch("sys.stdout", new_callable=io.StringIO):
            key_path, _ = runtime.ensure_launch_key(self.state)
        self.key = key_path.read_text().strip()
        self.opened = []
        env = patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9"})
        env.start()
        os.environ.pop("CHATGIT_STATE_DIR", None)
        self.addCleanup(env.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def write_origin(self, origin):
        runtime.write_runtime_metadata(self.state, origin)

    def run_launcher(self, opener=None):
        def record(url):
            self.opened.append(url)
            return True
        with patch("sys.stdout", new_callable=io.StringIO) as out, \
                patch("sys.stderr", new_callable=io.StringIO) as err:
            code = launcher.open_chatgit(self.project, opener=opener or record)
        return code, out.getvalue() + err.getvalue()

    def test_requests_a_ticket_directly_and_opens_it_in_a_fragment_without_printing(self):
        with FakeLaunchServer() as server:
            self.write_origin(server.origin)
            code, output = self.run_launcher()
        self.assertEqual(code, 0)
        self.assertEqual(self.opened, [f"{server.origin}/api/local/open#ticket={TICKET}"])
        sent = server.requests[0]
        self.assertEqual(sent["path"], "/api/local/launch")
        self.assertEqual(sent["headers"]["Authorization"], f"Bearer {self.key}")
        self.assertEqual(sent["headers"]["Host"], server.origin.removeprefix("http://"))
        for header in ("Origin", "Cookie", "Referer", "X-Forwarded-For"):
            self.assertNotIn(header, sent["headers"])
        self.assertNotIn(TICKET, output)
        self.assertNotIn(self.key, output)

    def test_can_be_run_again_later_for_a_fresh_ticket(self):
        with FakeLaunchServer() as server:
            self.write_origin(server.origin)
            self.assertEqual(self.run_launcher()[0], 0)
            self.assertEqual(self.run_launcher()[0], 0)
        self.assertEqual(len(server.requests), 2)

    def test_not_running_fails_without_opening(self):
        code, output = self.run_launcher()
        self.assertEqual(code, 2)
        self.assertIn("npm run dev", output)
        self.assertEqual(self.opened, [])

    def test_refuses_a_non_loopback_origin_without_sending_the_key(self):
        for origin in ("http://localhost:3080", "http://evil.example:3080", "https://127.0.0.1:3080",
                       "http://127.0.0.1:3080/x", "http://127.0.0.1:80"):
            with self.subTest(origin=origin), FakeLaunchServer() as server:
                self.write_origin(origin)
                code, _ = self.run_launcher()
                self.assertEqual(code, 2)
                self.assertEqual(server.requests, [])
        self.assertEqual(self.opened, [])

    def test_refuses_a_key_readable_by_others(self):
        (self.state / "launch.key").chmod(0o640)
        with FakeLaunchServer() as server:
            self.write_origin(server.origin)
            code, output = self.run_launcher()
        self.assertEqual(code, 2)
        self.assertEqual(server.requests, [])
        self.assertNotIn(self.key, output)

    def test_maps_refusal_codes_and_never_opens(self):
        for status, server_code, expected in (
                (409, "LOCAL_DATABASE_HAS_ACCOUNTS", "CHATGIT_LOCAL_MODE=false"),
                (401, "LOCAL_LAUNCH_KEY_INVALID", "启动密钥"),
                (404, "LOCAL_MODE_DISABLED", "CHATGIT_LOCAL_MODE=false")):
            with self.subTest(code=server_code), FakeLaunchServer(status, {"code": server_code}) as server:
                self.write_origin(server.origin)
                code, output = self.run_launcher()
                self.assertEqual(code, 2)
                self.assertIn(expected, output)
        self.assertEqual(self.opened, [])

    def test_does_not_follow_a_redirect_with_the_key(self):
        with FakeLaunchServer() as target:
            with FakeLaunchServer(redirect=f"{target.origin}/steal") as server:
                self.write_origin(server.origin)
                code, _ = self.run_launcher()
        self.assertEqual(code, 2)
        self.assertEqual(target.requests, [])
        self.assertEqual(self.opened, [])

    def test_rejects_a_malformed_ticket(self):
        with FakeLaunchServer(body={"ticket": "short"}) as server:
            self.write_origin(server.origin)
            code, _ = self.run_launcher()
        self.assertEqual(code, 2)
        self.assertEqual(self.opened, [])

    def test_fails_closed_without_a_browser_and_does_not_show_the_link(self):
        with FakeLaunchServer() as server:
            self.write_origin(server.origin)
            code, output = self.run_launcher(opener=lambda _url: False)
        self.assertEqual(code, 2)
        self.assertNotIn(TICKET, output)
        self.assertNotIn("#ticket", output)

    def test_headless_linux_has_no_browser(self):
        with patch.object(launcher.sys, "platform", "linux"), \
                patch.dict(os.environ, {}, clear=False), \
                patch("subprocess.Popen") as popen:
            os.environ.pop("DISPLAY", None)
            os.environ.pop("WAYLAND_DISPLAY", None)
            self.assertFalse(launcher.open_in_browser("http://127.0.0.1:1/api/local/open#ticket=x"))
        popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
