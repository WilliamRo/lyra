# Example: home Mac mini with launchd

One way to host Lyra on a macOS machine. Replace `<user>` and paths; keep the data directory out of Dropbox and iCloud.

## 1. Steps

i. `python3 -m venv ~/lyra/venv && ~/lyra/venv/bin/pip install <path to lyra/server>`
ii. `LYRA_DATA_DIR="$HOME/Library/Application Support/lyra-server" ~/lyra/venv/bin/lyra-server init-admin --username <name>`
iii. Put the settings in `~/lyra/lyra.toml` (see the template below), then copy `com.lyra.server.plist` to `~/Library/LaunchAgents/`, edit the paths, and run `launchctl load ~/Library/LaunchAgents/com.lyra.server.plist`.
iv. Pick a transport from the [deploy guide](../../README.md): built-in TLS with a certificate for the host name, or a same-host HTTPS front end (for example a VPN's HTTPS serve feature) with `LYRA_BIND=127.0.0.1` and `LYRA_TRUST_PROXY_HEADERS=1`.
v. Schedule `lyra-server backup` daily with a second launchd job or `cron`.

## 2. Settings Template

```toml
bind = "127.0.0.1"
port = 8740
public_url = "https://<home-host-name>"
data_dir = "/Users/<user>/Library/Application Support/lyra-server"
trust_proxy_headers = true
```
