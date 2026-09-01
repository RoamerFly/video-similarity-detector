use reqwest::header::{ACCEPT, RANGE, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

const RUNTIME_VERSION: &str = include_str!("../../runtime-version.txt");
const FFMPEG_RUNTIME_VERSION: &str = include_str!("../../ffmpeg-runtime-version.txt");
const RELEASE_DOWNLOAD_ROOT: &str =
    "https://github.com/RoamerFly/video-similarity-detector/releases/latest/download";
const RESOURCE_MANIFEST_NAME: &str = "resource-manifest.json";
const RESOURCE_MANIFEST_SCHEMA_VERSION: u8 = 1;
const RESOURCE_MANIFEST_MAX_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct RuntimeManagerState {
    installing: AtomicBool,
    cancel_requested: Arc<AtomicBool>,
    active_task: Mutex<Option<String>>,
    status: Mutex<RuntimeDownloadStatus>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDownloadStatus {
    pub task: String,
    pub running: bool,
    pub cancel_requested: bool,
    pub cancelled: bool,
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub stage: String,
}

impl RuntimeManagerState {
    fn try_begin(&self, task: &str) -> bool {
        if self
            .installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        self.cancel_requested.store(false, Ordering::SeqCst);
        if let Ok(mut active) = self.active_task.lock() {
            *active = Some(task.to_string());
        }
        if let Ok(mut status) = self.status.lock() {
            *status = RuntimeDownloadStatus {
                task: task.to_string(),
                running: true,
                ..RuntimeDownloadStatus::default()
            };
        }
        true
    }

    fn finish(&self, stage: &str, cancelled: bool) {
        self.installing.store(false, Ordering::SeqCst);
        self.cancel_requested.store(false, Ordering::SeqCst);
        if let Ok(mut status) = self.status.lock() {
            status.running = false;
            status.cancel_requested = false;
            status.cancelled = cancelled;
            status.stage = stage.to_string();
            status.progress = if stage.contains("取消") {
                0.0
            } else {
                status.progress
            };
        }
        if let Ok(mut active) = self.active_task.lock() {
            *active = None;
        }
    }

    fn cancel(&self, task: &str) {
        let matches = self
            .active_task
            .lock()
            .map(|active| active.as_deref() == Some(task))
            .unwrap_or(false);
        if matches {
            self.cancel_requested.store(true, Ordering::SeqCst);
            if let Ok(mut status) = self.status.lock() {
                status.cancel_requested = true;
                status.stage = "正在取消下载".to_string();
            }
        }
    }

    /// Runtime migration and legacy cleanup use the same command and status
    /// channel as installation.  Keep their task names explicit so cancelling
    /// an AI-runtime task cannot accidentally cancel the independent FFmpeg
    /// runtime task.
    fn cancel_runtime_family(&self) {
        let matches = self
            .active_task
            .lock()
            .map(|active| {
                matches!(
                    active.as_deref(),
                    Some("runtime") | Some("runtime-migration") | Some("runtime-cleanup")
                )
            })
            .unwrap_or(false);
        if matches {
            self.cancel_requested.store(true, Ordering::SeqCst);
            if let Ok(mut status) = self.status.lock() {
                status.cancel_requested = true;
                status.stage = "正在取消下载".to_string();
            }
        }
    }

    fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel_requested.clone()
    }

    fn is_cancelled(&self) -> bool {
        self.cancel_requested.load(Ordering::SeqCst)
    }

    fn snapshot(&self) -> RuntimeDownloadStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }
}

struct MediaOperationReservation;

impl Drop for MediaOperationReservation {
    fn drop(&mut self) {
        crate::release_media_operation();
    }
}

