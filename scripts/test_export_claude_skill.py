"""Tests for scripts/export_claude_skill.py (stdlib unittest)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

import export_claude_skill as ex  # noqa: E402

URL = "https://github.com/WilliamRo/lyra"


class RewriteLinksTests(unittest.TestCase):
    def rw(self, text, file_rel="connectors/lyra-link/DESIGN.md", ref="main"):
        return ex.rewrite_links(text, file_rel, REPO, URL, ref)

    def test_link_leaving_the_skill_points_at_github(self):
        out, n = self.rw("See the [Lyra server](../../docs/DESIGN.md) design.")
        self.assertEqual(n, 1)
        self.assertEqual(out, f"See the [Lyra server]({URL}/blob/main/docs/DESIGN.md) design.")

    def test_directory_target_uses_tree_and_keeps_fragment_and_title(self):
        out, n = self.rw('[server](../../server "code") and [api](../../docs/API.md#5-delivery)')
        self.assertEqual(n, 2)
        self.assertIn(f'[server]({URL}/tree/main/server "code")', out)
        self.assertIn(f"[api]({URL}/blob/main/docs/API.md#5-delivery)", out)

    def test_links_inside_the_skill_and_absolute_links_are_unchanged(self):
        text = (
            "[cli](scripts/lyra_link.py) [skill](./SKILL.md) [top](#1-architecture) "
            "[site](https://example.org/x) [mail](mailto:a@b.c) [root](/abs/path)\n"
        )
        out, n = self.rw(text)
        self.assertEqual((out, n), (text, 0))

    def test_nested_file_resolves_relative_to_its_own_directory(self):
        out, n = self.rw("[d](../../../docs/DESIGN.md)", file_rel="connectors/lyra-link/scripts/README.md")
        self.assertEqual((out, n), (f"[d]({URL}/blob/main/docs/DESIGN.md)", 1))

    def test_fenced_code_and_links_outside_the_repo_are_left_alone(self):
        text = "```\n[x](../../docs/DESIGN.md)\n```\n[y](../../../../elsewhere.md)\n"
        out, n = self.rw(text)
        self.assertEqual((out, n), (text, 0))

    def test_custom_ref(self):
        out, _ = self.rw("[d](../../docs/DESIGN.md)", ref="v1.0.0")
        self.assertIn("/blob/v1.0.0/docs/DESIGN.md", out)

    def test_image_links_are_rewritten_too(self):
        out, n = self.rw("![diagram](../../docs/arch.svg)")
        self.assertEqual((out, n), (f"![diagram]({URL}/blob/main/docs/arch.svg)", 1))


class ExportTests(unittest.TestCase):
    def test_export_rewrites_design_link_and_copies_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = ex.export_skill(REPO, Path(tmp))
            design = (target / "DESIGN.md").read_text(encoding="utf-8")
            self.assertNotIn("](../../", design)
            self.assertIn(f"]({URL}/blob/main/docs/DESIGN.md)", design)
            self.assertTrue((target / "SKILL.md").is_file())
            self.assertTrue((target / "scripts" / "lyra_link.py").is_file())
            self.assertFalse(any(p.name == "__pycache__" for p in target.rglob("*")))
            stamp = (target / "EXPORTED_FROM.txt").read_text(encoding="utf-8")
            self.assertIn("Links outside the skill rewritten", stamp)

    def test_source_tree_is_not_modified(self):
        before = (REPO / "connectors" / "lyra-link" / "DESIGN.md").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            ex.export_skill(REPO, Path(tmp))
        after = (REPO / "connectors" / "lyra-link" / "DESIGN.md").read_text(encoding="utf-8")
        self.assertEqual(before, after)
        self.assertIn("](../../docs/DESIGN.md)", after)  # repo copy keeps the relative link


if __name__ == "__main__":
    unittest.main()
