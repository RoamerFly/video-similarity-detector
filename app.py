"""
Flask API for video similarity search - Backward compatible.

This module provides a web API for indexing and querying videos.
"""

from flask import Flask, request, jsonify
from pathlib import Path
import sys

# Add current directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from video_sim.embedder import get_embedder
from video_sim.frame_sampler import sample_frames
from video_sim.matcher import VideoMatcher
from video_sim.indexer import VideoIndexer

app = Flask(__name__)

# Configuration
INDEX_FILE = "faiss_video_index.bin"
META_FILE = "video_meta.txt"

# Lazy initialization for models
_embedder = None
_matcher = None


def get_models():
    """Get or initialize models."""
    global _embedder, _matcher
    if _embedder is None:
        _embedder = get_embedder()
    if _matcher is None:
        _matcher = VideoMatcher(use_legacy_paths=True)
        try:
            _matcher.load()
        except FileNotFoundError:
            print("Warning: Index file not found. Query endpoint will not work.")
    return _embedder, _matcher


@app.route("/index", methods=["POST"])
def index_video():
    """Index a video."""
    video_path = request.json.get("video_path")
    video_id = request.json.get("video_id")
    if not video_path or not video_id:
        return jsonify({"error": "Missing video_path or video_id"}), 400

    try:
        embedder, _ = get_models()
        frames = sample_frames(video_path)
        emb = embedder.embed(frames)

        # For now, just return the embedding
        # In production, you'd store this in a database or index
        return jsonify({
            "message": f"Video {video_id} processed successfully.",
            "embedding_shape": emb.shape.tolist()
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/query", methods=["POST"])
def query_video():
    """Query for similar videos."""
    video_path = request.json.get("video_path")
    top_k = request.json.get("top_k", 5)
    if not video_path:
        return jsonify({"error": "Missing video_path"}), 400

    try:
        embedder, matcher = get_models()
        results = matcher.search_by_video(video_path, top_k=top_k, embedder=embedder)

        return jsonify({
            "query_video": video_path,
            "results": [
                {"video": name, "similarity": score}
                for name, score in results
            ]
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