fn reserve_media_operation() -> Result<MediaOperationReservation, String> {
    if crate::try_acquire_media_operation() {
        Ok(MediaOperationReservation)
    } else {
        Err("已有视频合并或运行环境安装任务正在执行。".to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    ready: bool,
    managed: bool,
    legacy_fallback: bool,
    legacy_migration_available: bool,
    legacy_cleanup_available: bool,
    legacy_runtime_dir: String,
    expected_version: String,
    installed_version: Option<String>,
    flavor: String,
    runtime_dir: String,
    python_path: String,
    asset_name: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    progress: f64,
    stage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRuntimeStatus {
    ready: bool,
    managed: bool,
    legacy_fallback: bool,
    expected_version: String,
    installed_version: Option<String>,
    platform: String,
    runtime_dir: String,
    ffmpeg_path: String,
    ffprobe_path: String,
    asset_name: String,
    message: String,
}

/// The result of comparing one installed, managed resource with the latest
/// release resource manifest.  Keep these names stable: the settings UI uses
/// this shape for all three independently downloadable resources.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceUpdateCheck {
    pub installed: bool,
    pub update_available: bool,
    pub comparison_available: bool,
    pub asset_name: String,
    pub installed_version: Option<String>,
    pub remote_version: Option<String>,
    pub local_sha256: Option<String>,
    pub remote_sha256: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    version: String,
    flavor: String,
    asset_name: String,
    sha256: String,
    installed_at_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceManifest {
    pub(crate) schema_version: u8,
    pub(crate) release_tag: String,
    pub(crate) ai_runtimes: Vec<AiRuntimeResource>,
    pub(crate) merge_runtimes: Vec<MergeRuntimeResource>,
    pub(crate) clip_model: ClipModelResource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiRuntimeResource {
    pub(crate) platform: String,
    pub(crate) flavor: String,
    pub(crate) version: String,
    pub(crate) asset_name: String,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MergeRuntimeResource {
    pub(crate) platform: String,
    pub(crate) version: String,
    pub(crate) asset_name: String,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClipModelResource {
    pub(crate) revision: String,
    pub(crate) asset_name: String,
    pub(crate) archive_sha256: String,
    pub(crate) files: std::collections::BTreeMap<String, String>,
}

impl ResourceManifest {
    fn select_ai_runtime(
        &self,
        platform: &str,
        flavor: &str,
    ) -> Result<&AiRuntimeResource, String> {
        self.ai_runtimes
            .iter()
            .find(|entry| entry.platform == platform && entry.flavor == flavor)
            .ok_or_else(|| {
                format!("最新 Release 尚未提供当前平台的 AI 运行环境：{platform}/{flavor}。")
            })
    }

    fn select_merge_runtime(&self, platform: &str) -> Result<&MergeRuntimeResource, String> {
        self.merge_runtimes
            .iter()
            .find(|entry| entry.platform == platform)
            .ok_or_else(|| format!("最新 Release 尚未提供当前平台的视频合并环境：{platform}。"))
    }
}

fn valid_resource_version(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| !character.is_control() && character != '/' && character != '\\')
}

fn valid_clip_revision(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.len() <= 256
        && value.chars().all(|character| !character.is_control())
}

fn valid_asset_basename(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 255
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

fn valid_resource_platform(value: &str) -> bool {
    matches!(
        value,
        "windows-x64" | "macos-arm64" | "macos-x64" | "linux-x64"
    )
}

fn validate_resource_manifest(manifest: &ResourceManifest) -> Result<(), String> {
    if manifest.schema_version != RESOURCE_MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "资源清单 schemaVersion 不受支持：{}。",
            manifest.schema_version
        ));
    }
    if !valid_resource_version(&manifest.release_tag) {
        return Err("资源清单 releaseTag 无效。".to_string());
    }
    if manifest.ai_runtimes.is_empty() || manifest.merge_runtimes.is_empty() {
        return Err("资源清单缺少 AI 或视频合并环境条目。".to_string());
    }

    for (index, entry) in manifest.ai_runtimes.iter().enumerate() {
        if !valid_resource_platform(&entry.platform)
            || !matches!(entry.flavor.as_str(), "cpu" | "gpu")
            || (entry.platform != "windows-x64" && entry.flavor != "cpu")
            || !valid_resource_version(&entry.version)
            || !valid_asset_basename(&entry.asset_name)
            || !valid_sha256(&entry.sha256)
        {
            return Err(format!("资源清单 AI 运行环境条目无效：{index}。"));
        }
    }
    for (index, entry) in manifest.merge_runtimes.iter().enumerate() {
        if !valid_resource_platform(&entry.platform)
            || !valid_resource_version(&entry.version)
            || !valid_asset_basename(&entry.asset_name)
            || !valid_sha256(&entry.sha256)
        {
            return Err(format!("资源清单视频合并环境条目无效：{index}。"));
        }
    }
    let clip = &manifest.clip_model;
    let required_clip_files = [
        "config.json",
        "preprocessor_config.json",
        "pytorch_model.bin",
    ];
    if !valid_clip_revision(&clip.revision)
        || !valid_asset_basename(&clip.asset_name)
        || !valid_sha256(&clip.archive_sha256)
        || clip.files.len() != required_clip_files.len()
        || required_clip_files
            .iter()
            .any(|name| !clip.files.contains_key(*name))
        || clip.files.iter().any(|(name, hash)| {
            !required_clip_files.contains(&name.as_str()) || !valid_sha256(hash)
        })
    {
        return Err("资源清单 CLIP 模型条目无效。".to_string());
    }

    let mut ai_keys = std::collections::BTreeSet::new();
    for entry in &manifest.ai_runtimes {
        if !ai_keys.insert((&entry.platform, &entry.flavor)) {
            return Err(format!(
                "资源清单包含重复的 AI 运行环境条目：{}/{}。",
                entry.platform, entry.flavor
            ));
        }
    }
    let mut merge_keys = std::collections::BTreeSet::new();
    for entry in &manifest.merge_runtimes {
        if !merge_keys.insert(&entry.platform) {
            return Err(format!(
                "资源清单包含重复的视频合并环境条目：{}。",
                entry.platform
            ));
        }
    }
    Ok(())
}

fn parse_resource_manifest(content: &[u8]) -> Result<ResourceManifest, String> {
    if content.len() > RESOURCE_MANIFEST_MAX_BYTES {
        return Err("资源清单过大。".to_string());
    }
    let manifest: ResourceManifest =
        serde_json::from_slice(content).map_err(|error| format!("解析资源清单失败：{error}"))?;
    validate_resource_manifest(&manifest)?;
    Ok(manifest)
}

/// Fetch and validate the release resource manifest.  The URL is deliberately
/// assembled from the fixed release root; the manifest can select filenames,
/// but it cannot inject a download host or arbitrary URL.
pub(crate) async fn fetch_resource_manifest(
    proxy_url: Option<&str>,
) -> Result<ResourceManifest, String> {
    let client = build_client(proxy_url)?;
    let url = format!("{RELEASE_DOWNLOAD_ROOT}/{RESOURCE_MANIFEST_NAME}");
    let response = client
        .get(url)
        .header(USER_AGENT, "video-similarity-desktop")
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("连接资源清单地址失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("获取资源清单失败: HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > RESOURCE_MANIFEST_MAX_BYTES as u64)
    {
        return Err("资源清单过大。".to_string());
    }
    let mut response = response;
    let mut content = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取资源清单失败: {error}"))?
    {
        append_resource_manifest_chunk(&mut content, &chunk)?;
    }
    parse_resource_manifest(&content)
}

fn append_resource_manifest_chunk(content: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if content.len().saturating_add(chunk.len()) > RESOURCE_MANIFEST_MAX_BYTES {
        return Err("资源清单过大。".to_string());
    }
    content.extend_from_slice(chunk);
    Ok(())
}

fn comparable_runtime_manifest(manifest: Option<&RuntimeManifest>, expected_flavor: &str) -> bool {
    manifest.is_some_and(|entry| {
        entry.flavor == expected_flavor
            && valid_resource_version(&entry.version)
            && valid_asset_basename(&entry.asset_name)
            && valid_sha256(&entry.sha256)
    })
}

fn resource_update_check(
    installed: bool,
    comparison_available: bool,
    local: Option<&RuntimeManifest>,
    remote_version: &str,
    remote_asset_name: &str,
    remote_sha256: &str,
    resource_name: &str,
) -> ResourceUpdateCheck {
    let remote_sha256 = remote_sha256.to_ascii_lowercase();
    let local_sha256 = local
        .filter(|_| comparison_available)
        .map(|entry| entry.sha256.to_ascii_lowercase());
    let update_available = if !installed {
        true
    } else if comparison_available {
        local_sha256.as_deref() != Some(remote_sha256.as_str())
    } else {
        false
    };
    let message = if !installed {
        format!("尚未安装{resource_name}，可安装远端最新版本。")
    } else if !comparison_available {
        format!("已检测到{resource_name}，但本地版本清单无法比对；可由用户决定是否重装。")
    } else if update_available {
        format!("发现{resource_name}更新：{}。", remote_version)
    } else {
        format!("{resource_name}已是最新版本。")
    };
    ResourceUpdateCheck {
        installed,
        update_available,
        comparison_available,
        asset_name: remote_asset_name.to_string(),
        installed_version: local.map(|entry| entry.version.clone()),
        remote_version: Some(remote_version.to_string()),
        local_sha256,
        remote_sha256: Some(remote_sha256),
        message,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePartsManifest {
    archive_name: String,
    archive_sha256: String,
    parts: Vec<RuntimePart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePart {
    name: String,
    sha256: String,
    size_bytes: u64,
}

struct DownloadProgress<'a> {
    start: f64,
    span: f64,
    stage: &'a str,
}

#[tauri::command]
pub fn get_runtime_status(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    runtime_status(&app)
}

#[tauri::command]
pub async fn check_runtime_update(
    app: tauri::AppHandle,
    proxy_url: Option<String>,
) -> Result<ResourceUpdateCheck, String> {
    let manifest = fetch_resource_manifest(proxy_url.as_deref()).await?;
    let flavor = detect_build_flavor();
    let platform = runtime_platform();
    let remote = manifest.select_ai_runtime(platform, &flavor)?;
    let root = storage_root(&app)?;
    let local_manifest = read_manifest(&root.join("env").join(".runtime.json"));
    let installed = first_existing_python(&root).is_some() || runtime_status(&app)?.legacy_fallback;
    let comparison_available = comparable_runtime_manifest(local_manifest.as_ref(), &flavor);
    Ok(resource_update_check(
        installed,
        comparison_available,
        local_manifest.as_ref(),
        &remote.version,
        &remote.asset_name,
        &remote.sha256,
        "AI 运行环境",
    ))
}

#[tauri::command]
pub async fn install_runtime(
    app: tauri::AppHandle,
    state: State<'_, RuntimeManagerState>,
    proxy_url: Option<String>,
) -> Result<RuntimeStatus, String> {
    let _operation = reserve_media_operation()?;
    if !state.try_begin("runtime") {
        return Err("运行环境安装任务已经在执行。".to_string());
    }

    let install_result = install_runtime_impl(&app, &state, proxy_url.as_deref()).await;
    let committed = matches!(install_result, Ok(true));
    let result = install_result.map(|_| ());
    let result = if result.is_ok() {
        configure_environment(&app).map(|_| ())
    } else {
        result
    };
    let cancelled = !committed && result.is_err() && state.is_cancelled();
    state.finish(
        if cancelled {
            "运行环境安装已取消"
        } else if result.is_err() {
            "运行环境安装失败"
        } else {
            "AI 运行环境已安装"
        },
        cancelled,
    );
    if cancelled {
        cleanup_download_cache(&app, "runtime");
    }
    if result.is_ok() && committed {
        emit_progress(&app, 0, 0, 100.0, "AI 运行环境已安装");
    }
    result?;
    runtime_status(&app)
}

#[tauri::command]
pub fn cancel_runtime_install(state: State<'_, RuntimeManagerState>) {
    state.cancel_runtime_family();
}

#[tauri::command]
pub fn get_merge_runtime_status(app: tauri::AppHandle) -> Result<MergeRuntimeStatus, String> {
    merge_runtime_status(&app)
}

#[tauri::command]
pub async fn check_merge_runtime_update(
    app: tauri::AppHandle,
    proxy_url: Option<String>,
) -> Result<ResourceUpdateCheck, String> {
    let manifest = fetch_resource_manifest(proxy_url.as_deref()).await?;
    let platform = runtime_platform();
    let remote = manifest.select_merge_runtime(platform)?;
    let root = storage_root(&app)?;
    let local_manifest = read_manifest(&root.join("merge-env").join(".runtime.json"));
    let status = merge_runtime_status(&app)?;
    let installed = status.ready
        || (executable_in_env(&root.join("merge-env"), "ffmpeg").is_some()
            && executable_in_env(&root.join("merge-env"), "ffprobe").is_some());
    let comparison_available = comparable_runtime_manifest(local_manifest.as_ref(), platform);
    Ok(resource_update_check(
        installed,
        comparison_available,
        local_manifest.as_ref(),
        &remote.version,
        &remote.asset_name,
        &remote.sha256,
        "视频合并环境",
    ))
}

#[tauri::command]
pub async fn install_merge_runtime(
    app: tauri::AppHandle,
    state: State<'_, RuntimeManagerState>,
    proxy_url: Option<String>,
) -> Result<MergeRuntimeStatus, String> {
    let _operation = reserve_media_operation()?;
    if !state.try_begin("merge-runtime") {
        return Err("运行环境安装任务已经在执行。".to_string());
    }

    let install_result = install_merge_runtime_impl(&app, &state, proxy_url.as_deref()).await;
    let committed = matches!(install_result, Ok(true));
    let result = install_result.map(|_| ());
    let result = if result.is_ok() {
        configure_environment(&app).map(|_| ())
    } else {
        result
    };
    let cancelled = !committed && result.is_err() && state.is_cancelled();
    state.finish(
        if cancelled {
            "视频合并环境安装已取消"
        } else if result.is_err() {
            "视频合并环境安装失败"
        } else {
            "视频合并环境已安装"
        },
        cancelled,
    );
    if cancelled {
        cleanup_download_cache(&app, "ffmpeg-runtime");
    }
    if result.is_ok() && committed {
        emit_progress(&app, 0, 0, 100.0, "视频合并环境已安装");
    }
    result?;
    merge_runtime_status(&app)
}

#[tauri::command]
pub fn cancel_merge_runtime_install(state: State<'_, RuntimeManagerState>) {
    state.cancel("merge-runtime");
}

#[tauri::command]
pub fn get_runtime_download_status(state: State<'_, RuntimeManagerState>) -> RuntimeDownloadStatus {
    state.snapshot()
}

#[tauri::command]
pub async fn migrate_legacy_runtime(
    app: tauri::AppHandle,
    state: State<'_, RuntimeManagerState>,
) -> Result<RuntimeStatus, String> {
    let _operation = reserve_media_operation()?;
    if !state.try_begin("runtime-migration") {
        return Err("运行环境安装或迁移任务已经在执行。".to_string());
    }
    emit_progress(&app, 0, 0, 5.0, "正在准备迁移旧版运行环境");

    let app_for_migration = app.clone();
    let cancel_token = state.cancel_token();
    let task_result = tauri::async_runtime::spawn_blocking(move || {
        migrate_legacy_runtime_impl(&app_for_migration, &cancel_token)
    })
    .await
    .map_err(|error| format!("运行环境迁移任务异常: {error}"));
    let result = task_result.and_then(|result| result);
    let cancelled = state.is_cancelled() && result.is_err();
    let result = if cancelled {
        Err("运行环境迁移已取消".to_string())
    } else {
        result
    };
    state.finish(
        if cancelled {
            "运行环境迁移已取消"
        } else if result.is_err() {
            "运行环境迁移失败"
        } else {
            ""
        },
        cancelled,
    );
    let legacy_removed = result?;

    configure_environment(&app)?;
    emit_progress(&app, 0, 0, 100.0, "旧版运行环境迁移完成");
    let mut status = runtime_status(&app)?;
    status.message = if legacy_removed {
        "旧版运行环境已就地登记或完成迁移，无需重新下载。".to_string()
    } else {
        "运行环境已迁移完成，但旧目录未能自动删除；可在设置中重试清理。".to_string()
    };
    Ok(status)
}

#[tauri::command]
pub async fn remove_legacy_runtime(
    app: tauri::AppHandle,
    state: State<'_, RuntimeManagerState>,
) -> Result<RuntimeStatus, String> {
    let _operation = reserve_media_operation()?;
    if !state.try_begin("runtime-cleanup") {
        return Err("运行环境安装、迁移或清理任务已经在执行。".to_string());
    }

    let app_for_cleanup = app.clone();
    let cancel_token = state.cancel_token();
    let task_result = tauri::async_runtime::spawn_blocking(move || {
        remove_legacy_runtime_impl(&app_for_cleanup, &cancel_token)
    })
    .await
    .map_err(|error| format!("旧版运行环境清理任务异常: {error}"));
    let result = task_result.and_then(|result| result);
    let cancelled = state.is_cancelled() && result.is_err();
    let result = if cancelled {
        Err("旧版运行环境清理已取消".to_string())
    } else {
        result
    };
    state.finish(
        if cancelled {
            "旧版运行环境清理已取消"
        } else if result.is_err() {
            "旧版运行环境清理失败"
        } else {
            ""
        },
        cancelled,
    );
    result?;

    let mut status = runtime_status(&app)?;
    status.message = "旧版内置运行环境已清理，当前托管运行环境保持可用。".to_string();
    Ok(status)
}

pub fn asset_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    storage_root(app)
}

pub fn configure_environment(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = runtime_status(app)?;
    if runtime.ready && !runtime.python_path.is_empty() {
        let python = PathBuf::from(&runtime.python_path);
        if let Some(env_dir) = python_runtime_env_dir(&python) {
            std::env::set_var("VIDEO_SIM_RUNTIME_DIR", &env_dir);
        }
    }

    configure_merge_environment(app)?;

    if std::env::var_os("VIDEO_SIM_CLIP_MODEL_DIR").is_none() {
        let model_dir = asset_root(app)?
            .join("models")
            .join("clip-vit-base-patch32");
        std::env::set_var("VIDEO_SIM_CLIP_MODEL_DIR", model_dir);
    }
    Ok(())
}

pub fn configure_merge_environment(app: &tauri::AppHandle) -> Result<(), String> {
    let root = storage_root(app)?;
    let mut roots = vec![root];
    roots.extend(legacy_runtime_roots(app));
    for base in deduplicate_paths(roots) {
        let merge_dir = base.join("merge-env");
        let legacy_dir = base.join("env");
        let ffmpeg = executable_in_env(&merge_dir, "ffmpeg")
            .or_else(|| executable_in_env(&legacy_dir, "ffmpeg"));
        let ffprobe = executable_in_env(&merge_dir, "ffprobe")
            .or_else(|| executable_in_env(&legacy_dir, "ffprobe"));
        if let (Some(ffmpeg), Some(ffprobe)) = (ffmpeg, ffprobe) {
            std::env::set_var("VIDEO_SIM_FFMPEG", ffmpeg);
            std::env::set_var("VIDEO_SIM_FFPROBE", ffprobe);
            break;
        }
    }
    Ok(())
}

pub fn python_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(root) = storage_root(app) {
        candidates.extend(python_candidates_below(&root));
    }

    candidates.extend(
        legacy_runtime_roots(app)
            .into_iter()
            .flat_map(|root| python_candidates_below(&root)),
    );
    deduplicate_paths(candidates)
}

fn runtime_status(app: &tauri::AppHandle) -> Result<RuntimeStatus, String> {
    let flavor = detect_build_flavor();
    let expected_version = expected_version();
    let root = storage_root(app)?;
    let runtime_dir = root.join("env");
    let asset_name = runtime_asset_name(&expected_version, &flavor);
    let managed_python = first_existing_python(&root);
    let manifest = read_manifest(&runtime_dir.join(".runtime.json"));
    let safe_legacy_dir = safe_legacy_runtime_dir(app);

    if let (Some(python), Some(manifest)) = (managed_python, manifest.as_ref()) {
        let version_matches = manifest.version.eq(&expected_version) && manifest.flavor == flavor;
        // The latest resource manifest can advance independently of the app
        // binary.  A package whose archive hash was recorded by the installer
        // remains usable after such an update; check_runtime_update is the
        // authority for whether it should be replaced.
        let managed_manifest_is_usable = manifest.flavor == flavor
            && valid_resource_version(&manifest.version)
            && valid_asset_basename(&manifest.asset_name)
            && valid_sha256(&manifest.sha256);
        let cleanup_legacy = safe_legacy_dir
            .as_ref()
            .filter(|legacy| !paths_equivalent(legacy, &runtime_dir));
        return Ok(RuntimeStatus {
            ready: version_matches || managed_manifest_is_usable,
            managed: true,
            legacy_fallback: false,
            legacy_migration_available: false,
            legacy_cleanup_available: cleanup_legacy.is_some(),
            legacy_runtime_dir: cleanup_legacy
                .map(|path| display_path(path))
                .unwrap_or_default(),
            expected_version,
            installed_version: Some(manifest.version.clone()),
            flavor,
            runtime_dir: display_path(&runtime_dir),
            python_path: display_path(&python),
            asset_name,
            message: if version_matches || managed_manifest_is_usable {
                "env 运行环境已就绪。".to_string()
            } else {
                "检测到运行环境文件，但版本清单缺失或不匹配，请重新安装。".to_string()
            },
        });
    }

    let legacy_python = legacy_runtime_roots(app)
        .into_iter()
        .find_map(|root| first_existing_python(&root));
    if let Some(python) = legacy_python {
        let legacy_env = python_runtime_env_dir(&python);
        let migration_available = safe_legacy_dir
            .as_ref()
            .is_some_and(|safe| legacy_env.as_ref().is_some_and(|found| found == safe));
        return Ok(RuntimeStatus {
            ready: true,
            managed: false,
            legacy_fallback: true,
            legacy_migration_available: migration_available,
            legacy_cleanup_available: false,
            legacy_runtime_dir: legacy_env.as_deref().map(display_path).unwrap_or_default(),
            expected_version,
            installed_version: None,
            flavor,
            runtime_dir: display_path(&runtime_dir),
            python_path: display_path(&python),
            asset_name,
            message: "已检测到安装目录中的旧版 env；可就地登记并继续使用，无需重新下载。"
                .to_string(),
        });
    }

    Ok(RuntimeStatus {
        ready: false,
        managed: false,
        legacy_fallback: false,
        legacy_migration_available: false,
        legacy_cleanup_available: false,
        legacy_runtime_dir: String::new(),
        expected_version,
        installed_version: None,
        flavor,
        runtime_dir: display_path(&runtime_dir),
        python_path: String::new(),
        asset_name,
        message: "尚未安装 AI 运行环境。应用本体保持轻量，首次使用前需下载一次。".to_string(),
    })
}

fn merge_runtime_status(app: &tauri::AppHandle) -> Result<MergeRuntimeStatus, String> {
    let expected_version = merge_expected_version();
    let platform = runtime_platform().to_string();
    let root = storage_root(app)?;
    let asset_name = ffmpeg_runtime_asset_name(&expected_version, &platform);
    let runtime_dir = root.join("merge-env");
    let mut roots = vec![root.clone()];
    roots.extend(legacy_runtime_roots(app));
    let roots = deduplicate_paths(roots);
    for base in &roots {
        let candidate = base.join("merge-env");
        let (Some(ffmpeg_path), Some(ffprobe_path)) = (
            executable_in_env(&candidate, "ffmpeg"),
            executable_in_env(&candidate, "ffprobe"),
        ) else {
            continue;
        };
        let manifest = read_manifest(&candidate.join(".runtime.json"));
        let managed = manifest.is_some() && paths_equivalent(&candidate, &runtime_dir);
        let bundled = is_bundled_runtime_root(base);
        let version_matches = manifest
            .as_ref()
            .is_some_and(|entry| entry.version == expected_version && entry.flavor == platform)
            || (managed
                && manifest.as_ref().is_some_and(|entry| {
                    entry.flavor == platform
                        && valid_resource_version(&entry.version)
                        && valid_asset_basename(&entry.asset_name)
                        && valid_sha256(&entry.sha256)
                }))
            || (!managed && (candidate != runtime_dir || bundled));
        return Ok(MergeRuntimeStatus {
            ready: version_matches,
            managed,
            legacy_fallback: !managed,
            expected_version,
            installed_version: manifest.map(|entry| entry.version),
            platform,
            runtime_dir: display_path(&candidate),
            ffmpeg_path: display_path(&ffmpeg_path),
            ffprobe_path: display_path(&ffprobe_path),
            asset_name,
            message: if managed && version_matches {
                "视频合并环境已就绪，可更新到最新 Release 环境。".to_string()
            } else if managed {
                "检测到视频合并环境，但版本清单不匹配，请重装最新环境。".to_string()
            } else if bundled {
                "已使用随应用提供的视频合并环境（FFmpeg / FFprobe）。可在此更新到最新 Release。"
                    .to_string()
            } else {
                "检测到未登记的视频合并环境；建议安装最新 Release 环境以启用版本管理。".to_string()
            },
        });
    }

    for base in roots {
        let legacy_dir = base.join("env");
        if let (Some(ffmpeg_path), Some(ffprobe_path)) = (
            executable_in_env(&legacy_dir, "ffmpeg"),
            executable_in_env(&legacy_dir, "ffprobe"),
        ) {
            return Ok(MergeRuntimeStatus {
                ready: true,
                managed: false,
                legacy_fallback: true,
                expected_version,
                installed_version: None,
                platform,
                runtime_dir: display_path(&runtime_dir),
                ffmpeg_path: display_path(&ffmpeg_path),
                ffprobe_path: display_path(&ffprobe_path),
                asset_name,
                message: "正在使用旧版 env 中的 FFmpeg；建议安装独立的视频合并环境。".to_string(),
            });
        }
    }

    Ok(MergeRuntimeStatus {
        ready: false,
        managed: false,
        legacy_fallback: false,
        expected_version,
        installed_version: None,
        platform,
        runtime_dir: display_path(&runtime_dir),
        ffmpeg_path: String::new(),
        ffprobe_path: String::new(),
        asset_name,
        message: "尚未安装视频合并环境，请下载安装最新 Release 环境。".to_string(),
    })
}

fn migrate_legacy_runtime_impl(
    app: &tauri::AppHandle,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    check_cancel(cancel)?;
    let source = safe_legacy_runtime_dir(app)
        .ok_or_else(|| "未找到可安全迁移的旧版内置运行环境。".to_string())?;
    let flavor = detect_build_flavor();
    if flavor == "gpu" {
        ensure_cuda_13_compatible()?;
    }
    let version = expected_version();
    let runtime_root = storage_root(app)?;
    let target = runtime_root.join("env");

    if paths_equivalent(&source, &target) {
        check_cancel(cancel)?;
        if first_existing_python(&runtime_root).is_none() {
            return Err("旧版运行环境校验失败：未找到 Python 可执行文件。".to_string());
        }
        write_runtime_manifest(
            &target,
            RuntimeManifest {
                version,
                flavor,
                asset_name: "legacy-local-registration".to_string(),
                sha256: "local-registration".to_string(),
                installed_at_ms: timestamp_millis(),
            },
        )?;
        return Ok(true);
    }

    if target.exists()
        && first_existing_python(&runtime_root).is_some()
        && read_manifest(&target.join(".runtime.json"))
            .is_some_and(|manifest| manifest.version == version && manifest.flavor == flavor)
    {
        return remove_legacy_directory_cancelable(&source, &target, cancel).map(|_| true);
    }

    check_cancel(cancel)?;
    fs::create_dir_all(&runtime_root).map_err(|error| format!("创建安装目录失败: {error}"))?;
    let staging = runtime_root.join(format!(".runtime-migrate-{}", timestamp_millis()));
    let staging_env = staging.join("env");
    fs::create_dir_all(&staging)
        .map_err(|error| format!("创建运行环境迁移临时目录失败: {error}"))?;

    check_cancel(cancel)?;
    let moved_source = match fs::rename(&source, &staging_env) {
        Ok(()) => true,
        Err(_) => {
            if let Err(error) = copy_dir_recursive_cancelable(&source, &staging_env, cancel) {
                let _ = fs::remove_dir_all(&staging);
                return Err(format!("复制旧版运行环境失败: {error}"));
            }
            false
        }
    };

    let migration_result = (|| {
        check_cancel(cancel)?;
        if first_existing_python(&staging).is_none() {
            return Err("旧版运行环境迁移校验失败：未找到 Python 可执行文件。".to_string());
        }
        let manifest = RuntimeManifest {
            version: version.clone(),
            flavor: flavor.clone(),
            asset_name: "legacy-local-migration".to_string(),
            sha256: "local-migration".to_string(),
            installed_at_ms: timestamp_millis(),
        };
        write_runtime_manifest(&staging_env, manifest)?;

        check_cancel(cancel)?;
        let backup = runtime_root.join(format!(".env-old-{}", timestamp_millis()));
        if target.exists() {
            fs::rename(&target, &backup)
                .map_err(|error| format!("备份旧托管运行环境失败: {error}"))?;
        }
        // The replacement itself is atomic and cannot be interrupted.  The
        // final cancellation checkpoint is deliberately immediately before
        // it, so a cancellation never leaves the target half-swapped.
        check_cancel(cancel)?;
        if let Err(error) = fs::rename(&staging_env, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(format!("启用迁移后的运行环境失败: {error}"));
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(&backup);
        }
        let _ = fs::remove_dir_all(&staging);
        Ok(())
    })();

    if let Err(error) = migration_result {
        if moved_source && staging_env.exists() && !source.exists() {
            let _ = fs::rename(&staging_env, &source);
        }
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        return Err(error);
    }

    if moved_source {
        return Ok(true);
    }
    check_cancel(cancel)?;
    match remove_legacy_directory_cancelable(&source, &target, cancel) {
        Ok(()) => Ok(true),
        Err(error) if cancel.load(Ordering::SeqCst) => Err(error),
        Err(_) => Ok(false),
    }
}

fn remove_legacy_runtime_impl(app: &tauri::AppHandle, cancel: &AtomicBool) -> Result<(), String> {
    check_cancel(cancel)?;
    let status = runtime_status(app)?;
    if !status.ready || !status.managed {
        return Err("仅在托管运行环境已就绪后才能清理旧版环境。".to_string());
    }
    let source = safe_legacy_runtime_dir(app)
        .ok_or_else(|| "未找到可安全清理的旧版内置运行环境。".to_string())?;
    let managed_env = storage_root(app)?.join("env");
    remove_legacy_directory_cancelable(&source, &managed_env, cancel)
}

fn remove_legacy_directory_cancelable(
    source: &Path,
    managed_runtime_root: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancel)?;
    let source =
        fs::canonicalize(source).map_err(|error| format!("定位旧版运行环境失败: {error}"))?;
    let managed_runtime_root = fs::canonicalize(managed_runtime_root)
        .unwrap_or_else(|_| managed_runtime_root.to_path_buf());
    if source.starts_with(&managed_runtime_root) || managed_runtime_root.starts_with(&source) {
        return Err("拒绝清理与托管运行环境重叠的目录。".to_string());
    }
    remove_dir_all_cancelable(&source, cancel).map_err(|error| {
        format!(
            "删除旧版运行环境失败（可能需要手动删除 {}）: {error}",
            display_path(&source)
        )
    })
}

fn copy_dir_recursive_cancelable(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancel)?;
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取 {} 失败: {error}", display_path(source)))?;

    if metadata.file_type().is_symlink() {
        #[cfg(unix)]
        {
            let target = fs::read_link(source)
                .map_err(|error| format!("读取符号链接 {} 失败: {error}", display_path(source)))?;
            std::os::unix::fs::symlink(target, destination).map_err(|error| {
                format!("创建符号链接 {} 失败: {error}", display_path(destination))
            })?;
            return Ok(());
        }
        #[cfg(not(unix))]
        {
            let resolved = fs::canonicalize(source)
                .map_err(|error| format!("解析符号链接 {} 失败: {error}", display_path(source)))?;
            return copy_dir_recursive_cancelable(&resolved, destination, cancel);
        }
    }

    if metadata.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|error| format!("创建目录 {} 失败: {error}", display_path(destination)))?;
        for entry in fs::read_dir(source)
            .map_err(|error| format!("读取目录 {} 失败: {error}", display_path(source)))?
        {
            let entry = entry.map_err(|error| format!("读取迁移目录条目失败: {error}"))?;
            copy_dir_recursive_cancelable(
                &entry.path(),
                &destination.join(entry.file_name()),
                cancel,
            )?;
        }
        fs::set_permissions(destination, metadata.permissions())
            .map_err(|error| format!("保留目录权限 {} 失败: {error}", display_path(destination)))?;
        return Ok(());
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录 {} 失败: {error}", display_path(parent)))?;
    }
    check_cancel(cancel)?;
    fs::copy(source, destination).map_err(|error| {
        format!(
            "复制 {} 到 {} 失败: {error}",
            display_path(source),
            display_path(destination)
        )
    })?;
    check_cancel(cancel)?;
    fs::set_permissions(destination, metadata.permissions())
        .map_err(|error| format!("保留文件权限 {} 失败: {error}", display_path(destination)))?;
    Ok(())
}

