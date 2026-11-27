# Deploying lyra-server

Lyra runs on any owner-controlled machine with Python 3.11 or newer. Nothing depends on a particular VPN, sync tool or operating-system directory. Production deployment is a separate, owner-approved step; the files here are examples.

## 1. Install

i. Copy `server/` to the host (any method) and install it into its own virtual environment outside synced folders:
   `python3 -m venv /opt/lyra/venv && /opt/lyra/venv/bin/pip install ./server`
ii. Choose a data directory on a local volume (never Dropbox, iCloud, OneDrive or Google Drive; the server refuses to start there).
iii. Create the administrator: `lyra-server init-admin --username <name>` (prompts for a password of at least 10 characters).
iv. Validate: `lyra-server check-config`.

## 2. Configuration

Set `LYRA_*` environment variables or put the same keys (lowercase, without the prefix) in a TOML file named by `LYRA_CONFIG`. Environment variables win.

| Key | Default | Notes |
| --- | --- | --- |
| `LYRA_BIND`, `LYRA_PORT` | `127.0.0.1`, `8740` | Off loopback, built-in TLS is required. |
| `LYRA_PUBLIC_URL` | unset | Required off loopback; the browser origin for cookies and `Origin` checks. Must be `https` unless loopback. |
| `LYRA_DATA_DIR` | platform user data directory | Database, backups. |
| `LYRA_TLS_CERT`, `LYRA_TLS_KEY` | unset | Built-in TLS (TLS 1.2+). |
| `LYRA_TRUST_PROXY_HEADERS` | `0` | Honor `X-Forwarded-Proto` and `X-Forwarded-For` from a loopback proxy only. |
| `LYRA_COOKIE_SECURE` | `auto` | `auto` sets `Secure` whenever TLS or an `https` public URL is configured. |
| `LYRA_ALLOW_PLAINTEXT_BIND` | `0` | Only for a private container network where TLS terminates at a proxy; never between machines. |
| `LYRA_CHECKIN_INTERVAL_SEC`, `LYRA_CHECKIN_TTL_SEC` | `15`, `45` | Presence. |
| `LYRA_MESSAGE_TTL_SEC` | `86400` | Undelivered messages fail after 24 hours. |
| `LYRA_INVITE_TTL_SEC` | `86400` | One-time invites expire after 24 hours. |
| `LYRA_REMEMBER_ME_DAYS`, `LYRA_SESSION_IDLE_HOURS` | `30`, `12` | Browser sessions. |

## 3. Transport Patterns

- **Built-in TLS:** set `LYRA_BIND` to the host address, `LYRA_TLS_CERT` and `LYRA_TLS_KEY`, and `LYRA_PUBLIC_URL=https://<name>:<port>`. Connectors with a private CA use `--ca-bundle`.
- **TLS reverse proxy on the same host** (Caddy, nginx, a tunnel or a VPN's HTTPS front end): keep `LYRA_BIND=127.0.0.1`, set `LYRA_PUBLIC_URL` to the public `https` origin and `LYRA_TRUST_PROXY_HEADERS=1`. Disable response buffering for `/api/v1/events` (SSE).
- **Loopback only:** for tests; reach it remotely with an SSH tunnel and set `LYRA_PUBLIC_URL` to the tunnel origin if it differs from the bind address.

## 4. Operations

- **Backup:** `lyra-server backup` writes a consistent copy to `<data>/backups/` and keeps the newest 14; `--out <file>` writes one file elsewhere. Schedule it with the host's scheduler.
- **Restore:** `lyra-server restore <file>` into an empty data directory (`--force` moves an existing database aside). Restart the server afterwards.
- **Password reset:** `lyra-server reset-password --username <name>` also signs out all browser sessions.

## 5. Examples

- [Home Mac mini with launchd](examples/home-mac-mini/README.md)
- [Linux with systemd and a TLS proxy](examples/linux-systemd/README.md)
