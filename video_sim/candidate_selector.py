"""Fast coarse candidate selection for large batch comparisons."""

from __future__ import annotations

from dataclasses import dataclass
from array import array
from itertools import combinations
from pathlib import Path
from typing import Callable, Mapping

import faiss
import numpy as np

from video_sim.embedder import FrameEmbeddingCache


@dataclass(frozen=True)
class CandidateSelection:
    pairs: list[tuple[Path, Path]]
    all_pair_count: int
    candidate_limit: int

    @property
    def skipped_pair_count(self) -> int:
        return max(0, self.all_pair_count - len(self.pairs))


@dataclass
class CandidateVideoSummary:
    """Candidate-stage representation; timestamps/signatures remain O(N).

    Only the embedding sketches are bounded per video.  Full timestamps and
    auxiliary signatures are retained to preserve candidate evidence.
    """

    video_path: str
    frame_count: int
    duration_seconds: float
    timestamps: np.ndarray
    optimized_source_representatives: np.ndarray
    optimized_index_embeddings: np.ndarray
    auxiliary_signatures: np.ndarray
    auxiliary_kind: str
    # Kept optional for callers that explicitly request the diagnostic
    # baseline. Production summaries intentionally do not retain this second
    # float matrix set.
    baseline_source_representatives: np.ndarray | None = None
    baseline_index_embeddings: np.ndarray | None = None
    # Persisted identity fields are populated by build/load helpers.  They
    # remain optional so existing callers constructing summaries directly keep
    # working.
    embedding_shape: tuple[int, int] | None = None
    embedding_dtype: str = "float32"
    cache_metadata: dict | None = None
    feature_cache_identity: dict | None = None
    summary_params: dict | None = None


@dataclass
class _AuxiliarySignatureIndex:
    signatures_by_video: list[np.ndarray]
    signature_kinds: list[str]
    # Sorted compact bucket metadata avoids one Python dict/array object for
    # every mostly-unique random signature.
    bucket_keys: np.ndarray
    bucket_starts: np.ndarray
    bucket_stops: np.ndarray
    bucket_entry_ids: np.ndarray
    owners: np.ndarray
    frame_indices: np.ndarray
    signature_bytes: int
    estimated_bytes: int


AUXILIARY_SIGNATURE_BITS = 64
AUXILIARY_SIGNATURE_BATCH_SIZE = 1024
AUXILIARY_BAND_BITS = 16
AUXILIARY_BAND_COUNT = AUXILIARY_SIGNATURE_BITS // AUXILIARY_BAND_BITS
# A matching band is only a cheap LSH prefilter.  The full 64-bit signature
# still has to be close before it can become evidence.  The limits below are
# deliberately hard: repeated/static frames must not create a Cartesian
# product of source and target hits.
AUXILIARY_MAX_HAMMING_BITS = 12
AUXILIARY_MAX_ENTRIES_PER_BUCKET_QUERY = 256
AUXILIARY_MAX_ENTRIES_PER_OWNER_BUCKET = 2
AUXILIARY_MAX_EVIDENCE_PER_TARGET = 512