fn remove_dir_all_cancelable(path: &Path, cancel: &AtomicBool) -> Result<(), String> {
    check_cancel(cancel)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        check_cancel(cancel)?;
        let entry = entry.map_err(|error| error.to_string())?;
        remove_dir_all_cancelable(&entry.path(), cancel)?;
    }
    check_cancel(cancel)?;
    fs::remove_dir(path).map_err(|error| error.to_string())
}

async fn install_merge_runtime_impl(
    app: &tauri::AppHandle,
    state: &RuntimeManagerState,
    proxy_url: Option<&str>,
) -> Result<bool, String> {
    let platform = runtime_platform().to_string();
    if platform == "unsupported" {
        return Err("当前平台没有可用的视频合并环境包。".to_string());
    }
    let resource_manifest = fetch_resource_manifest(proxy_url).await?;
    let remote_resource = resource_manifest.select_merge_runtime(&platform)?;
    let version = remote_resource.version.clone();
    let asset_name = remote_resource.asset_name.clone();
    let expected_hash = remote_resource.sha256.to_ascii_lowercase();
    let download_root = storage_root(app)?
        .join("data")
        .join(".downloads")
        .join("ffmpeg-runtime");
    fs::create_dir_all(&download_root)
        .map_err(|error| format!("创建视频合并环境下载目录失败: {error}"))?;
    let archive_path = download_root.join(&asset_name);
    let client = build_client(proxy_url)?;
    let asset_url = format!("{RELEASE_DOWNLOAD_ROOT}/{asset_name}");
    emit_progress(app, 0, 0, 1.0, "正在读取独立 FFmpeg 环境校验信息");
    download_archive(
        app,
        state,
        &client,
        &asset_url,
        &archive_path,
        DownloadProgress {
            start: 5.0,
            span: 70.0,
            stage: "正在下载视频合并环境",
        },
    )
    .await?;
    if state.cancel_requested.load(Ordering::SeqCst) {
        return Err("视频合并环境下载已取消。".to_string());
    }

    emit_progress(app, 0, 0, 78.0, "正在校验视频合并环境");
    let archive_for_hash = archive_path.clone();
    let cancel_token = state.cancel_requested.clone();
    let actual_hash = tauri::async_runtime::spawn_blocking(move || {
        sha256_file_cancelable(&archive_for_hash, &cancel_token)
    })
    .await
    .map_err(|error| format!("视频合并环境校验任务异常: {error}"))??;
    if actual_hash != expected_hash {
        let _ = fs::remove_file(&archive_path);
        return Err("视频合并环境 SHA-256 校验失败，已删除损坏文件。".to_string());
    }

    emit_progress(app, 0, 0, 84.0, "正在解压视频合并环境");
    let install_root = storage_root(app)?;
    let target = install_root.join("merge-env");
    let archive_for_install = archive_path.clone();
    let asset_for_manifest = asset_name.clone();
    let version_for_manifest = version.clone();
    let hash_for_manifest = expected_hash.clone();
    let platform_for_manifest = platform.clone();
    let cancel_token = state.cancel_requested.clone();
    let committed = tauri::async_runtime::spawn_blocking(move || {
        install_merge_archive_cancelable(
            &archive_for_install,
            &install_root,
            &target,
            RuntimeManifest {
                version: version_for_manifest,
                flavor: platform_for_manifest,
                asset_name: asset_for_manifest,
                sha256: hash_for_manifest,
                installed_at_ms: timestamp_millis(),
            },
            &cancel_token,
        )
    })
    .await
    .map_err(|error| format!("视频合并环境安装任务异常: {error}"))??;

    let _ = fs::remove_file(archive_path);
    Ok(committed)
}

