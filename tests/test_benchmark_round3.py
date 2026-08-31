from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "benchmark_round3.py"


def _module():
    spec = importlib.util.spec_from_file_location("benchmark_round3_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parser_has_round3_default_scale_and_explicit_abba_parameters():
    benchmark = _module()
    args = benchmark.build_parser().parse_args([])
    assert args.videos == 8
    assert args.frames == 128
    assert args.scheduler_pairs == 1000
    assert args.sqlite_rows == 1000
    assert args.repeats == 3
    assert args.warmup == 1


def test_synthetic_summary_hot_load_preserves_semantics_and_pairs(tmp_path: Path):
    benchmark = _module()
    args = benchmark.build_parser().parse_args(
        [
            "--cache-dir",
            str(tmp_path / "cache"),
            "--videos",
            "4",
            "--frames",
            "12",
            "--dimension",
            "8",
            "--warmup",
            "0",
            "--repeats",
            "1",
        ]
    )
    cache_paths, metadata = benchmark._build_synthetic_caches(
        args.cache_dir,
        videos=args.videos,
        frames=args.frames,
        dimension=args.dimension,
        seed=args.seed,
        skip_threshold=args.skip_threshold,
        max_gap_sec=args.max_gap_sec,
    )
    benchmark._prepare_sidecars(cache_paths, metadata)
    full, _, _ = benchmark._full_audit(
        cache_paths,
        skip_threshold=args.skip_threshold,
        max_gap_sec=args.max_gap_sec,
    )
    hot, _, _ = benchmark._hot_audit(cache_paths, metadata)
    full_digest = {
        str(video): benchmark._summary_semantic_digest(summary)
        for video, summary in full.items()
    }
    hot_digest = {
        str(video): benchmark._summary_semantic_digest(summary)
        for video, summary in hot.items()
    }
    assert full_digest == hot_digest
    assert benchmark._candidate_pairs(full, candidate_limit=2) == benchmark._candidate_pairs(
        hot, candidate_limit=2
    )
    assert benchmark._cache_bytes(cache_paths) > 0
    assert benchmark._sidecar_bytes(cache_paths) > 0


def test_scheduler_benchmark_preserves_contract_and_counts():
    benchmark = _module()
    args = benchmark.build_parser().parse_args(
        ["--scheduler-pairs", "1000", "--schedule-window", "64"]
    )
    result = benchmark._benchmark_scheduler(args)
    assert result["correctness"]["status"] == "pass"
    assert result["correctness"]["pair_count_equal"] is True
    assert result["correctness"]["object_identity_preserved"] is True
    assert result["correctness"]["result_digest_equal"] is True
    assert result["original"]["pairs"] == 1000
    assert result["scheduled"]["pairs"] == 1000
    assert result["original"]["predicted_loads"] == 2000
    assert result["scheduled"]["predicted_loads"] == 2000


def test_sqlite_benchmark_reports_same_rows_digest_and_expected_connection_counts(tmp_path: Path):
    benchmark = _module()
    args = benchmark.build_parser().parse_args(
        ["--sqlite-rows", "8", "--repeats", "1", "--warmup", "0"]
    )
    result = benchmark._benchmark_sqlite(args)
    assert result["correctness"]["status"] == "pass"
    assert result["correctness"]["prior_connections_equal_rows"] is True
    assert result["correctness"]["current_connections_equal_one"] is True
    assert result["correctness"]["expected_fetchmany_batches"] == 1
    assert all(row["rows"] == 8 for row in result["raw"])
    assert all(row["payload_digest"] == result["raw"][0]["payload_digest"] for row in result["raw"])


def test_cli_smoke_writes_structured_json_without_speed_assertions(tmp_path: Path):
    output = tmp_path / "round3.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--output",
            str(output),
            "--cache-dir",
            str(tmp_path / "synthetic-cache"),
            "--videos",
            "2",
            "--frames",
            "4",
            "--dimension",
            "4",
            "--candidate-limit",
            "1",
            "--scheduler-pairs",
            "4",
            "--sqlite-rows",
            "4",
            "--warmup",
            "0",
            "--repeats",
            "1",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-4000:]
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["source"]["sha"]
    assert report["environment"]["python"]
    assert report["summary_audit"]["correctness"]["status"] == "pass"
    assert report["scheduler"]["correctness"]["status"] == "pass"
    assert report["sqlite"]["correctness"]["status"] == "pass"
    assert report["summary_audit"]["raw"]
    assert report["sqlite"]["raw"]
    assert report["limitations"]
