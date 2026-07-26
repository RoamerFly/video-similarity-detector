use reqwest::header::{ACCEPT, RANGE, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

const RUNTIME_VERSION: &str = include_str!("../../runtime-version.txt");
const RELEASE_DOWNLOAD_ROOT: &str =
    "https://github.com/RoamerFly/video-similarity-detector/releases/latest/download";

#[derive(Default)]
pub struct RuntimeManagerState {
    installing: AtomicBool,
    cancel_requested: AtomicBool,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    version: String,
    flavor: String,
    asset_name: String,
    sha256: String,
    installed_at_ms: u128,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePartsManifest {
    archive_name: String,
    archive_sha256: String,
    parts: Vec<RuntimePart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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
pub async fn install_runtime(
    app: tauri::AppHandle,
    state: State<'_, RuntimeManagerState>,
    proxy_url: Option<String>,
) -> Result<RuntimeStatus, String> {
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("运行环境安装任务已经在执行。".to_string());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    let result = install_runtime_impl(&app, &state, proxy_url.as_deref()).await;
    state.installing.store(false, Ordering::SeqCst);
    result?;
    configure_environment(&app)?;
    runtime_status(&app)
}

#[tauri::command]
pub fn cancel_runtime_install(state: State<'_, RuntimeManagerState>) {
    state.cancel_requested.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn migrate_legacy_runtime(
    app: tauri::AppHandle,
    state: State<'_, RuntimeManagerState>,
) -> Result<RuntimeStatus, String> {
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("运行环境安装或迁移任务已经在执行。".to_string());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);
    emit_progress(&app, 0, 0, 5.0, "正在准备迁移旧版运行环境");

    let app_for_migration = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        migrate_legacy_runtime_impl(&app_for_migration)
    })
    .await
    .map_err(|error| format!("运行环境迁移任务异常: {error}"));
    state.installing.store(false, Ordering::SeqCst);
    let legacy_removed = result??;

    configure_environment(&app)?;
    emit_progress(&app, 0, 0, 100.0, "旧版运行环境迁移完成");
    let mut status = runtime_status(&app)?;
    status.message = if legacy_removed {
        "旧版运行环境已迁移到应用数据目录，无需重新下载。".to_string()
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
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("运行环境安装、迁移或清理任务已经在执行。".to_string());
    }

    let app_for_cleanup = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || remove_legacy_runtime_impl(&app_for_cleanup))
            .await
            .map_err(|error| format!("旧版运行环境清理任务异常: {error}"));
    state.installing.store(false, Ordering::SeqCst);
    result??;

    let mut status = runtime_status(&app)?;
    status.message = "旧版内置运行环境已清理，当前托管运行环境保持可用。".to_string();
    Ok(status)
}

pub fn asset_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_local_root(app)?.join("assets"))
}

pub fn configure_environment(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = runtime_status(app)?;
    if runtime.ready && !runtime.python_path.is_empty() {
        let python = PathBuf::from(&runtime.python_path);
        if let Some(env_dir) = python_runtime_env_dir(&python) {
            std::env::set_var("VIDEO_SIM_RUNTIME_DIR", &env_dir);
            if std::env::var_os("VIDEO_SIM_FFMPEG").is_none() {
                if let Some(ffmpeg) = executable_in_env(&env_dir, "ffmpeg") {
                    std::env::set_var("VIDEO_SIM_FFMPEG", ffmpeg);
                }
            }
            if std::env::var_os("VIDEO_SIM_FFPROBE").is_none() {
                if let Some(ffprobe) = executable_in_env(&env_dir, "ffprobe") {
                    std::env::set_var("VIDEO_SIM_FFPROBE", ffprobe);
                }
            }
        }
    }

    if std::env::var_os("VIDEO_SIM_CLIP_MODEL_DIR").is_none() {
        let model_dir = asset_root(app)?
            .join("models")
            .join("clip-vit-base-patch32");
        std::env::set_var("VIDEO_SIM_CLIP_MODEL_DIR", model_dir);
    }
    Ok(())
}

