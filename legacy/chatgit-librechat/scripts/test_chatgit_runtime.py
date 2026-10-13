import io
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch

import chatgit_runtime as runtime
import chatgit_toolchain as toolchain


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def make_project(root):
    (root / "app" / "api/server").mkdir(parents=True)
    (root / "app" / "chatgit.yaml").write_text("version: 1.3.17\n")
    return root


PREVIEW = {"CHATGIT_LOCAL_MODE": "false"}


def executable(path, body):
    path.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    path.chmod(0o755)
    return path


class EnvTests(unittest.TestCase):
    def test_env_file_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.env"
            path.write_text("# c\nexport A=1\nB='two words'\nC=\"q\"\n\nD=a=b\n")
            self.assertEqual(runtime.parse_env_file(path), {"A": "1", "B": "two words", "C": "q", "D": "a=b"})
            path.write_text("not valid\n")
            with self.assertRaises(ValueError):
                runtime.parse_env_file(path)

    def test_secrets_are_private_stable_and_never_printed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / ".chatgit"
            with patch("sys.stdout", new_callable=io.StringIO) as out:
                path, missing = runtime.ensure_secrets(state)
            self.assertEqual(sorted(missing), sorted(runtime.SECRET_SPECS))
            first = runtime.parse_env_file(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(len(first["CREDS_KEY"]), 64)
            self.assertEqual(len(first["CREDS_IV"]), 32)
            for value in first.values():
                self.assertNotIn(value, out.getvalue())
            _, missing_again = runtime.ensure_secrets(state)
            self.assertEqual(missing_again, [])
            self.assertEqual(runtime.parse_env_file(path), first)
            # A missing key is added without rotating the others.
            lines = [l for l in path.read_text().splitlines() if not l.startswith("JWT_SECRET=")]
            path.write_text("\n".join(lines) + "\n")
            _, added = runtime.ensure_secrets(state)
            self.assertEqual(added, ["JWT_SECRET"])
            after = runtime.parse_env_file(path)
            self.assertEqual(after["CREDS_KEY"], first["CREDS_KEY"])
            self.assertNotEqual(after["JWT_SECRET"], "")

    def test_preview_mode_layering_defaults_local_env_process_and_port(self):
        with tempfile.TemporaryDirectory() as directory:
            project = make_project(Path(directory))
            state = project / ".chatgit"
            runtime.ensure_secrets(state)
            env, mongo_port = runtime.compose_env(dict(PREVIEW), 4100, project, state)
            self.assertEqual(env["CHATGIT_LOCAL_MODE"], "false")
            self.assertEqual(env["ALLOW_REGISTRATION"], "true")
            self.assertEqual(env["ALLOW_EMAIL_LOGIN"], "true")
            for key in runtime.LOCAL_RUNTIME_KEYS:
                self.assertNotIn(key, env)
            self.assertEqual(env["APP_TITLE"], "ChatGit")
            self.assertEqual(env["NODE_ENV"], "production")
            self.assertEqual(env["PORT"], "4100")
            self.assertEqual(env["DOMAIN_SERVER"], "http://localhost:4100")
            self.assertEqual(env["CONFIG_PATH"], str(project / "app/chatgit.yaml"))
            self.assertEqual(env["ENDPOINTS"], "agents")
            self.assertEqual(mongo_port, runtime.DEFAULT_MONGO_PORT)
            self.assertEqual(env["MONGO_URI"], f"mongodb://127.0.0.1:{mongo_port}/ChatGit")

            fixture = state / "fixture.yaml"
            fixture.write_text("version: 1.3.17\n")
            (state / "local.env").write_text(f"CONFIG_PATH={fixture}\nALLOW_REGISTRATION=false\nCHATGIT_MONGO_PORT=27999\n")
            env, mongo_port = runtime.compose_env({**PREVIEW, "ALLOW_REGISTRATION": "true", "PORT": "1"},
                                                  4101, project, state)
            self.assertEqual(env["CONFIG_PATH"], str(fixture))
            self.assertEqual(env["ALLOW_REGISTRATION"], "true")  # process env wins
            self.assertEqual(env["PORT"], "4101")                 # --port wins
            self.assertEqual(mongo_port, 27999)

            env, mongo_port = runtime.compose_env({**PREVIEW, "MONGO_URI": "mongodb://db.example/x"},
                                                  4102, project, state)
            self.assertIsNone(mongo_port)
            self.assertEqual(env["MONGO_URI"], "mongodb://db.example/x")

    def test_local_mode_is_the_default_and_closes_every_sign_in_path(self):
        with tempfile.TemporaryDirectory() as directory:
            project = make_project(Path(directory))
            state = project / ".chatgit"
            runtime.ensure_secrets(state)
            (state / "local.env").write_text(
                "ALLOW_REGISTRATION=true\nALLOW_EMAIL_LOGIN=true\nALLOW_SOCIAL_LOGIN=true\n"
                "ALLOW_EMAIL_LOGIN_OVERRIDE=true\nALLOW_PASSKEY_LOGIN=true\nLDAP_URL=ldap://x\n")
            env, mongo_port = runtime.compose_env({}, 4110, project, state)
            self.assertEqual(env["CHATGIT_LOCAL_MODE"], "true")
            self.assertEqual(env["HOST"], "127.0.0.1")
            self.assertEqual(env["DOMAIN_CLIENT"], "http://127.0.0.1:4110")
            self.assertEqual(env["DOMAIN_SERVER"], "http://127.0.0.1:4110")
            self.assertEqual(env["CHATGIT_LOCAL_ORIGIN"], "http://127.0.0.1:4110")
            for key in runtime.LOCAL_DISABLED_AUTH:
                self.assertEqual(env[key], "false", key)
            self.assertEqual(env["LDAP_URL"], "")  # empty, so app/.env cannot fill it back in
            self.assertEqual(env["CHATGIT_LAUNCH_KEY_FILE"], str(state.resolve() / "launch.key"))
            self.assertEqual(env["CHATGIT_LOCAL_OWNER_FILE"], str(state.resolve() / "local-owner.json"))
            self.assertEqual(env["MONGO_URI"], f"mongodb://127.0.0.1:{mongo_port}/ChatGit")
            # An explicit loopback HOST or matching domain is accepted.
            env, _ = runtime.compose_env({"HOST": "127.0.0.1", "DOMAIN_CLIENT": "http://127.0.0.1:4110/"},
                                         4110, project, state)
            self.assertEqual(env["HOST"], "127.0.0.1")

    def test_local_mode_refuses_settings_that_widen_it(self):
        with tempfile.TemporaryDirectory() as directory:
            project = make_project(Path(directory))
            state = project / ".chatgit"
            runtime.ensure_secrets(state)
            for override in ({"MONGO_URI": "mongodb://db.example/x"},
                             {"MONGO_URI": "mongodb://127.0.0.1:27017/ChatGit"},
                             {"HOST": "0.0.0.0"}, {"HOST": "localhost"},
                             {"DOMAIN_CLIENT": "https://chat.example"},
                             {"DOMAIN_SERVER": "http://localhost:4111"},
                             {"CHATGIT_LOCAL_MODE": "yes"}):
                with self.subTest(override=override), self.assertRaises(ValueError):
                    runtime.compose_env(dict(override), 4111, project, state)
            with self.assertRaises(ValueError):
                runtime.compose_env({}, 80, project, state)
            (state / "local.env").write_text("MONGO_URI=mongodb://db.example/x\n")
            with self.assertRaises(ValueError):
                runtime.compose_env({}, 4111, project, state)
            # The same file is fine for the account-protected preview.
            env, managed = runtime.compose_env(dict(PREVIEW), 4111, project, state)
            self.assertIsNone(managed)

    def test_launch_key_is_private_stable_and_never_printed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / ".chatgit"
            with patch("sys.stdout", new_callable=io.StringIO) as out:
                path, created = runtime.ensure_launch_key(state)
            key = path.read_text().strip()
            self.assertTrue(created)
            self.assertGreaterEqual(len(key), 43)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertNotIn(key, out.getvalue())
            path.chmod(0o644)
            _, created_again = runtime.ensure_launch_key(state)
            self.assertFalse(created_again)
            self.assertEqual(path.read_text().strip(), key)  # never rotated
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)  # re-tightened

    def test_runtime_metadata_has_origin_but_no_secret_and_is_removed_by_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            key_path, _ = runtime.ensure_launch_key(state)
            path = runtime.write_runtime_metadata(state, "http://127.0.0.1:4112")
            data = json.loads(path.read_text())
            self.assertEqual(data["origin"], "http://127.0.0.1:4112")
            self.assertTrue(data["localMode"])
            self.assertNotIn(key_path.read_text().strip(), path.read_text())
            path.write_text(json.dumps({**data, "pid": data["pid"] + 1}))
            runtime.remove_runtime_metadata(state)
            self.assertTrue(path.exists())  # another runtime's file is left alone
            runtime.write_runtime_metadata(state, "http://127.0.0.1:4112")
            runtime.remove_runtime_metadata(state)
            self.assertFalse(path.exists())

    def test_missing_config_or_bad_secret_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            project = make_project(Path(directory))
            state = project / ".chatgit"
            runtime.ensure_secrets(state)
            with self.assertRaises(ValueError):
                runtime.compose_env({"CONFIG_PATH": str(project / "nope.yaml")}, 4103, project, state)
            with self.assertRaises(ValueError):
                runtime.compose_env({"CREDS_KEY": "short"}, 4103, project, state)


