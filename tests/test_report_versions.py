import csv
import json

from video_sim.recognition_contract import (
    CONTAINMENT_SCORING_VERSION,
    FEATURE_EXTRACTOR_ID,
    REPORT_SCHEMA_VERSION,
)
from video_sim.matcher import ContainmentResult, FrameMatch
from video_sim.reporter import BatchReportData, write_csv_report, write_json_report


def test_modern_json_and_csv_reports_include_versions(tmp_path):
    report = BatchReportData(timestamp="now")
    verified_match = FrameMatch(
        source_video="a.mp4",
        target_video="b.mp4",
        source_frame_index=0,
        target_frame_index=0,
        source_timestamp=0.0,
        target_timestamp=1.0,
        similarity=0.99,
    )
    report.add_pair_result(
        ContainmentResult(
            video_a="a.mp4",
            video_b="b.mp4",
            a_in_b=1.0,
            b_in_a=0.5,
            symmetric_similarity=0.75,
            avg_similarity_a_to_b=0.99,
            avg_similarity_b_to_a=0.8,
            relation="partial_overlap",
            matches_a_to_b=[verified_match],
            verified_matches_a_to_b=[verified_match],
            verified_matches_b_to_a=[],
            alignment_computed=True,
        )
    )
    json_path = write_json_report(report, tmp_path / "report.json")
    csv_path = write_csv_report(report, tmp_path / "report.csv")
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["report_schema_version"] == REPORT_SCHEMA_VERSION
    assert payload["containment_scoring_version"] == CONTAINMENT_SCORING_VERSION
    assert payload["feature_extractor_id"] == FEATURE_EXTRACTOR_ID
    assert payload["video_pairs"][0]["report_schema_version"] == REPORT_SCHEMA_VERSION
    assert payload["video_pairs"][0]["feature_extractor_id"] == FEATURE_EXTRACTOR_ID
    assert payload["video_pairs"][0]["verified_matches_a_to_b"] == [verified_match.to_dict()]
    assert payload["video_pairs"][0]["verified_matches_b_to_a"] == []
    assert payload["video_pairs"][0]["alignment_computed"] is True
    with csv_path.open(newline="", encoding="utf-8") as handle:
        row = next(csv.DictReader(handle))
    assert int(row["report_schema_version"]) == REPORT_SCHEMA_VERSION
    assert int(row["containment_scoring_version"]) == CONTAINMENT_SCORING_VERSION
    assert row["feature_extractor_id"] == FEATURE_EXTRACTOR_ID