async fn install_runtime_impl(
    app: &tauri::AppHandle,
    state: &RuntimeManagerState,
    proxy_url: Option<&str>,
) -> Result<bool, String> {
    let flavor = detect_build_flavor();
    if flavor == "gpu" {
        ensure_cuda_13_compatible()?;
    }
    let platform = runtime_platform();
    let resource_manifest = fetch_resource_manifest(proxy_url).await?;
    let remote_resource = resource_manifest.select_ai_runtime(platform, &flavor)?;
    let version = remote_resource.version.clone();
    let asset_name = remote_resource.asset_name.clone();
    let manifest_hash = remote_resource.sha256.to_ascii_lowercase();
    let download_root = storage_root(app)?
        .join("data")
        .join(".downloads")
        .join("runtime");
    fs::create_dir_all(&download_root)
        .map_err(|error| format!("创建运行环境下载目录失败: {error}"))?;
    let archive_path = download_root.join(&asset_name);

    let client = build_client(proxy_url)?;
    let asset_url = format!("{RELEASE_DOWNLOAD_ROOT}/{asset_name}");
    let mut cleanup_paths = vec![archive_path.clone()];
    let expected_hash = if uses_multipart_runtime(&flavor) {
        let descriptor_name = format!(
            "{}.parts.json",
            asset_name
                .strip_suffix(".zip")
                .unwrap_or(asset_name.as_str())
        );
        let descriptor_path = download_root.join(&descriptor_name);
        let descriptor_url = format!("{RELEASE_DOWNLOAD_ROOT}/{descriptor_name}");
        emit_progress(app, 0, 0, 1.0, "正在获取 GPU 运行环境分卷清单");
        download_small_file(
            &client,
            &descriptor_url,
            &descriptor_path,
            &state.cancel_requested,
        )
        .await?;
        let parts_manifest = parse_parts_manifest(&descriptor_path, &asset_name)?;
        cleanup_paths.push(descriptor_path);

        let part_count = parts_manifest.parts.len();
        let progress_span = 70.0 / part_count as f64;
        let mut part_paths = Vec::with_capacity(part_count);
        for (index, part) in parts_manifest.parts.iter().enumerate() {
            let part_path = download_root.join(&part.name);
            let part_url = format!("{RELEASE_DOWNLOAD_ROOT}/{}", part.name);
            let stage = format!("正在下载 GPU 运行环境分卷 {}/{}", index + 1, part_count);
            let existing_part = part_path.clone();
            let expected_part_hash = part.sha256.clone();
            let expected_part_size = part.size_bytes;
            let cancel_token = state.cancel_requested.clone();
            let existing_valid = tauri::async_runtime::spawn_blocking(move || {
                !cancel_token.load(Ordering::SeqCst)
                    && fs::metadata(&existing_part)
                        .is_ok_and(|metadata| metadata.len() == expected_part_size)
                    && sha256_file_cancelable(&existing_part, &cancel_token)
                        .is_ok_and(|hash| hash == expected_part_hash)
            })
            .await
            .unwrap_or(false);

            if !existing_valid {
                if part_path.exists() {
                    let _ = fs::remove_file(&part_path);
                }
                download_archive(
                    app,
                    state,
                    &client,
                    &part_url,
                    &part_path,
                    DownloadProgress {
                        start: 5.0 + index as f64 * progress_span,
                        span: progress_span,
                        stage: &stage,
                    },
                )
                .await?;
                if fs::metadata(&part_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or_default()
                    != part.size_bytes
                {
                    let _ = fs::remove_file(&part_path);
                    return Err(format!("GPU 运行环境分卷大小校验失败: {}", part.name));
                }
                let part_for_hash = part_path.clone();
                let cancel_token = state.cancel_requested.clone();
                let actual_hash = tauri::async_runtime::spawn_blocking(move || {
                    sha256_file_cancelable(&part_for_hash, &cancel_token)
                })
                .await
                .map_err(|error| format!("GPU 运行环境分卷校验任务异常: {error}"))??;
                if actual_hash != part.sha256 {
                    let _ = fs::remove_file(&part_path);
                    return Err(format!("GPU 运行环境分卷 SHA-256 校验失败: {}", part.name));
                }
            } else {
                emit_progress(
                    app,
                    part.size_bytes,
                    part.size_bytes,
                    5.0 + (index + 1) as f64 * progress_span,
                    &format!("已复用 GPU 运行环境分卷 {}/{}", index + 1, part_count),
                );
            }
            cleanup_paths.push(part_path.clone());
            part_paths.push(part_path);
        }

        emit_progress(app, 0, 0, 76.0, "正在合并 GPU 运行环境分卷");
        let archive_for_merge = archive_path.clone();
        let cancel_token = state.cancel_requested.clone();
        tauri::async_runtime::spawn_blocking(move || {
            concatenate_files_cancelable(&part_paths, &archive_for_merge, &cancel_token)
        })
        .await
        .map_err(|error| format!("GPU 运行环境分卷合并任务异常: {error}"))??;
        if parts_manifest.archive_sha256.to_ascii_lowercase() != manifest_hash {
            return Err("GPU 运行环境分卷清单与资源清单中的整包 SHA-256 不一致。".to_string());
        }
        manifest_hash.clone()
    } else {
        emit_progress(app, 0, 0, 1.0, "正在读取运行环境校验信息");
        download_archive(
            app,
            state,
            &client,
            &asset_url,
            &archive_path,
            DownloadProgress {
                start: 5.0,
                span: 70.0,
                stage: "正在下载 AI 运行环境",
            },
        )
        .await?;
        manifest_hash.clone()
    };
    if state.cancel_requested.load(Ordering::SeqCst) {
        return Err("运行环境下载已取消。".to_string());
    }

    emit_progress(app, 0, 0, 78.0, "正在校验运行环境");
    let archive_for_hash = archive_path.clone();
    let cancel_token = state.cancel_requested.clone();
    let actual_hash = tauri::async_runtime::spawn_blocking(move || {
        sha256_file_cancelable(&archive_for_hash, &cancel_token)
    })
    .await
    .map_err(|error| format!("运行环境校验任务异常: {error}"))??;
    if actual_hash != expected_hash {
        let _ = fs::remove_file(&archive_path);
        return Err("运行环境 SHA-256 校验失败，已删除损坏文件。".to_string());
    }

    emit_progress(app, 0, 0, 84.0, "正在解压运行环境");
    let install_root = storage_root(app)?;
    let target = install_root.join("env");
    let archive_for_install = archive_path.clone();
    let asset_for_manifest = asset_name.clone();
    let version_for_manifest = version.clone();
    let flavor_for_manifest = flavor.clone();
    let hash_for_manifest = expected_hash.clone();
    let cancel_token = state.cancel_requested.clone();
    let committed = tauri::async_runtime::spawn_blocking(move || {
        install_archive_cancelable(
            &archive_for_install,
            &install_root,
            &target,
            RuntimeManifest {
                version: version_for_manifest,
                flavor: flavor_for_manifest,
                asset_name: asset_for_manifest,
                sha256: hash_for_manifest,
                installed_at_ms: timestamp_millis(),
            },
            &cancel_token,
        )
    })
    .await
    .map_err(|error| format!("运行环境安装任务异常: {error}"))??;

    for path in cleanup_paths {
        let _ = fs::remove_file(path);
    }
    Ok(committed)
}

async fn download_small_file(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancel)?;
    let response = tokio::select! {
        result = client
            .get(url)
            .header(USER_AGENT, "video-similarity-desktop")
            .header(ACCEPT, "application/json, text/plain")
            .send() => result
                .map_err(|error| format!("连接运行环境元数据地址失败: {error}"))?,
        _ = wait_cancel_flag(cancel) => {
            return Err("运行环境安装已取消。".to_string());
        }
    };
    check_cancel(cancel)?;
    if !response.status().is_success() {
        return Err(format!(
            "获取运行环境元数据失败: HTTP {}",
            response.status()
        ));
    }
    let partial = partial_download_path(destination);
    let mut output = File::create(&partial)
        .map_err(|error| format!("创建运行环境元数据临时文件失败: {error}"))?;
    let mut response = response;
    loop {
        let chunk = tokio::select! {
            result = response.chunk() => result
                .map_err(|error| format!("读取运行环境元数据失败: {error}"))?,
            _ = wait_cancel_flag(cancel) => {
                drop(output);
                let _ = fs::remove_file(&partial);
                return Err("运行环境安装已取消。".to_string());
            }
        };
        let Some(chunk) = chunk else { break };
        if let Err(error) = check_cancel(cancel) {
            drop(output);
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
        output
            .write_all(&chunk)
            .map_err(|error| format!("保存运行环境元数据失败: {error}"))?;
    }
    output
        .flush()
        .map_err(|error| format!("保存运行环境元数据失败: {error}"))?;
    if let Err(error) = check_cancel(cancel) {
        drop(output);
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    drop(output);
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| format!("替换运行环境元数据失败: {error}"))?;
    }
    if let Err(error) = check_cancel(cancel) {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    fs::rename(&partial, destination).map_err(|error| format!("保存运行环境元数据失败: {error}"))
}

fn cleanup_download_cache(app: &tauri::AppHandle, category: &str) {
    let Ok(root) = storage_root(app) else { return };
    let directory = root.join("data").join(".downloads").join(category);
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                let _ = fs::remove_file(path);
            }
        }
    }
}

