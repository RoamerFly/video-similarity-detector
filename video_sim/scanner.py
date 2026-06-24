"""
Video scanner module for video similarity search.

Provides video file discovery and metadata extraction.
"""

from dataclasses import dataclass
import os
from pathlib import Path
from typing import List, Optional, Union

from video_sim.config import Config

# Default video extensions
VIDEO_EXTENSIONS = (".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv")


def _scan_video_paths(input_path: Path, recursive: bool, extensions: tuple[str, ...]) -> List[Path]:
    videos: List[Path] = []
    stack = [input_path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if recursive:
                                stack.append(Path(entry.path))
                            continue
                        if (
                            entry.is_file(follow_symlinks=False)
                            and Path(entry.name).suffix.lower() in extensions
                        ):
                            videos.append(Path(entry.path))
                    except OSError:
                        continue
        except OSError:
            continue
    return videos


def scan_videos(input_dir: Union[str, Path], recursive: bool = True) -> List[Path]:
    """
    Scan directory for video files.

    Recursively scans the input directory for video files with supported extensions.
    Returns sorted list of video file paths.

    Args:
        input_dir: Directory to scan for videos
        recursive: Whether to scan subdirectories (default: True)

    Returns:
        Sorted list of Path objects for discovered video files
    """
    input_path = Path(input_dir)
    if not input_path.exists():
        print(f"Warning: Input directory not found: {input_path}")
        return []

    videos = _scan_video_paths(input_path, recursive, VIDEO_EXTENSIONS)

    return sorted(videos, key=lambda p: p.name)


@dataclass
class VideoInfo:
    """Video file information."""

    path: Path
    name: str
    size_mb: float
    extension: str

    @property
    def stem(self) -> str:
        """Get the filename without extension."""
        return self.path.stem


class VideoScanner:
    """
    Scanner for discovering and managing video files.
    """

    def __init__(
        self,
        videos_dir: Optional[Union[str, Path]] = None,
        extensions: Optional[tuple] = None,
    ):
        """
        Initialize the video scanner.

        Args:
            videos_dir: Directory to scan for videos
            extensions: Tuple of video file extensions to include
        """
        self.videos_dir = Path(videos_dir) if videos_dir else Config.VIDEOS_DIR
        self.extensions = extensions or Config.VIDEO_EXTENSIONS

    def scan(self, recursive: bool = False) -> List[VideoInfo]:
        """
        Scan for video files.

        Args:
            recursive: Whether to scan subdirectories

        Returns:
            List of VideoInfo objects
        """
        if not self.videos_dir.exists():
            print(f"Warning: Videos directory not found: {self.videos_dir}")
            return []

        videos = []
        for path in _scan_video_paths(self.videos_dir, recursive, self.extensions):
            try:
                size_mb = path.stat().st_size / (1024 * 1024)
            except OSError:
                continue
            videos.append(
                VideoInfo(
                    path=path,
                    name=path.name,
                    size_mb=size_mb,
                    extension=path.suffix.lower(),
                )
            )

        return sorted(videos, key=lambda v: v.name)

    def get_video_path(self, video_name: str) -> Optional[Path]:
        """
        Get the full path for a video by name.

        Args:
            video_name: Name of the video file

        Returns:
            Full path to the video or None if not found
        """
        path = self.videos_dir / video_name
        if path.exists():
            return path
        return None

    def get_videos_list(self) -> List[str]:
        """
        Get a list of video filenames.

        Returns:
            List of video filenames
        """
        return [v.name for v in self.scan()]

    def count_videos(self) -> int:
        """
        Count the number of video files.

        Returns:
            Number of video files found
        """
        return len(self.scan())

    def print_summary(self) -> None:
        """Print a summary of discovered videos."""
        videos = self.scan()
        if not videos:
            print(f"No videos found in {self.videos_dir}")
            return

        total_size = sum(v.size_mb for v in videos)
        print(f"Found {len(videos)} videos in {self.videos_dir}")
        print(f"Total size: {total_size:.2f} MB")
        print("\nVideos:")
        for v in videos:
            print(f"  - {v.name} ({v.size_mb:.2f} MB)")