def select_candidate_pairs(
    video_caches: Mapping[Path, FrameEmbeddingCache | CandidateVideoSummary],
    candidate_limit: int,
    match_threshold: float,
    representatives_per_video: int = 64,
    max_index_frames_per_video: int = 2048,
    window_seconds: float = 30.0,
    max_windows_per_video: int = 96,
    progress_callback: Callable[[int, int, str], None] | None = None,
    sketch_mode: str = "optimized",
) -> CandidateSelection:
    """
    Select likely related video pairs before the expensive frame-to-frame pass.

    Each video contributes a small, evenly distributed set of cached CLIP
    embeddings to one global FAISS index. Every video's representatives query
    that index, then retain its highest-scoring target videos. Pair selection is
    symmetric: a pair is kept when either side selects the other.
    """
    videos = list(video_caches.keys())
    cache_list = [video_caches[video_path] for video_path in videos]
    summary_flags = [isinstance(item, CandidateVideoSummary) for item in cache_list]
    if any(summary_flags) and not all(summary_flags):
        raise TypeError("candidate input must contain either caches or summaries, not both")
    summary_input = bool(summary_flags and summary_flags[0])
    all_pair_count = len(videos) * (len(videos) - 1) // 2
    limit = max(0, int(candidate_limit))

    if len(videos) < 2:
        if progress_callback:
            progress_callback(len(videos), max(1, len(videos)), "全部视频对")
        return CandidateSelection([], all_pair_count, limit)

    if limit == 0 or limit >= len(videos) - 1:
        if progress_callback:
            progress_callback(len(videos), max(1, len(videos)), "全部视频对")
        return CandidateSelection(list(combinations(videos, 2)), all_pair_count, limit)

    mode = str(sketch_mode or "optimized").lower()
    if mode not in {"optimized", "baseline"}:
        raise ValueError("sketch_mode must be 'optimized' or 'baseline'")
    # Candidate screening is a single coordinating operation. Keeping its
    # FAISS search single-threaded makes equal-score tie ordering stable
    # across legacy caches and compact summaries; the exact comparison stage
    # applies its own worker budget afterwards.
    faiss_set_threads = getattr(faiss, "omp_set_num_threads", None)
    if callable(faiss_set_threads):
        faiss_set_threads(1)

    index_blocks = []
    owner_blocks = []
    source_representatives: list[np.ndarray] = []
    auxiliary_index = None

    if mode == "optimized":
        auxiliary_index = _build_auxiliary_signature_index(
            cache_list
        )

    for video_id, video_path in enumerate(videos):
        item = video_caches[video_path]
        if summary_input:
            summary = item
            if mode == "baseline":
                if (
                    summary.baseline_source_representatives is None
                    or summary.baseline_index_embeddings is None
                ):
                    raise ValueError(
                        "baseline candidate selection requires persisted baseline summaries"
                    )
                source_block = summary.baseline_source_representatives
                indexed_embeddings = summary.baseline_index_embeddings
            else:
                source_block = summary.optimized_source_representatives
                indexed_embeddings = summary.optimized_index_embeddings
        else:
            embeddings = np.asarray(item.embeddings, dtype="float32")
            timestamps = np.asarray(item.timestamps, dtype="float32")
            if mode == "baseline":
                representatives = _representative_embeddings(
                    embeddings,
                    max(4, representatives_per_video),
                )
                window_representatives = _window_embeddings(
                    embeddings,
                    timestamps,
                    window_seconds=window_seconds,
                    limit=max(1, max_windows_per_video),
                )
                source_block = _stack_nonempty(
                    [representatives, window_representatives]
                )
                indexed_embeddings = _representative_embeddings(
                    embeddings,
                    max(representatives_per_video, max_index_frames_per_video),
                )
                indexed_embeddings = _stack_nonempty(
                    [indexed_embeddings, window_representatives]
                )
            else:
                # The optimized path indexes actual frames at multiple temporal
                # scales.  It never pools an entire window into one mean vector,
                # which is what diluted very short exact clips in the baseline.
                source_block = _multiscale_sketch(
                    embeddings,
                    timestamps,
                    limit=max(1, representatives_per_video),
                    window_seconds=window_seconds,
                )
                indexed_embeddings = _multiscale_sketch(
                    embeddings,
                    timestamps,
                    limit=max(1, max_index_frames_per_video),
                    window_seconds=window_seconds,
                )
        source_representatives.append(
            np.ascontiguousarray(source_block, dtype="float32")
        )
        index_blocks.append(np.ascontiguousarray(indexed_embeddings, dtype="float32"))
        owner_blocks.append(np.full(len(indexed_embeddings), video_id, dtype=np.int32))
        if progress_callback:
            progress_callback(video_id + 1, len(videos) * 2, f"读取缓存：{video_path.name}")

    if not index_blocks or any(len(block) == 0 for block in index_blocks):
        invalid_videos = [
            videos[index].name
            for index, block in enumerate(index_blocks)
            if len(block) == 0
        ]
        raise ValueError(
            "Candidate selection requires a non-empty embedding cache for every video; "
            f"invalid caches: {', '.join(invalid_videos[:8])}"
        )

    global_embeddings = np.ascontiguousarray(np.vstack(index_blocks), dtype="float32")
    global_owners = np.concatenate(owner_blocks)
    faiss.normalize_L2(global_embeddings)
    index = _build_global_index(global_embeddings.shape[1], len(global_embeddings))
    index.add(global_embeddings)

    selected_pair_ids: set[tuple[int, int]] = set()
    coarse_threshold = max(0.35, min(0.90, float(match_threshold) - 0.16))
    search_k = min(index.ntotal, max(128, limit * 16))
    if hasattr(index, "hnsw"):
        index.hnsw.efSearch = max(64, search_k)

    for source_id, query_embeddings in enumerate(source_representatives):
        query = np.ascontiguousarray(query_embeddings.copy(), dtype="float32")
        faiss.normalize_L2(query)
        similarities, indices = index.search(query, search_k)
        target_best_by_query: dict[int, np.ndarray] = {}

        for query_id, (query_similarities, query_indices) in enumerate(zip(similarities, indices)):
            for similarity, global_index in zip(query_similarities, query_indices):
                if global_index < 0:
                    continue
                target_id = int(global_owners[int(global_index)])
                if target_id == source_id:
                    continue
                target_scores = target_best_by_query.setdefault(
                    target_id,
                    np.zeros(len(query), dtype="float32"),
                )
                if similarity > target_scores[query_id]:
                    target_scores[query_id] = float(similarity)

        auxiliary_scores = (
            _auxiliary_candidate_scores(
                source_id,
                auxiliary_index,
                cache_list,
            )
            if auxiliary_index is not None
            else {}
        )

        ranked_candidates = [
            (
                _candidate_score(
                    scores,
                    coarse_threshold,
                    match_threshold,
                )
                + (auxiliary_scores.get(target_id, 0.0) * 2.0 if auxiliary_scores else 0.0),
                target_id,
            )
            for target_id, scores in target_best_by_query.items()
        ]
        ranked_candidates.extend(
            [
                (score * 2.0, target_id)
                for target_id, score in auxiliary_scores.items()
                if target_id not in target_best_by_query
            ]
        )
        ranked_targets = sorted(
            ranked_candidates,
            key=lambda item: (-item[0], item[1]),
        )

        for _, target_id in ranked_targets[:limit]:
            selected_pair_ids.add(tuple(sorted((source_id, target_id))))

        if progress_callback:
            progress_callback(
                len(videos) + source_id + 1,
                len(videos) * 2,
                f"{videos[source_id].name}: {min(limit, len(ranked_targets))} 个候选",
            )

    selected_pairs = [
        (videos[left_id], videos[right_id])
        for left_id, right_id in sorted(selected_pair_ids)
    ]
    return CandidateSelection(selected_pairs, all_pair_count, limit)