class LifecycleTests(unittest.TestCase):
    def test_runtime_starts_persistent_db_then_app_and_cleans_both(self):
        with tempfile.TemporaryDirectory() as directory:
            project = make_project(Path(directory))
            marks = project / "marks"
            marks.mkdir()
            server = textwrap.dedent(f"""
                import os, socket, sys, time, pathlib
                args = sys.argv[1:]
                port = int(args[args.index('--port') + 1]) if '--port' in args else int(os.environ['PORT'])
                name = 'mongod' if '--port' in args else 'app'
                if name == 'mongod':
                    pathlib.Path(args[args.index('--dbpath') + 1], 'data').write_text('kept')
                else:
                    assert os.environ['MONGO_URI'].endswith('/ChatGit')
                    assert os.environ['NODE_ENV'] == 'production'
                    assert os.environ['CHATGIT_LOCAL_MODE'] == 'true'
                    assert os.environ['HOST'] == '127.0.0.1'
                    assert pathlib.Path(os.environ['CHATGIT_LAUNCH_KEY_FILE']).is_file()
                s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(('127.0.0.1', port)); s.listen()
                pathlib.Path({str(marks)!r}, name).write_text(str(os.getpid()))
                time.sleep(60)
            """)
            fake_node = executable(project / "node", server)
            fake_mongod = executable(project / "mongod", server)
            app_port, db_port = free_port(), free_port()
            env = {k: v for k, v in os.environ.items()
                   if k not in ("MONGO_URI", "CONFIG_PATH", "HOST", "DOMAIN_CLIENT", "DOMAIN_SERVER",
                                "CHATGIT_LOCAL_MODE")}
            env["CHATGIT_MONGO_PORT"] = str(db_port)
            env.pop("CHATGIT_STATE_DIR", None)
            process = subprocess.Popen(
                [sys.executable, str(Path(runtime.__file__)), "--port", str(app_port),
                 "--node", str(fake_node), "--mongod", str(fake_mongod), "--project", str(project)],
                env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                deadline = time.monotonic() + 15
                while not (marks / "app").exists() and time.monotonic() < deadline:
                    time.sleep(0.1)
                self.assertTrue((marks / "app").exists(), "app did not start")
                runtime_file = project / ".chatgit/runtime.json"
                deadline = time.monotonic() + 5
                while not runtime_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(json.loads(runtime_file.read_text())["origin"], f"http://127.0.0.1:{app_port}")
                pids = [int((marks / n).read_text()) for n in ("mongod", "app")]
                process.send_signal(signal.SIGTERM)
                output, _ = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 128 + signal.SIGTERM)
                for pid in pids:
                    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
                    self.assertTrue(result.returncode != 0 or result.stdout.strip().startswith("Z"))
                self.assertEqual((project / ".chatgit/mongodb/data").read_text(), "kept")
                secrets_values = list(runtime.parse_env_file(project / ".chatgit/secrets.env").values())
                secrets_values.append((project / ".chatgit/launch.key").read_text().strip())
                for value in secrets_values:
                    self.assertNotIn(value, output)
                self.assertFalse(runtime_file.exists(), "runtime.json outlived the runtime")
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)

    def test_runtime_refuses_busy_port_without_starting_children(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as busy:
            project = make_project(Path(directory))
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            port = busy.getsockname()[1]
            with patch.dict(os.environ, {"CHATGIT_STATE_DIR": str(project / ".chatgit")}):
                os.environ.pop("MONGO_URI", None)
                os.environ.pop("CONFIG_PATH", None)
                with patch("subprocess.Popen") as popen, patch("sys.stderr", new_callable=io.StringIO):
                    code = runtime.main(["--port", str(port), "--node", "/missing", "--project", str(project)])
            self.assertEqual(code, 2)
            popen.assert_not_called()


class ToolchainTests(unittest.TestCase):
    def test_only_exact_pinned_node_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "node"
            fake.write_text("#!/bin/sh\necho 26.10.0\n")
            fake.chmod(0o755)
            with patch.object(toolchain, "node_candidates", return_value=[fake]):
                self.assertIsNone(toolchain.find_node("24.16.0"))
            fake.write_text("#!/bin/sh\necho 24.16.0\n")
            with patch.object(toolchain, "node_candidates", return_value=[fake]):
                self.assertEqual(toolchain.find_node("24.16.0"), (str(fake), "24.16.0"))

    def test_root_pin_matches_upstream(self):
        self.assertEqual(toolchain.pinned_node_version(), "24.16.0")
        self.assertEqual(toolchain.NODE_SHA256_VERSION, "24.16.0")


if __name__ == "__main__":
    unittest.main()
