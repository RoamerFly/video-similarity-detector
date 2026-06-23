"""
Tests for dynamic frame sampling functionality.

Tests cover:
- pHash similarity calculation
- First frame always retained
- max_gap_sec forced retention
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import cv2
import imagehash
import numpy as np
import pytest
from PIL import Image

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.frame_sampler import (
    DynamicFrameSampler,
    RetainedFrame,
    compute_phash_similarity,
)


def _create_checkerboard(size: int = 64, square_size: int = 8) -> Image.Image:
    """Create a black and white checkerboard pattern."""
    img = np.zeros((size, size, 3), dtype=np.uint8)
    for i in range(0, size, square_size):
        for j in range(0, size, square_size):
            if (i // square_size + j // square_size) % 2 == 0:
                img[i:i+square_size, j:j+square_size] = (255, 255, 255)
    return Image.fromarray(img)


class TestPHashSimilarity:
    """Tests for pHash similarity calculation."""

    def test_identical_hashes(self):
        """Test that identical hashes have similarity of 1.0."""
        # Create a simple image
        img = Image.new("RGB", (64, 64), color="red")
        hash1 = imagehash.phash(img)
        hash2 = imagehash.phash(img)

        similarity = compute_phash_similarity(hash1, hash2)

        assert similarity == 1.0

    def test_different_hashes(self):
        """Test that different images have similarity < 1.0."""
        # Create two structurally different images:
        # - img1: solid color (uniform frequency)
        # - img2: checkerboard pattern (high frequency edges)
        img1 = Image.new("RGB", (64, 64), color="red")
        img2 = _create_checkerboard(size=64, square_size=8)

        hash1 = imagehash.phash(img1)
        hash2 = imagehash.phash(img2)

        similarity = compute_phash_similarity(hash1, hash2)

        # Different images should have similarity < 1.0
        assert similarity < 1.0
        # But similarity should be >= 0
        assert similarity >= 0.0

    def test_similarity_range(self):
        """Test that similarity is always in range [0, 1]."""
        # Create several different images
        images = [
            Image.new("RGB", (64, 64), color=c)
            for c in ["red", "blue", "green", "white", "black"]
        ]
        hashes = [imagehash.phash(img) for img in images]

        # Compare all pairs
        for i in range(len(hashes)):
            for j in range(i + 1, len(hashes)):
                similarity = compute_phash_similarity(hashes[i], hashes[j])
                assert 0.0 <= similarity <= 1.0, f"Similarity out of range: {similarity}"

    def test_symmetry(self):
        """Test that similarity is symmetric: sim(A, B) == sim(B, A)."""
        img1 = Image.new("RGB", (64, 64), color="red")
        img2 = _create_checkerboard(size=64, square_size=8)

        hash1 = imagehash.phash(img1)
        hash2 = imagehash.phash(img2)

        sim_12 = compute_phash_similarity(hash1, hash2)
        sim_21 = compute_phash_similarity(hash2, hash1)

        assert sim_12 == sim_21


class TestFirstFrameAlwaysRetained:
    """Test that the first frame is always retained."""

    def test_first_frame_retained(self, tmp_path):
        """First frame of any video should always be retained."""
        # Create a simple test video with identical frames
        video_path = tmp_path / "test_video.mp4"
        self._create_test_video(video_path, num_frames=30, frame_color=(128, 128, 128))

        sampler = DynamicFrameSampler(
            skip_threshold=0.99,  # Very high threshold
            max_gap_sec=100.0,  # Very large gap to avoid forced retention
            cache_dir=tmp_path,
        )

        retained = sampler.sample(video_path)

        # First frame should always be retained
        assert len(retained) >= 1
        assert retained[0].frame_index == 0
        assert retained[0].timestamp == 0.0

    def _create_test_video(
        self, video_path: Path, num_frames: int, frame_color: tuple
    ):
        """Helper to create a test video."""
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(str(video_path), fourcc, 30.0, (64, 64))

        for _ in range(num_frames):
            frame = np.full((64, 64, 3), frame_color, dtype=np.uint8)
            out.write(frame)

        out.release()


class TestMaxGapForcedRetention:
    """Test that max_gap_sec forces frame retention."""

    def test_max_gap_forces_retention(self, tmp_path):
        """Frames should be retained at least every max_gap_sec."""
        # Create a test video with identical frames
        video_path = tmp_path / "test_gap.mp4"
        fps = 30.0
        duration_sec = 3.0  # 3 seconds
        num_frames = int(fps * duration_sec)
        self._create_test_video(video_path, num_frames=num_frames, fps=fps)

        # Set max_gap_sec to 1 second
        max_gap_sec = 1.0
        sampler = DynamicFrameSampler(
            skip_threshold=0.99,  # Very high - almost all frames are "similar"
            max_gap_sec=max_gap_sec,
            cache_dir=tmp_path,
        )

        retained = sampler.sample(video_path)

        # With identical frames and high skip_threshold, we should get
        # approximately duration/max_gap_sec frames due to forced retention
        expected_min_retained = int(duration_sec / max_gap_sec)

        # First frame + forced frames every max_gap_sec
        assert len(retained) >= expected_min_retained

        # Verify timestamps are approximately evenly spaced
        timestamps = [rf.timestamp for rf in retained]
        for i in range(1, len(timestamps)):
            gap = timestamps[i] - timestamps[i - 1]
            # Gap should not exceed max_gap_sec by more than 1 frame
            assert gap <= max_gap_sec + 1.0 / fps + 0.01

    def test_gap_calculation(self, tmp_path):
        """Test that gap calculation is correct in frame indices."""
        video_path = tmp_path / "test_gap_calc.mp4"
        fps = 10.0  # Low fps for easier testing
        duration_sec = 2.0
        num_frames = int(fps * duration_sec)
        self._create_test_video(video_path, num_frames=num_frames, fps=fps)

        max_gap_sec = 0.5
        max_gap_frames = int(max_gap_sec * fps)  # Should be 5 frames

        sampler = DynamicFrameSampler(
            skip_threshold=0.99,
            max_gap_sec=max_gap_sec,
            cache_dir=tmp_path,
        )

        retained = sampler.sample(video_path)

        # Check that no consecutive retained frames are more than max_gap_frames apart
        for i in range(1, len(retained)):
            gap_frames = retained[i].frame_index - retained[i - 1].frame_index
            assert gap_frames <= max_gap_frames + 1  # Allow +1 for rounding

    def _create_test_video(
        self, video_path: Path, num_frames: int, fps: float = 30.0
    ):
        """Helper to create a test video with identical frames."""
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(str(video_path), fourcc, fps, (64, 64))

        for _ in range(num_frames):
            # Create a simple frame with some pattern
            frame = np.zeros((64, 64, 3), dtype=np.uint8)
            frame[:] = (100, 100, 100)  # Gray frame
            out.write(frame)

        out.release()


class TestDynamicFrameSamplerBasic:
    """Basic tests for DynamicFrameSampler."""

    def test_retained_frame_attributes(self, tmp_path):
        """Test that RetainedFrame has all required attributes."""
        video_path = tmp_path / "test_attrs.mp4"
        self._create_test_video(video_path, num_frames=10)

        sampler = DynamicFrameSampler(
            skip_threshold=0.90,
            max_gap_sec=1.0,
            cache_dir=tmp_path,
        )

        retained = sampler.sample(video_path)

        assert len(retained) >= 1
        rf = retained[0]

        # Check all required attributes exist and have correct types
        assert hasattr(rf, "video_path")
        assert hasattr(rf, "frame_index")
        assert hasattr(rf, "timestamp")
        assert hasattr(rf, "phash")
        assert hasattr(rf, "thumbnail_path")

        assert isinstance(rf.video_path, str)
        assert isinstance(rf.frame_index, int)
        assert isinstance(rf.timestamp, float)
        assert isinstance(rf.phash, str)
        assert isinstance(rf.thumbnail_path, str)

    def test_thumbnail_saved(self, tmp_path):
        """Test that thumbnails are actually saved to disk."""
        video_path = tmp_path / "test_thumb.mp4"
        self._create_test_video(video_path, num_frames=10)

        sampler = DynamicFrameSampler(
            skip_threshold=0.90,
            max_gap_sec=1.0,
            cache_dir=tmp_path,
        )

        retained = sampler.sample(video_path)

        # Check that thumbnail files exist
        for rf in retained:
            thumb_path = Path(rf.thumbnail_path)
            assert thumb_path.exists(), f"Thumbnail not found: {thumb_path}"
            assert thumb_path.suffix == ".jpg"

    def test_video_not_found_error(self, tmp_path):
        """Test that FileNotFoundError is raised for missing video."""
        sampler = DynamicFrameSampler(
            skip_threshold=0.90,
            max_gap_sec=1.0,
            cache_dir=tmp_path,
        )

        with pytest.raises(FileNotFoundError):
            sampler.sample(tmp_path / "nonexistent.mp4")

    def test_sparse_sampling_prefers_sequential_opencv(self, tmp_path):
        video_path = tmp_path / "sparse.mp4"
        video_path.touch()
        sampler = DynamicFrameSampler(
            skip_threshold=0.90,
            max_gap_sec=1.0,
            frame_step=30,
            cache_dir=tmp_path,
        )
        expected = [MagicMock()]

        with (
            patch.object(sampler, "_sample_with_opencv", return_value=expected) as opencv,
            patch.object(sampler, "_sample_with_decord") as decord,
        ):
            retained = sampler.sample(video_path)

        assert retained is expected
        opencv.assert_called_once()
        decord.assert_not_called()

    def test_sparse_sampling_falls_back_to_decord(self, tmp_path):
        video_path = tmp_path / "fallback.mp4"
        video_path.touch()
        sampler = DynamicFrameSampler(
            skip_threshold=0.90,
            max_gap_sec=1.0,
            frame_step=30,
            cache_dir=tmp_path,
        )
        expected = [MagicMock()]

        with (
            patch.object(sampler, "_sample_with_opencv", side_effect=ValueError("open failed")),
            patch.object(sampler, "_sample_with_decord", return_value=expected) as decord,
        ):
            retained = sampler.sample(video_path)

        assert retained is expected
        decord.assert_called_once()

    def _create_test_video(self, video_path: Path, num_frames: int):
        """Helper to create a test video."""
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(str(video_path), fourcc, 30.0, (64, 64))

        for i in range(num_frames):
            # Create frames with varying content
            frame = np.zeros((64, 64, 3), dtype=np.uint8)
            # Add some variation
            frame[:] = (i * 25 % 256, 100, 150)
            out.write(frame)

        out.release()


class TestVisuallyDifferentFrames:
    """Test that visually different frames are retained."""

    def test_different_scenes_retained(self, tmp_path):
        """Frames with significantly different content should be retained."""
        video_path = tmp_path / "test_scenes.mp4"
        self._create_video_with_scenes(video_path)

        sampler = DynamicFrameSampler(
            skip_threshold=0.90,
            max_gap_sec=10.0,  # Large gap to avoid forced retention
            cache_dir=tmp_path,
        )

        retained = sampler.sample(video_path)

        # With 3 very different scenes, we should retain at least 3 frames
        assert len(retained) >= 3

    def _create_video_with_scenes(self, video_path: Path):
        """Create a video with 3 structurally distinct scenes."""
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(str(video_path), fourcc, 10.0, (64, 64))

        # Scene 1: White background with black rectangle
        for _ in range(10):
            frame = np.full((64, 64, 3), (255, 255, 255), dtype=np.uint8)
            cv2.rectangle(frame, (10, 10), (54, 54), (0, 0, 0), -1)
            out.write(frame)

        # Scene 2: Black background with white circle
        for _ in range(10):
            frame = np.zeros((64, 64, 3), dtype=np.uint8)
            cv2.circle(frame, (32, 32), 25, (255, 255, 255), -1)
            out.write(frame)

        # Scene 3: Gray background with checkerboard pattern
        for _ in range(10):
            frame = np.full((64, 64, 3), (128, 128, 128), dtype=np.uint8)
            square_size = 8
            for i in range(0, 64, square_size):
                for j in range(0, 64, square_size):
                    if (i // square_size + j // square_size) % 2 == 0:
                        frame[i:i+square_size, j:j+square_size] = (255, 255, 255)
                    else:
                        frame[i:i+square_size, j:j+square_size] = (0, 0, 0)
            out.write(frame)

        out.release()