async fn download_archive(
    app: &tauri::AppHandle,
    state: &RuntimeManagerState,
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    progress: DownloadProgress<'_>,
) -> Result<(), String> {
    let part_path = partial_download_path(destination);
    let existing_bytes = fs::metadata(&part_path).map(|meta| meta.len()).unwrap_or(0);
    let mut request = client
        .get(url)
        .header(USER_AGENT, "video-similarity-desktop")
        .header(ACCEPT, "application/octet-stream");
    if existing_bytes > 0 {
        request = request.header(RANGE, format!("bytes={existing_bytes}-"));
    }
    let mut response = tokio::select! {
        result = request.send() => result
            .map_err(|error| format!("连接运行环境下载地址失败: {error}"))?,
        _ = wait_runtime_cancel(state) => {
            let _ = fs::remove_file(&part_path);
            return Err("运行环境下载已取消。".to_string());
        }
    };
    if !response.status().is_success() {
        return Err(format!("运行环境下载失败: HTTP {}", response.status()));
    }

    let resumed = existing_bytes > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let downloaded_start = if resumed { existing_bytes } else { 0 };
    if existing_bytes > 0 && !resumed {
        let _ = fs::remove_file(&part_path);
    }
    let total_bytes = response
        .content_length()
        .map(|length| length.saturating_add(downloaded_start))
        .unwrap_or(0);
    let mut downloaded_bytes = downloaded_start;
    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part_path)
        .map_err(|error| format!("创建运行环境断点文件失败: {error}"))?;

    loop {
        let chunk = tokio::select! {
            result = response.chunk() => result
                .map_err(|error| format!("读取运行环境下载数据失败: {error}"))?,
            _ = wait_runtime_cancel(state) => {
                drop(output);
                let _ = fs::remove_file(&part_path);
                return Err("运行环境下载已取消。".to_string());
            }
        };
        let Some(chunk) = chunk else { break };
        if state.cancel_requested.load(Ordering::SeqCst) {
            output
                .flush()
                .map_err(|error| format!("保存运行环境断点文件失败: {error}"))?;
            drop(output);
            let _ = fs::remove_file(&part_path);
            return Err("运行环境下载已取消。".to_string());
        }
        output
            .write_all(&chunk)
            .map_err(|error| format!("写入运行环境断点文件失败: {error}"))?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        let progress_value = if total_bytes > 0 {
            progress.start + downloaded_bytes as f64 / total_bytes as f64 * progress.span
        } else {
            progress.start
        };
        emit_progress(
            app,
            downloaded_bytes,
            total_bytes,
            progress_value.min(progress.start + progress.span),
            if resumed {
                "正在续传运行环境"
            } else {
                progress.stage
            },
        );
    }
    output
        .flush()
        .map_err(|error| format!("保存运行环境断点文件失败: {error}"))?;
    check_cancel(&state.cancel_requested)?;
    if total_bytes > 0 && downloaded_bytes < total_bytes {
        return Err(format!(
            "运行环境下载不完整: {downloaded_bytes} / {total_bytes} 字节"
        ));
    }
    check_cancel(&state.cancel_requested)?;
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| format!("替换旧运行环境压缩包失败: {error}"))?;
    }
    check_cancel(&state.cancel_requested)?;
    fs::rename(&part_path, destination)
        .map_err(|error| format!("保存运行环境压缩包失败: {error}"))?;
    if state.cancel_requested.load(Ordering::SeqCst) {
        let _ = fs::remove_file(destination);
        return Err("运行环境下载已取消。".to_string());
    }
    Ok(())
}

async fn wait_runtime_cancel(state: &RuntimeManagerState) {
    while !state.cancel_requested.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn wait_cancel_flag(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

fn partial_download_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    destination.with_file_name(format!("{name}.download"))
}

fn uses_multipart_runtime(_flavor: &str) -> bool {
    // The pinned Windows CUDA runtime is kept below GitHub's 2 GiB asset
    // limit, so every supported platform downloads one resumable ZIP.
    false
}

fn parse_parts_manifest(
    path: &Path,
    expected_archive_name: &str,
) -> Result<RuntimePartsManifest, String> {
    let content =
        fs::read(path).map_err(|error| format!("读取 GPU 运行环境分卷清单失败: {error}"))?;
    let mut manifest: RuntimePartsManifest = serde_json::from_slice(&content)
        .map_err(|error| format!("解析 GPU 运行环境分卷清单失败: {error}"))?;
    if manifest.archive_name != expected_archive_name {
        return Err("GPU 运行环境分卷清单与当前构建不匹配。".to_string());
    }
    if !valid_sha256(&manifest.archive_sha256) {
        return Err("GPU 运行环境分卷清单中的整包 SHA-256 无效。".to_string());
    }
    if !(2..=16).contains(&manifest.parts.len()) {
        return Err("GPU 运行环境分卷数量无效。".to_string());
    }
    for (index, part) in manifest.parts.iter().enumerate() {
        let expected_name = format!("{expected_archive_name}.part{:02}", index + 1);
        if part.name != expected_name
            || !valid_sha256(&part.sha256)
            || part.size_bytes == 0
            || part.size_bytes >= 2 * 1024 * 1024 * 1024
        {
            return Err(format!("GPU 运行环境分卷清单条目无效: {}", part.name));
        }
    }
    manifest.archive_sha256.make_ascii_lowercase();
    for part in &mut manifest.parts {
        part.sha256.make_ascii_lowercase();
    }
    Ok(manifest)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn concatenate_files_cancelable(
    parts: &[PathBuf],
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut output = File::create(destination)
        .map_err(|error| format!("创建 GPU 运行环境合并文件失败: {error}"))?;
    for part in parts {
        check_cancel(cancel)?;
        let mut input =
            File::open(part).map_err(|error| format!("打开 GPU 运行环境分卷失败: {error}"))?;
        copy_with_cancel(&mut input, &mut output, cancel)
            .map_err(|error| format!("合并 GPU 运行环境分卷失败: {error}"))?;
    }
    output
        .flush()
        .map_err(|error| format!("保存 GPU 运行环境合并文件失败: {error}"))
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("运行环境安装已取消。".to_string())
    } else {
        Ok(())
    }
}

fn copy_with_cancel<R: Read, W: Write>(
    source: &mut R,
    destination: &mut W,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    // This function runs on a blocking worker, but it is also called from
    // recursive archive/copy paths.  Keep the 1 MiB transfer buffer on the
    // heap so a small-stack worker cannot overflow before the first read.
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut copied = 0u64;
    loop {
        check_cancel(cancel)?;
        let read = source
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(copied);
        }
        destination
            .write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        copied = copied.saturating_add(read as u64);
    }
}

