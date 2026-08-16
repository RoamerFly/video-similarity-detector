from __future__ import annotations

import pytest

from scripts.benchmark_resource_pool import (
    _validate_profile_result,
    _validate_report_profiles,
)


def _profile(name: str, modeled_legacy: int, modeled_compact: int, *, gate: bool):
    legacy = {
        "candidate_pair_digest": f"candidate-{name}",
        "exact_digest": f"exact-{name}",
        "candidate_pair_count": 3,
        "modeled_peak_artifact_bytes": modeled_legacy,
        "rss_peak_delta_bytes": modeled_legacy + 1_000,
    }
    compact = {
        "candidate_pair_digest": f"candidate-{name}",
        "exact_digest": f"exact-{name}",
        "candidate_pair_count": 3,
        "modeled_peak_artifact_bytes": modeled_compact,
        "rss_peak_delta_bytes": modeled_compact + 1_000,
        "resident_videos": 2,
        "pool": {
            "capacity": 2,
            "peak_resident_videos": 2,
        },
    }
    return {
        "status": "ok",
        "config": {
            "videos": 8 if name == "smoke" else 24,
            "frames": 1024 if name == "smoke" else 4096,
            "dimension": 256 if name == "smoke" else 512,
            "memory_gate": gate,
        },
        "legacy": legacy,
        "compact": compact,
    }


def test_smoke_report_keeps_real_ratio_without_false_memory_gate():
    report = _profile("smoke", 100, 55, gate=False)

    _validate_profile_result(report)


def test_scale_report_requires_modeled_memory_reduction():
    report = _profile("scale", 100, 51, gate=True)

    with pytest.raises(RuntimeError, match="modeled artifact residency reduction"):
        _validate_profile_result(report)


def test_report_checks_digests_resident_two_and_memory_trend():
    profiles = {
        "smoke": _profile("smoke", 100, 55, gate=False),
        "scale": _profile("scale", 400, 60, gate=True),
    }

    checks = _validate_report_profiles(profiles)

    assert all(profile["status"] == "ok" for profile in profiles.values())
    assert profiles["smoke"]["config"]["videos"] == 8
    assert profiles["scale"]["config"]["videos"] == 24
    assert checks["all_profiles_ok"] is True
    assert checks["candidate_digest_match"] is True
    assert checks["exact_digest_match"] is True
    assert checks["compact_peak_resident_videos_two"] is True
    assert checks["smoke_to_scale_legacy_increases"] is True
    assert checks["smoke_to_scale_compact_increases"] is True
