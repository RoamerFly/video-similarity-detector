from __future__ import annotations

import os
from pathlib import Path

import pytest

from video_sim.pair_scheduler import (
    PairWorkItem,
    schedule_diagnostics,
    schedule_pairs_for_locality,
)


def _item(ordinal: int, left: str, right: str) -> PairWorkItem:
    return PairWorkItem(ordinal, Path(left), Path(right), key=f"k{ordinal}", units=ordinal + 0.5)


def test_empty_single_and_window_one() -> None:
    assert schedule_pairs_for_locality([], window_size=8, resident_capacity=2) == []

    single = _item(10, "a.mp4", "b.mp4")
    result = schedule_pairs_for_locality([single], window_size=8, resident_capacity=2)
    assert result == [single]
    assert result[0] is single

    items = [_item(0, "a.mp4", "b.mp4"), _item(1, "c.mp4", "d.mp4")]
    result = schedule_pairs_for_locality(items, window_size=1, resident_capacity=2)
    assert result == items
    assert all(actual is expected for actual, expected in zip(result, items))


def test_star_and_chain_reuse_shared_endpoints() -> None:
    star = [_item(i, "hub.mp4", f"leaf-{i}.mp4") for i in range(5)]
    star_result = schedule_pairs_for_locality(star, window_size=5, resident_capacity=2)
    assert {id(item) for item in star_result} == {id(item) for item in star}
    assert all(item.video_a == Path("hub.mp4") for item in star_result)
    assert schedule_diagnostics(star, star_result, 2)["predicted_hits"] >= 4

    chain = [_item(i, f"v{i}.mp4", f"v{i + 1}.mp4") for i in range(5)]
    chain_result = schedule_pairs_for_locality(chain, window_size=5, resident_capacity=2)
    chain_diag = schedule_diagnostics(chain, chain_result, 2)
    assert chain_diag["shared_endpoint_transitions"] >= 3
    assert chain_diag["predicted_hits"] >= 3


def test_disconnected_pairs_keep_all_pair_identity() -> None:
    items = [_item(i, f"left-{i}.mp4", f"right-{i}.mp4") for i in range(10)]
    result = schedule_pairs_for_locality(items, window_size=4, resident_capacity=2)
    assert sorted(item.report_ordinal for item in result) == list(range(10))
    assert all(
        actual.video_a == original.video_a and actual.video_b == original.video_b
        for original in items
        for actual in result
        if actual.report_ordinal == original.report_ordinal
    )
    assert schedule_diagnostics(items, result, 2)["shared_endpoint_transitions"] == 0


@pytest.mark.parametrize(
    "items",
    [
        [_item(0, "a.mp4", "a.mp4")],
        [_item(0, "a.mp4", "b.mp4"), _item(1, "b.mp4", "a.mp4")],
        [_item(0, "a.mp4", "b.mp4"), _item(0, "c.mp4", "d.mp4")],
    ],
)
def test_invalid_pairs_and_ordinals_are_rejected(items: list[PairWorkItem]) -> None:
    with pytest.raises((TypeError, ValueError)):
        schedule_pairs_for_locality(items, window_size=4, resident_capacity=2)


def test_windows_case_insensitive_pair_identity_follows_platform() -> None:
    if os.path.normcase("Aa") == "Aa":
        pytest.skip("case-sensitive platform")
    items = [_item(0, "SomeVideo.mp4", "other.mp4"), _item(1, "OTHer.mp4", "somevideo.MP4")]
    with pytest.raises(ValueError, match="duplicate"):
        schedule_pairs_for_locality(items, window_size=4, resident_capacity=2)


def test_capacity_is_at_least_two_and_scheduler_is_repeatable() -> None:
    items = [
        _item(7, "a.mp4", "b.mp4"),
        _item(3, "b.mp4", "c.mp4"),
        _item(9, "d.mp4", "a.mp4"),
        _item(2, "c.mp4", "d.mp4"),
    ]
    with pytest.raises(ValueError, match="at least 2"):
        schedule_pairs_for_locality(items, window_size=4, resident_capacity=1)
    first = schedule_pairs_for_locality(items, window_size=4, resident_capacity=2)
    second = schedule_pairs_for_locality(items, window_size=4, resident_capacity=2)
    assert first == second
    assert all(a is b for a, b in zip(first, second))
    assert [item.report_ordinal for item in items] == [7, 3, 9, 2]


def test_items_are_reordered_only_within_their_input_window() -> None:
    items = [_item(i, f"v{i}.mp4", f"v{i + 1}.mp4") for i in range(17)]
    result = schedule_pairs_for_locality(items, window_size=4, resident_capacity=2)
    original_index = {id(item): index for index, item in enumerate(items)}
    for output_index, item in enumerate(result):
        assert abs(output_index - original_index[id(item)]) <= 3
        assert output_index // 4 == original_index[id(item)] // 4


def test_scheduler_can_reduce_predicted_misses_for_interleaved_clusters() -> None:
    items = [
        _item(0, "a.mp4", "b.mp4"),
        _item(1, "c.mp4", "d.mp4"),
        _item(2, "a.mp4", "c.mp4"),
        _item(3, "b.mp4", "d.mp4"),
    ]
    result = schedule_pairs_for_locality(items, window_size=4, resident_capacity=2)
    original_diag = schedule_diagnostics(items, items, 2)
    scheduled_diag = schedule_diagnostics(items, result, 2)
    assert scheduled_diag["predicted_misses"] <= original_diag["predicted_misses"]
    assert scheduled_diag["predicted_misses"] < original_diag["predicted_misses"]


def test_diagnostics_simulate_endpoint_lru_by_hand() -> None:
    items = [
        _item(0, "a.mp4", "b.mp4"),
        _item(1, "b.mp4", "c.mp4"),
        _item(2, "c.mp4", "d.mp4"),
    ]
    assert schedule_diagnostics(items, items, 2) == {
        "pairs": 3,
        "shared_endpoint_transitions": 2,
        "predicted_loads": 6,
        "predicted_misses": 4,
        "predicted_hits": 2,
        "predicted_evictions": 2,
    }


def test_diagnostics_requires_the_same_work_item_objects() -> None:
    original = [_item(0, "a.mp4", "b.mp4")]
    equivalent_copy = [_item(0, "a.mp4", "b.mp4")]
    with pytest.raises(ValueError, match="identity"):
        schedule_diagnostics(original, equivalent_copy, 2)


def test_large_window_is_deterministic_and_reasonably_fast() -> None:
    items = [_item(i, f"v{i}.mp4", f"v{i + 1}.mp4") for i in range(1000)]
    result = schedule_pairs_for_locality(items, window_size=64, resident_capacity=2)
    assert len(result) == len(items)
    assert {id(item) for item in result} == {id(item) for item in items}
    assert result == schedule_pairs_for_locality(items, window_size=64, resident_capacity=2)
