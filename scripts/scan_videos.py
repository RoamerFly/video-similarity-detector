#!/usr/bin/env python3
"""
Scan videos script - Discover and list video files.

Usage:
    python scripts/scan_videos.py [--dir VIDEOS_DIR] [--recursive]
"""

import argparse
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.scanner import VideoScanner
from video_sim.config import Config


def main():
    parser = argparse.ArgumentParser(description="Scan for video files")
    parser.add_argument(
        "--dir",
        type=str,
        default=None,
        help="Directory to scan (default: videos/)",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Scan subdirectories recursively",
    )
    args = parser.parse_args()

    videos_dir = args.dir or Config.VIDEOS_DIR
    scanner = VideoScanner(videos_dir=videos_dir)

    videos = scanner.scan(recursive=args.recursive)

    if not videos:
        print(f"No videos found in {videos_dir}")
        return

    print(f"Found {len(videos)} videos in {videos_dir}")
    print("=" * 50)

    total_size = 0
    for i, video in enumerate(videos, 1):
        print(f"{i:3d}. {video.name:40s} ({video.size_mb:8.2f} MB)")
        total_size += video.size_mb

    print("=" * 50)
    print(f"Total: {len(videos)} videos, {total_size:.2f} MB")


if __name__ == "__main__":
    main()
