// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv"];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma"];
const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "vtt", "ass", "ssa"];
const REPORT_EXTENSIONS: &[&str] = &["json", "csv", "html"];
const MAIN_TRAY_ID: &str = "main-tray";
const CLOSE_BEHAVIOR_ASK: u8 = 0;
const CLOSE_BEHAVIOR_TRAY: u8 = 1;
const CLOSE_BEHAVIOR_EXIT: u8 = 2;
const RELEASES_LATEST_PAGE_URL: &str =
    "https://github.com/RoamerFly/video-similarity-detector/releases/latest";
const CLIP_MODEL_DOWNLOAD_URL: &str =
    "https://github.com/RoamerFly/video-similarity-detector/releases/latest/download/clip-vit-base-patch32.zip";
const CLIP_MODEL_DIR_NAME: &str = "clip-vit-base-patch32";
const ANALYSIS_VIDEO_CONTEXT_PREFIX: &str = "ANALYSIS_VIDEO_CONTEXT|";
const ANALYSIS_VIDEO_QUARANTINED_PREFIX: &str = "ANALYSIS_VIDEO_QUARANTINED|";
static CLOSE_BEHAVIOR: AtomicU8 = AtomicU8::new(CLOSE_BEHAVIOR_ASK);

#[derive(Default)]
struct TaskState {
    current_pid: Mutex<Option<u32>>,
    cancel_file: Mutex<Option<PathBuf>>,
    cancel_requested: Mutex<bool>,
    is_running: Mutex<bool>,
}

#[derive(Default)]
struct UpdateCancelState {
    cancel_requested: AtomicBool,
}

