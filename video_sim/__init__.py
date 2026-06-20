"""
video_sim - Video Similarity Search Library

A modular library for video similarity search using frame-level embeddings
and FAISS vector indexing.

This package uses lazy loading for heavy dependencies (torch, faiss, transformers).
Only lightweight modules are imported at package initialization.

Usage:
    # These work immediately (no torch/faiss loading):
    from video_sim import Config, VideoScanner, VideoInfo, scan_videos
    from video_sim import BatchReportData, write_json_report, write_csv_report, write_html_report
    from video_sim import PreprocessConfig, ResizeMode

    # These trigger lazy loading of heavy dependencies:
    from video_sim import VideoEmbedder, VideoIndexer, VideoMatcher
    from video_sim.frame_sampler import FrameSampler, sample_frames
    from video_sim.segmenter import fixed_window_similarity, aggregate_segments
"""

__version__ = "1.0.0"

# ============================================================================
# Lightweight imports only - no torch, faiss, transformers, cv2, etc.
# ============================================================================
from video_sim.config import Config
from video_sim.scanner import VideoScanner, VideoInfo, scan_videos
from video_sim.reporter import (
    BatchReportData,
    Reporter,
    write_json_report,
    write_csv_report,
    write_html_report,
)
from video_sim.preprocess import PreprocessConfig, ResizeMode

# ============================================================================
# Heavy modules - available via lazy loading
# ============================================================================
_LAZY_MODULES = {
    "FrameSampler": ("video_sim.frame_sampler", "FrameSampler"),
    "sample_frames": ("video_sim.frame_sampler", "sample_frames"),
    "compute_frame_features": ("video_sim.frame_sampler", "compute_frame_features"),
    "DynamicFrameSampler": ("video_sim.frame_sampler", "DynamicFrameSampler"),
    "dynamic_sample_frames": ("video_sim.frame_sampler", "dynamic_sample_frames"),
    "RetainedFrame": ("video_sim.frame_sampler", "RetainedFrame"),
    "compute_phash_similarity": ("video_sim.frame_sampler", "compute_phash_similarity"),
    "VideoEmbedder": ("video_sim.embedder", "VideoEmbedder"),
    "embed_video": ("video_sim.embedder", "embed_video"),
    "FrameEmbeddingCache": ("video_sim.embedder", "FrameEmbeddingCache"),
    "embed_frames_with_cache": ("video_sim.embedder", "embed_frames_with_cache"),
    "l2_normalize": ("video_sim.embedder", "l2_normalize"),
    "VideoIndexer": ("video_sim.indexer", "VideoIndexer"),
    "build_index": ("video_sim.indexer", "build_index"),
    "FrameIndexResult": ("video_sim.indexer", "FrameIndexResult"),
    "build_frame_index": ("video_sim.indexer", "build_frame_index"),
    "build_frame_index_from_path": ("video_sim.indexer", "build_frame_index_from_path"),
    "VideoMatcher": ("video_sim.matcher", "VideoMatcher"),
    "query": ("video_sim.matcher", "query"),
    "FrameMatch": ("video_sim.matcher", "FrameMatch"),
    "ContainmentResult": ("video_sim.matcher", "ContainmentResult"),
    "compare_videos_bidirectional": ("video_sim.matcher", "compare_videos_bidirectional"),
    "compare_frame_indexes_bidirectional": ("video_sim.matcher", "compare_frame_indexes_bidirectional"),
    # Segmenter (requires matcher types)
    "WindowSimilarity": ("video_sim.segmenter", "WindowSimilarity"),
    "MatchedSegment": ("video_sim.segmenter", "MatchedSegment"),
    "fixed_window_similarity": ("video_sim.segmenter", "fixed_window_similarity"),
    "aggregate_segments": ("video_sim.segmenter", "aggregate_segments"),
}

# What dir() and help() show
__all__ = [
    # Lightweight (immediately available)
    "Config",
    "VideoScanner",
    "VideoInfo",
    "scan_videos",
    "BatchReportData",
    "Reporter",
    "write_json_report",
    "write_csv_report",
    "write_html_report",
    "PreprocessConfig",
    "ResizeMode",
    # Heavy (lazy loaded)
    "FrameSampler",
    "sample_frames",
    "compute_frame_features",
    "DynamicFrameSampler",
    "dynamic_sample_frames",
    "RetainedFrame",
    "compute_phash_similarity",
    "VideoEmbedder",
    "embed_video",
    "FrameEmbeddingCache",
    "embed_frames_with_cache",
    "l2_normalize",
    "VideoIndexer",
    "build_index",
    "FrameIndexResult",
    "build_frame_index",
    "build_frame_index_from_path",
    "VideoMatcher",
    "query",
    "FrameMatch",
    "ContainmentResult",
    "compare_videos_bidirectional",
    "compare_frame_indexes_bidirectional",
    "WindowSimilarity",
    "MatchedSegment",
    "fixed_window_similarity",
    "aggregate_segments",
]


def __getattr__(name: str):
    """
    Lazy loading for heavy modules.

    This allows `from video_sim import VideoEmbedder` to work,
    but the actual import (and torch loading) only happens when
    the attribute is first accessed.
    """
    if name in _LAZY_MODULES:
        module_path, attr_name = _LAZY_MODULES[name]
        import importlib

        module = importlib.import_module(module_path)
        attr = getattr(module, attr_name)
        # Cache it so subsequent accesses don't re-import
        globals()[name] = attr
        return attr

    raise AttributeError(f"module 'video_sim' has no attribute {name!r}")


def __dir__():
    """Make sure lazy-loaded names appear in dir()."""
    return __all__