pub fn python_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let flavor = detect_build_flavor();
    let version = expected_version();
    let mut candidates = Vec::new();

    if let Ok(root) = app_local_root(app) {
        let managed = root
            .join("runtime")
            .join("versions")
            .join(version)
            .join(flavor);
        candidates.extend(python_candidates_below(&managed));
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
    let compatibility_issue = if flavor == "gpu" {
        cuda_13_compatibility_issue()
    } else {
        None
    };
    let expected_version = expected_version();
    let runtime_dir = app_local_root(app)?
        .join("runtime")
        .join("versions")
        .join(&expected_version)
        .join(&flavor);
    let asset_name = runtime_asset_name(&expected_version, &flavor);
    let managed_python = first_existing_python(&runtime_dir);
    let manifest = read_manifest(&runtime_dir.join(".runtime.json"));
    let safe_legacy_dir = safe_legacy_runtime_dir(app);

    if let Some(python) = managed_python {
        let version_matches = manifest
            .as_ref()
            .is_some_and(|value| value.version == expected_version && value.flavor == flavor);
        return Ok(RuntimeStatus {
            ready: version_matches && compatibility_issue.is_none(),
            managed: true,
            legacy_fallback: false,
            legacy_migration_available: false,
            legacy_cleanup_available: safe_legacy_dir.is_some(),
            legacy_runtime_dir: safe_legacy_dir
                .as_deref()
                .map(display_path)
                .unwrap_or_default(),
            expected_version,
            installed_version: manifest.as_ref().map(|value| value.version.clone()),
            flavor,
            runtime_dir: display_path(&runtime_dir),
            python_path: display_path(&python),
            asset_name,
            message: if let Some(issue) = compatibility_issue {
                issue
            } else if version_matches {
                "应用数据目录中的运行环境已就绪。".to_string()
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
            ready: compatibility_issue.is_none(),
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
            message: compatibility_issue.unwrap_or_else(|| {
                "正在兼容使用旧版内置运行环境；可迁移到应用数据目录完成升级。".to_string()
            }),
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
        message: compatibility_issue.unwrap_or_else(|| {
            "尚未安装 AI 运行环境。应用本体保持轻量，首次使用前需下载一次。".to_string()
        }),
    })
}

fn migrate_legacy_runtime_impl(app: &tauri::AppHandle) -> Result<bool, String> {
    let source = safe_legacy_runtime_dir(app)
        .ok_or_else(|| "未找到可安全迁移的旧版内置运行环境。".to_string())?;
    let flavor = detect_build_flavor();
    if flavor == "gpu" {
        ensure_cuda_13_compatible()?;
    }
    let version = expected_version();
    let runtime_root = app_local_root(app)?.join("runtime");
    let target = runtime_root.join("versions").join(&version).join(&flavor);

    if target.exists()
        && first_existing_python(&target).is_some()
        && read_manifest(&target.join(".runtime.json"))
            .is_some_and(|manifest| manifest.version == version && manifest.flavor == flavor)
    {
        return remove_legacy_directory(&source, &runtime_root).map(|_| true);
    }

    fs::create_dir_all(&runtime_root)
        .map_err(|error| format!("创建应用数据运行环境目录失败: {error}"))?;
    let staging = runtime_root.join(format!(".migrate-{}", timestamp_millis()));
    let staging_env = staging.join("env");
    fs::create_dir_all(&staging)
        .map_err(|error| format!("创建运行环境迁移临时目录失败: {error}"))?;

    let moved_source = match fs::rename(&source, &staging_env) {
        Ok(()) => true,
        Err(_) => {
            if let Err(error) = copy_dir_recursive(&source, &staging_env) {
                let _ = fs::remove_dir_all(&staging);
                return Err(format!("复制旧版运行环境失败: {error}"));
            }
            false
        }
    };

    let migration_result = (|| {
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
        fs::write(
            staging.join(".runtime.json"),
            serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("生成迁移运行环境清单失败: {error}"))?,
        )
        .map_err(|error| format!("写入迁移运行环境清单失败: {error}"))?;

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建运行环境版本目录失败: {error}"))?;
        }
        let backup = target.with_extension(format!("old-{}", timestamp_millis()));
        if target.exists() {
            fs::rename(&target, &backup)
                .map_err(|error| format!("备份旧托管运行环境失败: {error}"))?;
        }
        if let Err(error) = fs::rename(&staging, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(format!("启用迁移后的运行环境失败: {error}"));
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(&backup);
        }
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
    Ok(remove_legacy_directory(&source, &runtime_root).is_ok())
}

fn remove_legacy_runtime_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let status = runtime_status(app)?;
    if !status.ready || !status.managed {
        return Err("仅在托管运行环境已就绪后才能清理旧版环境。".to_string());
    }
    let source = safe_legacy_runtime_dir(app)
        .ok_or_else(|| "未找到可安全清理的旧版内置运行环境。".to_string())?;
    let runtime_root = app_local_root(app)?.join("runtime");
    remove_legacy_directory(&source, &runtime_root)
}

fn remove_legacy_directory(source: &Path, managed_runtime_root: &Path) -> Result<(), String> {
    let source =
        fs::canonicalize(source).map_err(|error| format!("定位旧版运行环境失败: {error}"))?;
    let managed_runtime_root = fs::canonicalize(managed_runtime_root)
        .unwrap_or_else(|_| managed_runtime_root.to_path_buf());
    if source.starts_with(&managed_runtime_root) || managed_runtime_root.starts_with(&source) {
        return Err("拒绝清理与托管运行环境重叠的目录。".to_string());
    }
    fs::remove_dir_all(&source).map_err(|error| {
        format!(
            "删除旧版运行环境失败（可能需要手动删除 {}）: {error}",
            display_path(&source)
        )
    })
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
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
            return copy_dir_recursive(&resolved, destination);
        }
    }

    if metadata.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|error| format!("创建目录 {} 失败: {error}", display_path(destination)))?;
        for entry in fs::read_dir(source)
            .map_err(|error| format!("读取目录 {} 失败: {error}", display_path(source)))?
        {
            let entry = entry.map_err(|error| format!("读取迁移目录条目失败: {error}"))?;
            copy_dir_recursive(&entry.path(), &destination.join(entry.file_name()))?;
        }
        fs::set_permissions(destination, metadata.permissions())
            .map_err(|error| format!("保留目录权限 {} 失败: {error}", display_path(destination)))?;
        return Ok(());
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录 {} 失败: {error}", display_path(parent)))?;
    }
    fs::copy(source, destination).map_err(|error| {
        format!(
            "复制 {} 到 {} 失败: {error}",
            display_path(source),
            display_path(destination)
        )
    })?;
    fs::set_permissions(destination, metadata.permissions())
        .map_err(|error| format!("保留文件权限 {} 失败: {error}", display_path(destination)))?;
    Ok(())
}

