"""Run each existing Move package's native build and complete unit suite through pytest."""

from pathlib import Path
import json
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = ("bs_oracle", "bs_sid", "example_consumer")


@pytest.mark.parametrize("package", PACKAGES)
def test_native_move_package(package):
    """Fail on any native compile/assertion error and retain the native case/coverage reports."""
    marker = ROOT / ".evaluator-localnet.json"
    if not marker.is_file():
        pytest.fail(
            "Run through the evaluator localnet launcher with the pinned Sui toolchain"
        )
    settings = json.loads(marker.read_text())
    assert settings["rpc"] == "http://127.0.0.1:9000"
    directory = ROOT / "move" / package
    output = ROOT / ".evaluator-artifacts" / "move" / package
    output.mkdir(parents=True, exist_ok=True)
    common = [
        "--build-env",
        "testnet",
        "--lint",
        "--warnings-are-errors",
        "-p",
        str(directory),
    ]
    commands = {
        "build": ["sui", "move", "build", *common],
        "test": [
            "sui",
            "move",
            "test",
            "--coverage",
            "--gas-limit",
            "100000000000",
            *common,
        ],
        "coverage": [
            "sui",
            "move",
            "coverage",
            "summary",
            "--build-env",
            "testnet",
            "--csv",
            "-p",
            str(directory),
        ],
    }
    for phase, command in commands.items():
        with (output / f"{phase}.log").open("w") as log:
            result = subprocess.run(
                command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=900
            )
        assert (
            result.returncode == 0
        ), f"Native {package} {phase} failed; see {output / (phase + '.log')}"
