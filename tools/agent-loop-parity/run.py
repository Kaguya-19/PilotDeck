"""Run and compare PilotDeck native and sidecar AgentLoop adapters."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from trace import (
    Difference,
    compare_trace_details,
    load_trace,
    validate_trace_expectations,
    write_report,
)

ROOT = Path(__file__).resolve().parent


def load_scenarios(path: Path, selected: str, suite: str) -> list[dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    candidates = document.get("scenarios") if isinstance(document, dict) else None
    if not isinstance(candidates, list):
        raise TypeError("scenario file must contain a scenarios list")
    result: list[dict[str, Any]] = []
    for scenario in candidates:
        if not isinstance(scenario, dict) or "pilotdeck" not in (scenario.get("pairs") or []):
            continue
        if selected != "all" and scenario.get("scenarioId") != selected:
            continue
        if suite != "all" and scenario.get("suite") != suite:
            continue
        result.append(scenario)
    if selected != "all" and not result:
        raise ValueError(f"unknown PilotDeck scenario: {selected}")
    return result


def start_mock() -> tuple[subprocess.Popen[str], str]:
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "mock_backend.py"), "--port", "0"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if line:
            payload = json.loads(line)
            return process, f"http://127.0.0.1:{int(payload['port'])}"
        if process.poll() is not None:
            break
    process.kill()
    raise RuntimeError("PilotDeck parity mock did not become ready")


def materialize_baseline(root: Path, ref: str, parent: Path) -> tuple[Path, bool]:
    if ref in {"", "HEAD", "working-tree"}:
        return root, False
    target = parent / f"{root.name}-{ref.replace('/', '_')}"
    result = subprocess.run(
        ["git", "worktree", "add", "--detach", str(target), ref],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"cannot materialize PilotDeck at {ref}: {result.stderr.strip()}")
    source = root / "node_modules"
    destination = target / "node_modules"
    if source.exists() and not destination.exists():
        destination.symlink_to(source, target_is_directory=True)
    return target, True


def remove_baseline(root: Path, target: Path, created: bool) -> None:
    if created:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(target)],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )


def prepare_baseline(root: Path) -> None:
    if (root / "package.json").exists() and not (root / "dist").exists():
        result = subprocess.run(["pnpm", "build"], cwd=root, text=True, capture_output=True, check=False)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise RuntimeError(f"PilotDeck baseline build failed: {detail}")


def adapter_env(scenario: dict[str, Any], mode: str, source: Path, mock: str, output: Path, ref: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update({
        "PARITY_SCENARIO_FILE": str(ROOT / "scenarios.json"),
        "PARITY_SCENARIO_ID": str(scenario["scenarioId"]),
        "PARITY_Q": str(scenario["q"]),
        "PARITY_SCENARIO_JSON": json.dumps(scenario, ensure_ascii=False),
        "PARITY_MOCK_BASE_URL": mock,
        "PARITY_TRACE_OUT": str(output),
        "PARITY_SOURCE_ROOT": str(source.resolve()),
        "PARITY_SOURCE_REF": ref,
        "PARITY_MODE": mode,
        "PARITY_PILOTDECK_ROOT": str(source.resolve()),
        # Keep mock side effects and cancellation state isolated per adapter
        # invocation. The mock server is shared across a run, but a trace must
        # never inherit effects from another scenario or comparison pair.
        "PARITY_RUN_KEY": f"{mode}-{scenario['scenarioId']}-{ref.replace('/', '_')}",
    })
    if mode in {"native", "sidecar"}:
        env["PARITY_RUNTIME_ROOT"] = str(output.parent / ".runtime" / str(scenario["scenarioId"]))
    return env


def run_adapter(
    mode: str,
    source: Path,
    ref: str,
    scenario: dict[str, Any],
    mock: str,
    output: Path,
    surface: str,
    timeout_seconds: float,
    override: str | None,
) -> str:
    if override:
        command = override
    elif surface == "gateway":
        command = f"node {shlex.quote(str(ROOT / 'adapters' / 'pilotdeck_gateway_impl.mjs'))}"
    elif mode == "native":
        command = f"node {shlex.quote(str(ROOT / 'adapters' / 'pilotdeck_native_impl.mjs'))}"
    else:
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(ROOT / 'adapters' / 'pilotdeck_sidecar_impl.py'))}"
    try:
        result = subprocess.run(
            shlex.split(command),
            cwd=source,
            env=adapter_env(scenario, mode, source, mock, output, ref),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        detail = error.stderr or error.stdout or ""
        return f"BLOCKED: adapter timeout ({str(detail).strip()[-300:]})"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()[-3:]
        return f"BLOCKED: adapter exited {result.returncode}: {' | '.join(detail)}"
    if not output.exists():
        return "BLOCKED: adapter did not write trace"
    return "PASS"


def known_gap_matches(scenario: dict[str, Any], differences: list[Difference]) -> bool:
    expected = sorted(str(item) for item in scenario.get("expectedDifferencePaths") or [])
    return bool(expected) and sorted(item.path for item in differences) == expected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilotdeck-root", type=Path, required=True)
    parser.add_argument("--pilotdeck-baseline", default="working-tree")
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--suite", default="all")
    parser.add_argument("--comparison", choices=("same-version", "baseline", "both"), default="same-version")
    parser.add_argument("--surface", "--pilotdeck-surface", choices=("loop", "gateway"), default="gateway")
    parser.add_argument("--scenario-file", type=Path, default=ROOT / "scenarios.json")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts")
    parser.add_argument("--pilotdeck-native-cmd")
    parser.add_argument("--pilotdeck-sidecar-cmd")
    parser.add_argument("--adapter-timeout-seconds", type=float, default=30)
    args = parser.parse_args()

    scenarios = load_scenarios(args.scenario_file, args.scenario, args.suite)
    args.output.mkdir(parents=True, exist_ok=True)
    mock_process, mock_url = start_mock()
    blocked: list[str] = []
    failed: list[str] = []
    oracle_failures: list[str] = []
    known_gaps: list[str] = []
    warnings: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix="pilotdeck-agent-loop-parity-") as temporary:
            baseline, created = materialize_baseline(args.pilotdeck_root, args.pilotdeck_baseline, Path(temporary))
            try:
                if args.comparison in {"baseline", "both"}:
                    prepare_baseline(baseline)
                for scenario in scenarios:
                    sid = str(scenario["scenarioId"])
                    jobs: list[tuple[str, str, Path, str, str | None]] = []
                    if args.comparison in {"same-version", "both"}:
                        jobs.extend([
                            ("pilotdeck-native", "native", args.pilotdeck_root, "working-tree", args.pilotdeck_native_cmd),
                            ("pilotdeck-sidecar", "sidecar", args.pilotdeck_root, "working-tree", args.pilotdeck_sidecar_cmd),
                        ])
                    if args.comparison in {"baseline", "both"}:
                        jobs.extend([
                            ("pilotdeck-baseline-native", "native", baseline, args.pilotdeck_baseline, args.pilotdeck_native_cmd),
                            ("pilotdeck-current-native", "native", args.pilotdeck_root, "working-tree", args.pilotdeck_native_cmd),
                        ])
                    traces: dict[str, Path] = {}
                    for name, mode, source, ref, override in jobs:
                        trace_path = args.output / f"{sid}.{name}.jsonl"
                        status = run_adapter(mode, source, ref, scenario, mock_url, trace_path, args.surface, args.adapter_timeout_seconds, override)
                        if status != "PASS":
                            blocked.append(f"{sid}/{name}: {status}")
                            continue
                        traces[name] = trace_path
                        if "baseline-" not in name:
                            for failure in validate_trace_expectations(load_trace(trace_path), scenario, "pilotdeck", name):
                                oracle_failures.append(f"{sid}/{name}: {failure.path} expected={failure.left!r} actual={failure.right!r}")
                    comparisons = [
                        ("PilotDeck", "pilotdeck-native", "pilotdeck-sidecar", False),
                        ("PilotDeck baseline drift", "pilotdeck-baseline-native", "pilotdeck-current-native", True),
                    ]
                    for label, left_name, right_name, is_baseline in comparisons:
                        if left_name not in traces or right_name not in traces:
                            continue
                        comparison = compare_trace_details(load_trace(traces[left_name]), load_trace(traces[right_name]))
                        report = args.output / f"{sid}-{label.lower().replace(' ', '-')}.md"
                        write_report(report, f"{sid} {label}", traces[left_name], traces[right_name], comparison)
                        if comparison.format_warnings:
                            warnings.append(f"{sid}/{label}: {len(comparison.format_warnings)} warning(s)")
                        if is_baseline:
                            continue
                        if scenario.get("suite") == "known-gap":
                            if known_gap_matches(scenario, comparison.semantic):
                                known_gaps.append(f"{sid}/{label}: reproduced {len(comparison.semantic)} expected difference(s)")
                            else:
                                failed.append(f"{sid}/{label}: known-gap declaration mismatch")
                        elif comparison.semantic:
                            failed.append(f"{sid}/{label}: {len(comparison.semantic)} semantic difference(s)")
            finally:
                remove_baseline(args.pilotdeck_root, baseline, created)
    finally:
        mock_process.terminate()
        try:
            mock_process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            mock_process.kill()
    summary = {
        "scenarios": len(scenarios),
        "blocked": blocked,
        "failed": failed,
        "oracleFailures": oracle_failures,
        "knownGaps": known_gaps,
        "formatWarnings": warnings,
        "output": str(args.output),
    }
    (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if failed or oracle_failures:
        return 1
    return 2 if blocked else 0


if __name__ == "__main__":
    raise SystemExit(main())
