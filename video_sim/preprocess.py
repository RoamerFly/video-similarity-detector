"""
Frame preprocessing module for video similarity search.

Provides unified preprocessing for frames before pHash computation and CLIP embedding.
Handles different resolutions, black borders, and aspect ratio variations.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Tuple

import cv2
import numpy as np
from PIL import Image


class ResizeMode(str, Enum):
    """Resize mode for frame preprocessing."""
    CENTER_CROP = "center_crop"
    LETTERBOX = "letterbox"


class PortraitRotation(str, Enum):
    """Rotation direction used when cropped frames are portrait-oriented."""
    LEFT_90 = "left_90"
    RIGHT_90 = "right_90"


@dataclass
class PreprocessConfig:
    """Configuration for frame preprocessing."""
    crop_black_borders: bool = False
    resize_mode: ResizeMode = ResizeMode.CENTER_CROP
    input_size: int = 224
    portrait_rotation: PortraitRotation = PortraitRotation.RIGHT_90
    border_threshold: int = 16  # Pixel value threshold for black detection
    border_crop_ratio: float = 0.02  # Minimum border size ratio to detect

    @classmethod
    def from_args(cls, args) -> "PreprocessConfig":
        """Create config from argparse namespace."""
        return cls(
            crop_black_borders=getattr(args, "crop_black_borders", False),
            resize_mode=ResizeMode(getattr(args, "resize_mode", "center_crop")),
            input_size=max(1, int(getattr(args, "input_size", 224))),
            portrait_rotation=PortraitRotation(
                getattr(args, "portrait_rotation", "right_90")
            ),
        )

    @property
    def cache_suffix(self) -> str:
        """
        Generate a suffix for cache file naming.

        Returns a string that uniquely identifies this preprocessing configuration.
        Used to prevent cache collisions between different preprocessing settings.

        Returns:
            Suffix string like "_crop_center_crop_224" or "_center_crop_224"
        """
        parts = []
        if self.crop_black_borders:
            parts.append("crop")
        parts.append(self.resize_mode.value)
        parts.append(str(self.input_size))
        parts.append(self.portrait_rotation.value)
        return "_" + "_".join(parts)

    def to_dict(self) -> dict:
        """Convert config to dictionary for serialization."""
        return {
            "crop_black_borders": self.crop_black_borders,
            "resize_mode": self.resize_mode.value,
            "input_size": self.input_size,
            "portrait_rotation": self.portrait_rotation.value,
            "border_threshold": self.border_threshold,
            "border_crop_ratio": self.border_crop_ratio,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PreprocessConfig":
        """Create config from dictionary."""
        return cls(
            crop_black_borders=data.get("crop_black_borders", False),
            resize_mode=ResizeMode(data.get("resize_mode", "center_crop")),
            input_size=data.get("input_size", 224),
            portrait_rotation=PortraitRotation(data.get("portrait_rotation", "right_90")),
            border_threshold=data.get("border_threshold", 16),
            border_crop_ratio=data.get("border_crop_ratio", 0.02),
        )


def detect_black_borders(
    frame: np.ndarray,
    threshold: int = 16,
    min_ratio: float = 0.02,
) -> Tuple[int, int, int, int]:
    """
    Detect black borders in a frame.

    Args:
        frame: Input frame (H, W, 3) uint8
        threshold: Pixel value threshold for black detection (0-255)
        min_ratio: Minimum border size ratio to detect

    Returns:
        Tuple of (top, bottom, left, right) crop coordinates
    """
    h, w = frame.shape[:2]

    # Convert to grayscale for analysis
    if len(frame.shape) == 3:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    else:
        gray = frame

    # Find non-black regions
    mask = gray > threshold

    # Find bounding box of non-black content
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)

    if not np.any(rows) or not np.any(cols):
        # Entire frame is black, return original
        return 0, h, 0, w

    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]

    # Check if borders are significant enough to crop
    min_h_border = int(h * min_ratio)
    min_w_border = int(w * min_ratio)

    top = rmin if rmin >= min_h_border else 0
    bottom = rmax + 1 if (h - rmax - 1) >= min_h_border else h
    left = cmin if cmin >= min_w_border else 0
    right = cmax + 1 if (w - cmax - 1) >= min_w_border else w

    return top, bottom, left, right


def crop_black_borders(
    frame: np.ndarray,
    threshold: int = 16,
    min_ratio: float = 0.02,
) -> np.ndarray:
    """
    Crop black borders from a frame.

    Args:
        frame: Input frame (H, W, 3) uint8
        threshold: Pixel value threshold for black detection
        min_ratio: Minimum border size ratio to detect

    Returns:
        Cropped frame
    """
    top, bottom, left, right = detect_black_borders(frame, threshold, min_ratio)
    return frame[top:bottom, left:right]


def resize_with_aspect_ratio(
    frame: np.ndarray,
    target_size: int,
    mode: ResizeMode = ResizeMode.CENTER_CROP,
    interpolation: int = cv2.INTER_LINEAR,
) -> np.ndarray:
    """
    Resize frame while handling aspect ratio.

    Args:
        frame: Input frame (H, W, 3) uint8
        target_size: Target size (square)
        mode: Resize mode (center_crop or letterbox)
        interpolation: OpenCV interpolation method

    Returns:
        Resized frame (target_size, target_size, 3)
    """
    h, w = frame.shape[:2]

    if h == 0 or w == 0:
        return np.zeros((target_size, target_size, 3), dtype=np.uint8)

    if mode == ResizeMode.CENTER_CROP:
        # Resize to match shorter side, then center crop
        scale = target_size / min(h, w)
        new_h, new_w = int(h * scale), int(w * scale)
        resized = cv2.resize(frame, (new_w, new_h), interpolation=interpolation)

        # Center crop
        start_h = (new_h - target_size) // 2
        start_w = (new_w - target_size) // 2
        cropped = resized[start_h:start_h + target_size, start_w:start_w + target_size]

        # Handle case where crop might be slightly off
        if cropped.shape[0] != target_size or cropped.shape[1] != target_size:
            cropped = cv2.resize(cropped, (target_size, target_size), interpolation=interpolation)

        return cropped

    else:  # letterbox
        # Resize to fit within target_size, pad with black
        scale = target_size / max(h, w)
        new_h, new_w = int(h * scale), int(w * scale)
        resized = cv2.resize(frame, (new_w, new_h), interpolation=interpolation)

        # Create black canvas
        canvas = np.zeros((target_size, target_size, 3), dtype=np.uint8)

        # Center the resized image
        start_h = (target_size - new_h) // 2
        start_w = (target_size - new_w) // 2
        canvas[start_h:start_h + new_h, start_w:start_w + new_w] = resized

        return canvas


def rotate_portrait_frame(
    frame: np.ndarray,
    rotation: PortraitRotation = PortraitRotation.RIGHT_90,
) -> np.ndarray:
    """
    Rotate portrait frames into landscape orientation.

    Landscape or square frames are returned unchanged. The rotation is applied
    after black-border cropping so letterboxed portrait videos are detected by
    their real visible content.
    """
    h, w = frame.shape[:2]
    if h <= w:
        return frame

    if rotation == PortraitRotation.LEFT_90:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)


def preprocess_frame_geometry(
    frame: np.ndarray,
    config: PreprocessConfig = None,
    target_size: int = None,
    interpolation: int = cv2.INTER_LINEAR,
) -> np.ndarray:
    """
    Apply the shared geometric preprocessing pipeline.

    Order: crop black borders -> rotate portrait content -> resize/crop to a
    fixed square resolution. This keeps all compared frames on the same pixel
    grid before pHash or embedding similarity is calculated.
    """
    if config is None:
        config = PreprocessConfig()

    result = frame.copy()

    if config.crop_black_borders:
        result = crop_black_borders(
            result,
            threshold=config.border_threshold,
            min_ratio=config.border_crop_ratio,
        )

    result = rotate_portrait_frame(result, config.portrait_rotation)

    size = max(1, int(target_size or config.input_size))
    if result.shape[0] != size or result.shape[1] != size:
        result = resize_with_aspect_ratio(
            result,
            target_size=size,
            mode=config.resize_mode,
            interpolation=interpolation,
        )

    return result


def preprocess_frame_for_hash(
    frame: np.ndarray,
    config: PreprocessConfig = None,
) -> np.ndarray:
    """
    Preprocess a frame for perceptual hash computation.

    Args:
        frame: Input frame (H, W, 3) uint8 (BGR from OpenCV or RGB)
        config: Preprocessing configuration

    Returns:
        Preprocessed frame ready for pHash computation
    """
    if config is None:
        config = PreprocessConfig()

    return preprocess_frame_geometry(
        frame,
        config,
        target_size=config.input_size,
        interpolation=cv2.INTER_AREA,
    )


def preprocess_frame_for_clip(
    frame: np.ndarray,
    config: PreprocessConfig = None,
) -> np.ndarray:
    """
    Preprocess a frame for CLIP embedding.

    Args:
        frame: Input frame (H, W, 3) uint8 (BGR from OpenCV or RGB)
        config: Preprocessing configuration

    Returns:
        Preprocessed frame ready for CLIP (input_size, input_size, 3) uint8
    """
    if config is None:
        config = PreprocessConfig()

    return preprocess_frame_geometry(frame, config, target_size=config.input_size)


def preprocess_frame_for_clip_pil(
    frame: Image.Image,
    config: PreprocessConfig = None,
) -> Image.Image:
    """
    Preprocess a PIL Image for CLIP embedding.

    Args:
        frame: Input PIL Image (RGB)
        config: Preprocessing configuration

    Returns:
        Preprocessed PIL Image ready for CLIP
    """
    if config is None:
        config = PreprocessConfig()

    # Convert PIL to numpy for processing
    np_frame = np.array(frame)

    # Process
    processed = preprocess_frame_for_clip(np_frame, config)

    # Convert back to PIL
    return Image.fromarray(processed)


def add_preprocess_args(parser):
    """
    Add preprocessing arguments to an argument parser.

    Args:
        parser: argparse.ArgumentParser instance
    """
    parser.add_argument(
        "--crop-black-borders",
        action="store_true",
        default=False,
        help="Auto-crop black borders from frames (default: disabled)",
    )
    parser.add_argument(
        "--resize-mode",
        type=str,
        default="center_crop",
        choices=["center_crop", "letterbox"],
        help="Resize mode for aspect ratio handling (default: center_crop)",
    )
    parser.add_argument(
        "--input-size",
        type=int,
        default=224,
        help="Matching resolution used before similarity calculation (default: 224)",
    )
    parser.add_argument(
        "--portrait-rotation",
        type=str,
        default="right_90",
        choices=["left_90", "right_90"],
        help="Rotate cropped portrait videos left or right before matching (default: right_90)",
    )
