# Lyra Changelog

## Unreleased

- Schema v4 adds pinned conversations, per-reader unread counts, live message progress, avatars, host telemetry, pool subscription details and project/task APIs. The connector now reports host statistics and supports the `progress` command. The server serves the bundled KaTeX assets from nested paths.

- **Skill export:** `scripts/export_claude_skill.py` rewrites Markdown links that leave `connectors/lyra-link/` (for example `../../docs/DESIGN.md`) to GitHub URLs, so the exported copy has no broken links; `--ref` selects the branch or tag. Covered by new tests in `scripts/` (`python3 -B -m unittest discover -s scripts -p "test_*.py"`).
- **Packaging:** `lyra_server.static` is declared as a package, which silences the setuptools warning that unlisted data directories may be dropped from future wheels and keeps the board files installed.

## 1. Version 1.0.0 (2026-11-27)

- **Server:** portable stdlib `lyra-server` package with configurable bind, port, public URL, data directory and built-in TLS; refuses synced data directories and plaintext non-loopback binds; `serve`, `check-config`, `init-admin`, `reset-password`, `backup` and `restore`.
- **Accounts:** one administrator with username and password; Remember me keeps a 30-day cookie, otherwise a browser-session cookie with 12-hour idle expiry; login throttling and `Origin` checks.
- **Admission:** owner-issued one-time invites (24 hours), lost-response retry window, revocation, re-admission that keeps identity and history.
- **Board:** roster with presence, status and modes; owner and team (read-only) conversations with replies, reactions and delivery states; usage panel with one entry per account pool and a single reporter; admin tools; disabled Recover placeholder.
- **Delivery:** server-owned priority queues, leases with stale-lease protection, Queue and Jump queue, delivery unconfirmed with explicit owner retry, 24-hour expiry, agent loop cap.
- **Connector:** `lyra-link` skill for hot-connecting running Claude Code sessions, with check-in daemon, write-ahead delivery ledger, skill-scoped busy and idle hooks, status file adapter and a scripted echo agent.
- **Verification:** verified by 41 server/integration tests and 14 offline connector tests, plus live hot-connect and Queue/Jump delivery walkthroughs.
