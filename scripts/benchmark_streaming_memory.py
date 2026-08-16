"""Compare materialized and bounded streaming prepared-frame memory.

The benchmark intentionally uses synthetic RGB arrays and separate child
processes.  This keeps import history and allocator peaks from one mode from
polluting the other mode, while making the O(total frames) versus O(batch)
pixel lifetime visible without loading CLIP or a real video.
"""

from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from video_sim.metrics import process_memory_snapshot


def _worker(mode: str, frames: int, frame_size: int, batch_size: int) -> dict:
    baseline = process_memory_snapshot()
    baseline_rss = baseline.get("current_rss_bytes") or baseline.get("peak_rss_bytes") or 0
    peak_frames = 0
    prepared_bytes = 0
    started = time.perf_counter()

    def make_frame(index: int) -> np.ndarray:
        return np.full((frame_size, frame_size, 3), index % 251, dtype=np.uint8)

    if mode == "materialize":
        materialized = [make_frame(index) for index in range(frames)]
        peak_frames = len(materialized)
        prepared_bytes = sum(int(frame.nbytes) for frame in materialized)
        # Match the legacy np.stack peak: the list and the contiguous batch
        # briefly coexist before inference consumes the batch.
        stacked = np.stack(materialized, axis=0)
        peak_frames += len(materialized)
        prepared_bytes += int(stacked.nbytes)
        del stacked, materialized
    else:
        batch = []
        for index in range(frames):
            batch.append(make_frame(index))
            peak_frames = max(peak_frames, len(batch))
            prepared_bytes = max(prepared_bytes, sum(int(frame.nbytes) for frame in batch))
            if len(batch) >= batch_size:
                # A fake consumer represents embed_frames_batch.  Release all
                # prepared pixels before producing the next bounded batch.
                _ = sum(int(frame[0, 0, 0]) for frame in batch)
                batch.clear()
        batch.clear()

    gc.collect()
    observed = process_memory_snapshot()
    observed_peak = observed.get("peak_rss_bytes") or observed.get("current_rss_bytes") or 0
    return {
        "mode": mode,
        "frames": frames,
        "frame_size": frame_size,
        "batch_size": batch_size,
        "peak_frames_in_memory": peak_frames,
        "prepared_pixel_peak_bytes": prepared_bytes,
        "baseline_rss_bytes": int(baseline_rss),
        "observed_peak_rss_bytes": int(observed_peak),
        "peak_rss_delta_bytes": max(0, int(observed_peak) - int(baseline_rss)),
        "wall_elapsed_ms": round((time.perf_counter() - started) * 1000.0, 3),
    }


def _run_child(mode: str, args) -> dict:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        mode,
        "--frames",
        str(args.frames),
        "--frame-size",
        str(args.frame_size),
        "--batch-size",
        str(args.batch_size),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=True)
    return json.loads(completed.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", choices=["materialize", "streaming"])
    parser.add_argument("--frames", type=int, default=2048)
    parser.add_argument("--frame-size", type=int, default=96)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "benchmarks" / "streaming_memory.json")
    args = parser.parse_args()
    if min(args.frames, args.frame_size, args.batch_size) <= 0:
        parser.error("frames, frame-size and batch-size must be positive")

    if args.worker:
        print(json.dumps(_worker(args.worker, args.frames, args.frame_size, args.batch_size)))
        return

    materialize = _run_child("materialize", args)
    streaming = _run_child("streaming", args)
    result = {
        "schema_version": 1,
        "status": "ok",
        "config": {
            "frames": args.frames,
            "frame_size": args.frame_size,
            "batch_size": args.batch_size,
            "measurement": "separate child process per mode",
        },
        "materialize": materialize,
        "streaming": streaming,
        "assertions": {
            "streaming_pixel_lifetime_is_bounded": streaming["peak_frames_in_memory"] <= args.batch_size,
            "streaming_prepared_bytes_bounded": streaming["prepared_pixel_peak_bytes"]
            <= args.batch_size * args.frame_size * args.frame_size * 3,
        },
        "notes": [
            "RSS includes interpreter and NumPy allocator overhead; compare deltas, not absolute baselines.",
            "The synthetic worker does not load a CLIP model or decode a real video.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"Benchmark JSON: {args.output}")


if __name__ == "__main__":
    main()