async fn install_runtime_impl(
    app: &tauri::AppHandle,
    state: &RuntimeManagerState,
    proxy_url: Option<&str>,
) -> Result<(), String> {
    let flavor = detect_build_flavor();
    if flavor == "gpu" {
        ensure_cuda_13_compatible()?;
    }
    let version = expected_version();
    let asset_name = runtime_asset_name(&version, &flavor);
    let download_root = app_local_root(app)?.join("runtime").join("downloads");
    fs::create_dir_all(&download_root)
        .map_err(|error| format!("创建运行环境下载目录失败: {error}"))?;
    let archive_path = download_root.join(&asset_name);
    let checksum_path = download_root.join(format!("{asset_name}.sha256"));

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
        download_small_file(&client, &descriptor_url, &descriptor_path).await?;
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
            let existing_valid = tauri::async_runtime::spawn_blocking(move || {
                fs::metadata(&existing_part)
                    .is_ok_and(|metadata| metadata.len() == expected_part_size)
                    && sha256_file(&existing_part).is_ok_and(|hash| hash == expected_part_hash)
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
                let actual_hash =
                    tauri::async_runtime::spawn_blocking(move || sha256_file(&part_for_hash))
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
        tauri::async_runtime::spawn_blocking(move || {
            concatenate_files(&part_paths, &archive_for_merge)
        })
        .await
        .map_err(|error| format!("GPU 运行环境分卷合并任务异常: {error}"))??;
        parts_manifest.archive_sha256
    } else {
        let checksum_url = format!("{asset_url}.sha256");
        emit_progress(app, 0, 0, 1.0, "正在获取运行环境校验文件");
        download_small_file(&client, &checksum_url, &checksum_path).await?;
        cleanup_paths.push(checksum_path.clone());
        let expected_hash = parse_checksum(&checksum_path)?;
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
        expected_hash
    };
    if state.cancel_requested.load(Ordering::SeqCst) {
        return Err("运行环境下载已取消，已保留断点文件。".to_string());
    }

    emit_progress(app, 0, 0, 78.0, "正在校验运行环境");
    let archive_for_hash = archive_path.clone();
    let actual_hash = tauri::async_runtime::spawn_blocking(move || sha256_file(&archive_for_hash))
        .await
        .map_err(|error| format!("运行环境校验任务异常: {error}"))??;
    if actual_hash != expected_hash {
        let _ = fs::remove_file(&archive_path);
        return Err("运行环境 SHA-256 校验失败，已删除损坏文件。".to_string());
    }

    emit_progress(app, 0, 0, 84.0, "正在解压运行环境");
    let install_root = app_local_root(app)?.join("runtime");
    let target = install_root.join("versions").join(&version).join(&flavor);
    let archive_for_install = archive_path.clone();
    let asset_for_manifest = asset_name.clone();
    let version_for_manifest = version.clone();
    let flavor_for_manifest = flavor.clone();
    let hash_for_manifest = expected_hash.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_archive(
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
        )
    })
    .await
    .map_err(|error| format!("运行环境安装任务异常: {error}"))??;

    for path in cleanup_paths {
        let _ = fs::remove_file(path);
    }
    emit_progress(app, 0, 0, 100.0, "AI 运行环境已安装");
    Ok(())
}

