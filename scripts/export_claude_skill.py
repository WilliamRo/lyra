#!/usr/bin/env python3
"""Export connectors/lyra-link cleanly into a workspace .claude/skills/lyra-link/ directory."""

from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_URL = "https://github.com/WilliamRo/lyra"


def _git_head(repo_root: Path) -> str:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out or "unknown"
    except Exception:
        return "unknown"


def export_skill(repo_root: Path, workspace: Path) -> Path:
    src = repo_root / "connectors" / "lyra-link"
    if not (src / "SKILL.md").is_file():
        raise FileNotFoundError(f"Missing canonical skill at {src}")

    target_dir = workspace / ".claude" / "skills" / "lyra-link"
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    if target_dir.exists():
        shutil.rmtree(target_dir)

    ignore = shutil.ignore_patterns(
        "__pycache__", "*.py[cod]", ".pytest_cache", ".git*", ".DS_Store"
    )
    shutil.copytree(src, target_dir, ignore=ignore)

    stamp = (
        f"Exported from: {REPO_URL} (connectors/lyra-link)\n"
        f"Commit: {_git_head(repo_root)}\n"
        f"Date: {dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
        "Do not add .git metadata inside synced workspaces.\n"
        "Make connector changes in the Git repository and re-run export_claude_skill.py.\n"
    )
    (target_dir / "EXPORTED_FROM.txt").write_text(stamp, encoding="utf-8")
    return target_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Export connectors/lyra-link into <workspace>/.claude/skills/lyra-link/"
    )
    parser.add_argument("workspace", help="Path to target workspace root")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent
    workspace = Path(os.path.expanduser(args.workspace)).resolve()
    target = export_skill(repo_root, workspace)
    print(f"Exported lyra-link skill to {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
