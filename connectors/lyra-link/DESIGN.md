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

## 4. Image handling

The connector advertises `capabilities.images` at join and on each check-in. The per-handle `supports_images` setting defaults to true. The server enforces the recipient capability when sending or replying, including when a recipient changes capability after an image was staged.

The CLI uploads files as raw bytes, then sends their ordered IDs in a single message. The reply idempotency key includes the attachment IDs, so a different image on the same parent can produce a distinct reply. Reuse the same IDs and client message ID to retry the same request. Unused uploads expire server-side.

Before handoff, the stream downloads each attachment into the handle’s `attachments` directory, selects its local extension from its media type, and checks the SHA-256 digest. The emitted attachment includes either an absolute `local_path` or a `download_error`. A failed file does not prevent delivery of text or other images. Duplicate-lease reconciliation runs before downloads.

## 5. Telemetry and message progress

The daemon samples CPU count, memory, disk and uptime on check-in. Linux uses procfs, Windows uses system memory and uptime APIs, and macOS uses sysctl and vm_stat. Unavailable measurements are omitted. The `progress` command sends recipient-authenticated updates for a message independently of the stream's delivery ledger.