async fn download_small_file(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    let response = client
        .get(url)
        .header(USER_AGENT, "video-similarity-desktop")
        .header(ACCEPT, "application/json, text/plain")
        .send()
        .await
        .map_err(|error| format!("连接运行环境元数据地址失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "获取运行环境元数据失败: HTTP {}",
            response.status()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取运行环境元数据失败: {error}"))?;
    fs::write(destination, body).map_err(|error| format!("保存运行环境元数据失败: {error}"))
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
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("连接运行环境下载地址失败: {error}"))?;
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

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取运行环境下载数据失败: {error}"))?
    {
        if state.cancel_requested.load(Ordering::SeqCst) {
            output
                .flush()
                .map_err(|error| format!("保存运行环境断点文件失败: {error}"))?;
            return Err("运行环境下载已取消，已保留断点文件。".to_string());
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
                "正在续传 AI 运行环境"
            } else {
                progress.stage
            },
        );
    }
    output
        .flush()
        .map_err(|error| format!("保存运行环境断点文件失败: {error}"))?;
    if total_bytes > 0 && downloaded_bytes < total_bytes {
        return Err(format!(
            "运行环境下载不完整: {downloaded_bytes} / {total_bytes} 字节"
        ));
    }
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| format!("替换旧运行环境压缩包失败: {error}"))?;
    }
    fs::rename(part_path, destination).map_err(|error| format!("保存运行环境压缩包失败: {error}"))
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
    let manifest: RuntimePartsManifest = serde_json::from_slice(&content)
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
    Ok(manifest)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn concatenate_files(parts: &[PathBuf], destination: &Path) -> Result<(), String> {
    let mut output = File::create(destination)
        .map_err(|error| format!("创建 GPU 运行环境合并文件失败: {error}"))?;
    for part in parts {
        let mut input =
            File::open(part).map_err(|error| format!("打开 GPU 运行环境分卷失败: {error}"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|error| format!("合并 GPU 运行环境分卷失败: {error}"))?;
    }
    output
        .flush()
        .map_err(|error| format!("保存 GPU 运行环境合并文件失败: {error}"))
}

fn install_archive(
    archive_path: &Path,
    runtime_root: &Path,
    target: &Path,
    manifest: RuntimeManifest,
) -> Result<(), String> {
    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("创建应用数据运行环境目录失败: {error}"))?;
    let staging = runtime_root.join(format!(".install-{}", timestamp_millis()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建运行环境临时目录失败: {error}"))?;

    let result = (|| {
        let archive_file =
            File::open(archive_path).map_err(|error| format!("打开运行环境压缩包失败: {error}"))?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("读取运行环境压缩包失败: {error}"))?;
        for index in 0..archive.len() {
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
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("解压运行环境文件失败: {error}"))?;
            drop(output);
            restore_zip_permissions(&destination, entry.unix_mode())?;
        }

        if first_existing_python(&staging).is_none() {
            return Err("运行环境包校验失败：未找到 Python 可执行文件。".to_string());
        }
        fs::write(
            staging.join(".runtime.json"),
            serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("生成运行环境清单失败: {error}"))?,
        )
        .map_err(|error| format!("写入运行环境清单失败: {error}"))?;

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建运行环境版本目录失败: {error}"))?;
        }
        let backup = target.with_extension(format!("old-{}", timestamp_millis()));
        if target.exists() {
            fs::rename(target, &backup).map_err(|error| format!("备份旧运行环境失败: {error}"))?;
        }
        if let Err(error) = fs::rename(&staging, target) {
            if backup.exists() {
                let _ = fs::rename(&backup, target);
            }
            return Err(format!("启用新运行环境失败: {error}"));
        }
        if backup.exists() {
            fs::remove_dir_all(backup).map_err(|error| format!("清理旧运行环境失败: {error}"))?;
        }
        Ok(())
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

fn expected_version() -> String {
    RUNTIME_VERSION.trim().to_string()
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
    let output = match Command::new("nvidia-smi")
        .args([
            "--query-gpu=compute_cap,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .output()
    {
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

fn parse_checksum(path: &Path) -> Result<String, String> {
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取运行环境校验文件失败: {error}"))?;
    let hash = content.split_whitespace().next().unwrap_or_default();
    if !valid_sha256(hash) {
        return Err("运行环境校验文件格式无效。".to_string());
    }
    Ok(hash.to_ascii_lowercase())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("打开运行环境压缩包失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
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
    use super::{
        copy_dir_recursive, cuda_13_compatibility_issue_from_output, parse_checksum,
        parse_parts_manifest, partial_download_path, python_candidates_below, runtime_asset_name,
        runtime_asset_name_for_platform,
    };
    use std::fs;

    #[test]
    fn runtime_asset_name_includes_version_platform_and_flavor() {
        let name = runtime_asset_name("7", "gpu");
        assert!(name.starts_with("Video_Similarity-runtime-v7-"));
        assert!(name.ends_with("-gpu.zip"));
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
    fn checksum_parser_accepts_sha256_sidecar_format() {
        let path = std::env::temp_dir().join(format!(
            "video-similarity-runtime-checksum-{}.txt",
            super::timestamp_millis()
        ));
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        fs::write(&path, format!("{hash}  runtime.zip\n")).unwrap();
        assert_eq!(parse_checksum(&path).unwrap(), hash);
        let _ = fs::remove_file(path);
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

        copy_dir_recursive(&source, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join("python").join("bin").join("python")).unwrap(),
            b"runtime"
        );
        let _ = fs::remove_dir_all(root);
    }
}
