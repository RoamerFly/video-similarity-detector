#!/usr/bin/env python3
"""Synchronize desktop package versions from a release tag."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("tag", help="Release tag, for example v0.1.0")
    args = parser.parse_args()
    version = normalize_version(args.tag)

    replace_versions(DESKTOP / "package.json", version, 1)
    replace_versions(DESKTOP / "package-lock.json", version, 2)
    replace_versions(DESKTOP / "src-tauri" / "tauri.conf.json", version, 1)
    update_cargo_toml(DESKTOP / "src-tauri" / "Cargo.toml", version)
    print(version)


if __name__ == "__main__":
    main()
