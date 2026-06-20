"""
Reporter module for video similarity search.

Provides report generation for search results and batch operations.
Supports JSON, CSV, and HTML output formats.
"""

import csv
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from video_sim.config import Config
from video_sim.matcher import ContainmentResult, SearchResult


@dataclass
class BatchReportData:
    """Data structure for batch comparison report."""

    timestamp: str
    video_pairs: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    total_possible_pairs: int = 0
    candidate_pairs: int = 0
    skipped_by_candidate_screening: int = 0

    def add_pair_result(
        self,
        result: ContainmentResult,
        segments: List[Dict] = None,
        windows: List[Dict] = None,
        windows_a_to_b: List[Dict] = None,
        windows_b_to_a: List[Dict] = None,
    ):
        """Add a video pair comparison result."""
        directional_windows = []
        for direction, items in [
            ("A_to_B", windows_a_to_b or []),
            ("B_to_A", windows_b_to_a or []),
        ]:
            for item in items:
                directional_windows.append({**item, "direction": direction})

        pair_data = {
            "completed_at": datetime.now().isoformat(timespec="seconds"),
            "video_a": Path(result.video_a).name,
            "video_b": Path(result.video_b).name,
            "video_a_path": result.video_a,
            "video_b_path": result.video_b,
            "a_in_b": result.a_in_b,
            "b_in_a": result.b_in_a,
            "symmetric_similarity": result.symmetric_similarity,
            "avg_similarity_a_to_b": result.avg_similarity_a_to_b,
            "avg_similarity_b_to_a": result.avg_similarity_b_to_a,
            "relation": result.relation,
            "total_frames_a": result.total_frames_a,
            "total_frames_b": result.total_frames_b,
            "duration_a": result.duration_a,
            "duration_b": result.duration_b,
            "raw_similarity_max": result.raw_similarity_max,
            "raw_similarity_mean": result.raw_similarity_mean,
            "raw_similarity_p95": result.raw_similarity_p95,
            "raw_similarity_p99": result.raw_similarity_p99,
            "matched_segment_count": len(segments) if segments else 0,
            "segments": segments or [],
            "windows": directional_windows or windows or [],
            "windows_a_to_b": windows_a_to_b or [],
            "windows_b_to_a": windows_b_to_a or [],
            "matches_a_to_b_total": len(result.matches_a_to_b),
            "matches_b_to_a_total": len(result.matches_b_to_a),
            "matches_a_to_b": _serialize_frame_matches(result.matches_a_to_b),
            "matches_b_to_a": _serialize_frame_matches(result.matches_b_to_a),
        }
        self.video_pairs.append(pair_data)

    def add_warning(self, message: str):
        """Add a warning message."""
        self.warnings.append(message)

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "timestamp": self.timestamp,
            "num_pairs": len(self.video_pairs),
            "total_possible_pairs": self.total_possible_pairs,
            "candidate_pairs": self.candidate_pairs,
            "skipped_by_candidate_screening": self.skipped_by_candidate_screening,
            "warnings": self.warnings,
            "video_pairs": self.video_pairs,
        }


def write_json_report(data: BatchReportData, output_path: Union[str, Path]) -> Path:
    """
    Write batch comparison results to JSON file.

    Args:
        data: Batch report data
        output_path: Output file path

    Returns:
        Path to the saved file
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data.to_dict(), f, indent=2, ensure_ascii=False)

    return output_path


def write_csv_report(data: BatchReportData, output_path: Union[str, Path]) -> Path:
    """
    Write batch comparison results to CSV file.

    Args:
        data: Batch report data
        output_path: Output file path

    Returns:
        Path to the saved file
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "completed_at",
        "video_a",
        "video_b",
        "a_in_b",
        "b_in_a",
        "symmetric_similarity",
        "avg_similarity_a_to_b",
        "avg_similarity_b_to_a",
        "relation",
        "total_frames_a",
        "total_frames_b",
        "duration_a",
        "duration_b",
        "raw_similarity_max",
        "raw_similarity_p95",
        "matched_segment_count",
    ]

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for pair in data.video_pairs:
            writer.writerow(pair)

    return output_path


