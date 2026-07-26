#!/usr/bin/env python3
"""Synchronize desktop package versions from a release tag."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"
JSON_VERSION_PATTERN = r'(?m)^(\s*"version"\s*:\s*")([^"]+)(")'
CARGO_PACKAGE_PATTERN = (
    r'(?m)(^\[\[package\]\]\n'
    r'name = "video-similarity-desktop"\n'
    r'version = ")([^"]+)(")'
)


def normalize_version(tag: str) -> str:
    version = tag.strip()
    if version.startswith("v"):
        version = version[1:]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise ValueError(f"Invalid release version: {tag}")
    return version


def replace_versions(path: Path, version: str, count: int) -> None:
    content = path.read_text(encoding="utf-8")
    updated, replacements = re.subn(
        r'(?m)^(\s*"version"\s*:\s*")[^"]+(")',
        rf"\g<1>{version}\g<2>",
        content,
        count=count,
    )
    if replacements != count:
        raise RuntimeError(
            f"Expected {count} version field(s) in {path}, found {replacements}"
        )
    if updated != content:
        path.write_text(updated, encoding="utf-8")


def update_cargo_toml(path: Path, version: str) -> None:
    content = path.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'(?m)^(version\s*=\s*")[^"]+(")',
        rf"\g<1>{version}\g<2>",
        content,
        count=1,
    )
    if count != 1:
        raise RuntimeError(f"Unable to update package version in {path}")
    if updated != content:
        path.write_text(updated, encoding="utf-8")


def update_cargo_lock(path: Path, version: str) -> None:
    content = path.read_text(encoding="utf-8")
    updated, count = re.subn(
        CARGO_PACKAGE_PATTERN,
        rf"\g<1>{version}\g<3>",
        content,
        count=1,
    )
    if count != 1:
        raise RuntimeError(f"Unable to update package version in {path}")
    if updated != content:
        path.write_text(updated, encoding="utf-8")


def update_python_package(path: Path, version: str) -> None:
    content = path.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'(?m)^(__version__\s*=\s*")[^"]+(")',
        rf"\g<1>{version}\g<2>",
        content,
        count=1,
    )
    if count != 1:
        raise RuntimeError(f"Unable to update Python package version in {path}")
    if updated != content:
        path.write_text(updated, encoding="utf-8")


def assert_versions(version: str) -> None:
    expected_json_versions = [
        (DESKTOP / "package.json", 1),
        (DESKTOP / "package-lock.json", 2),
        (DESKTOP / "src-tauri" / "tauri.conf.json", 1),
    ]
    for path, count in expected_json_versions:
        values = [
            match.group(2)
            for match in re.finditer(JSON_VERSION_PATTERN, path.read_text(encoding="utf-8"))
        ][:count]
        if values != [version] * count:
            raise RuntimeError(
                f"Version mismatch in {path}: expected {version!r}, found {values!r}"
            )

    cargo_toml = DESKTOP / "src-tauri" / "Cargo.toml"
    cargo_toml_match = re.search(
        r'(?m)^version\s*=\s*"([^"]+)"',
        cargo_toml.read_text(encoding="utf-8"),
    )
    cargo_toml_version = cargo_toml_match.group(1) if cargo_toml_match else None
    if cargo_toml_version != version:
        raise RuntimeError(
            f"Version mismatch in {cargo_toml}: "
            f"expected {version!r}, found {cargo_toml_version!r}"
        )

    cargo_lock = DESKTOP / "src-tauri" / "Cargo.lock"
    cargo_lock_match = re.search(
        CARGO_PACKAGE_PATTERN,
        cargo_lock.read_text(encoding="utf-8"),
    )
    cargo_lock_version = cargo_lock_match.group(2) if cargo_lock_match else None
    if cargo_lock_version != version:
        raise RuntimeError(
            f"Version mismatch in {cargo_lock}: "
            f"expected {version!r}, found {cargo_lock_version!r}"
        )

    python_package = ROOT / "video_sim" / "__init__.py"
    python_version_match = re.search(
        r'(?m)^__version__\s*=\s*"([^"]+)"',
        python_package.read_text(encoding="utf-8"),
    )
    python_version = python_version_match.group(1) if python_version_match else None
    if python_version != version:
        raise RuntimeError(
            f"Version mismatch in {python_package}: "
            f"expected {version!r}, found {python_version!r}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("tag", help="Release tag, for example v0.1.0")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify that committed source versions match the tag without editing files",
    )
    args = parser.parse_args()
    version = normalize_version(args.tag)

    if args.check:
        assert_versions(version)
    else:
        replace_versions(DESKTOP / "package.json", version, 1)
        replace_versions(DESKTOP / "package-lock.json", version, 2)
        replace_versions(DESKTOP / "src-tauri" / "tauri.conf.json", version, 1)
        update_cargo_toml(DESKTOP / "src-tauri" / "Cargo.toml", version)
        update_cargo_lock(DESKTOP / "src-tauri" / "Cargo.lock", version)
        update_python_package(ROOT / "video_sim" / "__init__.py", version)
    print(version)


if __name__ == "__main__":
    main()
