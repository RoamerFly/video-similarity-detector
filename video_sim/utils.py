"""
Utility functions for video similarity search.
"""

import logging
from pathlib import Path
from typing import List, Optional, Union

import numpy as np

logger = logging.getLogger(__name__)


def normalize_vector(vector: np.ndarray) -> np.ndarray:
    """
    Normalize a vector to unit length.

    Args:
        vector: Input vector

    Returns:
        Normalized vector
    """
    norm = np.linalg.norm(vector)
    if norm > 0:
        return vector / norm
    return vector


def cosine_similarity(vec1: np.ndarray, vec2: np.ndarray) -> float:
    """
    Compute cosine similarity between two vectors.

    Args:
        vec1: First vector
        vec2: Second vector

    Returns:
        Cosine similarity score
    """
    vec1_norm = normalize_vector(vec1)
    vec2_norm = normalize_vector(vec2)
    return float(np.dot(vec1_norm, vec2_norm))


def load_video_list(meta_file: Union[str, Path]) -> List[str]:
    """
    Load video names from metadata file.

    Args:
        meta_file: Path to the metadata file

    Returns:
        List of video names
    """
    with open(meta_file, "r", encoding="utf-8") as f:
        return [line.strip() for line in f.readlines() if line.strip()]


def save_video_list(
    videos: List[str],
    output_file: Union[str, Path],
) -> None:
    """
    Save video names to metadata file.

    Args:
        videos: List of video names
        output_file: Path to the output file
    """
    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        for video in videos:
            f.write(video + "\n")


def load_embedding(embedding_path: Union[str, Path]) -> np.ndarray:
    """
    Load an embedding from a .npy file.

    Args:
        embedding_path: Path to the embedding file

    Returns:
        Embedding vector
    """
    return np.load(embedding_path)


def save_embedding(
    embedding: np.ndarray,
    output_path: Union[str, Path],
) -> None:
    """
    Save an embedding to a .npy file.

    Args:
        embedding: Embedding vector
        output_path: Path to save the embedding
    """
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.save(output, embedding)


def compute_embedding_stats(embeddings: np.ndarray) -> dict:
    """
    Compute statistics for a set of embeddings.

    Args:
        embeddings: Array of embeddings (N, dim)

    Returns:
        Dictionary with statistics
    """
    norms = np.linalg.norm(embeddings, axis=1)
    return {
        "num_embeddings": len(embeddings),
        "dimension": embeddings.shape[1],
        "norm_mean": float(norms.mean()),
        "norm_std": float(norms.std()),
        "norm_min": float(norms.min()),
        "norm_max": float(norms.max()),
    }


def format_similarity(score: float) -> str:
    """
    Format a similarity score for display.

    Args:
        score: Similarity score

    Returns:
        Formatted string
    """
    return f"{score:.4f}"


def get_video_extensions() -> tuple:
    """
    Get supported video file extensions.

    Returns:
        Tuple of extensions
    """
    from video_sim.config import Config

    return Config.VIDEO_EXTENSIONS