def write_html_report(data: BatchReportData, output_path: Union[str, Path]) -> Path:
    """
    Write batch comparison results to HTML file.

    Generates an interactive HTML report with:
    - Video pairs sorted by symmetric similarity
    - Containment ratios (A_in_B, B_in_A)
    - Relation classification
    - Matched segments display
    - Thumbnail preview placeholders

    Args:
        data: Batch report data
        output_path: Output file path

    Returns:
        Path to the saved file
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Sort pairs by symmetric_similarity (descending)
    sorted_pairs = sorted(
        data.video_pairs, key=lambda p: p["symmetric_similarity"], reverse=True
    )

    html = _generate_html_content(data, sorted_pairs)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    return output_path


def _serialize_frame_matches(matches: List[Any], limit: int = 240) -> List[Dict[str, Any]]:
    """Serialize the highest-similarity frame matches for visual review."""
    top_matches = sorted(matches, key=lambda match: match.similarity, reverse=True)[:limit]
    return [match.to_dict() for match in top_matches]


def _generate_html_content(
    data: BatchReportData, sorted_pairs: List[Dict]
) -> str:
    """Generate HTML content for the report."""

    # Build pairs table rows
    pairs_rows = []
    for i, pair in enumerate(sorted_pairs):
        relation_class = _get_relation_class(pair["relation"])
        relation_label = _format_relation(pair["relation"])

        # Build segments HTML
        segments_html = ""
        if pair.get("segments"):
            segments_html = '<div class="segments"><strong>匹配片段(Matched Segments):</strong><ul>'
            for seg in pair["segments"][:5]:  # Show max 5 segments
                segments_html += f"""
                <li>
                    源片段(Source): {seg['source_start']:.1f}s - {seg['source_end']:.1f}s →
                    目标片段(Target): {seg['target_start']:.1f}s - {seg['target_end']:.1f}s
                    (相似度(sim)={seg['avg_similarity']:.3f}, 可信度(confidence)={seg['confidence']:.3f})
                </li>"""
            if len(pair["segments"]) > 5:
                segments_html += f'<li>... 还有 {len(pair["segments"]) - 5} 个片段(more segments)</li>'
            segments_html += "</ul></div>"

        windows_html = ""
        if pair.get("windows"):
            windows_html = '<div class="segments"><strong>时间窗口(Time Windows):</strong><ul>'
            for window in pair["windows"][:6]:
                direction = _format_direction(window.get("direction", "combined"))
                windows_html += f"""
                <li>
                    {direction}: {window['source_start']:.1f}s - {window['source_end']:.1f}s,
                    匹配比例(matched ratio): {window['matched_frame_ratio']:.3f},
                    平均相似度(avg sim): {window['avg_similarity']:.3f}
                </li>"""
            if len(pair["windows"]) > 6:
                windows_html += f'<li>... 还有 {len(pair["windows"]) - 6} 个窗口(more windows)</li>'
            windows_html += "</ul></div>"

        frame_match_count = pair.get("matches_a_to_b_total", 0) + pair.get("matches_b_to_a_total", 0)

        pairs_rows.append(f"""
        <tr class="{relation_class}">
            <td>{i + 1}</td>
            <td class="video-name" title="{pair['video_a_path']}">{pair['video_a']}</td>
            <td class="video-name" title="{pair['video_b_path']}">{pair['video_b']}</td>
            <td class="metric">{pair['a_in_b']:.4f}</td>
            <td class="metric">{pair['b_in_a']:.4f}</td>
            <td class="metric highlight">{pair['symmetric_similarity']:.4f}</td>
            <td><span class="relation-badge {relation_class}">{relation_label}</span></td>
            <td class="metric">{pair['matched_segment_count']}</td>
            <td class="metric">{frame_match_count}</td>
            <td>
                <details>
                    <summary>详情(Details)</summary>
                    <div class="details-content">
                        <p><strong>保留帧(Total Frames):</strong> A={pair['total_frames_a']}, B={pair['total_frames_b']}</p>
                        <p><strong>估算时长(Duration):</strong> A={float(pair.get('duration_a', 0.0)):.1f}s, B={float(pair.get('duration_b', 0.0)):.1f}s</p>
                        <p><strong>平均相似度(Avg Similarity):</strong> A→B={pair['avg_similarity_a_to_b']:.4f}, B→A={pair['avg_similarity_b_to_a']:.4f}</p>
                        <p><strong>原始统计(Raw Stats):</strong> max={pair['raw_similarity_max']:.4f}, p95={pair['raw_similarity_p95']:.4f}</p>
                        {segments_html}
                        {windows_html}
                    </div>
                </details>
            </td>
        </tr>""")

    # Warnings section
    warnings_html = ""
    if data.warnings:
        warnings_items = "".join(f"<li>{w}</li>" for w in data.warnings)
        warnings_html = f"""
        <div class="warnings">
            <h3>警告(Warnings)</h3>
            <ul>{warnings_items}</ul>
        </div>"""

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>视频相似度批量报告(Video Similarity Batch Report)</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }}
        h1, h2, h3 {{ color: #333; }}
        .header {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
        }}
        .header h1 {{ margin: 0; }}
        .header p {{ margin: 10px 0 0 0; opacity: 0.9; }}
        .summary {{
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        .summary-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
        }}
        .summary-item {{
            text-align: center;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
        }}
        .summary-item .value {{
            font-size: 24px;
            font-weight: bold;
            color: #667eea;
        }}
        .summary-item .label {{
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        th, td {{
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #eee;
        }}
        th {{
            background: #667eea;
            color: white;
            font-weight: 600;
        }}
        tr:hover {{
            background: #f8f9fa;
        }}
        .metric {{
            font-family: 'Monaco', 'Consolas', monospace;
            text-align: right;
        }}
        .highlight {{
            font-weight: bold;
            color: #667eea;
        }}
        .video-name {{
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }}
        .relation-badge {{
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }}
        .relation-badge.near-duplicate {{ background: #d4edda; color: #155724; }}
        .relation-badge.partial-overlap {{ background: #fff3cd; color: #856404; }}
        .relation-badge.clip {{ background: #cce5ff; color: #004085; }}
        .relation-badge.different {{ background: #f8d7da; color: #721c24; }}
        .warnings {{
            background: #fff3cd;
            border: 1px solid #ffc107;
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
        }}
        .warnings h3 {{ margin-top: 0; color: #856404; }}
        .warnings ul {{ margin-bottom: 0; }}
        details {{
            cursor: pointer;
        }}
        .details-content {{
            padding: 10px;
            background: #f8f9fa;
            border-radius: 5px;
            margin-top: 10px;
        }}
        .segments ul {{
            margin: 5px 0;
            padding-left: 20px;
        }}
        .segments li {{
            font-size: 12px;
            margin: 3px 0;
        }}
        .footer {{
            text-align: center;
            padding: 20px;
            color: #666;
            font-size: 12px;
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>视频相似度批量报告(Video Similarity Batch Report)</h1>
        <p>生成时间(Generated): {data.timestamp}</p>
    </div>

    {warnings_html}

    <div class="summary">
        <h2>摘要(Summary)</h2>
        <div class="summary-grid">
            <div class="summary-item">
                <div class="value">{len(sorted_pairs)}</div>
                <div class="label">视频对(Video Pairs)</div>
            </div>
            <div class="summary-item">
                <div class="value">{sum(1 for p in sorted_pairs if p['relation'] == 'near_duplicate_or_same_content')}</div>
                <div class="label">近似重复(Near Duplicates)</div>
            </div>
            <div class="summary-item">
                <div class="value">{sum(1 for p in sorted_pairs if 'clip' in p['relation'])}</div>
                <div class="label">片段包含(Clip Relations)</div>
            </div>
            <div class="summary-item">
                <div class="value">{sum(1 for p in sorted_pairs if p['relation'] == 'partial_overlap')}</div>
                <div class="label">部分重叠(Partial Overlaps)</div>
            </div>
            <div class="summary-item">
                <div class="value">{sum(1 for p in sorted_pairs if p['relation'] == 'different')}</div>
                <div class="label">差异较大(Different)</div>
            </div>
        </div>
    </div>

    <h2>视频对(Video Pairs，按相似度排序)</h2>
    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>视频 A(Video A)</th>
                <th>视频 B(Video B)</th>
                <th>A 包含于 B(A in B)</th>
                <th>B 包含于 A(B in A)</th>
                <th>整体相似度(Symmetric)</th>
                <th>关系(Relation)</th>
                <th>片段(Segments)</th>
                <th>相似帧(Frame Matches)</th>
                <th>详情(Details)</th>
            </tr>
        </thead>
        <tbody>
            {"".join(pairs_rows)}
        </tbody>
    </table>

    <div class="footer">
        <p>视频相似度识别引擎(Video Similarity Search Engine) - 批量比较报告(Batch Comparison Report)</p>
    </div>
</body>
</html>"""