#[derive(Default)]
struct MergeTaskState {
    current_pid: Mutex<Option<u32>>,
    cancel_requested: Mutex<bool>,
    is_running: Mutex<bool>,
    config_path: Mutex<Option<PathBuf>>,
    result_path: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    project_root: String,
    default_video_dir: String,
    default_cache_dir: String,
    default_output_dir: String,
    app_name: String,
    version: String,
    build_flavor: String,
    install_type: String,
    install_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: String,
    release_notes: String,
    published_at: String,
    asset_name: String,
    asset_url: String,
    asset_size: u64,
    build_flavor: String,
    install_type: String,
    install_root: String,
    can_auto_install: bool,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    progress: f64,
    stage: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipModelStatus {
    installed: bool,
    model_dir: String,
    size_bytes: u64,
    message: String,
    required_files: Vec<String>,
    missing_files: Vec<String>,
}

fn updater_target_for_build(build_flavor: &str) -> Option<String> {
    if cfg!(target_os = "windows") {
        Some(format!("windows-x86_64-{build_flavor}"))
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        Some("darwin-aarch64".to_string())
    } else if cfg!(target_os = "macos") {
        Some("darwin-x86_64".to_string())
    } else if cfg!(target_os = "linux") {
        Some("linux-x86_64".to_string())
    } else {
        None
    }
}

fn updater_metadata_unavailable_message(error: impl std::fmt::Display) -> String {
    let detail = error.to_string();
    if detail.contains("Could not fetch a valid release JSON") {
        format!("自动更新元数据暂不可用，请打开 GitHub 发布页下载最新版。详情：{detail}")
    } else {
        format!("检查更新通道暂不可用，请打开 GitHub 发布页下载最新版。详情：{detail}")
    }
}

fn updater_install_error_message(error: impl std::fmt::Display) -> String {
    let detail = error.to_string();
    if detail.contains("os error 225")
        || detail.contains("contains a virus")
        || detail.contains("potentially unwanted")
        || detail.contains("病毒")
        || detail.contains("潜在的垃圾软件")
    {
        format!(
            "Windows 安全中心拦截了更新安装包，已停止自动安装。请从 GitHub 发布页手动下载，并只在确认来源可信后按系统安全提示处理。详情：{detail}"
        )
    } else {
        format!("下载并安装更新失败: {detail}")
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VideoFile {
    path: String,
    name: String,
    extension: String,
    size_bytes: u64,
    size_mb: f64,
    modified_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportSummary {
    id: String,
    path: String,
    json_path: Option<String>,
    csv_path: Option<String>,
    html_path: Option<String>,
    name: String,
    created_at: String,
    modified_at: String,
    size_bytes: u64,
    video_count: usize,
    pair_count: usize,
    warning_count: usize,
    status: String,
    formats: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathStatus {
    exists: bool,
    is_file: bool,
    normalized_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PythonEnvStatus {
    ok: bool,
    python_version: Option<String>,
    resolved_python_path: String,
    message: String,
    scripts_ok: bool,
    report_dir_ok: bool,
    gpu_available: Option<bool>,
    gpu_message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AnalysisLogPayload {
    stream: String,
    line: String,
    timestamp: u128,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AnalysisProgressPayload {
    stage: String,
    progress: f64,
    sub_stage: Option<String>,
    sub_progress: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AnalysisFinishedPayload {
    report_json: String,
    report_csv: String,
    report_html: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AnalysisStageFinishedPayload {
    task_id: String,
    stage_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AnalysisErrorPayload {
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AnalysisVideoQuarantinedPayload {
    original_path: String,
    destination_path: String,
    remaining_videos: usize,
    removed_videos: usize,
    moved: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MergeProgressPayload {
    progress: f64,
    stage: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MergeFinishedPayload {
    output_paths: Vec<String>,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MergeErrorPayload {
    message: String,
}

#[derive(Debug, Clone)]
struct ParsedProgress {
    stage: String,
    progress: f64,
    sub_stage: Option<String>,
    sub_progress: Option<f64>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
struct AnalysisVideoContext {
    path: String,
    phase: String,
}

#[derive(Debug, Default)]
struct DecoderWarningAccumulator {
    context: Option<AnalysisVideoContext>,
    total: u64,
    invalid_nal: u64,
    missing_picture: u64,
    other: u64,
    last_reported: u64,
}

impl DecoderWarningAccumulator {
    fn switch_context(&mut self, context: AnalysisVideoContext) -> Option<String> {
        let summary = self.pending_summary("视频解码告警汇总");
        self.context = Some(context);
        self.total = 0;
        self.invalid_nal = 0;
        self.missing_picture = 0;
        self.other = 0;
        self.last_reported = 0;
        summary
    }

    fn record(&mut self, line: &str) -> Option<String> {
        self.total += 1;
        if line.contains("Invalid NAL unit size") {
            self.invalid_nal += 1;
        } else if line.contains("missing picture in access unit") {
            self.missing_picture += 1;
        } else {
            self.other += 1;
        }

        if self.total == 100 || self.total % 1000 == 0 {
            self.last_reported = self.total;
            return Some(self.format_summary("视频解码告警累计"));
        }

        None
    }

    fn finish(&mut self) -> Option<String> {
        let summary = self.pending_summary("视频解码告警汇总");
        self.last_reported = self.total;
        summary
    }

    fn pending_summary(&self, title: &str) -> Option<String> {
        let severe = self.invalid_nal + self.other;
        (self.total > self.last_reported && (self.total >= 100 || severe >= 20))
            .then(|| self.format_summary(title))
    }

    fn format_summary(&self, title: &str) -> String {
        let (path, phase) = self.context_description();
        format!(
            "{title}：path={path}；阶段={phase}；NAL 长度错误 {} 次；缺失画面 {} 次；其他 H.264 告警 {} 次；合计 {} 条。",
            self.invalid_nal, self.missing_picture, self.other, self.total
        )
    }

    fn context_description(&self) -> (&str, &str) {
        match self.context.as_ref() {
            Some(context) => (
                context.path.as_str(),
                decoder_phase_label(context.phase.as_str()),
            ),
            None => ("未知视频（未收到上下文）", "未知"),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRequest {
    input_dir: String,
    recursive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoMetadataRequest {
    paths: Vec<String>,
    project_root: Option<String>,
    python_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoMetadata {
    path: String,
    width: u32,
    height: u32,
    duration: f64,
    fps: f64,
    frame_count: u64,
    readable: bool,
    error: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportPathRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportPairIdentity {
    video_a: String,
    video_b: String,
    video_a_path: String,
    video_b_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReportEntriesRequest {
    path: String,
    pairs: Vec<ReportPairIdentity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReportEntriesResult {
    removed_count: usize,
    remaining_count: usize,
    updated_files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureFrameRequest {
    path: String,
    timestamp: f64,
    frame_index: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureComparisonFrameRequest {
    path: String,
    timestamp: f64,
    frame_index: Option<i64>,
    crop_black_borders: bool,
    resize_mode: String,
    input_size: u32,
    portrait_rotation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputDirRequest {
    output_dir: String,
    #[serde(default)]
    refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearCacheRequest {
    cache_dir: String,
    project_root: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearCacheItemsRequest {
    cache_dir: String,
    project_root: Option<String>,
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateFileCheckConfig {
    video_dir: String,
    output_dir: String,
    project_root: Option<String>,
    recursive: Option<bool>,
    #[serde(default)]
    video_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteFilesRequest {
    paths: Vec<String>,
}

#[derive(Clone, Default)]
struct FileMoveState {
    inner: Arc<FileMoveStateInner>,
}

#[derive(Default)]
struct FileMoveStateInner {
    is_running: AtomicBool,
    cancel_requested: AtomicBool,
    target_dir: Mutex<String>,
    current_path: Mutex<Option<String>>,
    pending_paths: Mutex<Vec<String>>,
}

impl FileMoveState {
    fn try_begin(&self, target_dir: String, pending_paths: Vec<String>) -> bool {
        if self
            .inner
            .is_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        self.inner.cancel_requested.store(false, Ordering::SeqCst);
        *self.inner.target_dir.lock().unwrap() = target_dir;
        *self.inner.current_path.lock().unwrap() = None;
        *self.inner.pending_paths.lock().unwrap() = pending_paths;
        true
    }

    fn finish(&self) {
        self.inner.is_running.store(false, Ordering::SeqCst);
        self.inner.cancel_requested.store(false, Ordering::SeqCst);
        *self.inner.target_dir.lock().unwrap() = String::new();
        *self.inner.current_path.lock().unwrap() = None;
        self.inner.pending_paths.lock().unwrap().clear();
    }

    fn request_cancel(&self) {
        self.inner.cancel_requested.store(true, Ordering::SeqCst);
    }

    fn is_cancel_requested(&self) -> bool {
        self.inner.cancel_requested.load(Ordering::SeqCst)
    }

    fn is_running(&self) -> bool {
        self.inner.is_running.load(Ordering::SeqCst)
    }

    fn set_current_path(&self, path: Option<String>) {
        *self.inner.current_path.lock().unwrap() = path;
    }

    fn snapshot(&self) -> FileMoveStatus {
        FileMoveStatus {
            running: self.is_running(),
            cancel_requested: self.is_cancel_requested(),
            target_dir: self.inner.target_dir.lock().unwrap().clone(),
            current_path: self.inner.current_path.lock().unwrap().clone(),
            pending_paths: self.inner.pending_paths.lock().unwrap().clone(),
        }
    }
}

struct FileMoveGuard {
    state: FileMoveState,
}

impl Drop for FileMoveGuard {
    fn drop(&mut self) {
        self.state.finish();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveFilesRequest {
    paths: Vec<String>,
    target_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloseWindowRequest {
    minimize_to_tray: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearCacheResult {
    removed_entries: usize,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    id: String,
    path: String,
    name: String,
    kind: String,
    category: String,
    description: String,
    size_bytes: u64,
    entry_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheScanResult {
    cache_dir: String,
    items: Vec<CacheEntry>,
    total_size_bytes: u64,
    total_entries: usize,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteFileFailure {
    path: String,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteFilesResult {
    deleted_paths: Vec<String>,
    failed: Vec<DeleteFileFailure>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveFileRecord {
    from: String,
    to: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveFilesResult {
    moved_paths: Vec<MoveFileRecord>,
    failed: Vec<DeleteFileFailure>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMoveStatus {
    running: bool,
    cancel_requested: bool,
    target_dir: String,
    current_path: Option<String>,
    pending_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PythonEnvConfig {
    python_path: Option<String>,
    project_root: Option<String>,
    report_dir: Option<String>,
    quick_check: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentRequest {
    python_path: Option<String>,
    output_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunBatchCompareConfig {
    video_dir: String,
    output_dir: Option<String>,
    cache_dir: String,
    python_path: Option<String>,
    project_root: Option<String>,
    skip_threshold: f64,
    match_threshold: f64,
    window_size: f64,
    top_k: u32,
    candidate_limit: Option<u32>,
    compare_workers: Option<u32>,
    max_gap_sec: f64,
    frame_step: Option<u32>,
    crop_black_borders: bool,
    resize_mode: String,
    input_size: u32,
    portrait_rotation: Option<String>,
    force: bool,
    early_stop: Option<bool>,
    device: Option<String>,
    error_tolerance_preset: Option<String>,
    error_tolerance_severe_limit: Option<u32>,
    error_tolerance_missing_picture_limit: Option<u32>,
    error_tolerance_preflight_validation: Option<bool>,
    analysis_mode: Option<String>,
    min_segment_duration: Option<f64>,
    min_segment_matches: Option<u32>,
    offset_tolerance: Option<f64>,
    task_id: Option<String>,
    task_match_key: Option<String>,
    execution_stage: Option<String>,
    redo_stage: Option<bool>,
    #[serde(default)]
    video_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigTemplateListRequest {
    project_root: Option<String>,
    kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveConfigTemplateRequest {
    project_root: Option<String>,
    id: Option<String>,
    kind: String,
    name: String,
    config: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteConfigTemplateRequest {
    project_root: Option<String>,
    kind: String,
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigTemplateRecord {
    id: String,
    kind: String,
    name: String,
    created_at: String,
    updated_at: String,
    config: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisTaskListRequest {
    cache_dir: String,
    project_root: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAnalysisTaskRequest {
    cache_dir: String,
    project_root: Option<String>,
    task_id: String,
    #[serde(default)]
    delete_cache: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAnalysisTaskRequest {
    cache_dir: String,
    project_root: Option<String>,
    config: RunBatchCompareConfig,
    task_match_key: String,
    task_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAnalysisTaskRequest {
    cache_dir: String,
    project_root: Option<String>,
    task_id: String,
    status: Option<String>,
    stage: Option<String>,
    progress: Option<f64>,
    total_pairs: Option<usize>,
    completed_pairs: Option<usize>,
    videos: Option<Vec<AnalysisTaskVideo>>,
    report_json: Option<String>,
    report_csv: Option<String>,
    report_html: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AnalysisTaskVideo {
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    mtime_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AnalysisTaskStage {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    progress: f64,
    #[serde(default)]
    weight: f64,
    #[serde(default)]
    started_at: String,
    #[serde(default)]
    completed_at: String,
    #[serde(default)]
    elapsed_ms: u64,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AnalysisTaskCacheArtifact {
    #[serde(default)]
    path: String,
    #[serde(default)]
    path_base: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AnalysisTaskRecord {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    video_dir: String,
    #[serde(default)]
    video_count: usize,
    #[serde(default)]
    total_pairs: usize,
    #[serde(default)]
    completed_pairs: usize,
    #[serde(default)]
    progress: f64,
    #[serde(default)]
    stage: String,
    #[serde(default)]
    match_key: String,
    #[serde(default)]
    videos: Vec<AnalysisTaskVideo>,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    report_json: String,
    #[serde(default)]
    report_csv: String,
    #[serde(default)]
    report_html: String,
    #[serde(default)]
    active_stage: String,
    #[serde(default)]
    stages: Vec<AnalysisTaskStage>,
    #[serde(default)]
    cache_artifacts: Vec<AnalysisTaskCacheArtifact>,
    #[serde(default)]
    reused_video_caches: usize,
    #[serde(default)]
    generated_video_caches: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeVideoItem {
    path: String,
    #[serde(default)]
    start_time: f64,
    #[serde(default)]
    track_index: u32,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    #[serde(default)]
    muted: bool,
    #[serde(default)]
    rotation: u16,
    #[serde(default)]
    crop_enabled: bool,
    #[serde(default)]
    crop_x: u32,
    #[serde(default)]
    crop_y: u32,
    #[serde(default)]
    crop_width: u32,
    #[serde(default)]
    crop_height: u32,
    #[serde(default)]
    layout_custom: bool,
    #[serde(default)]
    layout_x: f64,
    #[serde(default)]
    layout_y: f64,
    #[serde(default = "default_layout_size")]
    layout_width: f64,
    #[serde(default = "default_layout_size")]
    layout_height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeAudioItem {
    path: String,
    start_time: f64,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoMergeConfig {
    inputs: Vec<MergeVideoItem>,
    #[serde(default)]
    audio_tracks: Vec<MergeAudioItem>,
    output_dir: String,
    output_name: String,
    width: u32,
    height: u32,
    fit_mode: String,
    #[serde(default = "default_canvas_background")]
    canvas_background: String,
    split_mode: String,
    split_value: f64,
    fps: u32,
    crf: u32,
    encoder_preset: String,
    include_audio: bool,
    #[serde(default = "default_true")]
    snap_to_videos: bool,
    project_root: Option<String>,
    python_path: Option<String>,
}

fn default_canvas_background() -> String {
    "black".to_string()
}

fn default_layout_size() -> f64 {
    1.0
}

fn default_true() -> bool {
    true
}

#[derive(Default)]
struct ReportGroup {
    stem: String,
    json_path: Option<PathBuf>,
    csv_path: Option<PathBuf>,
    html_path: Option<PathBuf>,
    modified_at: String,
    size_bytes: u64,
}

#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    let root = resolve_project_root(&app)?;
    let build_flavor = detect_build_flavor(&root);
    let install_type = detect_install_type(&root);
    Ok(AppInfo {
        default_video_dir: path_to_string(root.join("videos")),
        default_cache_dir: path_to_string(root.join("data")),
        default_output_dir: path_to_string(root.join("data").join("reports")),
        project_root: path_to_string(root),
        app_name: app.package_info().name.to_string(),
        version: app.package_info().version.to_string(),
        build_flavor,
        install_type,
        install_root: path_to_string(resolve_install_root()?),
    })
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let root = resolve_project_root(&app)?;
    let current_version = app.package_info().version.to_string();
    let build_flavor = detect_build_flavor(&root);
    let install_type = detect_install_type(&root);
    let install_root = resolve_install_root()?;

    let mut updater_builder = app.updater_builder();
    if let Some(target) = updater_target_for_build(&build_flavor) {
        updater_builder = updater_builder.target(target);
    }
    let updater = updater_builder
        .build()
        .map_err(|e| format!("初始化更新检查失败: {e}"))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let latest_version = update.version.clone();
            let update_available = true;
            let can_auto_install = cfg!(target_os = "windows");
            let download_url_str = update.download_url.to_string();
            let asset_name = download_url_str
                .rsplit_once('/')
                .map(|(_, name)| name.to_string())
                .unwrap_or_default();
            let release_url = format!(
                "https://github.com/RoamerFly/video-similarity-detector/releases/tag/v{}",
                latest_version
            );
            let message = if can_auto_install {
                format!("发现新版本 v{latest_version}，可保留数据直接覆盖安装")
            } else {
                format!("发现新版本 v{latest_version}，请打开发布页下载")
            };

            Ok(UpdateInfo {
                current_version,
                latest_version,
                update_available,
                release_url,
                release_notes: update.body.unwrap_or_default(),
                published_at: update.date.map(|d| d.to_string()).unwrap_or_default(),
                asset_name,
                asset_url: update.download_url.to_string(),
                asset_size: 0,
                build_flavor,
                install_type,
                install_root: path_to_string(install_root),
                can_auto_install,
                message,
            })
        }
        Ok(None) => Ok(UpdateInfo {
            current_version: current_version.clone(),
            latest_version: current_version.clone(),
            update_available: false,
            release_url: RELEASES_LATEST_PAGE_URL.to_string(),
            release_notes: String::new(),
            published_at: String::new(),
            asset_name: String::new(),
            asset_url: String::new(),
            asset_size: 0,
            build_flavor,
            install_type,
            install_root: path_to_string(install_root),
            can_auto_install: false,
            message: format!("当前已是最新版本 v{current_version}"),
        }),
        Err(e) => Ok(UpdateInfo {
            current_version: current_version.clone(),
            latest_version: current_version,
            update_available: false,
            release_url: RELEASES_LATEST_PAGE_URL.to_string(),
            release_notes: String::new(),
            published_at: String::new(),
            asset_name: String::new(),
            asset_url: String::new(),
            asset_size: 0,
            build_flavor,
            install_type,
            install_root: path_to_string(install_root),
            can_auto_install: false,
            message: updater_metadata_unavailable_message(e),
        }),
    }
}

#[tauri::command]
async fn download_and_install_update(
    app: tauri::AppHandle,
    cancel_state: State<'_, UpdateCancelState>,
) -> Result<(), String> {
    cancel_state.cancel_requested.store(false, Ordering::SeqCst);

    let root = resolve_project_root(&app)?;
    let build_flavor = detect_build_flavor(&root);
    let install_root = resolve_install_root()?;
    let mut updater_builder = app.updater_builder();
    if let Some(target) = updater_target_for_build(&build_flavor) {
        updater_builder = updater_builder.target(target);
    }
    #[cfg(target_os = "windows")]
    {
        updater_builder = updater_builder
            .installer_arg("--update")
            .installer_arg("--auto-start")
            .installer_arg("--target")
            .installer_arg(path_to_string(&install_root))
            .installer_arg("--wait-pid")
            .installer_arg(std::process::id().to_string());
    }
    let updater = updater_builder
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(updater_install_error_message)?
        .ok_or_else(|| "没有可用的更新。".to_string())?;

    let progress_app = app.clone();
    let finished_app = app.clone();
    let total = Arc::new(std::sync::Mutex::new(None::<u64>));
    let total_for_cb = total.clone();
    let mut downloaded = 0u64;

    let download_future = update.download_and_install(
        move |chunk_len, content_len| {
            downloaded += chunk_len as u64;
            if content_len.is_some() {
                *total_for_cb.lock().unwrap() = content_len;
            }
            let total = *total_for_cb.lock().unwrap();
            let _ = progress_app.emit(
                "update-download-progress",
                UpdateDownloadProgress {
                    downloaded_bytes: downloaded,
                    total_bytes: total.unwrap_or(0),
                    progress: total
                        .filter(|t| *t > 0)
                        .map(|t| downloaded as f64 / t as f64 * 100.0)
                        .unwrap_or(0.0),
                    stage: "正在下载并验证更新安装包".to_string(),
                },
            );
        },
        move || {
            let _ = finished_app.emit(
                "update-download-progress",
                UpdateDownloadProgress {
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    progress: 100.0,
                    stage: "更新包已验证，正在启动安装器".to_string(),
                },
            );
        },
    );

    tokio::select! {
        result = download_future => {
            result.map_err(updater_install_error_message)?;
            Ok(())
        }
        _ = cancel_check(cancel_state) => {
            Err("下载已被用户取消".to_string())
        }
    }
}

#[tauri::command]
fn get_clip_model_status(app: tauri::AppHandle) -> Result<ClipModelStatus, String> {
    let root = resolve_project_root(&app)?;
    Ok(clip_model_status_for_root(&root))
}

#[tauri::command]
async fn install_clip_model(app: tauri::AppHandle) -> Result<ClipModelStatus, String> {
    let root = resolve_project_root(&app)?;
    let model_root = root.join("models");
    fs::create_dir_all(&model_root).map_err(|e| format!("创建模型目录失败: {e}"))?;

    let temp_root = std::env::temp_dir().join(format!(
        "video-similarity-clip-model-{}",
        timestamp_millis()
    ));
    fs::create_dir_all(&temp_root).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let zip_path = temp_root.join("clip-vit-base-patch32.zip");

    emit_model_progress(&app, 0, 0, 2.0, "正在连接 GitHub Releases");
    let client = reqwest::Client::new();
    let mut response = client
        .get(CLIP_MODEL_DOWNLOAD_URL)
        .header(reqwest::header::USER_AGENT, "video-similarity-desktop")
        .send()
        .await
        .map_err(|e| format!("连接模型下载地址失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("模型下载请求失败: {e}"))?;

    let total_bytes = response.content_length().unwrap_or(0);
    let mut downloaded_bytes = 0u64;
    let mut output = File::create(&zip_path).map_err(|e| format!("创建模型下载文件失败: {e}"))?;
    emit_model_progress(&app, 0, total_bytes, 5.0, "正在下载离线 CLIP 模型");
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取模型下载数据失败: {e}"))?
    {
        output
            .write_all(&chunk)
            .map_err(|e| format!("写入模型下载文件失败: {e}"))?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        let progress = if total_bytes > 0 {
            5.0 + downloaded_bytes as f64 / total_bytes as f64 * 65.0
        } else {
            5.0
        };
        emit_model_progress(
            &app,
            downloaded_bytes,
            total_bytes,
            progress.min(70.0),
            "正在下载离线 CLIP 模型",
        );
    }
    output
        .flush()
        .map_err(|e| format!("保存模型下载文件失败: {e}"))?;

    let root_for_extract = root.clone();
    let temp_for_extract = temp_root.clone();
    let zip_for_extract = zip_path.clone();
    emit_model_progress(
        &app,
        downloaded_bytes,
        total_bytes,
        72.0,
        "正在解压并校验模型",
    );
    tauri::async_runtime::spawn_blocking(move || {
        install_clip_model_zip(&root_for_extract, &temp_for_extract, &zip_for_extract)
    })
    .await
    .map_err(|e| format!("模型安装任务异常: {e}"))??;

    let _ = fs::remove_dir_all(&temp_root);
    emit_model_progress(
        &app,
        downloaded_bytes,
        total_bytes,
        100.0,
        "离线 CLIP 模型已安装",
    );
    Ok(clip_model_status_for_root(&root))
}

async fn cancel_check(cancel_state: State<'_, UpdateCancelState>) {
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if cancel_state.cancel_requested.load(Ordering::SeqCst) {
            break;
        }
    }
}

#[tauri::command]
fn cancel_update_download(cancel_state: State<'_, UpdateCancelState>) -> Result<(), String> {
    cancel_state.cancel_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn open_release_page(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/RoamerFly/video-similarity-detector/releases") {
        return Err("发布页地址不受信任。".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&url);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };

    command
        .spawn()
        .map_err(|e| format!("打开 GitHub 发布页失败: {e}"))?;
    Ok(())
}

fn resolve_install_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("无法读取当前程序路径: {e}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位当前安装目录。".to_string())
}

fn detect_build_flavor(root: &Path) -> String {
    let marker = root.join("BUILD_FLAVOR.txt");
    if let Ok(value) = fs::read_to_string(marker) {
        let value = value.trim().to_ascii_lowercase();
        if value == "gpu" || value == "cpu" {
            return value;
        }
    }
    if root.to_string_lossy().to_ascii_lowercase().contains("gpu") {
        "gpu".to_string()
    } else {
        "cpu".to_string()
    }
}

fn detect_install_type(root: &Path) -> String {
    if root.join(".video-similarity-install.json").exists() {
        return "installed".to_string();
    }
    let normalized = root
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if normalized.contains("/appdata/local/programs/") {
        "installed".to_string()
    } else {
        "portable".to_string()
    }
}

#[tauri::command]
fn select_video_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    select_folder(app)
}

#[tauri::command]
fn select_video_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .dialog()
        .file()
        .set_title("选择要加入合并列表的视频")
        .add_filter("视频文件", VIDEO_EXTENSIONS)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(path_to_string)
        .collect())
}

#[tauri::command]
fn select_audio_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .dialog()
        .file()
        .set_title("选择要加入音频线的音频文件")
        .add_filter("音频文件", AUDIO_EXTENSIONS)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(path_to_string)
        .collect())
}

#[tauri::command]
fn select_subtitle_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .dialog()
        .file()
        .set_title("选择要导入到文本线的字幕文件")
        .add_filter("字幕文件", SUBTITLE_EXTENSIONS)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(path_to_string)
        .collect())
}

#[tauri::command]
fn select_output_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    select_folder(app)
}

#[tauri::command]
fn select_python_executable(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("选择 Python 可执行文件")
        .add_filter("Python executable", &["exe"])
        .blocking_pick_file();
    Ok(selected
        .and_then(|file| file.into_path().ok())
        .map(path_to_string))
}

#[tauri::command]
async fn scan_videos(request: ScanRequest) -> Result<Vec<VideoFile>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_videos_impl(request))
        .await
        .map_err(|e| format!("扫描视频任务异常: {e}"))?
}

#[tauri::command]
async fn probe_video_metadata(
    app: tauri::AppHandle,
    request: VideoMetadataRequest,
) -> Result<Vec<VideoMetadata>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_video_metadata_impl(app, request))
        .await
        .map_err(|e| format!("读取视频信息任务异常: {e}"))?
}

fn probe_video_metadata_impl(
    app: tauri::AppHandle,
    request: VideoMetadataRequest,
) -> Result<Vec<VideoMetadata>, String> {
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let python = resolve_python(&app, &root, request.python_path.as_deref());
    let resolved_paths = request
        .paths
        .iter()
        .map(|path| path_to_string(resolve_user_path(&root, path)))
        .collect::<Vec<_>>();
    if resolved_paths.is_empty() {
        return Ok(Vec::new());
    }

    let script = r#"
import json
import sys
import cv2

rows = []
for path in sys.argv[1:]:
    row = {
        "path": path,
        "width": 0,
        "height": 0,
        "duration": 0.0,
        "fps": 0.0,
        "frameCount": 0,
        "readable": False,
        "error": "",
    }
    try:
        capture = cv2.VideoCapture(path)
        if not capture.isOpened():
            raise RuntimeError("播放器无法读取该视频")
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        row.update({
            "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
            "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
            "duration": frame_count / fps if fps > 0 else 0.0,
            "fps": fps,
            "frameCount": frame_count,
            "readable": True,
        })
        capture.release()
    except Exception as error:
        row["error"] = str(error)
    rows.append(row)
print(json.dumps(rows, ensure_ascii=False))
"#;
    let mut args = vec!["-c".into(), script.into()];
    args.extend(resolved_paths);
    let output = run_capture(&root, &python, args)?;
    if !output.status_success {
        return Err(format!(
            "读取视频信息失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ));
    }
    serde_json::from_str(output.stdout.trim()).map_err(|e| format!("解析视频信息失败: {e}"))
}

fn scan_videos_impl(request: ScanRequest) -> Result<Vec<VideoFile>, String> {
    let input_dir = PathBuf::from(request.input_dir);
    if !input_dir.exists() {
        return Err(format!("视频目录不存在: {}", input_dir.display()));
    }
    if !input_dir.is_dir() {
        return Err(format!("不是有效目录: {}", input_dir.display()));
    }

    let mut videos = Vec::new();
    collect_videos(
        &input_dir,
        request.recursive.unwrap_or(true),
        &mut videos,
        true,
    )?;
    videos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(videos)
}

#[tauri::command]
async fn check_python_env(
    app: tauri::AppHandle,
    config: PythonEnvConfig,
) -> Result<PythonEnvStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check_python_env_impl(app, config))
        .await
        .map_err(|e| format!("检查 Python 环境任务异常: {e}"))?
}

fn check_python_env_impl(
    app: tauri::AppHandle,
    config: PythonEnvConfig,
) -> Result<PythonEnvStatus, String> {
    let root = resolve_config_project_root(&app, config.project_root.as_deref())?;
    let python = resolve_python(&app, &root, config.python_path.as_deref());
    let quick_check = config.quick_check.unwrap_or(false);
    let report_dir = config
        .report_dir
        .as_deref()
        .map(|path| resolve_user_path(&root, path))
        .unwrap_or_else(|| root.join("data").join("reports"));
    let script = root.join("scripts").join("batch_compare.py");
    let scripts_ok = script.exists();
    let report_dir_ok = report_dir.exists() || fs::create_dir_all(&report_dir).is_ok();

    let version_output = run_capture(&root, &python, vec!["--version".into()]);
    let (python_ok, python_version, version_message) = match version_output {
        Ok(output) if output.status_success => {
            let version = first_non_empty(&output.stdout, &output.stderr);
            (true, Some(version), String::new())
        }
        Ok(output) => (
            false,
            None,
            format!(
                "Python 检测失败: {}",
                first_non_empty(&output.stderr, &output.stdout)
            ),
        ),
        Err(err) => (false, None, err),
    };

    let help_output = if quick_check && scripts_ok && python_ok {
        Ok(ProcessOutput {
            status_success: true,
            stdout: String::new(),
            stderr: String::new(),
        })
    } else if scripts_ok && python_ok {
        run_capture(
            &root,
            &python,
            vec!["-m".into(), "py_compile".into(), script_arg(&script)],
        )
    } else {
        Err("批量分析脚本不可用".to_string())
    };
    let help_ok = matches!(help_output, Ok(ref output) if output.status_success);
    let help_message = match help_output {
        Ok(output) if output.status_success => String::new(),
        Ok(output) => first_non_empty(&output.stderr, &output.stdout),
        Err(err) => err,
    };
    let (gpu_available, gpu_message) = detect_gpu_status(&root, &python, quick_check, python_ok);

    let ok = python_ok && scripts_ok && help_ok && report_dir_ok;
    let message = if ok {
        "环境正常".to_string()
    } else {
        [
            (!python_ok).then_some(version_message.as_str()),
            (!scripts_ok).then_some("找不到 scripts/batch_compare.py"),
            (scripts_ok && !help_ok).then_some(help_message.as_str()),
            (!report_dir_ok).then_some("报告输出目录不可用"),
        ]
        .into_iter()
        .flatten()
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>()
        .join("；")
    };

    Ok(PythonEnvStatus {
        ok,
        python_version,
        resolved_python_path: python,
        message,
        scripts_ok: scripts_ok && help_ok,
        report_dir_ok,
        gpu_available,
        gpu_message,
    })
}

fn detect_gpu_status(
    root: &Path,
    python: &str,
    quick_check: bool,
    python_ok: bool,
) -> (Option<bool>, String) {
    if quick_check {
        return (None, "未检测".to_string());
    }
    if !python_ok {
        return (None, "Python 环境不可用".to_string());
    }

    let script = r#"
import importlib.util

if importlib.util.find_spec("torch") is None:
    print("TORCH_MISSING")
else:
    import torch
    if torch.cuda.is_available():
        count = torch.cuda.device_count()
        name = torch.cuda.get_device_name(0) if count else "CUDA"
        print(f"CUDA_AVAILABLE|{count}|{name}")
    else:
        print("CUDA_UNAVAILABLE")
"#;

    match run_capture(root, python, vec!["-c".into(), script.into()]) {
        Ok(output) if output.status_success => {
            let text = first_non_empty(&output.stdout, &output.stderr);
            let trimmed = text.trim();
            if let Some(rest) = trimmed.strip_prefix("CUDA_AVAILABLE|") {
                let mut parts = rest.splitn(2, '|');
                let count = parts.next().unwrap_or("1");
                let name = parts.next().unwrap_or("CUDA");
                (Some(true), format!("可用：{count} 个设备，{name}"))
            } else if trimmed.contains("TORCH_MISSING") {
                (Some(false), "未安装 PyTorch，无法检测 CUDA".to_string())
            } else if trimmed.contains("CUDA_UNAVAILABLE") {
                (Some(false), "未检测到 CUDA，将使用 CPU".to_string())
            } else {
                (Some(false), first_non_empty(trimmed, "GPU 检测无返回"))
            }
        }
        Ok(output) => (
            Some(false),
            format!(
                "检测失败：{}",
                first_non_empty(&output.stderr, &output.stdout)
            ),
        ),
        Err(err) => (Some(false), format!("检测失败：{err}")),
    }
}

#[tauri::command]
async fn check_environment(
    app: tauri::AppHandle,
    request: EnvironmentRequest,
) -> Result<PythonEnvStatus, String> {
    let config = PythonEnvConfig {
        python_path: request.python_path,
        project_root: None,
        report_dir: Some(request.output_dir),
        quick_check: Some(false),
    };

    tauri::async_runtime::spawn_blocking(move || check_python_env_impl(app, config))
        .await
        .map_err(|e| format!("检查运行环境任务异常: {e}"))?
}

#[tauri::command]
fn list_config_templates(
    app: tauri::AppHandle,
    request: ConfigTemplateListRequest,
) -> Result<Vec<ConfigTemplateRecord>, String> {
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let directory = config_template_dir(&root, &request.kind)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }

    let mut templates = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| format!("读取配置模板目录失败: {e}"))?
    {
        let path = entry.map_err(|e| format!("读取配置模板失败: {e}"))?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let record = match serde_json::from_str::<ConfigTemplateRecord>(&content) {
            Ok(record) if record.kind == request.kind => record,
            _ => continue,
        };
        templates.push(record);
    }
    templates.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(templates)
}

#[tauri::command]
fn save_config_template(
    app: tauri::AppHandle,
    request: SaveConfigTemplateRequest,
) -> Result<ConfigTemplateRecord, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("模板名称不能为空".to_string());
    }
    if name.chars().count() > 80 {
        return Err("模板名称不能超过 80 个字符".to_string());
    }

    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let directory = config_template_dir(&root, &request.kind)?;
    fs::create_dir_all(&directory).map_err(|e| format!("创建配置模板目录失败: {e}"))?;
    let now = timestamp_millis().to_string();
    let id = request
        .id
        .as_deref()
        .filter(|value| is_safe_storage_id(value))
        .map(str::to_string)
        .unwrap_or_else(|| storage_record_id(name));
    let target = directory.join(format!("{id}.json"));
    let created_at = fs::read_to_string(&target)
        .ok()
        .and_then(|content| serde_json::from_str::<ConfigTemplateRecord>(&content).ok())
        .map(|record| record.created_at)
        .unwrap_or_else(|| now.clone());
    let record = ConfigTemplateRecord {
        id,
        kind: request.kind,
        name: name.to_string(),
        created_at,
        updated_at: now,
        config: request.config,
    };
    write_json_atomic(&target, &record)?;
    Ok(record)
}

#[tauri::command]
fn delete_config_template(
    app: tauri::AppHandle,
    request: DeleteConfigTemplateRequest,
) -> Result<(), String> {
    if !is_safe_storage_id(&request.id) {
        return Err("模板标识无效".to_string());
    }
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let target = config_template_dir(&root, &request.kind)?.join(format!("{}.json", request.id));
    if target.exists() {
        fs::remove_file(target).map_err(|e| format!("删除配置模板失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn list_analysis_tasks(
    app: tauri::AppHandle,
    request: AnalysisTaskListRequest,
) -> Result<Vec<AnalysisTaskRecord>, String> {
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    let directory = analysis_tasks_dir(&cache_dir);
    if !directory.exists() {
        return Ok(Vec::new());
    }

    let mut tasks = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| format!("读取任务列表失败: {e}"))? {
        let task_dir = match entry {
            Ok(entry) => entry.path(),
            Err(_) => continue,
        };
        if !task_dir.is_dir() {
            continue;
        }
        let manifest_path = task_dir.join("task.json");
        let content = match fs::read_to_string(&manifest_path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let mut record = match serde_json::from_str::<AnalysisTaskRecord>(&content) {
            Ok(record) => record,
            Err(_) => continue,
        };
        if record.id.is_empty() {
            record.id = task_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
        }
        if record.name.trim().is_empty() {
            record.name = record.id.clone();
        }
        if record.stages.is_empty() {
            record.stages = default_analysis_task_stages();
        }
        tasks.push(record);
    }
    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(tasks)
}

#[tauri::command]
fn create_analysis_task(
    app: tauri::AppHandle,
    request: CreateAnalysisTaskRequest,
) -> Result<AnalysisTaskRecord, String> {
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    let directory = analysis_tasks_dir(&cache_dir);
    fs::create_dir_all(&directory).map_err(|e| format!("创建分析任务目录失败: {e}"))?;

    let id = format!("analysis-{}", timestamp_millis());
    let name = request
        .task_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(id.as_str())
        .chars()
        .take(80)
        .collect::<String>();
    let now = (timestamp_millis() / 1000).to_string();
    let mut config = request.config;
    config.task_id = Some(id.clone());
    config.task_match_key = Some(request.task_match_key.clone());
    let video_dir = config.video_dir.clone();
    let record = AnalysisTaskRecord {
        version: 1,
        id: id.clone(),
        name,
        status: "created".to_string(),
        created_at: now.clone(),
        updated_at: now,
        video_dir,
        video_count: 0,
        total_pairs: 0,
        completed_pairs: 0,
        progress: 0.0,
        stage: "等待启动".to_string(),
        match_key: request.task_match_key,
        videos: Vec::new(),
        config: serde_json::to_value(config).map_err(|e| format!("序列化分析任务失败: {e}"))?,
        report_json: String::new(),
        report_csv: String::new(),
        report_html: String::new(),
        active_stage: String::new(),
        stages: default_analysis_task_stages(),
        cache_artifacts: Vec::new(),
        reused_video_caches: 0,
        generated_video_caches: 0,
    };
    write_json_atomic(&directory.join(&id).join("task.json"), &record)?;
    Ok(record)
}

#[tauri::command]
fn update_analysis_task(
    app: tauri::AppHandle,
    request: UpdateAnalysisTaskRequest,
) -> Result<AnalysisTaskRecord, String> {
    if !is_safe_storage_id(&request.task_id) {
        return Err("任务标识无效".to_string());
    }
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    let manifest_path = analysis_tasks_dir(&cache_dir)
        .join(&request.task_id)
        .join("task.json");
    let content =
        fs::read_to_string(&manifest_path).map_err(|e| format!("读取分析任务失败: {e}"))?;
    let mut record = serde_json::from_str::<AnalysisTaskRecord>(&content)
        .map_err(|e| format!("解析分析任务失败: {e}"))?;

    if let Some(status) = request.status {
        record.status = status;
    }
    if let Some(stage) = request.stage {
        record.stage = stage;
    }
    if let Some(progress) = request.progress {
        record.progress = progress.clamp(0.0, 100.0);
    }
    if let Some(total_pairs) = request.total_pairs {
        record.total_pairs = total_pairs;
    }
    if let Some(completed_pairs) = request.completed_pairs {
        record.completed_pairs = completed_pairs;
    }
    if let Some(videos) = request.videos {
        record.video_count = videos.len();
        record.videos = videos;
    }
    if let Some(path) = request.report_json {
        record.report_json = path;
    }
    if let Some(path) = request.report_csv {
        record.report_csv = path;
    }
    if let Some(path) = request.report_html {
        record.report_html = path;
    }
    record.updated_at = (timestamp_millis() / 1000).to_string();
    write_json_atomic(&manifest_path, &record)?;
    Ok(record)
}

#[tauri::command]
fn delete_analysis_task(
    app: tauri::AppHandle,
    request: DeleteAnalysisTaskRequest,
) -> Result<(), String> {
    if !is_safe_storage_id(&request.task_id) {
        return Err("任务标识无效".to_string());
    }
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    let target = analysis_tasks_dir(&cache_dir).join(&request.task_id);
    if request.delete_cache {
        let manifest_path = target.join("task.json");
        let record = fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|content| serde_json::from_str::<AnalysisTaskRecord>(&content).ok())
            .unwrap_or_default();
        let cache_root = cache_dir
            .canonicalize()
            .unwrap_or_else(|_| cache_dir.clone());
        let task_root = target.canonicalize().unwrap_or_else(|_| target.clone());

        for artifact in record.cache_artifacts {
            let path = resolve_analysis_artifact_path(&root, &cache_dir, &artifact);
            if !path.exists() {
                continue;
            }
            let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
            if !is_child_path(&cache_root, &resolved) || resolved.starts_with(&task_root) {
                continue;
            }
            // Stale generated-cache paths should not block removing the task record itself.
            let _ = if resolved.is_dir() {
                fs::remove_dir_all(&resolved)
            } else {
                fs::remove_file(&resolved)
            };
        }
    }
    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| format!("删除任务失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn scan_analysis_task_cache(
    app: tauri::AppHandle,
    request: DeleteAnalysisTaskRequest,
) -> Result<CacheScanResult, String> {
    if !is_safe_storage_id(&request.task_id) {
        return Err("任务标识无效".to_string());
    }
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    let task_dir = analysis_tasks_dir(&cache_dir).join(&request.task_id);
    let manifest_path = task_dir.join("task.json");
    let mut items = Vec::new();
    let mut seen = BTreeSet::new();

    let record = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<AnalysisTaskRecord>(&content).ok())
        .unwrap_or_default();

    if task_dir.is_dir() {
        for entry in fs::read_dir(&task_dir).map_err(|e| format!("读取任务缓存失败: {e}"))?
        {
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(_) => continue,
            };
            if path == manifest_path {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if name.starts_with("task.json.") {
                continue;
            }
            if seen.insert(path_to_string(&path)) {
                if let Ok(Some(entry)) = build_cache_entry(
                    &cache_dir,
                    &path,
                    "任务断点",
                    "当前任务的比较断点或临时恢复数据",
                ) {
                    items.push(entry);
                }
            }
        }
    }

    let base = cache_dir
        .canonicalize()
        .unwrap_or_else(|_| cache_dir.clone());
    for artifact in record.cache_artifacts {
        let path = resolve_analysis_artifact_path(&root, &cache_dir, &artifact);
        if !path.exists() {
            continue;
        }
        let target = path.canonicalize().unwrap_or_else(|_| path.clone());
        if !is_child_path(&base, &target) || !seen.insert(path_to_string(&target)) {
            continue;
        }
        if let Ok(Some(entry)) = build_cache_entry(
            &cache_dir,
            &target,
            if artifact.category.is_empty() {
                "任务生成缓存"
            } else {
                &artifact.category
            },
            if artifact.description.is_empty() {
                "当前任务新生成的视频特征缓存；同配置任务可能复用"
            } else {
                &artifact.description
            },
        ) {
            items.push(entry);
        }
    }

    items.sort_by(|left, right| {
        left.category
            .cmp(&right.category)
            .then(left.name.cmp(&right.name))
    });
    let total_size_bytes = items.iter().map(|item| item.size_bytes).sum();
    let total_entries = items.iter().map(|item| item.entry_count).sum();
    let message = if items.is_empty() {
        "该任务没有可清理的独立缓存；复用缓存不会列入当前任务。".to_string()
    } else {
        format!("发现 {} 个当前任务产生或持有的缓存项目", items.len())
    };

    Ok(CacheScanResult {
        cache_dir: path_to_string(cache_dir),
        items,
        total_size_bytes,
        total_entries,
        message,
    })
}

#[tauri::command]
fn run_batch_compare(
    app: tauri::AppHandle,
    task_state: State<'_, TaskState>,
    config: RunBatchCompareConfig,
) -> Result<AnalysisFinishedPayload, String> {
    let root = resolve_config_project_root(&app, config.project_root.as_deref())?;
    let video_dir = resolve_user_path(&root, &config.video_dir);
    if config.video_dir.trim().is_empty() {
        let message = "请选择视频目录".to_string();
        emit_error(&app, &message);
        return Err(message);
    }
    if !video_dir.exists() || !video_dir.is_dir() {
        let message = format!("视频目录不存在或不可用: {}", video_dir.display());
        emit_error(&app, &message);
        return Err(message);
    }

    let script = root.join("scripts").join("batch_compare.py");
    if !script.exists() {
        let message = format!("找不到批量分析脚本: {}", script.display());
        emit_error(&app, &message);
        return Err(message);
    }

    let output_dir = config
        .output_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|path| resolve_user_path(&root, path))
        .unwrap_or_else(|| root.join("data").join("reports"));
    let cache_dir = resolve_user_path(&root, &config.cache_dir);
    fs::create_dir_all(&output_dir).map_err(|e| format!("创建报告目录失败: {e}"))?;
    fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let output_stem = unique_report_stem("analysis", &video_dir);
    let output_json = output_dir.join(format!("{output_stem}.json"));
    let output_csv = output_dir.join(format!("{output_stem}.csv"));
    let output_html = output_dir.join(format!("{output_stem}.html"));
    let device = config.device.clone().unwrap_or_else(|| "auto".to_string());
    let runtime_dir = cache_dir.join(".runtime");
    fs::create_dir_all(&runtime_dir).map_err(|e| format!("创建运行状态目录失败: {e}"))?;
    let cancel_file = runtime_dir.join(format!("cancel-{}.flag", timestamp_millis()));
    if cancel_file.exists() {
        let _ = fs::remove_file(&cancel_file);
    }
    let video_list_path = if config.video_paths.is_empty() {
        None
    } else {
        let paths = config
            .video_paths
            .iter()
            .map(|path| path.trim())
            .filter(|path| !path.is_empty())
            .map(|path| path_to_string(resolve_user_path(&root, path)))
            .collect::<Vec<_>>();
        let path = runtime_dir.join(format!("videos-{}.json", timestamp_millis()));
        fs::write(
            &path,
            serde_json::to_string_pretty(&paths)
                .map_err(|e| format!("序列化视频扫描范围失败: {e}"))?,
        )
        .map_err(|e| format!("写入视频扫描范围失败: {e}"))?;
        Some(path)
    };
    let python = resolve_python(&app, &root, config.python_path.as_deref());
    let task_id = config
        .task_id
        .as_deref()
        .filter(|value| is_safe_storage_id(value))
        .map(str::to_string)
        .unwrap_or_else(|| format!("analysis-{}", timestamp_millis()));
    let execution_stage = config
        .execution_stage
        .as_deref()
        .filter(|value| {
            matches!(
                *value,
                "scan" | "cache" | "features" | "candidate" | "compare" | "report"
            )
        })
        .map(str::to_string);
    let redo_stage = config.redo_stage.unwrap_or(false);
    let task_config_json =
        serde_json::to_string(&config).map_err(|e| format!("序列化任务配置失败: {e}"))?;

    {
        let pid_guard = task_state
            .current_pid
            .lock()
            .map_err(|_| "任务状态锁定失败".to_string())?;
        if pid_guard.is_some() {
            let message = "已有分析任务正在运行".to_string();
            emit_error(&app, &message);
            return Err(message);
        }
        if let Ok(mut cancel_guard) = task_state.cancel_requested.lock() {
            *cancel_guard = false;
        };
    }

    let mut args = vec![
        "-u".into(),
        script_arg(&script),
        "--input".into(),
        path_to_string(&video_dir),
        "--cache-dir".into(),
        path_to_string(&cache_dir),
        "--output".into(),
        path_to_string(&output_json),
        "--skip-threshold".into(),
        config.skip_threshold.to_string(),
        "--match-threshold".into(),
        config.match_threshold.to_string(),
        "--window-size".into(),
        config.window_size.to_string(),
        "--top-k".into(),
        config.top_k.to_string(),
        "--candidate-limit".into(),
        config.candidate_limit.unwrap_or(20).to_string(),
        "--compare-workers".into(),
        config
            .compare_workers
            .unwrap_or(1)
            .max(1)
            .min(8)
            .to_string(),
        "--max-gap-sec".into(),
        config.max_gap_sec.to_string(),
        "--frame-step".into(),
        config.frame_step.unwrap_or(1).max(1).to_string(),
        "--resize-mode".into(),
        config.resize_mode,
        "--input-size".into(),
        config.input_size.to_string(),
        "--portrait-rotation".into(),
        config
            .portrait_rotation
            .unwrap_or_else(|| "right_90".to_string()),
        "--device".into(),
        device.clone(),
        "--error-tolerance".into(),
        config
            .error_tolerance_preset
            .unwrap_or_else(|| "balanced".to_string()),
        "--error-severe-limit".into(),
        config
            .error_tolerance_severe_limit
            .unwrap_or(20)
            .to_string(),
        "--error-missing-limit".into(),
        config
            .error_tolerance_missing_picture_limit
            .unwrap_or(100)
            .to_string(),
        "--cancel-file".into(),
        path_to_string(&cancel_file),
        "--task-id".into(),
        task_id.clone(),
        "--task-match-key".into(),
        config.task_match_key.unwrap_or_default(),
        "--task-config-json".into(),
        task_config_json,
    ];
    if let Some(stage_id) = execution_stage.as_deref() {
        args.extend(["--target-stage".into(), stage_id.to_string()]);
    }
    if let Some(path) = video_list_path.as_deref() {
        args.extend(["--video-list".into(), path_to_string(path)]);
    }
    if redo_stage {
        args.push("--redo-stage".into());
    }

    if let Some(value) = config.min_segment_duration {
        args.extend(["--min-segment-duration".into(), value.to_string()]);
    }
    if let Some(value) = config.min_segment_matches {
        args.extend(["--min-segment-matches".into(), value.to_string()]);
    }
    if let Some(value) = config.offset_tolerance {
        args.extend(["--offset-tolerance".into(), value.to_string()]);
    }
    if config.crop_black_borders {
        args.push("--crop-black-borders".into());
    }
    if config.force {
        args.push("--force".into());
    }
    if config.early_stop == Some(false) {
        args.push("--disable-early-stop".into());
    }
    if !config.error_tolerance_preflight_validation.unwrap_or(true) {
        args.push("--skip-stream-validation".into());
    }

    let mut command = Command::new(&python);
    command
        .current_dir(&root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .env("PYTHONFAULTHANDLER", "1")
        .env("VIDEO_SIM_PROGRESS_PROTOCOL_VERSION", "2")
        .env("OPENCV_LOG_LEVEL", "ERROR")
        .env("OMP_NUM_THREADS", "1")
        .env("TORCH_NUM_THREADS", "1");
    if device.eq_ignore_ascii_case("cuda") {
        command.env("VIDEO_SIM_EMBED_BATCH_SIZE", "8");
    }
    configure_python_command(&mut command, &root, &python);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000);
    }

    let payload = AnalysisFinishedPayload {
        report_json: path_to_string(output_json),
        report_csv: path_to_string(output_csv),
        report_html: path_to_string(output_html),
    };

    {
        let mut running_guard = task_state
            .is_running
            .lock()
            .map_err(|_| "任务状态锁定失败".to_string())?;
        if *running_guard {
            let message = "已有分析任务正在运行".to_string();
            emit_error(&app, &message);
            return Err(message);
        }
        *running_guard = true;
    }
    if let Ok(mut pid_guard) = task_state.current_pid.lock() {
        *pid_guard = None;
    }
    if let Ok(mut cancel_file_guard) = task_state.cancel_file.lock() {
        *cancel_file_guard = Some(cancel_file);
    }
    if let Ok(mut cancel_guard) = task_state.cancel_requested.lock() {
        *cancel_guard = false;
    }

    emit_progress(&app, "分析任务已启动，正在后台运行", 1.0);

    let app_for_task = app.clone();
    let payload_for_task = payload.clone();
    let task_id_for_event = task_id.clone();
    let stage_for_event = execution_stage.clone();
    thread::spawn(move || {
        run_batch_compare_process(
            app_for_task,
            command,
            payload_for_task,
            task_id_for_event,
            stage_for_event,
        );
    });

    Ok(payload)
}

#[tauri::command]
fn run_video_merge(
    app: tauri::AppHandle,
    merge_state: State<'_, MergeTaskState>,
    config: VideoMergeConfig,
) -> Result<String, String> {
    if config.inputs.is_empty() {
        return Err("时间线至少需要一个视频片段".to_string());
    }

    let root = resolve_config_project_root(&app, config.project_root.as_deref())?;
    let script = root.join("scripts").join("merge_videos.py");
    if !script.is_file() {
        return Err(format!("找不到视频合并脚本: {}", script.display()));
    }

    {
        let running = merge_state
            .is_running
            .lock()
            .map_err(|_| "合并任务状态锁定失败".to_string())?;
        if *running {
            return Err("已有视频合并任务正在运行".to_string());
        }
    }

    let output_dir = resolve_user_path(&root, &config.output_dir);
    fs::create_dir_all(&output_dir).map_err(|e| format!("创建合并输出目录失败: {e}"))?;

    let mut normalized_config = config.clone();
    normalized_config.output_dir = path_to_string(output_dir);
    normalized_config.inputs = config
        .inputs
        .iter()
        .map(|item| MergeVideoItem {
            path: path_to_string(resolve_user_path(&root, &item.path)),
            start_time: item.start_time,
            track_index: item.track_index,
            trim_start: item.trim_start,
            trim_end: item.trim_end,
            muted: item.muted,
            rotation: item.rotation,
            crop_enabled: item.crop_enabled,
            crop_x: item.crop_x,
            crop_y: item.crop_y,
            crop_width: item.crop_width,
            crop_height: item.crop_height,
            layout_custom: item.layout_custom,
            layout_x: item.layout_x,
            layout_y: item.layout_y,
            layout_width: item.layout_width,
            layout_height: item.layout_height,
        })
        .collect();
    for item in &normalized_config.inputs {
        let path = PathBuf::from(&item.path);
        if !path.is_file() {
            return Err(format!("视频文件不存在: {}", path.display()));
        }
    }

    let runtime_dir = root.join("data").join(".runtime");
    fs::create_dir_all(&runtime_dir).map_err(|e| format!("创建合并运行目录失败: {e}"))?;
    let task_id = format!("merge-{}", timestamp_millis());
    let config_path = runtime_dir.join(format!("{task_id}.json"));
    let result_path = runtime_dir.join(format!("{task_id}.result.json"));
    let config_json = serde_json::to_vec_pretty(&normalized_config)
        .map_err(|e| format!("生成合并配置失败: {e}"))?;
    fs::write(&config_path, config_json).map_err(|e| format!("写入合并配置失败: {e}"))?;

    let python = resolve_python(&app, &root, config.python_path.as_deref());
    let args = vec![
        "-u".into(),
        script_arg(&script),
        "--config".into(),
        script_arg(&config_path),
        "--result".into(),
        script_arg(&result_path),
        "--project-root".into(),
        script_arg(&root),
    ];
    let mut command = Command::new(&python);
    command
        .current_dir(&root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_python_command(&mut command, &root, &python);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000);
    }

    if let Ok(mut running) = merge_state.is_running.lock() {
        *running = true;
    }
    if let Ok(mut pid) = merge_state.current_pid.lock() {
        *pid = None;
    }
    if let Ok(mut cancelled) = merge_state.cancel_requested.lock() {
        *cancelled = false;
    }
    if let Ok(mut path) = merge_state.config_path.lock() {
        *path = Some(config_path.clone());
    }
    if let Ok(mut path) = merge_state.result_path.lock() {
        *path = Some(result_path.clone());
    }

    emit_merge_progress(&app, 1.0, "合并任务已启动");
    let app_for_task = app.clone();
    thread::spawn(move || {
        run_video_merge_process(app_for_task, command, config_path, result_path);
    });
    Ok(task_id)
}

#[tauri::command]
fn cancel_video_merge(
    app: tauri::AppHandle,
    merge_state: State<'_, MergeTaskState>,
) -> Result<(), String> {
    let is_running = merge_state
        .is_running
        .lock()
        .map(|guard| *guard)
        .unwrap_or(false);
    if !is_running {
        return Ok(());
    }
    if let Ok(mut cancelled) = merge_state.cancel_requested.lock() {
        *cancelled = true;
    }
    let pid = merge_state
        .current_pid
        .lock()
        .map_err(|_| "合并任务状态锁定失败".to_string())?
        .to_owned();
    if let Some(pid) = pid {
        let _ = kill_process_tree(pid);
    }
    emit_merge_progress(&app, 1.0, "正在取消合并任务");
    Ok(())
}

#[tauri::command]
async fn run_duplicate_file_check(
    app: tauri::AppHandle,
    config: DuplicateFileCheckConfig,
) -> Result<AnalysisFinishedPayload, String> {
    {
        let task_state = app.state::<TaskState>();
        let mut running_guard = task_state
            .is_running
            .lock()
            .map_err(|_| "任务状态锁定失败".to_string())?;
        if *running_guard {
            return Err("已有分析任务正在运行".to_string());
        }
        *running_guard = true;
        if let Ok(mut pid_guard) = task_state.current_pid.lock() {
            *pid_guard = None;
        }
        if let Ok(mut cancel_file_guard) = task_state.cancel_file.lock() {
            *cancel_file_guard = None;
        }
        {
            let mut cancel_guard = task_state
                .cancel_requested
                .lock()
                .map_err(|_| "任务状态锁定失败".to_string())?;
            *cancel_guard = false;
        }
    }

    let app_for_task = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_duplicate_file_check_impl(app_for_task, config)
    })
    .await
    .map_err(|e| format!("相同文件检查任务异常: {e}"))
    .and_then(|value| value);
    reset_task_state(&app);
    result
}

fn run_duplicate_file_check_impl(
    app: tauri::AppHandle,
    config: DuplicateFileCheckConfig,
) -> Result<AnalysisFinishedPayload, String> {
    let root = resolve_config_project_root(&app, config.project_root.as_deref())?;
    let video_dir = resolve_user_path(&root, &config.video_dir);
    if config.video_dir.trim().is_empty() {
        return Err("请选择视频目录".to_string());
    }
    if !video_dir.exists() || !video_dir.is_dir() {
        return Err(format!("视频目录不存在或不可用: {}", video_dir.display()));
    }

    let output_dir = resolve_user_path(&root, &config.output_dir);
    fs::create_dir_all(&output_dir).map_err(|e| format!("创建报告目录失败: {e}"))?;
    ensure_analysis_not_cancelled(&app)?;

    emit_progress(&app, "扫描视频文件", 5.0);
    emit_log(&app, "stdout", "相同文件检查：开始扫描视频目录");
    let videos = if config.video_paths.is_empty() {
        scan_videos_impl(ScanRequest {
            input_dir: path_to_string(&video_dir),
            recursive: config.recursive.or(Some(true)),
        })?
    } else {
        let mut selected = Vec::new();
        let mut failed = Vec::new();
        let mut seen = BTreeSet::new();
        for raw_path in &config.video_paths {
            let path_text = normalize_display_path(raw_path.trim()).trim().to_string();
            if path_text.is_empty() || !seen.insert(path_text.clone()) {
                continue;
            }
            let path = resolve_user_path(&root, &path_text);
            match video_file_from_path(&path) {
                Ok(video) => selected.push(video),
                Err(error) => failed.push(format!("{}: {error}", path.display())),
            }
        }
        selected.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        if selected.is_empty() {
            return Err("扫描范围内没有可检查的视频文件".to_string());
        }
        if !failed.is_empty() {
            emit_log(
                &app,
                "stderr",
                &format!("相同文件检查：{} 个筛选视频不可用，已跳过", failed.len()),
            );
        }
        selected
    };
    ensure_analysis_not_cancelled(&app)?;
    emit_log(
        &app,
        "stdout",
        &format!("相同文件检查：发现 {} 个视频文件", videos.len()),
    );

    let mut by_size: BTreeMap<u64, Vec<VideoFile>> = BTreeMap::new();
    for video in videos.iter().cloned() {
        if video.size_bytes > 0 {
            by_size.entry(video.size_bytes).or_default().push(video);
        }
    }

    let candidates = by_size
        .values()
        .filter(|group| group.len() > 1)
        .map(Vec::len)
        .sum::<usize>();
    emit_progress_detail(
        &app,
        "计算同大小文件指纹",
        20.0,
        Some(&format!("候选文件 {candidates} 个")),
        Some(0.0),
    );

    let mut fingerprint_groups: BTreeMap<String, Vec<VideoFile>> = BTreeMap::new();
    let mut processed = 0usize;
    for group in by_size.values().filter(|group| group.len() > 1) {
        for video in group {
            ensure_analysis_not_cancelled(&app)?;
            processed += 1;
            let fingerprint = file_fingerprint(&PathBuf::from(&video.path))
                .map_err(|e| format!("计算文件指纹失败 {}: {e}", video.path))?;
            fingerprint_groups
                .entry(format!("{}:{fingerprint}", video.size_bytes))
                .or_default()
                .push(video.clone());

            let sub_progress = if candidates > 0 {
                processed as f64 / candidates as f64 * 100.0
            } else {
                100.0
            };
            emit_progress_detail(
                &app,
                "计算同大小文件指纹",
                20.0 + sub_progress * 0.55,
                Some(&video.name),
                Some(sub_progress),
            );
        }
    }

    emit_progress(&app, "生成相同文件报告", 86.0);
    let timestamp = timestamp_millis().to_string();
    let duplicate_groups = fingerprint_groups
        .into_iter()
        .filter(|(_, group)| group.len() > 1)
        .collect::<Vec<_>>();
    let mut pairs = Vec::new();
    let mut duplicate_file_count = 0usize;

    for (group_index, (fingerprint, group)) in duplicate_groups.iter().enumerate() {
        ensure_analysis_not_cancelled(&app)?;
        duplicate_file_count += group.len();
        let paths = group
            .iter()
            .map(|video| video.path.clone())
            .collect::<Vec<_>>();
        for left_index in 0..group.len() {
            for right_index in (left_index + 1)..group.len() {
                let left = &group[left_index];
                let right = &group[right_index];
                pairs.push(serde_json::json!({
                    "analysis_mode": "duplicate_file",
                    "duplicate_group_id": format!("duplicate-group-{}", group_index + 1),
                    "duplicate_group_paths": paths.clone(),
                    "file_size_bytes": left.size_bytes,
                    "fingerprint": fingerprint,
                    "completed_at": timestamp.clone(),
                    "video_a": left.name,
                    "video_b": right.name,
                    "video_a_path": left.path,
                    "video_b_path": right.path,
                    "a_in_b": 1.0,
                    "b_in_a": 1.0,
                    "symmetric_similarity": 1.0,
                    "avg_similarity_a_to_b": 1.0,
                    "avg_similarity_b_to_a": 1.0,
                    "relation": "identical_file",
                    "matched_segment_count": 0,
                    "matches_a_to_b_total": 1,
                    "matches_b_to_a_total": 1,
                    "matches_a_to_b": [{
                        "source_video": left.path,
                        "target_video": right.path,
                        "source_frame_index": 0,
                        "target_frame_index": 0,
                        "source_timestamp": 0,
                        "target_timestamp": 0,
                        "similarity": 1.0
                    }],
                    "matches_b_to_a": [{
                        "source_video": right.path,
                        "target_video": left.path,
                        "source_frame_index": 0,
                        "target_frame_index": 0,
                        "source_timestamp": 0,
                        "target_timestamp": 0,
                        "similarity": 1.0
                    }]
                }));
            }
        }
    }

    let warnings = if pairs.is_empty() {
        vec!["未发现内容完全相同且路径不同的视频文件".to_string()]
    } else {
        Vec::new()
    };
    let pair_count = pairs.len();
    let report = serde_json::json!({
        "analysis_mode": "duplicate_file",
        "timestamp": timestamp,
        "num_videos": videos.len(),
        "num_pairs": pair_count,
        "duplicate_group_count": duplicate_groups.len(),
        "duplicate_file_count": duplicate_file_count,
        "warnings": warnings,
        "settings": {
            "mode": "duplicate_file",
            "method": "file_size_and_content_fingerprint",
            "frame_extraction": false
        },
        "video_pairs": pairs
    });

    let output_stem = unique_report_stem("duplicate_files", &video_dir);
    let output_json = output_dir.join(format!("{output_stem}.json"));
    let output_csv = output_dir.join(format!("{output_stem}.csv"));
    let output_html = output_dir.join(format!("{output_stem}.html"));
    ensure_analysis_not_cancelled(&app)?;
    fs::write(
        &output_json,
        serde_json::to_string_pretty(&report).map_err(|e| format!("生成 JSON 报告失败: {e}"))?,
    )
    .map_err(|e| format!("写入 JSON 报告失败: {e}"))?;
    fs::write(&output_csv, duplicate_report_csv(&report))
        .map_err(|e| format!("写入 CSV 报告失败: {e}"))?;
    fs::write(&output_html, duplicate_report_html(&report))
        .map_err(|e| format!("写入 HTML 报告失败: {e}"))?;

    emit_log(
        &app,
        "stdout",
        &format!(
            "相同文件检查完成：{} 个重复组，{} 对相同文件",
            duplicate_groups.len(),
            pair_count
        ),
    );
    emit_progress(&app, "相同文件检查完成", 100.0);

    Ok(AnalysisFinishedPayload {
        report_json: path_to_string(output_json),
        report_csv: path_to_string(output_csv),
        report_html: path_to_string(output_html),
    })
}

fn ensure_analysis_not_cancelled(app: &tauri::AppHandle) -> Result<(), String> {
    if is_cancel_requested(app) {
        Err("任务已暂停，可从任务列表继续".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn cancel_current_task(
    app: tauri::AppHandle,
    task_state: State<'_, TaskState>,
) -> Result<(), String> {
    let is_running = task_state
        .is_running
        .lock()
        .map(|guard| *guard)
        .unwrap_or(false);
    if !is_running {
        return Ok(());
    }

    if let Ok(mut cancel_guard) = task_state.cancel_requested.lock() {
        *cancel_guard = true;
    }

    let pid = task_state
        .current_pid
        .lock()
        .map_err(|_| "任务状态锁定失败".to_string())?
        .to_owned();

    let Some(pid) = pid else {
        write_cancel_file(&app)?;
        let _ = app.emit(
            "analysis-log",
            AnalysisLogPayload {
                stream: "stderr".to_string(),
                line: "已请求取消，等待分析进程启动后终止".to_string(),
                timestamp: timestamp_millis(),
            },
        );
        emit_progress(&app, "正在取消分析任务", 1.0);
        return Ok(());
    };

    write_cancel_file(&app)?;
    let _ = app.emit(
        "analysis-log",
        AnalysisLogPayload {
            stream: "stderr".to_string(),
            line: "已请求取消分析，正在等待当前步骤安全停止...".to_string(),
            timestamp: timestamp_millis(),
        },
    );
    emit_progress(&app, "正在取消分析任务", 1.0);
    spawn_cancel_watchdog(app, pid);
    Ok(())
}

fn run_batch_compare_process(
    app: tauri::AppHandle,
    mut command: Command,
    payload: AnalysisFinishedPayload,
    task_id: String,
    execution_stage: Option<String>,
) {
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Python 环境不可用，请在设置中检查 Python 路径: {error}");
            emit_log(&app, "stderr", &message);
            emit_error(&app, &message);
            reset_task_state(&app);
            return;
        }
    };

    if let Ok(mut pid_guard) = app.state::<TaskState>().current_pid.lock() {
        *pid_guard = Some(child.id());
    }

    emit_progress(&app, "启动 Python 分析进程", 2.0);

    let last_activity = Arc::new(AtomicU64::new(timestamp_millis_u64()));
    let current_progress = Arc::new(AtomicU64::new(progress_to_centi(2.0)));
    let heartbeat_stop = Arc::new(AtomicBool::new(false));
    let heartbeat_handle = spawn_heartbeat_thread(
        app.clone(),
        heartbeat_stop.clone(),
        last_activity.clone(),
        current_progress.clone(),
    );

    if is_cancel_requested(&app) {
        let _ = write_cancel_file(&app);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = stdout.map(|stream| {
        spawn_log_thread(
            app.clone(),
            "stdout",
            stream,
            last_activity.clone(),
            current_progress.clone(),
        )
    });
    let stderr_handle = stderr.map(|stream| {
        spawn_log_thread(
            app.clone(),
            "stderr",
            stream,
            last_activity.clone(),
            current_progress.clone(),
        )
    });

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            let message = format!("等待 Python 进程失败: {error}");
            emit_log(&app, "stderr", &message);
            emit_error(&app, &message);
            heartbeat_stop.store(true, Ordering::Relaxed);
            let _ = heartbeat_handle.join();
            join_log_threads(stdout_handle, stderr_handle);
            reset_task_state(&app);
            return;
        }
    };

    heartbeat_stop.store(true, Ordering::Relaxed);
    let _ = heartbeat_handle.join();
    join_log_threads(stdout_handle, stderr_handle);

    let cancelled = is_cancel_requested(&app) || status.code() == Some(130);
    reset_task_state(&app);

    if cancelled {
        let message = "分析已取消".to_string();
        emit_log(&app, "stderr", &message);
        emit_error(&app, &message);
        return;
    }

    if !status.success() {
        let message = match status.code() {
            Some(code) => python_exit_message(code),
            None => "Python 分析被系统终止".to_string(),
        };
        emit_log(&app, "stderr", &message);
        emit_error(&app, &message);
        return;
    }

    if let Some(stage_id) = execution_stage {
        emit_progress(&app, "当前阶段已完成", 100.0);
        let _ = app.emit(
            "analysis-stage-finished",
            AnalysisStageFinishedPayload { task_id, stage_id },
        );
    } else {
        emit_progress(&app, "分析完成", 100.0);
        let _ = app.emit("analysis-finished", payload);
    }
}

fn run_video_merge_process(
    app: tauri::AppHandle,
    mut command: Command,
    config_path: PathBuf,
    result_path: PathBuf,
) {
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            emit_merge_error(&app, &format!("无法启动视频合并进程: {error}"));
            reset_merge_task_state(&app);
            return;
        }
    };

    if let Ok(mut pid) = app.state::<MergeTaskState>().current_pid.lock() {
        *pid = Some(child.id());
    }

    let stdout_handle = child
        .stdout
        .take()
        .map(|stream| spawn_merge_stream_thread(app.clone(), "stdout", stream));
    let stderr_handle = child
        .stderr
        .take()
        .map(|stream| spawn_merge_stream_thread(app.clone(), "stderr", stream));
    let status = child.wait();
    join_log_threads(stdout_handle, stderr_handle);

    let cancelled = app
        .state::<MergeTaskState>()
        .cancel_requested
        .lock()
        .map(|guard| *guard)
        .unwrap_or(false);

    let outcome = match status {
        Ok(status) if cancelled || status.code() == Some(130) => Err("视频合并已取消".to_string()),
        Ok(status) if !status.success() => Err(match status.code() {
            Some(code) => format!("视频合并失败，退出码: {code}。请展开日志查看 FFmpeg 详细原因。"),
            None => "视频合并进程被系统终止".to_string(),
        }),
        Err(error) => Err(format!("等待视频合并进程失败: {error}")),
        Ok(_) => fs::read_to_string(&result_path)
            .map_err(|e| format!("读取合并结果失败: {e}"))
            .and_then(|content| {
                serde_json::from_str::<MergeFinishedPayload>(&content)
                    .map_err(|e| format!("解析合并结果失败: {e}"))
            })
            .map(|payload| {
                emit_merge_progress(&app, 100.0, &payload.message);
                let _ = app.emit("merge-finished", payload);
            }),
    };

    if let Err(message) = outcome {
        emit_merge_error(&app, &message);
    }
    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(result_path);
    reset_merge_task_state(&app);
}

fn spawn_merge_stream_thread<S>(
    app: tauri::AppHandle,
    stream_name: &'static str,
    stream: S,
) -> thread::JoinHandle<()>
where
    S: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            let cleaned = strip_ansi_sequences(&line);
            if let Some(payload) = cleaned.strip_prefix("MERGE_PROGRESS|") {
                let mut parts = payload.splitn(2, '|');
                if let (Some(progress), Some(stage)) = (parts.next(), parts.next()) {
                    if let Ok(progress) = progress.parse::<f64>() {
                        emit_merge_progress(&app, progress, stage);
                        continue;
                    }
                }
            }
            if cleaned.trim().is_empty() {
                continue;
            }
            let _ = app.emit(
                "merge-log",
                AnalysisLogPayload {
                    stream: stream_name.to_string(),
                    line: cleaned,
                    timestamp: timestamp_millis(),
                },
            );
        }
    })
}

fn emit_merge_progress<R: tauri::Runtime>(app: &tauri::AppHandle<R>, progress: f64, stage: &str) {
    let _ = app.emit(
        "merge-progress",
        MergeProgressPayload {
            progress: round_progress(progress),
            stage: stage.to_string(),
        },
    );
}

fn emit_merge_error<R: tauri::Runtime>(app: &tauri::AppHandle<R>, message: &str) {
    let _ = app.emit(
        "merge-error",
        MergeErrorPayload {
            message: message.to_string(),
        },
    );
}

fn reset_merge_task_state(app: &tauri::AppHandle) {
    let state = app.state::<MergeTaskState>();
    if let Ok(mut pid) = state.current_pid.lock() {
        *pid = None;
    }
    if let Ok(mut running) = state.is_running.lock() {
        *running = false;
    }
    if let Ok(mut cancelled) = state.cancel_requested.lock() {
        *cancelled = false;
    }
    if let Ok(mut path) = state.config_path.lock() {
        *path = None;
    }
    if let Ok(mut path) = state.result_path.lock() {
        *path = None;
    };
}

fn python_exit_message(code: i32) -> String {
    if code == -1073740791 {
        return "Python 分析失败，退出码: -1073740791。Windows 原生库发生异常，常见原因是 CUDA 显存不足、显卡驱动/torch 版本不匹配，或视频解码库崩溃。已默认降低 GPU 批处理大小；如果仍失败，请先切换 CPU 或降低匹配分辨率后重试。".to_string();
    }
    format!("Python 分析失败，退出码: {code}")
}

fn join_log_threads(
    stdout_handle: Option<thread::JoinHandle<()>>,
    stderr_handle: Option<thread::JoinHandle<()>>,
) {
    if let Some(handle) = stdout_handle {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }
}

fn reset_task_state(app: &tauri::AppHandle) {
    let task_state = app.state::<TaskState>();
    if let Ok(mut pid_guard) = task_state.current_pid.lock() {
        *pid_guard = None;
    }
    if let Ok(mut cancel_file_guard) = task_state.cancel_file.lock() {
        if let Some(path) = cancel_file_guard.take() {
            let _ = fs::remove_file(path);
        }
    }
    if let Ok(mut cancel_guard) = task_state.cancel_requested.lock() {
        *cancel_guard = false;
    }
    if let Ok(mut running_guard) = task_state.is_running.lock() {
        *running_guard = false;
    };
}

fn is_cancel_requested(app: &tauri::AppHandle) -> bool {
    app.state::<TaskState>()
        .cancel_requested
        .lock()
        .map(|guard| *guard)
        .unwrap_or(false)
}

fn write_cancel_file(app: &tauri::AppHandle) -> Result<(), String> {
    let cancel_file = app
        .state::<TaskState>()
        .cancel_file
        .lock()
        .map_err(|_| "任务状态锁定失败".to_string())?
        .clone();

    if let Some(path) = cancel_file {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建取消标记目录失败: {e}"))?;
        }
        fs::write(&path, "cancel").map_err(|e| format!("写入取消标记失败: {e}"))?;
    }

    Ok(())
}

fn spawn_cancel_watchdog(app: tauri::AppHandle, pid: u32) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(60));
        let task_state = app.state::<TaskState>();
        let should_force = task_state
            .is_running
            .lock()
            .map(|guard| *guard)
            .unwrap_or(false)
            && task_state
                .cancel_requested
                .lock()
                .map(|guard| *guard)
                .unwrap_or(false)
            && task_state
                .current_pid
                .lock()
                .map(|guard| *guard == Some(pid))
                .unwrap_or(false);

        if should_force {
            emit_log(&app, "stderr", "取消超时，正在强制结束分析进程...");
            let _ = kill_process_tree(pid);
        }
    });
}

#[tauri::command]
fn list_reports(
    app: tauri::AppHandle,
    request: OutputDirRequest,
) -> Result<Vec<ReportSummary>, String> {
    let output_dir = PathBuf::from(request.output_dir);
    if !output_dir.exists() {
        return Ok(Vec::new());
    }
    let root = resolve_project_root(&app)?;
    let cache_path = report_list_cache_path(&root, &output_dir);
    if !request.refresh && cache_path.is_file() {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if let Ok(cached) = serde_json::from_str::<Vec<ReportSummary>>(&content) {
                return Ok(cached);
            }
        }
    }

    let mut groups: BTreeMap<String, ReportGroup> = BTreeMap::new();
    for entry in fs::read_dir(&output_dir).map_err(|e| format!("读取报告目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取报告项失败: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|item| item.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if !REPORT_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|item| item.to_str())
            .unwrap_or("report")
            .to_string();
        let metadata = fs::metadata(&path).map_err(|e| format!("读取报告信息失败: {e}"))?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(system_time_to_string)
            .unwrap_or_default();

        let group = groups.entry(stem.clone()).or_insert_with(|| ReportGroup {
            stem,
            ..ReportGroup::default()
        });
        group.size_bytes += metadata.len();
        if modified_at > group.modified_at {
            group.modified_at = modified_at;
        }
        match extension.as_str() {
            "json" => group.json_path = Some(path),
            "csv" => group.csv_path = Some(path),
            "html" => group.html_path = Some(path),
            _ => {}
        }
    }

    let mut reports = Vec::new();
    for (_, group) in groups {
        let formats = [
            group.json_path.as_ref().map(|_| "JSON".to_string()),
            group.csv_path.as_ref().map(|_| "CSV".to_string()),
            group.html_path.as_ref().map(|_| "HTML".to_string()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let path = group
            .json_path
            .as_ref()
            .or(group.csv_path.as_ref())
            .or(group.html_path.as_ref())
            .map(path_to_string)
            .unwrap_or_default();

        reports.push(ReportSummary {
            id: group.stem.clone(),
            name: group.stem,
            path,
            json_path: group.json_path.map(path_to_string),
            csv_path: group.csv_path.map(path_to_string),
            html_path: group.html_path.map(path_to_string),
            created_at: group.modified_at.clone(),
            modified_at: group.modified_at,
            size_bytes: group.size_bytes,
            video_count: 0,
            pair_count: 0,
            warning_count: 0,
            status: "可查看".to_string(),
            formats,
        });
    }

    reports.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    if let Some(parent) = cache_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string(&reports) {
        let _ = fs::write(cache_path, content);
    }
    Ok(reports)
}

fn report_list_cache_path(root: &Path, output_dir: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    output_dir
        .to_string_lossy()
        .to_lowercase()
        .hash(&mut hasher);
    root.join("data")
        .join("cache")
        .join("ui")
        .join(format!("reports-{:016x}.json", hasher.finish()))
}

#[tauri::command]
fn read_report(app: tauri::AppHandle, request: ReportPathRequest) -> Result<Value, String> {
    let root = resolve_project_root(&app)?;
    let path = resolve_user_path(&root, &request.path);
    let content = fs::read_to_string(&path).map_err(|e| format!("读取报告失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析报告 JSON 失败: {e}"))
}

#[tauri::command]
fn read_text_file(app: tauri::AppHandle, request: ReportPathRequest) -> Result<String, String> {
    let root = resolve_project_root(&app)?;
    let path = resolve_user_path(&root, &request.path);
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败 {}: {e}", path.display()))
}

#[tauri::command]
fn path_status(app: tauri::AppHandle, request: ReportPathRequest) -> Result<PathStatus, String> {
    let root = resolve_project_root(&app)?;
    let raw_path = PathBuf::from(&request.path);
    let resolved_path = if raw_path.is_absolute() {
        raw_path
    } else {
        root.join(raw_path)
    };
    let normalized_path = resolved_path
        .canonicalize()
        .unwrap_or_else(|_| resolved_path.clone());
    let metadata = fs::metadata(&normalized_path).ok();

    Ok(PathStatus {
        exists: metadata.is_some(),
        is_file: metadata.as_ref().is_some_and(|item| item.is_file()),
        normalized_path: path_to_string(normalized_path),
    })
}

#[tauri::command]
fn capture_video_frame(
    app: tauri::AppHandle,
    request: CaptureFrameRequest,
) -> Result<String, String> {
    let root = resolve_project_root(&app)?;
    let raw_path = PathBuf::from(request.path);
    let video_path = if raw_path.is_absolute() {
        raw_path
    } else {
        root.join(raw_path)
    };
    if !video_path.exists() || !video_path.is_file() {
        return Err(format!("视频文件不存在: {}", video_path.display()));
    }

    let python = resolve_python(&app, &root, None);
    let timestamp = request.timestamp.max(0.0).to_string();
    let frame_index = request.frame_index.unwrap_or(-1).max(-1).to_string();
    let script = r#"
import base64
import sys

import cv2

video_path = sys.argv[1]
timestamp = max(0.0, float(sys.argv[2]))
frame_index = int(float(sys.argv[3])) if len(sys.argv) > 3 else -1
capture = cv2.VideoCapture(video_path)
if not capture.isOpened():
    raise SystemExit("OpenCV cannot open video")

ok = False
frame = None
if frame_index >= 0:
    capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
    ok, frame = capture.read()
if not ok or frame is None:
    capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
    ok, frame = capture.read()
if not ok or frame is None:
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(timestamp * fps)))
    ok, frame = capture.read()
capture.release()

if not ok or frame is None:
    raise SystemExit("Cannot decode frame at requested timestamp")

ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
if not ok:
    raise SystemExit("Cannot encode frame preview")

print("data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii"))
"#;

    let output = run_capture(
        &root,
        &python,
        vec![
            "-c".into(),
            script.into(),
            script_arg(&video_path),
            timestamp,
            frame_index,
        ],
    )?;

    if !output.status_success {
        return Err(format!(
            "抽取视频帧失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ));
    }

    let data_url = output.stdout.trim();
    if data_url.starts_with("data:image/jpeg;base64,") {
        Ok(data_url.to_string())
    } else {
        Err(format!(
            "抽取视频帧失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ))
    }
}

#[tauri::command]
fn capture_comparison_frame(
    app: tauri::AppHandle,
    request: CaptureComparisonFrameRequest,
) -> Result<String, String> {
    let root = resolve_project_root(&app)?;
    let raw_path = PathBuf::from(&request.path);
    let video_path = if raw_path.is_absolute() {
        raw_path
    } else {
        root.join(raw_path)
    };
    if !video_path.exists() || !video_path.is_file() {
        return Err(format!("视频文件不存在: {}", video_path.display()));
    }

    let cache_path = comparison_frame_cache_path(&root, &video_path, &request)?;
    if cache_path.is_file() {
        return image_file_data_url(&cache_path);
    }
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建算法帧缓存目录失败: {e}"))?;
    }

    let resize_mode = match request.resize_mode.as_str() {
        "letterbox" => "letterbox",
        _ => "center_crop",
    };
    let portrait_rotation = match request.portrait_rotation.as_str() {
        "left_90" => "left_90",
        _ => "right_90",
    };
    let input_size = request.input_size.clamp(1, 2048).to_string();
    let timestamp = request.timestamp.max(0.0).to_string();
    let frame_index = request.frame_index.unwrap_or(-1).max(-1).to_string();
    let crop_black_borders = if request.crop_black_borders { "1" } else { "0" }.to_string();
    let python = resolve_python(&app, &root, None);
    let script = r#"
import base64
import sys

import cv2

from video_sim.preprocess import PreprocessConfig, ResizeMode, PortraitRotation, preprocess_frame_for_clip

video_path = sys.argv[1]
timestamp = max(0.0, float(sys.argv[2]))
frame_index = int(float(sys.argv[3])) if len(sys.argv) > 3 else -1
crop_black_borders = sys.argv[4] == "1"
resize_mode = sys.argv[5]
input_size = max(1, int(sys.argv[6]))
portrait_rotation = sys.argv[7]
output_path = sys.argv[8]

capture = cv2.VideoCapture(video_path)
if not capture.isOpened():
    raise SystemExit("OpenCV cannot open video")

ok = False
frame = None
if frame_index >= 0:
    capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
    ok, frame = capture.read()
if not ok or frame is None:
    capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
    ok, frame = capture.read()
if not ok or frame is None:
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(timestamp * fps)))
    ok, frame = capture.read()
capture.release()

if not ok or frame is None:
    raise SystemExit("Cannot decode frame at requested timestamp")

config = PreprocessConfig(
    crop_black_borders=crop_black_borders,
    resize_mode=ResizeMode(resize_mode),
    input_size=input_size,
    portrait_rotation=PortraitRotation(portrait_rotation),
)
processed = preprocess_frame_for_clip(frame, config)
ok, encoded = cv2.imencode(".jpg", processed, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
if not ok:
    raise SystemExit("Cannot encode comparison frame")

encoded.tofile(output_path)
print("data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii"))
"#;

    let output = run_capture(
        &root,
        &python,
        vec![
            "-c".into(),
            script.into(),
            script_arg(&video_path),
            timestamp,
            frame_index,
            crop_black_borders,
            resize_mode.to_string(),
            input_size,
            portrait_rotation.to_string(),
            script_arg(&cache_path),
        ],
    )?;

    if !output.status_success {
        return Err(format!(
            "抽取算法对比帧失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ));
    }

    let data_url = output.stdout.trim();
    if data_url.starts_with("data:image/jpeg;base64,") {
        Ok(data_url.to_string())
    } else {
        Err(format!(
            "抽取算法对比帧失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ))
    }
}

fn comparison_frame_cache_path(
    root: &Path,
    video_path: &Path,
    request: &CaptureComparisonFrameRequest,
) -> Result<PathBuf, String> {
    let metadata = fs::metadata(video_path).map_err(|e| format!("读取视频信息失败: {e}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    video_path
        .to_string_lossy()
        .to_lowercase()
        .hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    request.timestamp.to_bits().hash(&mut hasher);
    request.frame_index.hash(&mut hasher);
    request.crop_black_borders.hash(&mut hasher);
    request.resize_mode.hash(&mut hasher);
    request.input_size.hash(&mut hasher);
    request.portrait_rotation.hash(&mut hasher);
    Ok(root
        .join("data")
        .join("frames")
        .join("ui_comparison")
        .join(format!("{:016x}.jpg", hasher.finish())))
}

fn image_file_data_url(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取算法帧缓存失败: {e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn delete_report(app: tauri::AppHandle, request: ReportPathRequest) -> Result<(), String> {
    let root = resolve_project_root(&app)?;
    let path = resolve_user_path(&root, &request.path);
    let stem = path.with_extension("");
    for ext in ["json", "csv", "html"] {
        let candidate = stem.with_extension(ext);
        if candidate.exists() {
            fs::remove_file(&candidate)
                .map_err(|e| format!("删除文件失败 {}: {e}", candidate.display()))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn update_report_entries(
    app: tauri::AppHandle,
    request: UpdateReportEntriesRequest,
) -> Result<UpdateReportEntriesResult, String> {
    let root = resolve_project_root(&app)?;
    let path = resolve_user_path(&root, request.path.trim());
    update_report_entries_for_resolved_path(&path, &request.pairs)
}

fn update_report_entries_for_resolved_path(
    path: &Path,
    pairs_to_remove: &[ReportPairIdentity],
) -> Result<UpdateReportEntriesResult, String> {
    if pairs_to_remove.is_empty() {
        return Ok(UpdateReportEntriesResult {
            removed_count: 0,
            remaining_count: 0,
            updated_files: Vec::new(),
        });
    }

    let stem = path.with_extension("");
    let json_path = stem.with_extension("json");
    let csv_path = stem.with_extension("csv");
    let html_path = stem.with_extension("html");
    let mut updated_files = Vec::new();

    if json_path.exists() {
        let content = fs::read_to_string(&json_path)
            .map_err(|e| format!("读取 JSON 报告失败 {}: {e}", json_path.display()))?;
        let mut report: Value = serde_json::from_str(&content)
            .map_err(|e| format!("解析 JSON 报告失败 {}: {e}", json_path.display()))?;
        let pairs = report
            .get_mut("video_pairs")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "JSON 报告中没有可修改的 video_pairs 数据".to_string())?;
        let before = pairs.len();
        pairs.retain(|pair| {
            !pairs_to_remove
                .iter()
                .any(|target| report_pair_matches(pair, target))
        });
        let removed_count = before.saturating_sub(pairs.len());
        let remaining_count = pairs.len();
        if removed_count == 0 {
            return Err("报告中未找到要删除的结果条目".to_string());
        }
        if let Some(object) = report.as_object_mut() {
            object.insert("num_pairs".to_string(), Value::from(remaining_count as u64));
        }
        write_json_atomic(&json_path, &report)?;
        updated_files.push(path_to_string(&json_path));

        if csv_path.exists() {
            write_text_atomic(&csv_path, &report_pairs_csv(&report))?;
            updated_files.push(path_to_string(&csv_path));
        }
        if html_path.exists() {
            write_text_atomic(&html_path, &report_pairs_html(&report))?;
            updated_files.push(path_to_string(&html_path));
        }
        return Ok(UpdateReportEntriesResult {
            removed_count,
            remaining_count,
            updated_files,
        });
    }

    if csv_path.exists() {
        let content = fs::read_to_string(&csv_path)
            .map_err(|e| format!("读取 CSV 报告失败 {}: {e}", csv_path.display()))?;
        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .from_reader(content.as_bytes());
        let headers = reader
            .headers()
            .map_err(|e| format!("读取 CSV 表头失败: {e}"))?
            .clone();
        let mut rows = reader
            .records()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("解析 CSV 报告失败: {e}"))?;
        let before = rows.len();
        rows.retain(|row| {
            !pairs_to_remove
                .iter()
                .any(|target| csv_pair_matches(&headers, row, target))
        });
        let removed_count = before.saturating_sub(rows.len());
        let remaining_count = rows.len();
        if removed_count == 0 {
            return Err("报告中未找到要删除的结果条目".to_string());
        }
        write_text_atomic(&csv_path, &serialize_csv_report(&headers, &rows)?)?;
        updated_files.push(path_to_string(&csv_path));
        if html_path.exists() {
            write_text_atomic(&html_path, &csv_rows_html(&headers, &rows))?;
            updated_files.push(path_to_string(&html_path));
        }
        return Ok(UpdateReportEntriesResult {
            removed_count,
            remaining_count,
            updated_files,
        });
    }

    Err(format!("报告文件不存在: {}", path.display()))
}

#[tauri::command]
fn delete_files(request: DeleteFilesRequest) -> Result<DeleteFilesResult, String> {
    let mut deleted_paths = Vec::new();
    let mut failed = Vec::new();
    let mut seen = BTreeSet::new();

    for raw_path in request.paths {
        let path_text = normalize_display_path(raw_path.trim()).trim().to_string();
        if path_text.is_empty() || !seen.insert(path_text.clone()) {
            continue;
        }

        let path = PathBuf::from(&path_text);
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => match fs::remove_file(&path) {
                Ok(()) => deleted_paths.push(path_to_string(path)),
                Err(error) => failed.push(DeleteFileFailure {
                    path: path_text,
                    error: error.to_string(),
                }),
            },
            Ok(_) => failed.push(DeleteFileFailure {
                path: path_text,
                error: "路径不是文件，已跳过".to_string(),
            }),
            Err(error) => failed.push(DeleteFileFailure {
                path: path_text,
                error: error.to_string(),
            }),
        }
    }

    let message = if failed.is_empty() {
        format!("已删除 {} 个文件", deleted_paths.len())
    } else {
        format!(
            "已删除 {} 个文件，{} 个文件删除失败",
            deleted_paths.len(),
            failed.len()
        )
    };

    Ok(DeleteFilesResult {
        deleted_paths,
        failed,
        message,
    })
}

#[tauri::command]
async fn move_files(
    state: State<'_, FileMoveState>,
    request: MoveFilesRequest,
) -> Result<MoveFilesResult, String> {
    let move_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || move_files_impl(request, move_state))
        .await
        .map_err(|error| format!("移动文件任务异常: {error}"))?
}

#[tauri::command]
fn cancel_move_files(state: State<FileMoveState>) -> Result<FileMoveStatus, String> {
    if !state.is_running() {
        return Err("当前没有正在移动的文件".to_string());
    }
    state.request_cancel();
    Ok(state.snapshot())
}

#[tauri::command]
fn get_file_move_status(state: State<FileMoveState>) -> Result<FileMoveStatus, String> {
    Ok(state.snapshot())
}

fn move_files_impl(
    request: MoveFilesRequest,
    state: FileMoveState,
) -> Result<MoveFilesResult, String> {
    let target_dir_text = normalize_display_path(request.target_dir.trim())
        .trim()
        .to_string();
    if target_dir_text.is_empty() {
        return Err("请选择目标目录".to_string());
    }
    let target_dir = PathBuf::from(&target_dir_text);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;
    if !target_dir.is_dir() {
        return Err("目标路径不是目录".to_string());
    }

    let mut moved_paths = Vec::new();
    let mut failed = Vec::new();
    let mut seen = BTreeSet::new();
    let mut requested_paths = Vec::new();

    for raw_path in request.paths {
        let path_text = normalize_display_path(raw_path.trim()).trim().to_string();
        if path_text.is_empty() || !seen.insert(path_text.clone()) {
            continue;
        }
        requested_paths.push(path_text);
    }

    if !state.try_begin(target_dir_text.clone(), requested_paths.clone()) {
        return Err("已有文件移动任务正在运行，请等待完成或先中断当前移动。".to_string());
    }
    let _guard = FileMoveGuard {
        state: state.clone(),
    };

    for (index, path_text) in requested_paths.iter().enumerate() {
        if state.is_cancel_requested() {
            push_move_cancel_failures(&mut failed, &requested_paths, index);
            break;
        }

        state.set_current_path(Some(path_text.clone()));
        let source = PathBuf::from(path_text);
        let metadata = match fs::metadata(&source) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => {
                failed.push(DeleteFileFailure {
                    path: path_text.clone(),
                    error: "路径不是文件，已跳过".to_string(),
                });
                state.set_current_path(None);
                continue;
            }
            Err(error) => {
                failed.push(DeleteFileFailure {
                    path: path_text.clone(),
                    error: error.to_string(),
                });
                state.set_current_path(None);
                continue;
            }
        };
        let Some(file_name) = source.file_name() else {
            failed.push(DeleteFileFailure {
                path: path_text.clone(),
                error: "无法识别文件名".to_string(),
            });
            state.set_current_path(None);
            continue;
        };
        let destination = unique_move_destination(&target_dir, file_name);
        if source == destination {
            failed.push(DeleteFileFailure {
                path: path_text.clone(),
                error: "源文件已在目标目录中".to_string(),
            });
            state.set_current_path(None);
            continue;
        }

        let move_result = fs::rename(&source, &destination).or_else(|rename_error| {
            copy_file_interruptible(&source, &destination, metadata.len(), &state)
                .and_then(|_| {
                    if state.is_cancel_requested() {
                        let _ = fs::remove_file(&destination);
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "移动已中断",
                        ));
                    }
                    fs::remove_file(&source)
                })
                .map_err(|copy_error| {
                    std::io::Error::new(
                        copy_error.kind(),
                        format!("{rename_error}; 复制兜底也失败: {copy_error}"),
                    )
                })
        });

        match move_result {
            Ok(()) => moved_paths.push(MoveFileRecord {
                from: path_to_string(source),
                to: path_to_string(destination),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                failed.push(DeleteFileFailure {
                    path: path_text.clone(),
                    error: "移动已中断，该文件未完成移动；已尽量清理未完成的目标文件。".to_string(),
                });
                push_move_cancel_failures(&mut failed, &requested_paths, index + 1);
                break;
            }
            Err(error) => failed.push(DeleteFileFailure {
                path: path_text.clone(),
                error: error.to_string(),
            }),
        }
        state.set_current_path(None);
    }

    let interrupted = failed.iter().any(|item| item.error.contains("移动已中断"));
    let message = if interrupted {
        format!(
            "移动已中断：已移动 {} 个文件，{} 个文件未完成或未处理",
            moved_paths.len(),
            failed.len()
        )
    } else if failed.is_empty() {
        format!("已移动 {} 个文件", moved_paths.len())
    } else {
        format!(
            "已移动 {} 个文件，{} 个文件移动失败",
            moved_paths.len(),
            failed.len()
        )
    };

    Ok(MoveFilesResult {
        moved_paths,
        failed,
        message,
    })
}

fn push_move_cancel_failures(
    failed: &mut Vec<DeleteFileFailure>,
    paths: &[String],
    start_index: usize,
) {
    for path in paths.iter().skip(start_index) {
        failed.push(DeleteFileFailure {
            path: path.clone(),
            error: "移动已中断，未处理该文件。".to_string(),
        });
    }
}

fn copy_file_interruptible(
    source: &Path,
    destination: &Path,
    expected_bytes: u64,
    state: &FileMoveState,
) -> std::io::Result<u64> {
    let mut input = File::open(source)?;
    let mut output = File::create(destination)?;
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    let mut copied = 0u64;

    loop {
        if state.is_cancel_requested() {
            drop(output);
            let _ = fs::remove_file(destination);
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "移动已中断",
            ));
        }

        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        copied = copied.saturating_add(read as u64);
    }

    output.flush()?;
    if copied != expected_bytes {
        let _ = fs::remove_file(destination);
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "复制后的文件大小不一致",
        ));
    }
    Ok(copied)
}

fn unique_move_destination(target_dir: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut candidate = target_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let file_path = Path::new(file_name);
    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    let extension = file_path.extension().and_then(|value| value.to_str());

    for index in 1..10_000 {
        let next_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem} ({index}).{ext}"),
            _ => format!("{stem} ({index})"),
        };
        candidate = target_dir.join(next_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    target_dir.join(format!("{stem}-{}", timestamp_millis()))
}

#[tauri::command]
async fn clear_cache(
    app: tauri::AppHandle,
    request: ClearCacheRequest,
) -> Result<ClearCacheResult, String> {
    tauri::async_runtime::spawn_blocking(move || clear_cache_impl(app, request))
        .await
        .map_err(|e| format!("清空缓存任务异常: {e}"))?
}

#[tauri::command]
async fn scan_cache(
    app: tauri::AppHandle,
    request: ClearCacheRequest,
) -> Result<CacheScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || scan_cache_impl(app, request))
        .await
        .map_err(|e| format!("扫描缓存任务异常: {e}"))?
}

#[tauri::command]
async fn clear_cache_items(
    app: tauri::AppHandle,
    request: ClearCacheItemsRequest,
) -> Result<ClearCacheResult, String> {
    tauri::async_runtime::spawn_blocking(move || clear_cache_items_impl(app, request))
        .await
        .map_err(|e| format!("清理缓存任务异常: {e}"))?
}

fn clear_cache_impl(
    app: tauri::AppHandle,
    request: ClearCacheRequest,
) -> Result<ClearCacheResult, String> {
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    if !cache_dir.exists() {
        return Ok(ClearCacheResult {
            removed_entries: 0,
            message: "缓存目录不存在，无需清理".to_string(),
        });
    }
    if !cache_dir.is_dir() {
        return Err(format!("缓存路径不是目录: {}", cache_dir.display()));
    }

    let mut removed_entries = 0usize;
    for name in [
        "video_cache",
        "embeddings",
        "frames",
        "cache",
        ".runtime",
        ".resume",
    ] {
        removed_entries += remove_cache_entry(&cache_dir.join(name))?;
    }
    removed_entries += remove_cache_entry(&cache_dir.join("reports").join(".resume"))?;

    for entry in fs::read_dir(&cache_dir).map_err(|e| format!("读取缓存目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取缓存项失败: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_cache_file = matches!(
            file_name.as_str(),
            "faiss_video_index.bin" | "video_meta.txt" | "index.faiss" | "index.bin"
        ) || matches!(extension.as_str(), "npz" | "faiss" | "index" | "pkl");

        if is_cache_file {
            removed_entries += remove_cache_entry(&path)?;
        }
    }

    Ok(ClearCacheResult {
        removed_entries,
        message: if removed_entries == 0 {
            "没有发现可清理的缓存文件".to_string()
        } else {
            format!("已清理 {removed_entries} 个缓存项")
        },
    })
}

fn scan_cache_impl(
    app: tauri::AppHandle,
    request: ClearCacheRequest,
) -> Result<CacheScanResult, String> {
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    if !cache_dir.exists() {
        return Ok(CacheScanResult {
            cache_dir: path_to_string(cache_dir),
            items: Vec::new(),
            total_size_bytes: 0,
            total_entries: 0,
            message: "缓存目录不存在，无需清理".to_string(),
        });
    }
    if !cache_dir.is_dir() {
        return Err(format!("缓存路径不是目录: {}", cache_dir.display()));
    }

    let mut items = Vec::new();
    let video_cache_dir = cache_dir.join("video_cache");
    if video_cache_dir.exists() {
        let video_entries = build_video_cache_entries(&cache_dir, &video_cache_dir)?;
        if video_entries.is_empty() {
            if let Some(entry) = build_cache_entry(
                &cache_dir,
                &video_cache_dir,
                "视频缓存",
                "按视频保存的抽帧与 CLIP 特征缓存",
            )? {
                items.push(entry);
            }
        } else {
            items.extend(video_entries);
        }
    }

    for (relative, category, description) in [
        ("cache", "界面缓存", "报告索引和页面读取缓存"),
        ("embeddings", "旧版特征缓存", "早期版本生成的扁平特征缓存"),
        ("frames", "旧版帧缓存", "早期版本生成的缩略图或帧文件"),
        (".runtime", "运行状态", "取消标记等临时运行状态"),
        (".resume", "断点恢复", "分析断点恢复状态"),
        ("reports/.resume", "报告断点", "报告目录中的断点恢复状态"),
    ] {
        let path = cache_dir.join(relative);
        if let Some(entry) = build_cache_entry(&cache_dir, &path, category, description)? {
            items.push(entry);
        }
    }

    for entry in fs::read_dir(&cache_dir).map_err(|e| format!("读取缓存目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取缓存项失败: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if is_cache_file(&path) {
            if let Some(entry) = build_cache_entry(
                &cache_dir,
                &path,
                "索引缓存",
                "旧版索引、向量或临时二进制缓存文件",
            )? {
                items.push(entry);
            }
        }
    }

    items.sort_by(|left, right| {
        left.category
            .cmp(&right.category)
            .then(left.name.cmp(&right.name))
    });
    let total_size_bytes = items.iter().map(|item| item.size_bytes).sum();
    let total_entries = items.iter().map(|item| item.entry_count).sum();
    let message = if items.is_empty() {
        "没有发现可清理的缓存项".to_string()
    } else {
        format!(
            "发现 {} 类缓存，共 {} 个文件或目录",
            items.len(),
            total_entries
        )
    };

    Ok(CacheScanResult {
        cache_dir: path_to_string(cache_dir),
        items,
        total_size_bytes,
        total_entries,
        message,
    })
}

fn clear_cache_items_impl(
    app: tauri::AppHandle,
    request: ClearCacheItemsRequest,
) -> Result<ClearCacheResult, String> {
    let root = resolve_config_project_root(&app, request.project_root.as_deref())?;
    let cache_dir = resolve_user_path(&root, &request.cache_dir);
    if !cache_dir.exists() {
        return Ok(ClearCacheResult {
            removed_entries: 0,
            message: "缓存目录不存在，无需清理".to_string(),
        });
    }
    if !cache_dir.is_dir() {
        return Err(format!("缓存路径不是目录: {}", cache_dir.display()));
    }

    let base = cache_dir
        .canonicalize()
        .map_err(|e| format!("读取缓存目录失败: {e}"))?;
    let mut removed_entries = 0usize;
    let mut seen = BTreeSet::new();

    for raw_path in request.paths {
        let path_text = normalize_display_path(raw_path.trim()).trim().to_string();
        if path_text.is_empty() || !seen.insert(path_text.clone()) {
            continue;
        }

        let path = PathBuf::from(&path_text);
        if !path.exists() {
            continue;
        }
        let target = path
            .canonicalize()
            .map_err(|e| format!("读取缓存项失败 {}: {e}", path.display()))?;
        if !is_child_path(&base, &target) {
            return Err(format!("拒绝删除缓存目录外的路径: {}", target.display()));
        }
        removed_entries += remove_cache_entry(&target)?;
    }

    Ok(ClearCacheResult {
        removed_entries,
        message: if removed_entries == 0 {
            "没有清理任何缓存项".to_string()
        } else {
            format!("已清理 {removed_entries} 个缓存项")
        },
    })
}

fn remove_cache_entry(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("删除缓存目录失败 {}: {e}", path.display()))?;
    } else {
        fs::remove_file(path).map_err(|e| format!("删除缓存文件失败 {}: {e}", path.display()))?;
    }
    Ok(1)
}

fn build_video_cache_entries(
    cache_dir: &Path,
    video_cache_dir: &Path,
) -> Result<Vec<CacheEntry>, String> {
    if !video_cache_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(video_cache_dir)
        .map_err(|e| format!("读取视频缓存目录失败 {}: {e}", video_cache_dir.display()))?
    {
        let entry = entry.map_err(|e| format!("读取视频缓存项失败: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let raw_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("video")
            .to_string();
        let video_name = readable_video_cache_name(&raw_name);
        let profile_count = fs::read_dir(&path)
            .ok()
            .map(|items| {
                items
                    .filter_map(Result::ok)
                    .filter(|item| item.path().is_dir())
                    .count()
            })
            .unwrap_or(0);
        let description = if profile_count > 0 {
            format!("视频：{video_name}；包含 {profile_count} 组抽帧/预处理参数缓存")
        } else {
            format!("视频：{video_name}；抽帧与特征缓存")
        };

        if let Some(mut cache_entry) =
            build_cache_entry(cache_dir, &path, "视频缓存", &description)?
        {
            cache_entry.name = video_name;
            entries.push(cache_entry);
        }
    }

    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

fn readable_video_cache_name(raw_name: &str) -> String {
    let stem = raw_name
        .rsplit_once('_')
        .and_then(|(name, digest)| {
            if digest.len() >= 8 && digest.chars().all(|ch| ch.is_ascii_hexdigit()) {
                Some(name)
            } else {
                None
            }
        })
        .unwrap_or(raw_name);
    stem.replace('_', " ")
}

fn build_cache_entry(
    cache_dir: &Path,
    path: &Path,
    category: &str,
    description: &str,
) -> Result<Option<CacheEntry>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let (size_bytes, entry_count) = cache_path_stats(path)?;
    let relative = path
        .strip_prefix(cache_dir)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&relative)
        .to_string();

    Ok(Some(CacheEntry {
        id: relative,
        path: path_to_string(path),
        name,
        kind: if path.is_dir() { "directory" } else { "file" }.to_string(),
        category: category.to_string(),
        description: description.to_string(),
        size_bytes,
        entry_count,
    }))
}

fn cache_path_stats(path: &Path) -> Result<(u64, usize), String> {
    if path.is_file() {
        let size = fs::metadata(path)
            .map_err(|e| format!("读取缓存文件失败 {}: {e}", path.display()))?
            .len();
        return Ok((size, 1));
    }

    let mut size_bytes = 0u64;
    let mut entry_count = 0usize;
    collect_path_stats(path, &mut size_bytes, &mut entry_count)?;
    Ok((size_bytes, entry_count.max(1)))
}

fn collect_path_stats(
    path: &Path,
    size_bytes: &mut u64,
    entry_count: &mut usize,
) -> Result<(), String> {
    for entry in
        fs::read_dir(path).map_err(|e| format!("读取缓存目录失败 {}: {e}", path.display()))?
    {
        let entry = entry.map_err(|e| format!("读取缓存项失败: {e}"))?;
        let child = entry.path();
        *entry_count += 1;
        if child.is_dir() {
            collect_path_stats(&child, size_bytes, entry_count)?;
        } else if child.is_file() {
            *size_bytes = size_bytes.saturating_add(
                fs::metadata(&child)
                    .map_err(|e| format!("读取缓存文件失败 {}: {e}", child.display()))?
                    .len(),
            );
        }
    }
    Ok(())
}

fn is_cache_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    matches!(
        file_name.as_str(),
        "faiss_video_index.bin" | "video_meta.txt" | "index.faiss" | "index.bin"
    ) || matches!(extension.as_str(), "npz" | "faiss" | "index" | "pkl")
}

fn is_child_path(parent: &Path, child: &Path) -> bool {
    child == parent || child.starts_with(parent)
}

#[tauri::command]
fn open_file(app: tauri::AppHandle, request: ReportPathRequest) -> Result<(), String> {
    let root = resolve_project_root(&app)?;
    open_os_path(&resolve_user_path(&root, &request.path))
}

#[tauri::command]
fn reveal_in_folder(app: tauri::AppHandle, request: ReportPathRequest) -> Result<(), String> {
    let root = resolve_project_root(&app)?;
    let path = resolve_user_path(&root, &request.path);
    let directory = if path.is_dir() {
        path
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法定位文件所在目录".to_string())?
    };
    open_os_path(&directory)
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, request: ReportPathRequest) -> Result<(), String> {
    let root = resolve_project_root(&app)?;
    open_os_path(&resolve_user_path(&root, &request.path))
}

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .minimize()
        .map_err(|e| format!("最小化窗口失败: {e}"))
}

#[tauri::command]
fn maximize_window(window: tauri::WebviewWindow) -> Result<bool, String> {
    window
        .maximize()
        .map_err(|e| format!("最大化窗口失败: {e}"))?;
    Ok(true)
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::WebviewWindow) -> Result<bool, String> {
    let maximized = window
        .is_maximized()
        .map_err(|e| format!("读取窗口状态失败: {e}"))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|e| format!("还原窗口失败: {e}"))?;
        Ok(false)
    } else {
        window
            .maximize()
            .map_err(|e| format!("最大化窗口失败: {e}"))?;
        Ok(true)
    }
}

#[tauri::command]
fn set_close_to_tray(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let behavior = if enabled {
        CLOSE_BEHAVIOR_TRAY
    } else {
        CLOSE_BEHAVIOR_EXIT
    };
    CLOSE_BEHAVIOR.store(behavior, Ordering::Relaxed);
    set_tray_visible(&app, enabled);
    Ok(())
}

#[tauri::command]
fn set_close_behavior(app: tauri::AppHandle, behavior: String) -> Result<(), String> {
    let behavior = match behavior.as_str() {
        "ask" => CLOSE_BEHAVIOR_ASK,
        "tray" => CLOSE_BEHAVIOR_TRAY,
        "exit" => CLOSE_BEHAVIOR_EXIT,
        other => return Err(format!("未知关闭方式: {other}")),
    };
    CLOSE_BEHAVIOR.store(behavior, Ordering::Relaxed);
    set_tray_visible(&app, behavior == CLOSE_BEHAVIOR_TRAY);
    Ok(())
}

#[tauri::command]
fn close_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: CloseWindowRequest,
) -> Result<(), String> {
    if request.minimize_to_tray {
        set_tray_visible(&app, true);
        window.hide().map_err(|e| format!("最小化到托盘失败: {e}"))
    } else {
        set_tray_visible(&app, false);
        app.exit(0);
        Ok(())
    }
}

#[tauri::command]
fn is_window_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    window
        .is_maximized()
        .map_err(|e| format!("读取窗口状态失败: {e}"))
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_tray_visible<R: tauri::Runtime>(app: &tauri::AppHandle<R>, visible: bool) {
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show_window", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit_app", "退出应用", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::with_id(MAIN_TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("视频相似度分析")
        .on_menu_event(|app, event| {
            if event.id() == "show_window" {
                show_main_window(app);
            } else if event.id() == "quit_app" {
                show_main_window(app);
                let _ = app.emit("app-exit-requested", ());
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    let tray = tray.build(app)?;
    let _ = tray.set_visible(false);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(TaskState::default())
        .manage(UpdateCancelState::default())
        .manage(MergeTaskState::default())
        .manage(FileMoveState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            setup_tray(_app)?;
            #[cfg(debug_assertions)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.open_devtools();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match CLOSE_BEHAVIOR.load(Ordering::Relaxed) {
                    CLOSE_BEHAVIOR_TRAY => {
                        api.prevent_close();
                        set_tray_visible(window.app_handle(), true);
                        let _ = window.hide();
                    }
                    CLOSE_BEHAVIOR_ASK => {
                        api.prevent_close();
                        let _ = window.emit("app-close-requested", ());
                    }
                    _ => {
                        api.prevent_close();
                        let _ = window.emit("app-exit-requested", ());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            check_for_updates,
            download_and_install_update,
            cancel_update_download,
            open_release_page,
            get_clip_model_status,
            install_clip_model,
            select_video_directory,
            select_video_files,
            select_audio_files,
            select_subtitle_files,
            select_output_directory,
            select_python_executable,
            scan_videos,
            probe_video_metadata,
            check_python_env,
            check_environment,
            list_config_templates,
            save_config_template,
            delete_config_template,
            list_analysis_tasks,
            create_analysis_task,
            update_analysis_task,
            delete_analysis_task,
            scan_analysis_task_cache,
            run_batch_compare,
            run_video_merge,
            cancel_video_merge,
            run_duplicate_file_check,
            cancel_current_task,
            list_reports,
            read_report,
            read_text_file,
            path_status,
            capture_video_frame,
            capture_comparison_frame,
            delete_report,
            update_report_entries,
            delete_files,
            move_files,
            cancel_move_files,
            get_file_move_status,
            clear_cache,
            scan_cache,
            clear_cache_items,
            open_file,
            reveal_in_folder,
            open_path,
            minimize_window,
            maximize_window,
            toggle_maximize_window,
            set_close_to_tray,
            set_close_behavior,
            close_window,
            is_window_maximized,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Debug)]
struct ProcessOutput {
    status_success: bool,
    stdout: String,
    stderr: String,
}

fn select_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    Ok(selected
        .and_then(|folder| folder.into_path().ok())
        .map(path_to_string))
}

fn resolve_project_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = portable_runtime_root() {
        return Ok(root);
    }

    let mut candidates = Vec::new();

    if let Ok(dir) = std::env::current_dir() {
        candidates.push(dir.clone());
        candidates.push(dir.join(".."));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
            candidates.push(parent.join(".."));
            candidates.push(parent.join("..").join(".."));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.clone());
        candidates.push(resource_dir.join(".."));
    }

    for candidate in candidates {
        for ancestor in candidate.ancestors() {
            if is_project_root(ancestor) {
                return ancestor
                    .canonicalize()
                    .map_err(|e| format!("解析项目目录失败: {e}"));
            }
        }
    }

    Err("无法定位项目根目录（需要包含 scripts/ 和 video_sim/）".to_string())
}

fn resolve_config_project_root(
    app: &tauri::AppHandle,
    project_root: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(root) = portable_runtime_root() {
        return Ok(root);
    }

    if let Some(project_root) = project_root.filter(|value| !value.trim().is_empty()) {
        let root = PathBuf::from(project_root);
        if is_project_root(&root) {
            return root
                .canonicalize()
                .map_err(|e| format!("解析项目目录失败: {e}"));
        }
        return Err(format!(
            "项目目录无效，需要包含 scripts/ 和 video_sim/: {}",
            root.display()
        ));
    }

    resolve_project_root(app)
}

fn portable_runtime_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    if is_project_root(parent) {
        return Some(
            parent
                .canonicalize()
                .unwrap_or_else(|_| parent.to_path_buf()),
        );
    }
    None
}

fn is_project_root(path: &Path) -> bool {
    path.join("scripts").join("batch_compare.py").exists()
        && path.join("video_sim").join("matcher.py").exists()
}

fn resolve_user_path(root: &Path, path: &str) -> PathBuf {
    let raw = PathBuf::from(path);
    if raw.is_absolute() {
        raw
    } else {
        root.join(raw)
    }
}

fn resolve_analysis_artifact_path(
    root: &Path,
    cache_dir: &Path,
    artifact: &AnalysisTaskCacheArtifact,
) -> PathBuf {
    let path_text = normalize_display_path(artifact.path.trim())
        .trim()
        .to_string();
    let raw = PathBuf::from(&path_text);
    if raw.is_absolute() {
        return raw;
    }

    match artifact.path_base.as_str() {
        "cacheDir" => cache_dir.join(raw),
        "projectRoot" => root.join(raw),
        "absolute" => raw,
        _ => {
            let cache_candidate = cache_dir.join(&raw);
            if cache_candidate.exists() {
                cache_candidate
            } else {
                root.join(raw)
            }
        }
    }
}

fn collect_videos(
    dir: &Path,
    recursive: bool,
    videos: &mut Vec<VideoFile>,
    strict: bool,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if strict => return Err(format!("读取视频目录失败: {error}")),
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() && recursive {
            collect_videos(&path, recursive, videos, false)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if !VIDEO_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }

        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        videos.push(VideoFile {
            name: path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path_to_string(path),
            extension,
            size_bytes: metadata.len(),
            size_mb: metadata.len() as f64 / 1024.0 / 1024.0,
            modified_at_ms: metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    Ok(())
}

fn video_file_from_path(path: &Path) -> Result<VideoFile, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    if !metadata.is_file() {
        return Err("路径不是文件".to_string());
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        return Err("不是支持的视频格式".to_string());
    }
    Ok(VideoFile {
        name: path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string(),
        path: path_to_string(path),
        extension,
        size_bytes: metadata.len(),
        size_mb: metadata.len() as f64 / 1024.0 / 1024.0,
        modified_at_ms: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0),
    })
}

fn run_capture(root: &Path, python: &str, args: Vec<String>) -> Result<ProcessOutput, String> {
    let mut command = Command::new(python);
    command.current_dir(root).args(args);
    configure_python_command(&mut command, root, python);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000);
    }

    let output = command
        .output()
        .map_err(|e| format!("无法启动 Python 命令 `{python}`: {e}"))?;

    Ok(ProcessOutput {
        status_success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn configure_python_command(command: &mut Command, root: &Path, python: &str) {
    let worker_threads = recommended_worker_threads();
    command
        .env_remove("PYTHONHOME")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("PYTHONPATH", root)
        .env("PYTHONNOUSERSITE", "1")
        .env("USE_TF", "0")
        .env("TRANSFORMERS_NO_TF", "1")
        .env("TF_CPP_MIN_LOG_LEVEL", "2")
        .env("HF_HUB_ETAG_TIMEOUT", "20")
        .env("HF_HUB_DOWNLOAD_TIMEOUT", "120")
        .env("OMP_NUM_THREADS", &worker_threads)
        .env("MKL_NUM_THREADS", &worker_threads)
        .env("OPENBLAS_NUM_THREADS", &worker_threads)
        .env("NUMEXPR_NUM_THREADS", &worker_threads)
        .env("TORCH_NUM_THREADS", &worker_threads)
        .env("TOKENIZERS_PARALLELISM", "false");

    if let Some(home) = portable_python_home(python) {
        command.env("PYTHONHOME", home);
    }
}

fn recommended_worker_threads() -> String {
    std::thread::available_parallelism()
        .map(|threads| threads.get().saturating_sub(1).clamp(1, 4))
        .unwrap_or(2)
        .to_string()
}

fn portable_python_home(python: &str) -> Option<PathBuf> {
    let path = PathBuf::from(python);
    let file_name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if file_name != "python.exe" && file_name != "python" {
        return None;
    }

    let parent = path.parent()?;
    let home = if parent
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Scripts"))
    {
        parent.parent()?
    } else {
        parent
    };

    let has_stdlib = home
        .join("Lib")
        .join("encodings")
        .join("__init__.py")
        .exists();
    let has_runtime_dll = home.join("python310.dll").exists() || home.join("python3.dll").exists();
    (has_stdlib && has_runtime_dll).then(|| home.to_path_buf())
}

fn spawn_log_thread<S>(
    app: tauri::AppHandle,
    stream_name: &'static str,
    stream: S,
    last_activity: Arc<AtomicU64>,
    current_progress: Arc<AtomicU64>,
) -> thread::JoinHandle<()>
where
    S: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        let mut decoder_warnings = DecoderWarningAccumulator::default();
        for line in reader.lines().map_while(Result::ok) {
            last_activity.store(timestamp_millis_u64(), Ordering::Relaxed);
            let cleaned_line = strip_ansi_sequences(&line);
            if let Some(context) = parse_analysis_video_context(&cleaned_line) {
                if let Some(summary) = decoder_warnings.switch_context(context) {
                    emit_log(&app, stream_name, &summary);
                }
                continue;
            }
            if is_h264_decoder_log_line(&cleaned_line) {
                if let Some(summary) = decoder_warnings.record(&cleaned_line) {
                    emit_log(&app, stream_name, &summary);
                }
                continue;
            }
            if let Some(payload) = parse_analysis_video_quarantined(&cleaned_line) {
                let _ = app.emit("analysis-video-quarantined", payload);
                continue;
            }
            if let Some(parsed) = progress_from_line(&cleaned_line) {
                let previous_progress = centi_to_progress(current_progress.load(Ordering::Relaxed));
                let progress = if parsed.progress >= 100.0 {
                    100.0
                } else {
                    parsed.progress.max(previous_progress).min(99.99)
                };
                current_progress.store(progress_to_centi(progress), Ordering::Relaxed);
                emit_progress_detail(
                    &app,
                    &parsed.stage,
                    progress,
                    parsed.sub_stage.as_deref(),
                    parsed.sub_progress,
                );
                continue;
            }
            if should_hide_analysis_log_line(&cleaned_line) {
                continue;
            }
            let _ = app.emit(
                "analysis-log",
                AnalysisLogPayload {
                    stream: stream_name.to_string(),
                    line: cleaned_line,
                    timestamp: timestamp_millis(),
                },
            );
        }
        if let Some(summary) = decoder_warnings.finish() {
            emit_log(&app, stream_name, &summary);
        }
    })
}

fn parse_analysis_video_context(line: &str) -> Option<AnalysisVideoContext> {
    let payload = line.trim().strip_prefix(ANALYSIS_VIDEO_CONTEXT_PREFIX)?;
    let context = serde_json::from_str::<AnalysisVideoContext>(payload).ok()?;
    if context.path.trim().is_empty() {
        return None;
    }
    Some(context)
}

fn parse_analysis_video_quarantined(line: &str) -> Option<AnalysisVideoQuarantinedPayload> {
    let payload = line
        .trim()
        .strip_prefix(ANALYSIS_VIDEO_QUARANTINED_PREFIX)?;
    serde_json::from_str::<AnalysisVideoQuarantinedPayload>(payload).ok()
}

fn decoder_phase_label(phase: &str) -> &str {
    match phase {
        "probe" => "读取视频信息",
        "index" => "动态抽帧与索引",
        _ => phase,
    }
}

fn is_h264_decoder_log_line(line: &str) -> bool {
    line.contains("[h264 @")
}

fn should_hide_analysis_log_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }
    if is_important_analysis_log_line(trimmed) {
        return false;
    }

    trimmed.starts_with("Loading weights:")
        || trimmed.starts_with(ANALYSIS_VIDEO_CONTEXT_PREFIX)
        || trimmed.starts_with(ANALYSIS_VIDEO_QUARANTINED_PREFIX)
        || trimmed.starts_with("[transformers]")
        || trimmed.starts_with("Key")
        || trimmed.starts_with("----")
        || trimmed.starts_with("Notes:")
        || trimmed.contains("UNEXPECTED")
        || trimmed.contains("can be ignored when loading")
        || trimmed.contains("requires torchvision")
        || trimmed.contains("HF_TOKEN")
        || trimmed.contains("unauthenticated requests to the HF Hub")
        || is_decord_seek_warning_line(trimmed)
        || is_ffmpeg_noise_line(trimmed)
}

fn is_important_analysis_log_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.starts_with("warning:")
        || lower.starts_with("error:")
        || lower.starts_with("traceback")
        || lower.contains("failed to index")
        || lower.contains("failed to compare")
        || lower.contains("failed to process")
        || lower.contains("cannot open video")
        || lower.contains("no frames retained")
        || lower.contains("exception")
        || line.contains("失败")
        || line.contains("错误")
        || line.contains("无法打开")
}

fn is_ffmpeg_noise_line(line: &str) -> bool {
    (line.contains("swscaler") && line.contains("Slice parameters") && line.contains("invalid"))
        || (line.contains("deprecated pixel format used") && line.contains("swscaler"))
}

fn is_decord_seek_warning_line(line: &str) -> bool {
    line.contains("video_reader.cc:711")
        && line.contains("Failed to skip frames effectively")
        && line.contains("Decoder did not respond after 10000 attempts")
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && matches!(chars.peek(), Some('[')) {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
            continue;
        }
        if ch != '\r' {
            output.push(ch);
        }
    }
    output
}

fn spawn_heartbeat_thread(
    app: tauri::AppHandle,
    stop: Arc<AtomicBool>,
    last_activity: Arc<AtomicU64>,
    current_progress: Arc<AtomicU64>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let started_at = timestamp_millis_u64();
        let mut last_emit = started_at;

        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(5));
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let now = timestamp_millis_u64();
            let quiet_for = now.saturating_sub(last_activity.load(Ordering::Relaxed));
            if quiet_for < 15_000 || now.saturating_sub(last_emit) < 15_000 {
                continue;
            }

            let elapsed = now.saturating_sub(started_at);
            let progress =
                centi_to_progress(current_progress.load(Ordering::Relaxed)).clamp(2.0, 99.0);
            let message = format!(
                "分析仍在运行，已用时 {}，最近 {} 没有新日志；可点击取消终止任务",
                format_duration(elapsed),
                format_duration(quiet_for)
            );
            emit_progress(&app, &message, progress);
            emit_log(&app, "stdout", &message);
            last_emit = now;
        }
    })
}

fn progress_from_line(line: &str) -> Option<ParsedProgress> {
    parse_progress_protocol(line)
}

fn parse_progress_protocol(line: &str) -> Option<ParsedProgress> {
    let payload = line.strip_prefix("PROGRESS|")?;
    let mut parts = payload.splitn(7, '|');
    let phase = parts.next()?.trim();
    let current = parts.next()?.trim().parse::<f64>().ok()?;
    let total = parts.next()?.trim().parse::<f64>().ok()?;
    let message = parts.next().unwrap_or_default().trim();
    let sub_current = parts
        .next()
        .and_then(|value| value.trim().parse::<f64>().ok());
    let sub_total = parts
        .next()
        .and_then(|value| value.trim().parse::<f64>().ok());
    let sub_stage = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let ratio = if total > 0.0 {
        (current / total).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let progress = match phase {
        "scan" => 5.0 + ratio * 7.0,
        "model" => 12.0 + ratio * 8.0,
        "index" => 20.0 + ratio * 35.0,
        "candidate" => 55.0 + ratio * 8.0,
        "compare" => 63.0 + ratio * 27.0,
        "report" => 90.0 + ratio * 8.0,
        "done" => 100.0,
        _ => return None,
    };

    let sub_progress = match (sub_current, sub_total) {
        (Some(current), Some(total)) if total > 0.0 => {
            Some(round_progress((current / total).clamp(0.0, 1.0) * 100.0))
        }
        _ => None,
    };

    Some(ParsedProgress {
        stage: message.to_string(),
        progress: round_progress(progress),
        sub_stage,
        sub_progress,
    })
}

fn progress_to_centi(progress: f64) -> u64 {
    (progress.clamp(0.0, 100.0) * 100.0).round() as u64
}

fn centi_to_progress(value: u64) -> f64 {
    (value.min(10_000) as f64) / 100.0
}

fn round_progress(progress: f64) -> f64 {
    (progress.clamp(0.0, 100.0) * 100.0).round() / 100.0
}

fn emit_progress<R: tauri::Runtime>(app: &tauri::AppHandle<R>, stage: &str, progress: f64) {
    emit_progress_detail(app, stage, progress, None, None);
}

fn emit_progress_detail<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    stage: &str,
    progress: f64,
    sub_stage: Option<&str>,
    sub_progress: Option<f64>,
) {
    let _ = app.emit(
        "analysis-progress",
        AnalysisProgressPayload {
            stage: stage.to_string(),
            progress: round_progress(progress),
            sub_stage: sub_stage.map(ToOwned::to_owned),
            sub_progress: sub_progress.map(round_progress),
        },
    );
}

fn emit_error<R: tauri::Runtime>(app: &tauri::AppHandle<R>, message: &str) {
    let _ = app.emit(
        "analysis-error",
        AnalysisErrorPayload {
            message: message.to_string(),
        },
    );
}

fn emit_log<R: tauri::Runtime>(app: &tauri::AppHandle<R>, stream: &str, line: &str) {
    let _ = app.emit(
        "analysis-log",
        AnalysisLogPayload {
            stream: stream.to_string(),
            line: line.to_string(),
            timestamp: timestamp_millis(),
        },
    );
}

fn file_fingerprint(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut buffer = [0u8; 1024 * 1024];
    let mut hash_a: u64 = 0xcbf29ce484222325;
    let mut hash_b: u64 = 0x9e3779b97f4a7c15;
    let mut length: u64 = 0;

    loop {
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        length += read as u64;
        for byte in &buffer[..read] {
            hash_a ^= u64::from(*byte);
            hash_a = hash_a.wrapping_mul(0x100000001b3);
            hash_b ^= u64::from(*byte).wrapping_add(length.rotate_left(17));
            hash_b = hash_b.rotate_left(5).wrapping_mul(0x517cc1b727220a95);
        }
    }

    Ok(format!("{length:016x}{hash_a:016x}{hash_b:016x}"))
}

fn duplicate_report_csv(report: &Value) -> String {
    let mut rows = vec![[
        "completed_at",
        "video_a",
        "video_b",
        "video_a_path",
        "video_b_path",
        "file_size_bytes",
        "fingerprint",
        "relation",
        "symmetric_similarity",
    ]
    .join(",")];

    for pair in report
        .get("video_pairs")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
    {
        rows.push(
            [
                json_text(pair, "completed_at"),
                json_text(pair, "video_a"),
                json_text(pair, "video_b"),
                json_text(pair, "video_a_path"),
                json_text(pair, "video_b_path"),
                json_text(pair, "file_size_bytes"),
                json_text(pair, "fingerprint"),
                json_text(pair, "relation"),
                json_text(pair, "symmetric_similarity"),
            ]
            .map(csv_cell)
            .join(","),
        );
    }

    rows.join("\n")
}

fn duplicate_report_html(report: &Value) -> String {
    let pair_count = report
        .get("num_pairs")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let group_count = report
        .get("duplicate_group_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>相同文件报告</title></head>
<body>
  <h1>相同文件报告</h1>
  <p>重复组：{group_count}</p>
  <p>相同文件对：{pair_count}</p>
  <p>请在桌面应用的“结果总览”和“对比视图”中查看、筛选、保留或删除重复路径。</p>
</body>
</html>"#
    )
}

fn json_text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn csv_cell(value: String) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

fn report_pair_matches(pair: &Value, target: &ReportPairIdentity) -> bool {
    let left = report_pair_side(pair, "video_a_path", "video_a");
    let right = report_pair_side(pair, "video_b_path", "video_b");
    let target_left = preferred_pair_identity(&target.video_a_path, &target.video_a);
    let target_right = preferred_pair_identity(&target.video_b_path, &target.video_b);
    unordered_pair_matches(&left, &right, &target_left, &target_right)
}

fn report_pair_side(pair: &Value, path_key: &str, name_key: &str) -> String {
    preferred_pair_identity(&json_text(pair, path_key), &json_text(pair, name_key))
}

fn preferred_pair_identity(path: &str, name: &str) -> String {
    let value = if path.trim().is_empty() { name } else { path };
    normalize_pair_identity(value)
}

fn normalize_pair_identity(value: &str) -> String {
    normalize_display_path(value.trim())
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn unordered_pair_matches(left: &str, right: &str, target_left: &str, target_right: &str) -> bool {
    (left == target_left && right == target_right) || (left == target_right && right == target_left)
}

fn csv_pair_matches(
    headers: &csv::StringRecord,
    row: &csv::StringRecord,
    target: &ReportPairIdentity,
) -> bool {
    let path_a_index = csv_header_index(headers, "video_a_path");
    let path_b_index = csv_header_index(headers, "video_b_path");
    let name_a_index = csv_header_index(headers, "video_a");
    let name_b_index = csv_header_index(headers, "video_b");
    let left = path_a_index
        .and_then(|index| row.get(index))
        .filter(|value| !value.trim().is_empty())
        .or_else(|| name_a_index.and_then(|index| row.get(index)))
        .unwrap_or_default();
    let right = path_b_index
        .and_then(|index| row.get(index))
        .filter(|value| !value.trim().is_empty())
        .or_else(|| name_b_index.and_then(|index| row.get(index)))
        .unwrap_or_default();
    let target_left = if path_a_index.is_some() {
        preferred_pair_identity(&target.video_a_path, &target.video_a)
    } else {
        normalize_pair_identity(&target.video_a)
    };
    let target_right = if path_b_index.is_some() {
        preferred_pair_identity(&target.video_b_path, &target.video_b)
    } else {
        normalize_pair_identity(&target.video_b)
    };
    unordered_pair_matches(
        &normalize_pair_identity(left),
        &normalize_pair_identity(right),
        &target_left,
        &target_right,
    )
}

fn csv_header_index(headers: &csv::StringRecord, name: &str) -> Option<usize> {
    headers.iter().position(|header| header == name)
}

fn serialize_csv_report(
    headers: &csv::StringRecord,
    rows: &[csv::StringRecord],
) -> Result<String, String> {
    let mut writer = csv::WriterBuilder::new().from_writer(Vec::new());
    writer
        .write_record(headers)
        .map_err(|e| format!("写入 CSV 表头失败: {e}"))?;
    for row in rows {
        writer
            .write_record(row)
            .map_err(|e| format!("写入 CSV 数据失败: {e}"))?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|e| format!("生成 CSV 报告失败: {}", e.error()))?;
    String::from_utf8(bytes).map_err(|e| format!("生成 CSV 文本失败: {e}"))
}

fn report_pairs_csv(report: &Value) -> String {
    let headers = [
        "completed_at",
        "video_a",
        "video_b",
        "video_a_path",
        "video_b_path",
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
    ];
    let mut rows = vec![headers.join(",")];
    for pair in report
        .get("video_pairs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        rows.push(
            headers
                .map(|header| csv_cell(json_text(pair, header)))
                .join(","),
        );
    }
    rows.join("\n")
}

fn report_pairs_html(report: &Value) -> String {
    let timestamp = html_escape(&json_text(report, "timestamp"));
    let pairs = report
        .get("video_pairs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rows = pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| {
            format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                index + 1,
                html_escape(&json_text(pair, "video_a")),
                html_escape(&json_text(pair, "video_b")),
                html_escape(&json_text(pair, "a_in_b")),
                html_escape(&json_text(pair, "b_in_a")),
                html_escape(&json_text(pair, "relation")),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    report_html_document(&timestamp, pairs.len(), &rows)
}

fn csv_rows_html(headers: &csv::StringRecord, rows: &[csv::StringRecord]) -> String {
    let video_a = csv_header_index(headers, "video_a");
    let video_b = csv_header_index(headers, "video_b");
    let a_in_b = csv_header_index(headers, "a_in_b");
    let b_in_a = csv_header_index(headers, "b_in_a");
    let relation = csv_header_index(headers, "relation");
    let rendered = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let cell = |column: Option<usize>| {
                html_escape(column.and_then(|value| row.get(value)).unwrap_or_default())
            };
            format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                index + 1,
                cell(video_a),
                cell(video_b),
                cell(a_in_b),
                cell(b_in_a),
                cell(relation),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    report_html_document("", rows.len(), &rendered)
}

fn report_html_document(timestamp: &str, pair_count: usize, rows: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>视频相似度分析报告</title>
  <style>
    body {{ font-family: sans-serif; margin: 24px; color: #1d2433; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ padding: 8px 10px; border: 1px solid #d9deea; text-align: left; }}
    th {{ background: #eef3ff; }}
  </style>
</head>
<body>
  <h1>视频相似度分析报告</h1>
  <p>生成时间：{timestamp}</p>
  <p>当前结果：{pair_count} 对</p>
  <table>
    <thead><tr><th>#</th><th>视频 A</th><th>视频 B</th><th>A 在 B 中</th><th>B 在 A 中</th><th>关系</th></tr></thead>
    <tbody>{rows}</tbody>
  </table>
</body>
</html>"#
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn open_os_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("路径不存在: {}", path.display()));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .spawn()
        .map_err(|e| format!("打开路径失败 {}: {e}", path.display()))?;
    Ok(())
}

fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|e| format!("取消分析失败: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|e| format!("取消分析失败: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("取消分析失败，进程可能已经退出".to_string())
    }
}

fn config_template_dir(root: &Path, kind: &str) -> Result<PathBuf, String> {
    if !matches!(kind, "analysis" | "error_tolerance") {
        return Err("不支持的配置模板类型".to_string());
    }
    Ok(root.join("data").join("templates").join(kind))
}

fn analysis_tasks_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("cache").join("tasks")
}

fn default_analysis_task_stages() -> Vec<AnalysisTaskStage> {
    [
        ("scan", "扫描与码流校验", 12.0),
        ("cache", "检查可复用缓存", 8.0),
        ("features", "动态抽帧与特征提取", 35.0),
        ("candidate", "候选视频粗筛", 8.0),
        ("compare", "视频两两比较", 30.0),
        ("report", "生成分析报告", 7.0),
    ]
    .into_iter()
    .map(|(id, label, weight)| AnalysisTaskStage {
        id: id.to_string(),
        label: label.to_string(),
        status: "pending".to_string(),
        progress: 0.0,
        weight,
        started_at: String::new(),
        completed_at: String::new(),
        elapsed_ms: 0,
        message: "等待前置阶段完成".to_string(),
    })
    .collect()
}

fn is_safe_storage_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn storage_record_id(seed: &str) -> String {
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    timestamp_millis().hash(&mut hasher);
    format!("template-{}-{:x}", timestamp_millis(), hasher.finish())
}

fn write_json_atomic<T: Serialize>(target: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    let pending = target.with_extension(format!("json.{}.pending", timestamp_millis()));
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("序列化数据失败: {e}"))?;
    fs::write(&pending, content).map_err(|e| format!("写入临时数据失败: {e}"))?;
    if target.exists() {
        fs::remove_file(target).map_err(|e| format!("替换旧数据失败: {e}"))?;
    }
    fs::rename(&pending, target).map_err(|e| format!("保存数据失败: {e}"))
}

fn write_text_atomic(target: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("tmp");
    let pending = target.with_extension(format!("{extension}.{}.pending", timestamp_millis()));
    fs::write(&pending, content).map_err(|e| format!("写入临时数据失败: {e}"))?;
    if target.exists() {
        fs::remove_file(target).map_err(|e| format!("替换旧数据失败: {e}"))?;
    }
    fs::rename(&pending, target).map_err(|e| format!("保存数据失败: {e}"))
}

fn system_time_to_string(time: SystemTime) -> Option<String> {
    let duration = time.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_secs().to_string())
}

fn clip_model_dir(root: &Path) -> PathBuf {
    root.join("models").join(CLIP_MODEL_DIR_NAME)
}

fn clip_model_required_files() -> Vec<String> {
    vec![
        "config.json".to_string(),
        "preprocessor_config.json".to_string(),
        "pytorch_model.bin".to_string(),
    ]
}

fn clip_model_missing_files(path: &Path) -> Vec<String> {
    clip_model_required_files()
        .into_iter()
        .filter(|name| !path.join(name).is_file())
        .collect()
}

fn is_complete_clip_model(path: &Path) -> bool {
    path.is_dir() && clip_model_missing_files(path).is_empty()
}

fn clip_model_status_for_root(root: &Path) -> ClipModelStatus {
    let model_dir = clip_model_dir(root);
    let missing_files = clip_model_missing_files(&model_dir);
    let installed = missing_files.is_empty();
    let size_bytes = directory_size(&model_dir).unwrap_or(0);
    ClipModelStatus {
        installed,
        model_dir: path_to_string(&model_dir),
        size_bytes,
        message: if installed {
            "Offline CLIP model is ready.".to_string()
        } else {
            "Offline CLIP model is not installed. The app will download from Hugging Face when online.".to_string()
        },
        required_files: clip_model_required_files(),
        missing_files,
    }
}

fn install_clip_model_zip(root: &Path, temp_root: &Path, zip_path: &Path) -> Result<(), String> {
    let extract_root = temp_root.join("extracted");
    if extract_root.exists() {
        fs::remove_dir_all(&extract_root).map_err(|e| format!("清理临时模型目录失败: {e}"))?;
    }
    fs::create_dir_all(&extract_root).map_err(|e| format!("创建临时模型目录失败: {e}"))?;

    let zip_file = File::open(zip_path).map_err(|e| format!("打开模型 zip 失败: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(zip_file).map_err(|e| format!("读取模型 zip 失败: {e}"))?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("读取模型 zip 条目失败: {e}"))?;
        let enclosed = file
            .enclosed_name()
            .ok_or_else(|| format!("模型 zip 包含不安全路径: {}", file.name()))?
            .to_path_buf();
        let destination = extract_root.join(enclosed);
        if file.is_dir() {
            fs::create_dir_all(&destination).map_err(|e| format!("创建模型目录失败: {e}"))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建模型目录失败: {e}"))?;
        }
        let mut output =
            File::create(&destination).map_err(|e| format!("写入模型文件失败: {e}"))?;
        std::io::copy(&mut file, &mut output).map_err(|e| format!("解压模型文件失败: {e}"))?;
    }

    let extracted_model = if is_complete_clip_model(&extract_root) {
        extract_root.clone()
    } else {
        extract_root.join(CLIP_MODEL_DIR_NAME)
    };
    if !is_complete_clip_model(&extracted_model) {
        let missing = clip_model_missing_files(&extracted_model).join(", ");
        return Err(format!("模型 zip 校验失败，缺少文件: {missing}"));
    }

    let models_root = root.join("models");
    fs::create_dir_all(&models_root).map_err(|e| format!("创建模型目录失败: {e}"))?;
    let target = clip_model_dir(root);
    let old = models_root.join(format!(
        ".{}-old-{}",
        CLIP_MODEL_DIR_NAME,
        timestamp_millis()
    ));
    if target.exists() {
        if old.exists() {
            fs::remove_dir_all(&old).map_err(|e| format!("清理旧模型备份失败: {e}"))?;
        }
        fs::rename(&target, &old).map_err(|e| format!("备份旧模型目录失败: {e}"))?;
    }
    if let Err(rename_error) = fs::rename(&extracted_model, &target) {
        if let Err(copy_error) = copy_dir_recursive(&extracted_model, &target) {
            if let Err(restore_error) = restore_clip_model_backup(&target, &old) {
                return Err(format!(
                    "安装模型失败: {rename_error}; 复制回退失败: {copy_error}; 恢复旧模型也失败: {restore_error}"
                ));
            }
            return Err(format!(
                "安装模型失败: {rename_error}; 复制回退失败: {copy_error}"
            ));
        }
        let _ = fs::remove_dir_all(&extracted_model);
    }
    if old.exists() {
        fs::remove_dir_all(&old).map_err(|e| format!("清理旧模型备份失败: {e}"))?;
    }
    Ok(())
}

fn restore_clip_model_backup(target: &Path, backup: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| format!("清理失败模型目录失败: {e}"))?;
    }
    if backup.exists() {
        fs::rename(backup, target).map_err(|e| format!("恢复旧模型目录失败: {e}"))?;
    }
    Ok(())
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| format!("清理目标模型目录失败: {e}"))?;
    }
    fs::create_dir_all(target).map_err(|e| format!("创建目标模型目录失败: {e}"))?;
    for entry in fs::read_dir(source).map_err(|e| format!("读取模型目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取模型目录项失败: {e}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "复制模型文件失败 {} -> {}: {e}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn directory_size(path: &Path) -> std::io::Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    if path.is_file() {
        return Ok(path.metadata()?.len());
    }
    let mut size = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        size = size.saturating_add(directory_size(&entry.path())?);
    }
    Ok(size)
}

fn emit_model_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    downloaded_bytes: u64,
    total_bytes: u64,
    progress: f64,
    stage: &str,
) {
    let _ = app.emit(
        "clip-model-install-progress",
        UpdateDownloadProgress {
            downloaded_bytes,
            total_bytes,
            progress: progress.clamp(0.0, 100.0),
            stage: stage.to_string(),
        },
    );
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn timestamp_millis_u64() -> u64 {
    timestamp_millis().min(u128::from(u64::MAX)) as u64
}

fn unique_report_stem(prefix: &str, video_dir: &Path) -> String {
    let source = video_dir
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("videos");
    format!(
        "{}_{}_{}",
        sanitize_report_name(prefix),
        sanitize_report_name(source),
        timestamp_millis()
    )
}

fn sanitize_report_name(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            result.push(ch);
        } else if ch.is_whitespace()
            || matches!(
                ch,
                '.' | ':' | '/' | '\\' | '|' | '?' | '*' | '"' | '<' | '>'
            )
        {
            result.push('_');
        } else {
            result.push(ch);
        }
    }
    let compact = result
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    if compact.is_empty() {
        "report".to_string()
    } else {
        compact.chars().take(80).collect()
    }
}

fn format_duration(millis: u64) -> String {
    let seconds = millis / 1000;
    if seconds < 60 {
        format!("{seconds} 秒")
    } else {
        format!("{} 分 {} 秒", seconds / 60, seconds % 60)
    }
}

fn first_non_empty(a: &str, b: &str) -> String {
    let first = a.trim();
    if !first.is_empty() {
        first.to_string()
    } else {
        b.trim().to_string()
    }
}

fn path_to_string(path: impl AsRef<Path>) -> String {
    normalize_display_path(&path.as_ref().to_string_lossy())
}

fn normalize_display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else if let Some(rest) = path.strip_prefix(r"\??\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

fn script_arg(path: &Path) -> String {
    path_to_string(path)
}

fn resolve_python(app: &tauri::AppHandle, root: &Path, value: Option<&str>) -> String {
    if let Some(configured) = value.map(str::trim).filter(|item| !item.is_empty()) {
        if !is_default_python_alias(configured) {
            return configured.to_string();
        }
    }

    for candidate in bundled_python_candidates(app, root) {
        if candidate.exists() {
            return path_to_string(candidate);
        }
    }

    "python".to_string()
}

fn is_default_python_alias(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "python" | "python.exe" | "py" | "py.exe"
    )
}

fn bundled_python_candidates(app: &tauri::AppHandle, root: &Path) -> Vec<PathBuf> {
    let mut bases = vec![root.to_path_buf()];

    if let Ok(resource_dir) = app.path().resource_dir() {
        bases.push(resource_dir);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            bases.push(parent.to_path_buf());
        }
    }

    let mut candidates = Vec::new();
    for base in bases {
        candidates.extend([
            base.join("env").join("python").join("python.exe"),
            base.join("env")
                .join("python")
                .join("Scripts")
                .join("python.exe"),
            base.join("env").join("python").join("bin").join("python"),
            base.join("env").join("python").join("bin").join("python3"),
            base.join("runtime").join("python").join("python.exe"),
            base.join("runtime")
                .join("python")
                .join("Scripts")
                .join("python.exe"),
            base.join("runtime")
                .join("python")
                .join("bin")
                .join("python"),
            base.join("runtime")
                .join("python")
                .join("bin")
                .join("python3"),
            base.join("python").join("python.exe"),
            base.join("python").join("Scripts").join("python.exe"),
            base.join("python").join("bin").join("python"),
            base.join("python").join("bin").join("python3"),
        ]);
    }

    candidates
}

#[cfg(test)]
mod tests {
    use super::{
        is_decord_seek_warning_line, is_h264_decoder_log_line, parse_analysis_video_context,
        parse_analysis_video_quarantined, update_report_entries_for_resolved_path,
        AnalysisVideoContext, AnalysisVideoQuarantinedPayload, DecoderWarningAccumulator,
        ReportPairIdentity,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn parses_unicode_video_context_marker() {
        let marker = r#"ANALYSIS_VIDEO_CONTEXT|{"path":"D:\\视频\\损坏.mp4","phase":"index"}"#;

        assert_eq!(
            parse_analysis_video_context(marker),
            Some(AnalysisVideoContext {
                path: r"D:\视频\损坏.mp4".to_string(),
                phase: "index".to_string(),
            })
        );
    }

    #[test]
    fn aggregates_h264_warnings_with_video_path() {
        let mut warnings = DecoderWarningAccumulator::default();
        warnings.switch_context(AnalysisVideoContext {
            path: r"D:\videos\broken.mp4".to_string(),
            phase: "index".to_string(),
        });

        assert!(warnings
            .record("[h264 @ 0001] Invalid NAL unit size (12 > 3).")
            .is_none());
        warnings.record("[h264 @ 0001] missing picture in access unit with size 3");
        for _ in 0..19 {
            warnings.record("[h264 @ 0001] Invalid NAL unit size (12 > 3).");
        }
        let summary = warnings.finish().expect("severe warning summary");
        assert!(summary.contains(r"D:\videos\broken.mp4"));
        assert!(summary.contains("动态抽帧与索引"));
        assert!(summary.contains("NAL 长度错误 20 次"));
        assert!(summary.contains("缺失画面 1 次"));
        assert!(summary.contains("合计 21 条"));
    }

    #[test]
    fn recognizes_only_h264_decoder_lines() {
        assert!(is_h264_decoder_log_line(
            "[h264 @ 0001] missing picture in access unit with size 5"
        ));
        assert!(!is_h264_decoder_log_line(
            "Warning: Failed to index video: path=broken.mp4"
        ));
    }

    #[test]
    fn recognizes_decord_sparse_seek_noise() {
        assert!(is_decord_seek_warning_line(
            r"[22:42:25] D:\a\decord2\decord2\src\video\video_reader.cc:711: [F:\video.mp4] Failed to skip frames effectively at frame 291. Decoder did not respond after 10000 attempts. Video might be corrupted or seeking failed."
        ));
    }

    #[test]
    fn parses_quarantined_video_event() {
        let marker = r#"ANALYSIS_VIDEO_QUARANTINED|{"originalPath":"F:\\broken.mp4","destinationPath":"D:\\app\\data\\error_videos\\broken.mp4","remainingVideos":7,"removedVideos":2,"moved":true}"#;

        assert_eq!(
            parse_analysis_video_quarantined(marker),
            Some(AnalysisVideoQuarantinedPayload {
                original_path: r"F:\broken.mp4".to_string(),
                destination_path: r"D:\app\data\error_videos\broken.mp4".to_string(),
                remaining_videos: 7,
                removed_videos: 2,
                moved: true,
            })
        );
    }

    #[test]
    fn collapses_thousands_of_decoder_lines_into_a_few_summaries() {
        let mut warnings = DecoderWarningAccumulator::default();
        warnings.switch_context(AnalysisVideoContext {
            path: r"D:\videos\very-broken.mp4".to_string(),
            phase: "index".to_string(),
        });

        let emitted = (0..2_500)
            .filter_map(|_| warnings.record("[h264 @ 0001] Invalid NAL unit size (120 > 3)."))
            .count();
        let final_summary = warnings.finish().expect("final warning summary");

        assert_eq!(emitted, 3);
        assert!(final_summary.contains("NAL 长度错误 2500 次"));
        assert!(final_summary.contains(r"D:\videos\very-broken.mp4"));
    }

    #[test]
    fn removes_selected_pair_from_all_report_formats() {
        let directory = std::env::temp_dir().join(format!(
            "video-similarity-report-delete-{}",
            super::timestamp_millis()
        ));
        fs::create_dir_all(&directory).expect("create temp report directory");
        let json_path = directory.join("batch_report.json");
        let csv_path = directory.join("batch_report.csv");
        let html_path = directory.join("batch_report.html");
        let report = json!({
            "timestamp": "2026-06-23T10:00:00",
            "num_pairs": 2,
            "video_pairs": [
                {
                    "video_a": "a.mp4",
                    "video_b": "b.mp4",
                    "video_a_path": "D:/videos/a.mp4",
                    "video_b_path": "D:/videos/b.mp4",
                    "relation": "partial_overlap"
                },
                {
                    "video_a": "c.mp4",
                    "video_b": "d.mp4",
                    "video_a_path": "D:/videos/c.mp4",
                    "video_b_path": "D:/videos/d.mp4",
                    "relation": "different"
                }
            ]
        });
        fs::write(
            &json_path,
            serde_json::to_string_pretty(&report).expect("serialize report"),
        )
        .expect("write json report");
        fs::write(&csv_path, "video_a,video_b\na.mp4,b.mp4\nc.mp4,d.mp4\n")
            .expect("write csv report");
        fs::write(&html_path, "<html>old report</html>").expect("write html report");

        let result = update_report_entries_for_resolved_path(
            &json_path,
            &[ReportPairIdentity {
                video_a: "b.mp4".to_string(),
                video_b: "a.mp4".to_string(),
                video_a_path: "D:/videos/b.mp4".to_string(),
                video_b_path: "D:/videos/a.mp4".to_string(),
            }],
        )
        .expect("delete selected report pair");

        assert_eq!(result.removed_count, 1);
        assert_eq!(result.remaining_count, 1);
        let json_content = fs::read_to_string(&json_path).expect("read updated json");
        let csv_content = fs::read_to_string(&csv_path).expect("read updated csv");
        let html_content = fs::read_to_string(&html_path).expect("read updated html");
        assert!(!json_content.contains("a.mp4"));
        assert!(!csv_content.contains("a.mp4"));
        assert!(!html_content.contains("a.mp4"));
        assert!(json_content.contains("c.mp4"));
        assert!(csv_content.contains("c.mp4"));
        assert!(html_content.contains("c.mp4"));

        fs::remove_dir_all(directory).expect("remove temp report directory");
    }
}