def _representative_embeddings(embeddings: np.ndarray, limit: int) -> np.ndarray:
    if embeddings.ndim != 2 or len(embeddings) == 0:
        return np.zeros((0, 0), dtype="float32")
    count = min(max(1, int(limit)), len(embeddings))
    indices = np.linspace(0, len(embeddings) - 1, count, dtype=np.int64)
    return np.ascontiguousarray(embeddings[indices], dtype="float32")


def _multiscale_sketch(
    embeddings: np.ndarray,
    timestamps: np.ndarray,
    limit: int,
    window_seconds: float,
) -> np.ndarray:
    """Select bounded actual frames at global and local temporal scales.

    Half of the budget is globally uniform.  The remainder is allocated
    round-robin across time buckets and selected by local quantiles.  Thus a
    short clip receives actual frame vectors even when its enclosing 30-second
    window is mostly unrelated content, while the returned sketch is always
    bounded by ``limit``.
    """
    if embeddings.ndim != 2 or len(embeddings) == 0:
        return np.zeros((0, 0), dtype="float32")
    count = min(max(1, int(limit)), len(embeddings))
    if count >= len(embeddings):
        return np.ascontiguousarray(embeddings, dtype="float32")
    chosen: list[int] = []

    def add(index: int) -> None:
        if index not in chosen and len(chosen) < count:
            chosen.append(int(index))

    uniform_count = max(1, count // 2)
    for index in np.linspace(0, len(embeddings) - 1, uniform_count, dtype=np.int64):
        add(int(index))

    if len(timestamps) == len(embeddings):
        span = max(float(window_seconds), 1.0)
        buckets: dict[int, list[int]] = {}
        for index, timestamp in enumerate(timestamps):
            try:
                bucket = int(max(0.0, float(timestamp)) // span)
            except (TypeError, ValueError):
                bucket = index
            buckets.setdefault(bucket, []).append(index)
        ordered_buckets = [buckets[key] for key in sorted(buckets)]
        remaining = max(0, count - len(chosen))
        slots_per_bucket = max(1, int(np.ceil(remaining / max(1, len(ordered_buckets)))))
        # Round-robin over buckets, rather than filling the first bucket
        # before moving on.  The latter silently starves late time ranges as
        # soon as the bounded budget is exhausted.
        for slot in range(slots_per_bucket):
            for bucket in ordered_buckets:
                if len(chosen) >= count:
                    break
                fraction = slot / max(1, slots_per_bucket - 1)
                local_index = int(round(fraction * (len(bucket) - 1)))
                add(bucket[local_index])

    if len(chosen) < count:
        for index in range(len(embeddings)):
            add(index)
            if len(chosen) >= count:
                break
    chosen.sort()
    return np.ascontiguousarray(embeddings[np.asarray(chosen, dtype=np.int64)], dtype="float32")


def _parse_phash_signatures(phashes: object, frame_count: int) -> np.ndarray | None:
    if not isinstance(phashes, (list, tuple)) or len(phashes) != frame_count:
        return None
    values = []
    for value in phashes:
        try:
            text = str(value).strip().lower()
            if not text or text.startswith("p"):
                return None
            values.append(int(text, 16) & ((1 << AUXILIARY_SIGNATURE_BITS) - 1))
        except (TypeError, ValueError):
            return None
    return np.asarray(values, dtype=np.uint64)


def _simhash_signatures(
    embeddings: np.ndarray,
    bits: int = AUXILIARY_SIGNATURE_BITS,
    batch_size: int = AUXILIARY_SIGNATURE_BATCH_SIZE,
) -> np.ndarray:
    """Create fixed random-projection signatures in bounded batches."""
    if embeddings.ndim != 2 or len(embeddings) == 0:
        return np.zeros((0,), dtype=np.uint64)
    dimension = embeddings.shape[1]
    rng = np.random.default_rng(0x51A9E7 + dimension * 17 + bits)
    projection = rng.normal(size=(dimension, bits)).astype("float32")
    projection /= np.maximum(np.linalg.norm(projection, axis=0, keepdims=True), 1e-12)
    weights = np.left_shift(
        np.uint64(1), np.arange(bits, dtype=np.uint64)
    )
    signatures = np.empty(len(embeddings), dtype=np.uint64)
    for start in range(0, len(embeddings), max(1, int(batch_size))):
        stop = min(len(embeddings), start + max(1, int(batch_size)))
        block = np.asarray(embeddings[start:stop], dtype="float32")
        signs = (block @ projection) >= 0.0
        signatures[start:stop] = np.sum(
            signs.astype(np.uint64) * weights,
            axis=1,
            dtype=np.uint64,
        )
    return signatures


def _build_auxiliary_signature_index(
    caches: list[FrameEmbeddingCache | CandidateVideoSummary],
) -> _AuxiliarySignatureIndex:
    signatures_by_video = []
    signature_kinds = []
    for owner, cache in enumerate(caches):
        if isinstance(cache, CandidateVideoSummary):
            signatures = np.ascontiguousarray(
                cache.auxiliary_signatures, dtype=np.uint64
            )
            signature_kind = cache.auxiliary_kind
        else:
            embeddings = np.asarray(cache.embeddings, dtype="float32")
            signatures = _parse_phash_signatures(cache.phashes, len(embeddings))
            if signatures is None:
                signatures = _simhash_signatures(embeddings)
                signature_kind = "simhash"
            else:
                signature_kind = "phash"
        signatures_by_video.append(signatures)
        signature_kinds.append(signature_kind)
    signature_counts = [len(signatures) for signatures in signatures_by_video]
    owner_array = np.concatenate(
        [
            np.full(count, owner, dtype=np.int32)
            for owner, count in enumerate(signature_counts)
            if count
        ]
    ) if any(signature_counts) else np.zeros((0,), dtype=np.int32)
    frame_array = np.concatenate(
        [np.arange(count, dtype=np.int32) for count in signature_counts if count]
    ) if any(signature_counts) else np.zeros((0,), dtype=np.int32)
    signature_bytes = int(sum(len(item) for item in signatures_by_video) * (AUXILIARY_SIGNATURE_BITS // 8))
    # Encode (channel kind, band, value) into one sortable uint32 key.  The
    # entry id remains the index into the compact owner/frame arrays.
    key_blocks: list[np.ndarray] = []
    entry_blocks: list[np.ndarray] = []
    entry_offset = 0
    for signatures, signature_kind in zip(signatures_by_video, signature_kinds):
        count = len(signatures)
        if not count:
            continue
        entry_ids = np.arange(entry_offset, entry_offset + count, dtype=np.int32)
        kind_code = 1 if signature_kind == "simhash" else 0
        for band in range(AUXILIARY_BAND_COUNT):
            values = (
                signatures >> np.uint64(band * AUXILIARY_BAND_BITS)
            ) & np.uint64((1 << AUXILIARY_BAND_BITS) - 1)
            keys = (
                ((kind_code * AUXILIARY_BAND_COUNT + band) << AUXILIARY_BAND_BITS)
                | values.astype(np.uint32)
            ).astype(np.uint32, copy=False)
            key_blocks.append(keys)
            entry_blocks.append(entry_ids)
        entry_offset += count
    raw_keys = np.concatenate(key_blocks) if key_blocks else np.zeros((0,), dtype=np.uint32)
    raw_entries = np.concatenate(entry_blocks) if entry_blocks else np.zeros((0,), dtype=np.int32)
    order = np.argsort(raw_keys, kind="stable")
    sorted_keys = raw_keys[order]
    sorted_entries = raw_entries[order]
    unique_keys, starts = np.unique(sorted_keys, return_index=True)
    stops = np.concatenate(
        [starts[1:], np.asarray([len(sorted_entries)], dtype=starts.dtype)]
    ) if len(starts) else np.zeros((0,), dtype=starts.dtype)

    compact_key_values = array("I")
    compact_entry_values = array("I")
    for key, start, stop in zip(unique_keys, starts, stops):
        entries = sorted_entries[int(start) : int(stop)]
        if len(entries) <= AUXILIARY_MAX_ENTRIES_PER_BUCKET_QUERY:
            selected_entries = entries
        else:
            # Build a bounded per-owner view.  Sampling the complete bucket
            # globally can let one static video occupy all slots and starve
            # every other owner.  Two temporal quantiles per owner, followed
            # by owner round-robin, keeps the index deterministic and gives a
            # 128-video collision bucket one entry for every owner.
            owner_positions: dict[int, list[int]] = {}
            for entry in entries:
                owner_positions.setdefault(int(owner_array[entry]), []).append(int(entry))
            owner_samples: dict[int, list[int]] = {}
            for owner, owner_entries in owner_positions.items():
                take = min(AUXILIARY_MAX_ENTRIES_PER_OWNER_BUCKET, len(owner_entries))
                positions = np.linspace(0, len(owner_entries) - 1, take, dtype=np.int64)
                owner_samples[owner] = [owner_entries[int(position)] for position in positions]
            selected_list: list[int] = []
            ordered_owners = sorted(owner_samples)
            max_samples = max((len(items) for items in owner_samples.values()), default=0)
            for slot in range(max_samples):
                for owner in ordered_owners:
                    samples = owner_samples[owner]
                    if slot < len(samples):
                        selected_list.append(samples[slot])
                        if len(selected_list) >= AUXILIARY_MAX_ENTRIES_PER_BUCKET_QUERY:
                            break
                if len(selected_list) >= AUXILIARY_MAX_ENTRIES_PER_BUCKET_QUERY:
                    break
            selected_entries = np.asarray(selected_list, dtype=np.int32)
        compact_key_values.extend([int(key)] * len(selected_entries))
        compact_entry_values.extend(int(entry) for entry in selected_entries)

    bucket_keys = np.frombuffer(compact_key_values, dtype=np.uint32).copy()
    bucket_entry_ids = np.frombuffer(compact_entry_values, dtype=np.uint32).astype(
        np.int32, copy=False
    )
    # The compact key list is grouped by construction; derive one range per
    # unique key without another Python dictionary.
    compact_unique_keys, compact_starts = np.unique(bucket_keys, return_index=True)
    compact_stops = np.concatenate(
        [compact_starts[1:], np.asarray([len(bucket_entry_ids)], dtype=compact_starts.dtype)]
    ) if len(compact_starts) else np.zeros((0,), dtype=compact_starts.dtype)
    estimated_bytes = signature_bytes + int(owner_array.nbytes + frame_array.nbytes)
    estimated_bytes += int(bucket_entry_ids.nbytes + compact_unique_keys.nbytes)
    estimated_bytes += int(compact_starts.nbytes + compact_stops.nbytes)
    return _AuxiliarySignatureIndex(
        signatures_by_video=signatures_by_video,
        signature_kinds=signature_kinds,
        bucket_keys=compact_unique_keys,
        bucket_starts=compact_starts.astype(np.int32, copy=False),
        bucket_stops=compact_stops.astype(np.int32, copy=False),
        bucket_entry_ids=bucket_entry_ids,
        owners=owner_array,
        frame_indices=frame_array,
        signature_bytes=signature_bytes,
        estimated_bytes=estimated_bytes,
    )


def estimate_auxiliary_memory_bytes(
    video_caches: Mapping[Path, FrameEmbeddingCache | CandidateVideoSummary],
    bits: int = AUXILIARY_SIGNATURE_BITS,
) -> dict[str, int]:
    """Estimate compressed full-frame auxiliary storage without allocating it."""
    frame_count = sum(
        len(cache.auxiliary_signatures)
        if isinstance(cache, CandidateVideoSummary)
        else len(cache.embeddings)
        for cache in video_caches.values()
    )
    signature_bytes = frame_count * max(1, int(bits) // 8)
    # signature + owner + frame index + compact bucket entry ids.  In the
    # worst case every band is unique, so each of the four bands also needs a
    # uint32 key/start/stop metadata tuple.  This is a conservative hard
    # estimate; repeated signatures use fewer bucket metadata records.
    bucket_entry_bytes = frame_count * AUXILIARY_BAND_COUNT * 4
    bucket_metadata_bytes = frame_count * AUXILIARY_BAND_COUNT * 12
    estimated_bytes = (
        signature_bytes
        + frame_count * (4 + 4)
        + bucket_entry_bytes
        + bucket_metadata_bytes
    )
    return {
        "frames": int(frame_count),
        "signature_bytes": int(signature_bytes),
        "estimated_bytes": int(estimated_bytes),
        "bucket_metadata_bytes": int(bucket_metadata_bytes),
        "bytes_per_frame": int(max(1, int(bits) // 8) + 8 + AUXILIARY_BAND_COUNT * (4 + 12)),
    }


def _temporal_auxiliary_score(
    evidence: set[tuple[int, int]],
    source_timestamps: np.ndarray,
    target_timestamps: np.ndarray,
) -> float:
    """Score a signature match set only when both timelines are coherent."""
    if not evidence:
        return 0.0
    ordered = sorted(
        evidence,
        key=lambda item: (float(source_timestamps[item[0]]), float(target_timestamps[item[1]])),
    )
    longest = 0
    current = 0
    previous_source = None
    previous_target = None
    previous_offset = None
    for source_index, target_index in ordered:
        source_time = float(source_timestamps[source_index])
        target_time = float(target_timestamps[target_index])
        offset = target_time - source_time
        if previous_source is None:
            current = 1
        else:
            source_delta = source_time - previous_source
            target_delta = target_time - previous_target
            slope = target_delta / source_delta if source_delta > 1e-6 else 1.0
            coherent = (
                source_delta >= 0.0
                and target_delta >= -1.0
                and 0.5 <= slope <= 1.5
                and abs(offset - previous_offset) <= 3.0
            )
            current = current + 1 if coherent else 1
        longest = max(longest, current)
        previous_source = source_time
        previous_target = target_time
        previous_offset = offset
    source_coverage = len({source for source, _ in evidence}) / max(1, len(source_timestamps))
    continuity = longest / max(1, min(len(source_timestamps), 16))
    return source_coverage * 1.5 + continuity * 3.0


def _auxiliary_candidate_scores(
    source_id: int,
    auxiliary_index: _AuxiliarySignatureIndex,
    caches: list[FrameEmbeddingCache],
) -> dict[int, float]:
    source_signatures = auxiliary_index.signatures_by_video[source_id]
    source_timestamps = np.asarray(caches[source_id].timestamps, dtype="float32")
    evidence: dict[int, set[tuple[int, int]]] = {}
    source_kind = auxiliary_index.signature_kinds[source_id]
    for source_frame_index, signature in enumerate(source_signatures):
        for band in range(AUXILIARY_BAND_COUNT):
            band_value = int(
                (int(signature) >> (band * AUXILIARY_BAND_BITS))
                & ((1 << AUXILIARY_BAND_BITS) - 1)
            )
            kind_code = 1 if source_kind == "simhash" else 0
            bucket_key = np.uint32(
                ((kind_code * AUXILIARY_BAND_COUNT + band) << AUXILIARY_BAND_BITS)
                | band_value
            )
            bucket_position = int(
                np.searchsorted(auxiliary_index.bucket_keys, bucket_key)
            )
            if (
                bucket_position >= len(auxiliary_index.bucket_keys)
                or auxiliary_index.bucket_keys[bucket_position] != bucket_key
            ):
                continue
            start = int(auxiliary_index.bucket_starts[bucket_position])
            stop = int(auxiliary_index.bucket_stops[bucket_position])
            entry_ids = auxiliary_index.bucket_entry_ids[start:stop]
            if len(entry_ids) > AUXILIARY_MAX_ENTRIES_PER_BUCKET_QUERY:
                # Keep temporal coverage when a static signature owns a very
                # large bucket instead of always taking its first entries.
                sample_positions = np.linspace(
                    0,
                    len(entry_ids) - 1,
                    AUXILIARY_MAX_ENTRIES_PER_BUCKET_QUERY,
                    dtype=np.int64,
                )
                entry_ids = entry_ids[sample_positions]
            for entry_id in entry_ids:
                target_id = int(auxiliary_index.owners[entry_id])
                if target_id == source_id:
                    continue
                target_frame_index = int(auxiliary_index.frame_indices[entry_id])
                target_signature = auxiliary_index.signatures_by_video[target_id][
                    target_frame_index
                ]
                hamming_distance = (
                    int(signature) ^ int(target_signature)
                ).bit_count()
                if hamming_distance > AUXILIARY_MAX_HAMMING_BITS:
                    continue
                target_evidence = evidence.setdefault(target_id, set())
                if len(target_evidence) < AUXILIARY_MAX_EVIDENCE_PER_TARGET:
                    target_evidence.add((source_frame_index, target_frame_index))
    scores = {}
    for target_id, matches in evidence.items():
        target_timestamps = np.asarray(caches[target_id].timestamps, dtype="float32")
        if len(source_timestamps) == 0 or len(target_timestamps) == 0:
            continue
        valid = {
            (source, target)
            for source, target in matches
            if source < len(source_timestamps) and target < len(target_timestamps)
        }
        score = _temporal_auxiliary_score(valid, source_timestamps, target_timestamps)
        if score > 0:
            scores[target_id] = score
    return scores


def _window_embeddings(
    embeddings: np.ndarray,
    timestamps: np.ndarray,
    window_seconds: float,
    limit: int,
) -> np.ndarray:
    if embeddings.ndim != 2 or len(embeddings) == 0:
        return np.zeros((0, 0), dtype="float32")
    if len(timestamps) != len(embeddings):
        return _representative_embeddings(embeddings, limit)

    span = max(float(window_seconds), 1.0)
    buckets: dict[int, list[int]] = {}
    for index, timestamp in enumerate(timestamps):
        try:
            bucket = int(max(0.0, float(timestamp)) // span)
        except (TypeError, ValueError):
            bucket = index
        buckets.setdefault(bucket, []).append(index)

    pooled = []
    for indices in buckets.values():
        block = np.asarray(embeddings[indices], dtype="float32")
        if len(block) == 0:
            continue
        vector = np.mean(block, axis=0)
        norm = float(np.linalg.norm(vector))
        if norm > 0:
            vector = vector / norm
        pooled.append(vector.astype("float32"))

    if not pooled:
        return _representative_embeddings(embeddings, limit)
    windows = np.ascontiguousarray(np.vstack(pooled), dtype="float32")
    return _representative_embeddings(windows, limit)


def _stack_nonempty(blocks: list[np.ndarray]) -> np.ndarray:
    valid = [block for block in blocks if block.ndim == 2 and len(block) > 0]
    if not valid:
        return np.zeros((0, 0), dtype="float32")
    return np.ascontiguousarray(np.vstack(valid), dtype="float32")


def _summary_duration_seconds(timestamps: np.ndarray, frame_count: int) -> float:
    if len(timestamps) == 0:
        return 0.0
    try:
        return max(0.0, float(timestamps[-1]))
    except (TypeError, ValueError):
        return float(max(0, frame_count - 1))


def build_candidate_summary(
    cache: FrameEmbeddingCache,
    representatives_per_video: int = 64,
    max_index_frames_per_video: int = 2048,
    window_seconds: float = 30.0,
    max_windows_per_video: int = 96,
    include_baseline: bool = True,
) -> CandidateVideoSummary:
    """Materialize a releaseable candidate representation.

    This helper is intentionally deterministic with the legacy selector: it
    uses the same sketch functions and signature generation as the full-cache
    path.  Embedding sketches are per-video limited, while timestamps and
    auxiliary signatures retain one value per frame.  Callers can delete the
    input cache immediately after it returns.
    """
    embeddings = np.asarray(cache.embeddings, dtype="float32")
    # Keep every timestamp (the embedding sketch alone is bounded).  The
    # selector historically consumes float32 timestamps, so it converts only
    # at that call boundary while the sidecar retains this complete vector.
    timestamps = np.ascontiguousarray(cache.timestamps).copy()
    selector_timestamps = np.asarray(cache.timestamps, dtype="float32")
    frame_count = int(len(embeddings))
    optimized_source = _multiscale_sketch(
        embeddings,
        selector_timestamps,
        limit=max(1, representatives_per_video),
        window_seconds=window_seconds,
    )
    optimized_index = _multiscale_sketch(
        embeddings,
        selector_timestamps,
        limit=max(1, max_index_frames_per_video),
        window_seconds=window_seconds,
    )
    signatures = _parse_phash_signatures(cache.phashes, frame_count)
    if signatures is None:
        signatures = _simhash_signatures(embeddings)
        signature_kind = "simhash"
    else:
        signature_kind = "phash"
    baseline_source = None
    baseline_index = None
    if include_baseline:
        window_representatives = _window_embeddings(
            embeddings,
            selector_timestamps,
            window_seconds=window_seconds,
            limit=max(1, max_windows_per_video),
        )
        baseline_source = _stack_nonempty(
            [
                _representative_embeddings(embeddings, max(4, representatives_per_video)),
                window_representatives,
            ]
        )
        baseline_index = _stack_nonempty(
            [
                _representative_embeddings(
                    embeddings,
                    max(representatives_per_video, max_index_frames_per_video),
                ),
                window_representatives,
            ]
        )
    return CandidateVideoSummary(
        video_path=str(cache.video_path),
        frame_count=frame_count,
        duration_seconds=_summary_duration_seconds(timestamps, frame_count),
        timestamps=timestamps,
        optimized_source_representatives=np.ascontiguousarray(
            optimized_source, dtype="float32"
        ),
        optimized_index_embeddings=np.ascontiguousarray(
            optimized_index, dtype="float32"
        ),
        auxiliary_signatures=np.ascontiguousarray(signatures, dtype=np.uint64),
        auxiliary_kind=signature_kind,
        baseline_source_representatives=baseline_source,
        baseline_index_embeddings=baseline_index,
        embedding_shape=(frame_count, int(embeddings.shape[1]) if embeddings.ndim == 2 else 0),
        embedding_dtype=str(getattr(cache.embeddings, "dtype", "float32")),
        cache_metadata=dict(cache.metadata) if isinstance(cache.metadata, Mapping) else None,
        summary_params={
            "representatives_per_video": int(representatives_per_video),
            "max_index_frames_per_video": int(max_index_frames_per_video),
            "window_seconds": float(window_seconds),
            "max_windows_per_video": int(max_windows_per_video),
        },
    )


def _candidate_score(
    scores: np.ndarray,
    coarse_threshold: float,
    match_threshold: float,
    query_hits: set[int] | None = None,
) -> float:
    if len(scores) == 0:
        return 0.0
    ordered = np.sort(scores)[::-1]
    top_count = max(1, len(ordered) // 4)
    coarse_coverage = float(np.count_nonzero(scores >= coarse_threshold)) / len(scores)
    strong_coverage = float(np.count_nonzero(scores >= match_threshold)) / len(scores)
    top_mean = float(np.mean(ordered[:top_count]))
    peak = float(ordered[0])
    # ``query_hits`` is retained as an ignored compatibility argument.  Query
    # ids are an index order chosen by the bounded sketch, not timestamps, so
    # treating adjacent ids as temporal continuity creates a false reward.
    # Real two-sided continuity is scored by ``_temporal_auxiliary_score``.
    return (
        strong_coverage * 2.0
        + coarse_coverage * 1.25
        + top_mean
        + peak * 0.25
    )


def _build_global_index(dimension: int, vector_count: int) -> faiss.Index:
    if vector_count < 4096:
        return faiss.IndexFlatIP(dimension)

    index = faiss.IndexHNSWFlat(dimension, 32, faiss.METRIC_INNER_PRODUCT)
    index.hnsw.efConstruction = 80
    return index
