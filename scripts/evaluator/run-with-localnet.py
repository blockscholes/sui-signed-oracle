"""Run an evaluator with a disposable, CI-pinned Sui localnet; never use an operator keystore."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request


def stop_owned(process):
    """Stop only the process group started by this launcher, including its children."""
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def ready():
    """Confirm the loopback RPC responds to a harmless checkpoint request."""
    request = urllib.request.Request(
        "http://127.0.0.1:9000",
        data=b'{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}',
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            return "result" in json.load(response)
    except Exception:
        return False


def terminated(signum, _frame):
    """Unwind the cleanup path if the enclosing measurement is interrupted."""
    raise SystemExit(128 + signum)


def main():
    """Validate the toolchain, own localnet for one child command, then clean it up."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sui-binary", required=True, type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("An evaluator command is required after --")
    binary = args.sui_binary.resolve(strict=True)
    version = subprocess.check_output([str(binary), "--version"], text=True)
    if not version.startswith("sui 1.74.1-"):
        raise RuntimeError("Use the CI-pinned Sui 1.74.1 toolchain")
    root = Path(__file__).resolve().parents[2]
    marker = root / ".evaluator-localnet.json"
    if marker.exists():
        raise RuntimeError("An evaluation localnet marker already exists")
    for port in (9000, 9123):
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(
                    f"Port {port} is occupied; no existing service was changed"
                )
    signal.signal(signal.SIGTERM, terminated)
    with tempfile.TemporaryDirectory(prefix="bs-sui-evaluation-", dir="/tmp") as temp:
        scratch = Path(temp)
        home = scratch / "home"
        home.mkdir(mode=0o700)
        bins = scratch / "bin"
        bins.mkdir()
        shim = bins / "sui"
        # The evaluator preserves system/temp PATH entries but resets HOME. This shim
        # selects only the new localnet home, which contains no operator credentials.
        shim.write_text(
            "#!/bin/sh\nexport HOME="
            + shlex.quote(str(home))
            + "\nexport XDG_CONFIG_HOME="
            + shlex.quote(str(home / ".config"))
            + "\nexport XDG_DATA_HOME="
            + shlex.quote(str(home / ".local/share"))
            + "\nexport XDG_CACHE_HOME="
            + shlex.quote(str(home / ".cache"))
            + "\nexec "
            + shlex.quote(str(binary))
            + ' "$@"\n'
        )
        shim.chmod(0o755)
        env = dict(os.environ, PATH=str(bins) + os.pathsep + os.environ.get("PATH", ""))
        with (scratch / "genesis.log").open("w") as log:
            subprocess.run(
                [str(shim), "genesis", "-f", "--with-faucet"],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=90,
            )
        for config in home.rglob("fullnode.yaml"):
            text, count = re.subn(
                r"^json-rpc-address:.*$",
                'json-rpc-address: "127.0.0.1:9000"',
                config.read_text(),
                flags=re.M,
            )
            if count != 1:
                raise RuntimeError(
                    "The generated local RPC listener was not recognized"
                )
            config.write_text(text)
        evidence = root / ".evaluator-artifacts"
        evidence.mkdir(exist_ok=True)
        with (evidence / "localnet.log").open("w") as log:
            server = subprocess.Popen(
                [str(shim), "start", "--with-faucet=127.0.0.1:9123"],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            child = None
            try:
                for _ in range(90):
                    if server.poll() is not None:
                        raise RuntimeError("Localnet exited during startup")
                    if ready():
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError("Localnet readiness timed out")
                for cli in (
                    [
                        "client",
                        "new-env",
                        "--alias",
                        "localnet",
                        "--rpc",
                        "http://127.0.0.1:9000",
                    ],
                    ["client", "switch", "--env", "localnet"],
                ):
                    result = subprocess.run(
                        [str(shim), *cli],
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    if (
                        result.returncode
                        and "already exists"
                        not in (result.stdout + result.stderr).lower()
                    ):
                        raise RuntimeError("Could not select the disposable localnet")
                marker.write_text(
                    json.dumps(
                        {"rpc": "http://127.0.0.1:9000", "cli_version": "1.74.1"}
                    )
                    + "\n"
                )
                child = subprocess.Popen(
                    command, cwd=root, env=env, start_new_session=True
                )
                return child.wait()
            finally:
                if child is not None:
                    stop_owned(child)
                stop_owned(server)
                marker.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