/// Restore the previous managed environment while the replacement is still
/// before its commit point.  A failed commit must never leave the application
/// without the previously working environment.
fn restore_runtime_backup(target: &Path, backup: &Path, context: &str) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target)
            .map_err(|error| format!("{context}时清理不完整的新环境失败: {error}"))?;
    }
    if backup.exists() {
        fs::rename(backup, target).map_err(|error| format!("{context}失败: {error}"))?;
    }
    Ok(())
}

/// Atomically switch a staged runtime into place.  The final rename is the
/// commit point: cancellation is honored before it, but never interpreted as
/// a rollback request after it.  The cleanup callback is deliberately
/// best-effort because the new runtime is already live once the rename has
/// succeeded.
fn commit_runtime_directory<F, C>(
    staging_env: &Path,
    target: &Path,
    backup: &Path,
    cancel: &AtomicBool,
    operation: &str,
    after_commit: F,
    cleanup_backup: C,
) -> Result<bool, String>
where
    F: FnOnce(),
    C: FnOnce(&Path) -> std::io::Result<()>,
{
    if target.exists() {
        fs::rename(target, backup).map_err(|error| format!("备份{operation}失败: {error}"))?;
    }
    if let Err(error) = check_cancel(cancel) {
        if backup.exists() {
            restore_runtime_backup(target, backup, &format!("{error}；取消前恢复{operation}"))?;
        }
        return Err(error);
    }
    if let Err(error) = fs::rename(staging_env, target) {
        if backup.exists() {
            if let Err(restore_error) =
                restore_runtime_backup(target, backup, &format!("启用{operation}失败后恢复旧环境"))
            {
                return Err(format!("启用{operation}失败: {error}; {restore_error}"));
            }
        }
        return Err(format!("启用{operation}失败: {error}"));
    }

    // Commit point.  A cancellation request can race with this rename, but
    // must not make a successfully activated runtime look cancelled.
    after_commit();
    if backup.exists() {
        if let Err(error) = cleanup_backup(backup) {
            eprintln!("清理旧{operation}备份失败（新环境已生效，稍后可重试）: {error}");
        }
    }
    Ok(true)
}

fn install_archive_cancelable(
    archive_path: &Path,
    runtime_root: &Path,
    target: &Path,
    manifest: RuntimeManifest,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    fs::create_dir_all(runtime_root).map_err(|error| format!("创建安装目录失败: {error}"))?;
    let staging = runtime_root.join(format!(".runtime-install-{}", timestamp_millis()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建运行环境临时目录失败: {error}"))?;

    let result = (|| {
        let archive_file =
            File::open(archive_path).map_err(|error| format!("打开运行环境压缩包失败: {error}"))?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("读取运行环境压缩包失败: {error}"))?;
        for index in 0..archive.len() {
            check_cancel(cancel)?;
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("读取运行环境条目失败: {error}"))?;
            let relative = entry
                .enclosed_name()
                .ok_or_else(|| format!("运行环境压缩包包含不安全路径: {}", entry.name()))?;
            let destination = staging.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&destination)
                    .map_err(|error| format!("创建运行环境目录失败: {error}"))?;
                restore_zip_permissions(&destination, entry.unix_mode())?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("创建运行环境目录失败: {error}"))?;
            }
            let mut output = File::create(&destination)
                .map_err(|error| format!("创建运行环境文件失败: {error}"))?;
            copy_with_cancel(&mut entry, &mut output, cancel)
                .map_err(|error| format!("解压运行环境文件失败: {error}"))?;
            drop(output);
            restore_zip_permissions(&destination, entry.unix_mode())?;
        }

        let staging_env = staging.join("env");
        if first_existing_python(&staging).is_none() || !staging_env.is_dir() {
            return Err("运行环境包校验失败：未找到 Python 可执行文件。".to_string());
        }
        check_cancel(cancel)?;
        write_runtime_manifest(&staging_env, manifest)?;

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建运行环境目标目录失败: {error}"))?;
        }
        check_cancel(cancel)?;
        let backup = runtime_root.join(format!(".env-old-{}", timestamp_millis()));
        commit_runtime_directory(
            &staging_env,
            target,
            &backup,
            cancel,
            "旧运行环境",
            || {},
            |path| fs::remove_dir_all(path),
        )
    })();

    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn install_merge_archive_cancelable(
    archive_path: &Path,
    runtime_root: &Path,
    target: &Path,
    manifest: RuntimeManifest,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    fs::create_dir_all(runtime_root).map_err(|error| format!("创建安装目录失败: {error}"))?;
    let staging = runtime_root.join(format!(".merge-runtime-install-{}", timestamp_millis()));
    let staging_env = staging.join("merge-env");
    fs::create_dir_all(&staging_env)
        .map_err(|error| format!("创建视频合并环境临时目录失败: {error}"))?;

    let result = (|| {
        let archive_file = File::open(archive_path)
            .map_err(|error| format!("打开视频合并环境压缩包失败: {error}"))?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("读取视频合并环境压缩包失败: {error}"))?;
        for index in 0..archive.len() {
            check_cancel(cancel)?;
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("读取视频合并环境条目失败: {error}"))?;
            let relative = entry
                .enclosed_name()
                .ok_or_else(|| format!("视频合并环境压缩包包含不安全路径: {}", entry.name()))?;
            let relative_path = relative.as_path();
            let relative_path = relative_path
                .strip_prefix("ffmpeg-env")
                .or_else(|_| relative_path.strip_prefix("merge-env"))
                .or_else(|_| relative_path.strip_prefix("env"))
                .unwrap_or(relative_path);
            let file_name = relative_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            let is_tool = matches!(
                file_name.to_ascii_lowercase().as_str(),
                "ffmpeg" | "ffmpeg.exe" | "ffprobe" | "ffprobe.exe"
            );
            let is_license = file_name.to_ascii_lowercase().starts_with("ffmpeg-")
                || file_name.eq_ignore_ascii_case("license")
                || file_name.eq_ignore_ascii_case("license.txt");
            if !is_tool && !is_license {
                continue;
            }
            let destination = staging_env.join(file_name);
            if entry.is_dir() {
                continue;
            }
            let mut output = File::create(&destination)
                .map_err(|error| format!("创建视频合并环境文件失败: {error}"))?;
            copy_with_cancel(&mut entry, &mut output, cancel)
                .map_err(|error| format!("解压视频合并环境文件失败: {error}"))?;
            drop(output);
            restore_zip_permissions(&destination, entry.unix_mode())?;
        }

        if executable_in_env(&staging_env, "ffmpeg").is_none()
            || executable_in_env(&staging_env, "ffprobe").is_none()
        {
            return Err("视频合并环境包校验失败：未找到 FFmpeg/FFprobe。".to_string());
        }
        check_cancel(cancel)?;
        write_runtime_manifest(&staging_env, manifest)?;

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建视频合并环境目标目录失败: {error}"))?;
        }
        check_cancel(cancel)?;
        let backup = runtime_root.join(format!(".merge-env-old-{}", timestamp_millis()));
        commit_runtime_directory(
            &staging_env,
            target,
            &backup,
            cancel,
            "旧视频合并环境",
            || {},
            |path| fs::remove_dir_all(path),
        )
    })();

    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(unix)]
fn restore_zip_permissions(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))
            .map_err(|error| format!("恢复运行环境文件权限失败: {error}"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn restore_zip_permissions(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

fn build_client(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .pool_max_idle_per_host(2)
        .tcp_nodelay(true);
    if let Some(proxy) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
        let parsed =
            reqwest::Url::parse(proxy).map_err(|error| format!("代理地址格式无效: {error}"))?;
        if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
            return Err(format!("不支持的代理协议: {}", parsed.scheme()));
        }
        builder = builder.proxy(
            reqwest::Proxy::all(parsed.as_str())
                .map_err(|error| format!("配置代理失败: {error}"))?,
        );
    }
    builder
        .build()
        .map_err(|error| format!("初始化运行环境下载客户端失败: {error}"))
}

fn app_local_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))
}

fn storage_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    if let Some(root) = windows_install_root() {
        return Ok(root);
    }

    app_local_root(app)
}

#[cfg(target_os = "windows")]
fn windows_install_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    windows_install_root_for_executable(&executable)
}

#[cfg(target_os = "windows")]
fn windows_install_root_for_executable(executable: &Path) -> Option<PathBuf> {
    let root = executable.parent()?;
    let packaged = root.join(".video-similarity-install.json").is_file()
        || root.join("BUILD_FLAVOR.txt").is_file()
            && root.join("scripts").is_dir()
            && root.join("video_sim").is_dir();
    packaged.then(|| root.canonicalize().unwrap_or_else(|_| root.to_path_buf()))
}

fn paths_equivalent(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    if cfg!(target_os = "windows") {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn write_runtime_manifest(directory: &Path, manifest: RuntimeManifest) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| format!("创建运行环境目录失败: {error}"))?;
    fs::write(
        directory.join(".runtime.json"),
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("生成运行环境清单失败: {error}"))?,
    )
    .map_err(|error| format!("写入运行环境清单失败: {error}"))
}

fn expected_version() -> String {
    RUNTIME_VERSION.trim().to_string()
}

fn merge_expected_version() -> String {
    FFMPEG_RUNTIME_VERSION.trim().to_string()
}

fn detect_build_flavor() -> String {
    for root in marker_roots() {
        if let Ok(value) = fs::read_to_string(root.join("BUILD_FLAVOR.txt")) {
            let value = value.trim().to_ascii_lowercase();
            if value == "cpu" || value == "gpu" {
                return value;
            }
        }
    }
    option_env!("VIDEO_SIM_BUILD_FLAVOR")
        .filter(|value| *value == "gpu")
        .unwrap_or("cpu")
        .to_string()
}

fn ensure_cuda_13_compatible() -> Result<(), String> {
    match cuda_13_compatibility_issue() {
        Some(issue) => Err(issue),
        None => Ok(()),
    }
}

fn cuda_13_compatibility_issue() -> Option<String> {
    if !cfg!(target_os = "windows") {
        return Some("CUDA 13.0 GPU 运行环境目前仅支持 Windows x64。".to_string());
    }
    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=compute_cap,driver_version",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = match command.output() {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Some(if detail.is_empty() {
                "无法读取 NVIDIA GPU 与驱动信息。CUDA 13.0 需要 Turing 或更新架构，并安装 R580 以上驱动。"
                    .to_string()
            } else {
                format!(
                    "无法读取 NVIDIA GPU 与驱动信息：{detail}。CUDA 13.0 需要 Turing 或更新架构，并安装 R580 以上驱动。"
                )
            });
        }
        Err(_) => {
            return Some(
                "未检测到 NVIDIA 驱动（nvidia-smi）。CUDA 13.0 需要 Turing 或更新架构，并安装 R580 以上驱动。"
                    .to_string(),
            );
        }
    };
    cuda_13_compatibility_issue_from_output(&String::from_utf8_lossy(&output.stdout))
}