def _get_relation_class(relation: str) -> str:
    """Get CSS class for relation type."""
    if "near_duplicate" in relation:
        return "near-duplicate"
    elif "clip" in relation:
        return "clip"
    elif "partial_overlap" in relation:
        return "partial-overlap"
    else:
        return "different"


def _format_relation(relation: str) -> str:
    """Format relation string for display."""
    labels = {
        "near_duplicate_or_same_content": "近似重复(Near Duplicate)",
        "partial_overlap": "部分重叠(Partial Overlap)",
        "different": "差异较大(Different)",
        "A_is_likely_clip_of_B": "A 可能是 B 的片段(A clip of B)",
        "B_is_likely_clip_of_A": "B 可能是 A 的片段(B clip of A)",
    }
    return labels.get(relation, f"未知关系({relation})")


def _format_direction(direction: str) -> str:
    if direction == "A_to_B":
        return "A 到 B(A to B)"
    if direction == "B_to_A":
        return "B 到 A(B to A)"
    return f"综合({direction})"


class Reporter:
    """
    Report generator for video similarity search results.
    """

    def __init__(self, reports_dir: Optional[Union[str, Path]] = None):
        """
        Initialize the reporter.

        Args:
            reports_dir: Directory to save reports
        """
        self.reports_dir = Path(reports_dir) if reports_dir else Config.REPORTS_DIR
        self.reports_dir.mkdir(parents=True, exist_ok=True)

    def format_results(
        self,
        results: List[SearchResult],
        query_video: str,
    ) -> str:
        """
        Format search results as a readable string.

        Args:
            results: List of (video_name, score) tuples
            query_video: Name of the query video

        Returns:
            Formatted string
        """
        lines = [
            f"Query: {query_video}",
            "=" * 50,
            "Top similar videos:",
            "",
        ]

        for i, (name, score) in enumerate(results, 1):
            lines.append(f"{i}. {name} | similarity: {score:.4f}")

        return "\n".join(lines)

    def save_results_json(
        self,
        results: List[SearchResult],
        query_video: str,
        filename: Optional[str] = None,
    ) -> Path:
        """
        Save search results as JSON.

        Args:
            results: List of (video_name, score) tuples
            query_video: Name of the query video
            filename: Output filename (auto-generated if None)

        Returns:
            Path to the saved file
        """
        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"search_results_{timestamp}.json"

        data = {
            "query_video": query_video,
            "timestamp": datetime.now().isoformat(),
            "num_results": len(results),
            "results": [
                {"rank": i + 1, "video": name, "similarity": score}
                for i, (name, score) in enumerate(results)
            ],
        }

        output_path = self.reports_dir / filename
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        print(f"Saved results to {output_path}")
        return output_path

    def save_results_text(
        self,
        results: List[SearchResult],
        query_video: str,
        filename: Optional[str] = None,
    ) -> Path:
        """
        Save search results as text.

        Args:
            results: List of (video_name, score) tuples
            query_video: Name of the query video
            filename: Output filename (auto-generated if None)

        Returns:
            Path to the saved file
        """
        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"search_results_{timestamp}.txt"

        content = self.format_results(results, query_video)

        output_path = self.reports_dir / filename
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(content)

        print(f"Saved results to {output_path}")
        return output_path

    def save_batch_results(
        self,
        batch_results: Dict[str, List[SearchResult]],
        filename: Optional[str] = None,
    ) -> Path:
        """
        Save batch search results.

        Args:
            batch_results: Dictionary mapping query videos to their results
            filename: Output filename (auto-generated if None)

        Returns:
            Path to the saved file
        """
        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"batch_results_{timestamp}.json"

        data = {
            "timestamp": datetime.now().isoformat(),
            "num_queries": len(batch_results),
            "results": {},
        }

        for query_video, results in batch_results.items():
            data["results"][query_video] = [
                {"rank": i + 1, "video": name, "similarity": score}
                for i, (name, score) in enumerate(results)
            ]

        output_path = self.reports_dir / filename
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        print(f"Saved batch results to {output_path}")
        return output_path
