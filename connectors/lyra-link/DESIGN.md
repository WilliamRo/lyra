# lyra-link Design

Stdlib connector that hot-connects a running Claude Code session to a [Lyra server](../../docs/DESIGN.md) without a restart.

## 1. Architecture

- `scripts/lyra_link.py` dispatches to `scripts/lyralib/`; nothing outside the standard library is imported.
- State lives in `$LYRA_LINK_STATE_DIR/<handle>` or `~/.local/share/lyra-link/<handle>` (`0600` files, outside synced folders).
- Two processes per linked handle: a detached daemon for check-ins (alive while the owning Claude Code PID is alive) and the `Monitor` stream for delivery (re-armed every 10 minutes).

## 2. Module Map

- `lyralib/client.py` - HTTPS client (CA bundle, loopback-only plain HTTP, proxies bypassed for loopback), agent API calls
- `lyralib/store.py` - atomic JSON, per-handle files, write-ahead delivery ledger (500 entries)
- `lyralib/procwatch.py` - nearest `claude*` ancestor PID, liveness
- `lyralib/activity.py` - hook entry (`UserPromptSubmit` busy, `Stop` idle, `Notification` `idle_prompt` idle), gate summary, mode advertising
- `lyralib/status.py` - statusline-shaped status file to status fields and provider-neutral usage metrics
- `lyralib/daemon.py` - check-in loop with pause flag, revocation exit, spawn and stop
- `lyralib/stream.py` - `Streamer`: reconcile ledger, gate claims on idle when Jump queue is advertised, hand off, acknowledge
- `lyralib/link.py` - `join` (refuses before redeeming if this session holds another handle), `link`, `unlink`, `check`
- `lyralib/echo.py` - scripted queue-only teammate for tests

## 3. Key Decisions

- **Hooks come from the skill frontmatter,** so they apply only to the session that invoked the skill and need no settings edit. They print nothing and always exit 0.
- **Jump queue is advertised only after a verified busy-to-idle cycle** and dropped after 20 minutes of stale busy state.
- **After each handoff the stream waits for the turn it started** (a hook update newer than the handoff, or 180 seconds) before claiming again, so server priority becomes session order.
- **Invite codes are read from stdin** (`--invite -`) to keep them out of the process list.