fn cuda_13_compatibility_issue_from_output(output: &str) -> Option<String> {
    let detected = output.lines().find_map(|line| {
        let mut columns = line.split(',').map(str::trim);
        let compute_capability = columns.next()?.parse::<f32>().ok()?;
        let driver_major = columns.next()?.split('.').next()?.parse::<u32>().ok()?;
        Some((compute_capability, driver_major))
    });
    let Some((compute_capability, driver_major)) = detected else {
        return Some(
            "无法解析 NVIDIA GPU 与驱动信息。CUDA 13.0 需要 Turing 或更新架构，并安装 R580 以上驱动。"
                .to_string(),
        );
    };
    if compute_capability < 7.5 {
        return Some(format!(
            "当前 NVIDIA GPU 的计算能力为 {compute_capability:.1}；CUDA 13.0 GPU 包要求 Turing 或更新架构（计算能力 7.5+）。请改用 CPU 包。"
        ));
    }
    if driver_major < 580 {
        return Some(format!(
            "当前 NVIDIA 驱动为 R{driver_major}；CUDA 13.0 GPU 包要求 R580 或更新驱动。请更新驱动或改用 CPU 包。"
        ));
    }
    None
}

fn runtime_asset_name(version: &str, flavor: &str) -> String {
    runtime_asset_name_for_platform(version, runtime_platform(), flavor)
}

fn runtime_asset_name_for_platform(version: &str, platform: &str, flavor: &str) -> String {
    if platform == "windows-x64" {
        format!("Video_Similarity-runtime-v{version}-{platform}-{flavor}.zip")
    } else {
        format!("Video_Similarity-runtime-v{version}-{platform}.zip")
    }
}

fn ffmpeg_runtime_asset_name(version: &str, platform: &str) -> String {
    format!("Video_Similarity-ffmpeg-runtime-v{version}-{platform}.zip")
}

fn is_bundled_runtime_root(root: &Path) -> bool {
    root.join("BUILD_FLAVOR.txt").is_file()
        && root.join("scripts").is_dir()
        && root.join("video_sim").is_dir()
}

fn runtime_platform() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "macos-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else {
        "unsupported"
    }
}

fn marker_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    roots
}

fn legacy_runtime_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = marker_roots();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir);
    }
    deduplicate_paths(roots)
}

fn safe_legacy_runtime_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir);
    }
    deduplicate_paths(roots).into_iter().find_map(|root| {
        let python = first_existing_python(&root)?;
        python_runtime_env_dir(&python)
    })
}

fn python_candidates_below(root: &Path) -> Vec<PathBuf> {
    [
        root.join("env").join("python").join("python.exe"),
        root.join("env")
            .join("python")
            .join("Scripts")
            .join("python.exe"),
        root.join("env").join("python").join("bin").join("python"),
        root.join("env").join("python").join("bin").join("python3"),
        root.join("python").join("python.exe"),
        root.join("python").join("Scripts").join("python.exe"),
        root.join("python").join("bin").join("python"),
        root.join("python").join("bin").join("python3"),
    ]
    .into_iter()
    .collect()
}

