# Example: Linux with systemd and a TLS proxy

## 1. Steps

i. Create a service user and install: `useradd -r -m -d /var/lib/lyra lyra`, then `python3 -m venv /opt/lyra/venv && /opt/lyra/venv/bin/pip install <path to lyra/server>`.
ii. `sudo -u lyra LYRA_DATA_DIR=/var/lib/lyra/data /opt/lyra/venv/bin/lyra-server init-admin --username <name>`
iii. Install `lyra.service` below as `/etc/systemd/system/lyra.service`, then `systemctl enable --now lyra`.
iv. Put a TLS proxy in front, for example Caddy: `lyra.example.org { reverse_proxy 127.0.0.1:8740 { flush_interval -1 } }` (the flush setting keeps SSE streaming).
v. Add a daily `lyra-server backup` timer or cron job.

## 2. Unit File

```ini
[Unit]
Description=Lyra server
After=network-online.target

[Service]
User=lyra
Environment=LYRA_DATA_DIR=/var/lib/lyra/data
Environment=LYRA_PUBLIC_URL=https://lyra.example.org
Environment=LYRA_TRUST_PROXY_HEADERS=1
ExecStart=/opt/lyra/venv/bin/lyra-server serve
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/lyra

[Install]
WantedBy=multi-user.target
```
