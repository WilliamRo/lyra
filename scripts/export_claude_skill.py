#!/usr/bin/env python3
"""Export connectors/lyra-link cleanly into a workspace .claude/skills/lyra-link/ directory."""

from __future__ import annotations

import argparse
import datetime as dt
import os
import posixpath
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_URL = "https://github.com/WilliamRo/lyra"
SKILL_REL = "connectors/lyra-link"

# Inline Markdown links and images: [text](target "optional title")
LINK_RE = re.compile(r'(!?\[[^\]\n]*\])\(([^)\s]+)((?:\s+"[^"\n]*")?)\)')
FENCE_RE = re.compile(r"^(```|~~~)")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


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


def _repo_target(href: str, file_rel: str) -> tuple[str, str] | None:
    """Return (repo-relative path, #fragment) when href leaves the skill directory."""
    if not href or href.startswith(("#", "/")) or SCHEME_RE.match(href):
        return None
    path, sep, frag = href.partition("#")
    if not path:
        return None
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(file_rel), path))
    if resolved == ".." or resolved.startswith("../"):
        return None  # points outside the repository; leave it alone
    if resolved == SKILL_REL or resolved.startswith(SKILL_REL + "/"):
        return None  # stays inside the exported skill, so it still resolves
    return resolved, sep + frag


def rewrite_links(text: str, file_rel: str, repo_root: Path, repo_url: str, ref: str) -> tuple[str, int]:
    """Point links that escape the skill at the repository on GitHub.

    The exported copy lives outside the repository (for example in
    <workspace>/.claude/skills/lyra-link/), so a relative link such as
    ../../docs/DESIGN.md would otherwise resolve to a missing file.
    Fenced code blocks are left untouched.
    """
    out: list[str] = []
    count = 0
    in_fence = False

    def sub(m: re.Match) -> str:
        nonlocal count
        target = _repo_target(m.group(2), file_rel)
        if target is None:
            return m.group(0)
        path, frag = target
        kind = "tree" if (repo_root / path).is_dir() else "blob"
        count += 1
        return f"{m.group(1)}({repo_url}/{kind}/{ref}/{path}{frag}{m.group(3)})"

    for line in text.splitlines(keepends=True):
        if FENCE_RE.match(line.lstrip()):
            in_fence = not in_fence
            out.append(line)
            continue
        out.append(line if in_fence else LINK_RE.sub(sub, line))
    return "".join(out), count


def export_skill(repo_root: Path, workspace: Path, ref: str = "main") -> Path:
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

    rewritten = 0
    for md in sorted(target_dir.rglob("*.md")):
        file_rel = posixpath.join(SKILL_REL, md.relative_to(target_dir).as_posix())
        text = md.read_text(encoding="utf-8")
        new, n = rewrite_links(text, file_rel, repo_root, REPO_URL, ref)
        if n:
            md.write_text(new, encoding="utf-8")
            rewritten += n

    stamp = (
        f"Exported from: {REPO_URL} (connectors/lyra-link)\n"
        f"Commit: {_git_head(repo_root)}\n"
        f"Links outside the skill rewritten to {REPO_URL}/blob/{ref}/: {rewritten}\n"
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
    parser.add_argument(
        "--ref",
        default="main",
        help="Git ref used for links that point outside the skill (default: main)",
    )
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent
    workspace = Path(os.path.expanduser(args.workspace)).resolve()
    target = export_skill(repo_root, workspace, ref=args.ref)
    print(f"Exported lyra-link skill to {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