fn first_existing_python(root: &Path) -> Option<PathBuf> {
    python_candidates_below(root)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn python_runtime_env_dir(python: &Path) -> Option<PathBuf> {
    for ancestor in python.ancestors() {
        if ancestor.file_name().is_some_and(|name| name == "env") {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

fn executable_in_env(env_dir: &Path, name: &str) -> Option<PathBuf> {
    let candidates = if cfg!(target_os = "windows") {
        vec![
            env_dir.join(format!("{name}.exe")),
            env_dir
                .join("python")
                .join("Scripts")
                .join(format!("{name}.exe")),
        ]
    } else {
        vec![
            env_dir.join(name),
            env_dir.join("python").join("bin").join(name),
        ]
    };
    candidates.into_iter().find(|path| path.is_file())
}

fn read_manifest(path: &Path) -> Option<RuntimeManifest> {
    let content = fs::read(path).ok()?;
    serde_json::from_slice(&content).ok()
}

fn sha256_file_cancelable(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("打开运行环境压缩包失败: {error}"))?;
    let mut hasher = Sha256::new();
    // Hashing is commonly run in a small-stack blocking worker.  A Vec keeps
    // this large scratch buffer out of that worker's stack frame.
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("运行环境下载已取消。".to_string());
        }
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取运行环境压缩包失败: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn emit_progress(
    app: &tauri::AppHandle,
    downloaded_bytes: u64,
    total_bytes: u64,
    progress: f64,
    stage: &str,
) {
    if let Some(state) = app.try_state::<RuntimeManagerState>() {
        if let Ok(mut status) = state.status.lock() {
            status.downloaded_bytes = downloaded_bytes;
            status.total_bytes = total_bytes;
            status.progress = progress.clamp(0.0, 100.0);
            status.stage = stage.to_string();
            status.cancel_requested = state.is_cancelled();
        }
    }
    let _ = app.emit(
        "runtime-install-progress",
        RuntimeInstallProgress {
            downloaded_bytes,
            total_bytes,
            progress,
            stage: stage.to_string(),
        },
    );
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut output = Vec::new();
    for path in paths {
        if !output.iter().any(|existing: &PathBuf| {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&path.to_string_lossy())
        }) {
            output.push(path);
        }
    }
    output
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.to_string()
    }
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::windows_install_root_for_executable;
    use super::{
        copy_dir_recursive_cancelable, cuda_13_compatibility_issue_from_output,
        ffmpeg_runtime_asset_name, install_archive_cancelable, install_merge_archive_cancelable,
        parse_parts_manifest, parse_resource_manifest, partial_download_path,
        python_candidates_below, runtime_asset_name, runtime_asset_name_for_platform,
        sha256_file_cancelable, RuntimeManagerState, RuntimeManifest,
    };
    use std::fs;
    use std::io::{Cursor, Write as _};
    use std::sync::atomic::AtomicBool;

    fn valid_resource_manifest_json() -> String {
        let hash = "a".repeat(64);
        format!(
            r#"{{
                "schemaVersion": 1,
                "releaseTag": "v1.3.0",
                "aiRuntimes": [
                    {{"platform":"windows-x64","flavor":"cpu","version":"1","assetName":"runtime.zip","sha256":"{hash}"}},
                    {{"platform":"windows-x64","flavor":"gpu","version":"1","assetName":"runtime-gpu.zip","sha256":"{hash}"}},
                    {{"platform":"linux-x64","flavor":"cpu","version":"1","assetName":"runtime-linux.zip","sha256":"{hash}"}}
                ],
                "mergeRuntimes": [
                    {{"platform":"windows-x64","version":"1","assetName":"ffmpeg.zip","sha256":"{hash}"}},
                    {{"platform":"linux-x64","version":"1","assetName":"ffmpeg-linux.zip","sha256":"{hash}"}}
                ],
                "clipModel": {{
                    "revision":"openai/clip-vit-base-patch32",
                    "assetName":"clip-vit-base-patch32.zip",
                    "archiveSha256":"{hash}",
                    "files": {{
                        "config.json":"{hash}",
                        "preprocessor_config.json":"{hash}",
                        "pytorch_model.bin":"{hash}"
                    }}
                }}
            }}"#
        )
    }

    #[test]
    fn runtime_asset_name_includes_version_platform_and_flavor() {
        let name = runtime_asset_name("7", "gpu");
        assert!(name.starts_with("Video_Similarity-runtime-v7-"));
        assert!(name.ends_with("-gpu.zip"));
    }

    #[test]
    fn runtime_download_state_is_queryable_and_cancel_is_scoped() {
        let state = RuntimeManagerState::default();
        assert!(state.try_begin("merge-runtime"));
        state.cancel("runtime");
        assert!(!state.snapshot().cancel_requested);
        state.cancel("merge-runtime");
        assert!(state.snapshot().cancel_requested);
        assert!(state.snapshot().running);
        state.finish("视频合并环境安装失败或已取消", true);
        assert!(!state.snapshot().running);
        assert!(!state.snapshot().cancel_requested);
    }

    #[test]
    fn non_windows_runtime_assets_are_arch_specific_without_flavor_suffix() {
        assert_eq!(
            runtime_asset_name_for_platform("1", "macos-arm64", "cpu"),
            "Video_Similarity-runtime-v1-macos-arm64.zip"
        );
        assert_eq!(
            runtime_asset_name_for_platform("1", "macos-x64", "cpu"),
            "Video_Similarity-runtime-v1-macos-x64.zip"
        );
        assert_eq!(
            runtime_asset_name_for_platform("1", "linux-x64", "cpu"),
            "Video_Similarity-runtime-v1-linux-x64.zip"
        );
    }

    #[test]
    fn ffmpeg_runtime_asset_name_is_platform_specific() {
        assert_eq!(
            ffmpeg_runtime_asset_name("3", "linux-x64"),
            "Video_Similarity-ffmpeg-runtime-v3-linux-x64.zip"
        );
    }

    #[test]
    fn cuda_13_requires_turing_or_newer_and_r580_driver() {
        assert!(cuda_13_compatibility_issue_from_output("7.5, 580.01").is_none());
        assert!(cuda_13_compatibility_issue_from_output("8.9, 591.44").is_none());
        assert!(cuda_13_compatibility_issue_from_output("6.1, 591.44")
            .unwrap()
            .contains("7.5+"));
        assert!(cuda_13_compatibility_issue_from_output("8.6, 572.83")
            .unwrap()
            .contains("R580"));
    }

    #[test]
    fn python_candidates_cover_portable_and_virtualenv_layouts() {
        let candidates = python_candidates_below(std::path::Path::new("runtime"));
        assert!(candidates
            .iter()
            .any(|path| path.ends_with("env/python/python.exe")));
        assert!(candidates
            .iter()
            .any(|path| path.ends_with("env/python/Scripts/python.exe")));
    }

    #[test]
    fn resource_manifest_requires_strict_schema_and_safe_entries() {
        let manifest = parse_resource_manifest(valid_resource_manifest_json().as_bytes()).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.clip_model.asset_name, "clip-vit-base-patch32.zip");

        let malformed =
            valid_resource_manifest_json().replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        assert!(parse_resource_manifest(malformed.as_bytes()).is_err());
        let unknown = valid_resource_manifest_json().replace(
            "\"releaseTag\": \"v1.3.0\"",
            "\"releaseTag\": \"v1.3.0\", \"unexpected\": true",
        );
        assert!(parse_resource_manifest(unknown.as_bytes()).is_err());
        let traversal = valid_resource_manifest_json().replace("runtime.zip", "../runtime.zip");
        assert!(parse_resource_manifest(traversal.as_bytes()).is_err());
        let invalid_platform =
            valid_resource_manifest_json().replace("windows-x64", "windows-arm64");
        assert!(parse_resource_manifest(invalid_platform.as_bytes()).is_err());
        let invalid_flavor =
            valid_resource_manifest_json().replace("\"flavor\":\"cpu\"", "\"flavor\":\"debug\"");
        assert!(parse_resource_manifest(invalid_flavor.as_bytes()).is_err());
        let bad_hash = valid_resource_manifest_json().replace(&"a".repeat(64), &"z".repeat(64));
        assert!(parse_resource_manifest(bad_hash.as_bytes()).is_err());
    }

    #[test]
    fn resource_manifest_body_enforces_limit_without_content_length() {
        let mut content = Vec::new();
        let chunk = vec![b'x'; super::RESOURCE_MANIFEST_MAX_BYTES];
        super::append_resource_manifest_chunk(&mut content, &chunk).unwrap();
        assert_eq!(content.len(), super::RESOURCE_MANIFEST_MAX_BYTES);
        assert!(super::append_resource_manifest_chunk(&mut content, b"x").is_err());
        assert_eq!(content.len(), super::RESOURCE_MANIFEST_MAX_BYTES);
    }

    #[test]
    fn resource_manifest_selects_platform_and_flavor() {
        let manifest = parse_resource_manifest(valid_resource_manifest_json().as_bytes()).unwrap();
        assert_eq!(
            manifest
                .select_ai_runtime("windows-x64", "gpu")
                .unwrap()
                .asset_name,
            "runtime-gpu.zip"
        );
        assert_eq!(
            manifest
                .select_ai_runtime("linux-x64", "cpu")
                .unwrap()
                .asset_name,
            "runtime-linux.zip"
        );
        assert!(manifest.select_ai_runtime("linux-x64", "gpu").is_err());
        assert_eq!(
            manifest
                .select_merge_runtime("windows-x64")
                .unwrap()
                .asset_name,
            "ffmpeg.zip"
        );
    }

    #[test]
    fn resource_update_check_distinguishes_matching_mismatching_and_missing_local_hash() {
        let hash = "a".repeat(64);
        let local = RuntimeManifest {
            version: "1".to_string(),
            flavor: "cpu".to_string(),
            asset_name: "runtime.zip".to_string(),
            sha256: hash.clone(),
            installed_at_ms: 1,
        };
        let current = super::resource_update_check(
            true,
            true,
            Some(&local),
            "1",
            "runtime.zip",
            &hash,
            "AI 运行环境",
        );
        assert!(!current.update_available);
        assert!(current.comparison_available);
        assert_eq!(current.local_sha256.as_deref(), Some(hash.as_str()));

        let other_hash = "b".repeat(64);
        let changed = super::resource_update_check(
            true,
            true,
            Some(&local),
            "2",
            "runtime-v2.zip",
            &other_hash,
            "AI 运行环境",
        );
        assert!(changed.update_available);
        assert_eq!(changed.remote_version.as_deref(), Some("2"));

        let missing = super::resource_update_check(
            false,
            false,
            None,
            "1",
            "runtime.zip",
            &hash,
            "AI 运行环境",
        );
        assert!(missing.update_available);
        assert!(!missing.comparison_available);
        assert!(missing.local_sha256.is_none());
    }

    #[test]
    fn copy_and_hash_work_on_a_small_stack() {
        let root = std::env::temp_dir().join(format!(
            "video-similarity-runtime-small-stack-{}",
            super::timestamp_millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = vec![0x5a_u8; 1024 * 1024 + 17];
        let source_path = root.join("source.bin");
        let destination_path = root.join("destination.bin");
        fs::write(&source_path, &source).unwrap();
        let source_for_copy = source.clone();
        let destination_for_copy = destination_path.clone();
        let copy_thread = std::thread::Builder::new()
            .name("runtime-small-stack-copy".to_string())
            .stack_size(64 * 1024)
            .spawn(move || {
                let mut input = Cursor::new(source_for_copy);
                let mut output = fs::File::create(destination_for_copy).unwrap();
                super::copy_with_cancel(&mut input, &mut output, &AtomicBool::new(false)).unwrap()
            })
            .unwrap();
        assert_eq!(copy_thread.join().unwrap(), source.len() as u64);
        assert_eq!(fs::read(&destination_path).unwrap(), source);

        let hash_path = source_path.clone();
        let hash_thread = std::thread::Builder::new()
            .name("runtime-small-stack-hash".to_string())
            .stack_size(64 * 1024)
            .spawn(move || sha256_file_cancelable(&hash_path, &AtomicBool::new(false)).unwrap())
            .unwrap();
        assert_eq!(hash_thread.join().unwrap().len(), 64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multipart_manifest_requires_ordered_safe_sub_two_gib_parts() {
        let path = std::env::temp_dir().join(format!(
            "video-similarity-runtime-parts-{}.json",
            super::timestamp_millis()
        ));
        let hash = "a".repeat(64);
        fs::write(
            &path,
            format!(
                r#"{{
                    "archiveName": "runtime-gpu.zip",
                    "archiveSha256": "{hash}",
                    "parts": [
                        {{"name": "runtime-gpu.zip.part01", "sha256": "{hash}", "sizeBytes": 1992294400}},
                        {{"name": "runtime-gpu.zip.part02", "sha256": "{hash}", "sizeBytes": 1024}}
                    ]
                }}"#
            ),
        )
        .unwrap();
        assert_eq!(
            parse_parts_manifest(&path, "runtime-gpu.zip")
                .unwrap()
                .parts
                .len(),
            2
        );
        assert!(
            partial_download_path(std::path::Path::new("runtime-gpu.zip.part01"))
                .ends_with("runtime-gpu.zip.part01.download")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn recursive_copy_preserves_nested_runtime_files() {
        let root = std::env::temp_dir().join(format!(
            "video-similarity-runtime-copy-{}",
            super::timestamp_millis()
        ));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("python").join("bin")).unwrap();
        fs::write(source.join("python").join("bin").join("python"), b"runtime").unwrap();

        copy_dir_recursive_cancelable(&source, &destination, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            fs::read(destination.join("python").join("bin").join("python")).unwrap(),
            b"runtime"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_archive_replaces_only_the_install_root_env_directory() {
        let root = std::env::temp_dir().join(format!(
            "video-similarity-runtime-install-{}",
            super::timestamp_millis()
        ));
        let archive_path = root.join("runtime.zip");
        let target = root.join("env");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old-runtime.txt"), b"old").unwrap();

        let archive_file = fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(archive_file);
        let options = zip::write::SimpleFileOptions::default();
        let python_path = if cfg!(target_os = "windows") {
            "env/python/python.exe"
        } else {
            "env/python/bin/python"
        };
        archive.start_file(python_path, options).unwrap();
        archive.write_all(b"runtime").unwrap();
        archive.finish().unwrap();

        install_archive_cancelable(
            &archive_path,
            &root,
            &target,
            RuntimeManifest {
                version: "1".to_string(),
                flavor: "cpu".to_string(),
                asset_name: "runtime.zip".to_string(),
                sha256: "test".to_string(),
                installed_at_ms: 1,
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert!(target.join(".runtime.json").is_file());
        assert!(!target.join("env").exists());
        assert!(!target.join("old-runtime.txt").exists());
        assert!(root.join(python_path).is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancelled_runtime_install_keeps_previous_environment_and_removes_staging() {
        let root = std::env::temp_dir().join(format!(
            "video-similarity-runtime-cancel-{}",
            super::timestamp_millis()
        ));
        let archive_path = root.join("runtime.zip");
        let target = root.join("env");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old-runtime.txt"), b"old").unwrap();

        let archive_file = fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(archive_file);
        archive
            .start_file(
                "env/python/bin/python",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"new").unwrap();
        archive.finish().unwrap();

        let cancelled = AtomicBool::new(true);
        let result = install_archive_cancelable(
            &archive_path,
            &root,
            &target,
            RuntimeManifest {
                version: "1".to_string(),
                flavor: "cpu".to_string(),
                asset_name: "runtime.zip".to_string(),
                sha256: "test".to_string(),
                installed_at_ms: 1,
            },
            &cancelled,
        );

        assert!(result.is_err());
        assert_eq!(fs::read(target.join("old-runtime.txt")).unwrap(), b"old");
        assert!(!fs::read_dir(&root).unwrap().flatten().any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(".runtime-install-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn standalone_ffmpeg_archive_installs_only_tools_and_licenses() {
        let root = std::env::temp_dir().join(format!(
            "video-similarity-ffmpeg-runtime-install-{}",
            super::timestamp_millis()
        ));
        let archive_path = root.join("ffmpeg-runtime.zip");
        let target = root.join("merge-env");
        fs::create_dir_all(&root).unwrap();
        let ffmpeg_name = if cfg!(target_os = "windows") {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let ffprobe_name = if cfg!(target_os = "windows") {
            "ffprobe.exe"
        } else {
            "ffprobe"
        };

        let archive_file = fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(archive_file);
        let options = zip::write::SimpleFileOptions::default();
        for (path, content) in [
            (format!("ffmpeg-env/{ffmpeg_name}"), b"ffmpeg".as_slice()),
            (format!("ffmpeg-env/{ffprobe_name}"), b"ffprobe".as_slice()),
            (
                "ffmpeg-env/FFmpeg-GPL-3.0.txt".to_string(),
                b"license".as_slice(),
            ),
            (
                "ffmpeg-env/python".to_string(),
                b"must not install".as_slice(),
            ),
        ] {
            archive.start_file(path, options).unwrap();
            archive.write_all(content).unwrap();
        }
        archive.finish().unwrap();

        install_merge_archive_cancelable(
            &archive_path,
            &root,
            &target,
            RuntimeManifest {
                version: "1".to_string(),
                flavor: "linux-x64".to_string(),
                asset_name: "ffmpeg-runtime.zip".to_string(),
                sha256: "test".to_string(),
                installed_at_ms: 1,
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(fs::read(target.join(ffmpeg_name)).unwrap(), b"ffmpeg");
        assert_eq!(fs::read(target.join(ffprobe_name)).unwrap(), b"ffprobe");
        assert!(target.join("FFmpeg-GPL-3.0.txt").is_file());
        assert!(!target.join("python").exists());
        assert!(target.join(".runtime.json").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancelled_merge_runtime_install_keeps_previous_environment_and_removes_staging() {
        let root = std::env::temp_dir().join(format!(
            "video-similarity-ffmpeg-runtime-cancel-{}",
            super::timestamp_millis()
        ));
        let archive_path = root.join("ffmpeg-runtime.zip");
        let target = root.join("merge-env");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old-ffmpeg"), b"old").unwrap();

        let archive_file = fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(archive_file);
        for (name, contents) in [
            ("ffmpeg-env/ffmpeg", b"ffmpeg".as_slice()),
            ("ffmpeg-env/ffprobe", b"ffprobe".as_slice()),
        ] {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(contents).unwrap();
        }
        archive.finish().unwrap();

        let cancelled = AtomicBool::new(true);
        let result = install_merge_archive_cancelable(
            &archive_path,
            &root,
            &target,
            RuntimeManifest {
                version: "1".to_string(),
                flavor: "linux-x64".to_string(),
                asset_name: "ffmpeg-runtime.zip".to_string(),
                sha256: "test".to_string(),
                installed_at_ms: 1,
            },
            &cancelled,
        );

        assert!(result.is_err());
        assert_eq!(fs::read(target.join("old-ffmpeg")).unwrap(), b"old");
        assert!(!fs::read_dir(&root).unwrap().flatten().any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(".merge-runtime-install-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_packaged_runtime_uses_the_custom_executable_directory() {
        let root = std::env::temp_dir().join(format!(
            "video-similarity-custom-install-{}",
            super::timestamp_millis()
        ));
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::create_dir_all(root.join("video_sim")).unwrap();
        fs::write(root.join("BUILD_FLAVOR.txt"), b"gpu").unwrap();
        let executable = root.join("video-similarity-desktop.exe");
        fs::write(&executable, b"app").unwrap();

        assert_eq!(
            windows_install_root_for_executable(&executable).unwrap(),
            root.canonicalize().unwrap()
        );
        let _ = fs::remove_dir_all(root);
    }
}
