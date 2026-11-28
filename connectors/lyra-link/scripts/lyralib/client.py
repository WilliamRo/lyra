# =============================================================================
# client.py: Stdlib HTTPS client for the Lyra agent API.
# =============================================================================

import ipaddress
import json
from pathlib import Path
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

from . import store


class LyraError(Exception):
  def __init__(self, status, code, message='', body=None):
    super().__init__(f'{status} {code}: {message}')
    self.status = status
    self.code = code
    self.message = message
    self.body = body or {}


def _loopback(host):
  if host in ('localhost', ''):
    return True
  try:
    return ipaddress.ip_address(host.strip('[]')).is_loopback
  except ValueError:
    return False


def check_url(url):
  """Encrypted transport between machines: plain http only to loopback."""
  u = urlsplit(url)
  if u.scheme not in ('http', 'https') or not u.netloc:
    raise ValueError(f'bad server URL {url!r}')
  if u.scheme == 'http' and not _loopback(u.hostname or ''):
    raise ValueError('refusing plain http to a non-loopback server; use https')
  return url.rstrip('/')


class Client:
  def __init__(self, server_url, token=None, ca_bundle=None, timeout=35.0):
    self.base = check_url(server_url)
    self.token = token
    self.timeout = timeout
    self.ctx = None
    if self.base.startswith('https://'):
      self.ctx = ssl.create_default_context(cafile=ca_bundle) if ca_bundle else \
        ssl.create_default_context()
    handlers = [urllib.request.HTTPSHandler(context=self.ctx)] if self.ctx else []
    if _loopback(urlsplit(self.base).hostname or ''):
      handlers.append(urllib.request.ProxyHandler({}))  # never route loopback via a proxy
    self.opener = urllib.request.build_opener(*handlers)

  def request(self, method, path, body=None, timeout=None, retries=2, *, raw_body=None,
              headers=None, binary=False):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    if raw_body is not None:
      data = raw_body
    last = None
    for attempt in range(retries + 1):
      req = urllib.request.Request(self.base + path, data=data, method=method)
      req.add_header('Content-Type', 'application/json')
      req.add_header('Accept', 'image/*' if binary else 'application/json')
      for name, value in (headers or {}).items():
        req.add_header(name, value)
      if self.token:
        req.add_header('Authorization', f'Bearer {self.token}')
      try:
        with self.opener.open(req, timeout=timeout or self.timeout) as r:
          raw = r.read()
          if binary:
            return raw
          return json.loads(raw) if raw else {}
      except urllib.error.HTTPError as e:
        raw = e.read()
        try:
          b = json.loads(raw) if raw else {}
        except ValueError:
          b = {}
        raise LyraError(e.code, b.get('error', 'http_error'), b.get('message', ''), b) from None
      except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
        last = e
        if attempt < retries:
          time.sleep(0.5 * (attempt + 1))
    raise LyraError(0, 'unreachable', str(last))

  # --- agent API -----------------------------------------------------------

  def join(self, payload):
    return self.request('POST', '/api/v1/join', payload)

  def checkin(self, payload):
    return self.request('POST', '/api/v1/checkin', payload, timeout=15, retries=0)

  def me(self):
    return self.request('GET', '/api/v1/me')

  def teammates(self):
    return self.request('GET', '/api/v1/teammates')

  def claim(self, wait=20):
    return self.request('POST', f'/api/v1/deliveries/claim?wait={int(wait)}',
                        timeout=wait + 15, retries=0)

  def ack(self, lease_id, outcome, reason=None):
    return self.request('POST', f'/api/v1/deliveries/{lease_id}/{outcome}',
                        {'reason': reason} if reason else {})

  def upload_attachment(self, path):
    path = Path(path)
    result = self.request('POST', '/api/v1/attachments', raw_body=path.read_bytes(), retries=0,
                          headers={'X-Filename': quote(path.name, safe=''),
                                   'Content-Type': 'application/octet-stream'})
    return result['attachment']

  def download_attachment(self, attachment_id, dest_path):
    data = self.request('GET', f'/api/v1/attachments/{int(attachment_id)}', binary=True)
    store.atomic_write_bytes(dest_path, data)

  def send(self, to, body, mode=None, client_msg_id=None, attachment_ids=None):
    return self.request('POST', '/api/v1/messages',
                        {'to': to, 'body': body, 'mode': mode, 'client_msg_id': client_msg_id,
                         'attachment_ids': attachment_ids or []})

  def reply(self, mid, body, mode=None, client_msg_id=None, attachment_ids=None):
    return self.request('POST', f'/api/v1/messages/{int(mid)}/reply',
                        {'body': body, 'mode': mode, 'client_msg_id': client_msg_id,
                         'attachment_ids': attachment_ids or []})

  def progress(self, message_id, phase, summary=None, bullets=None):
    return self.request('PUT', f'/api/v1/messages/{int(message_id)}/progress',
                        {'phase': phase, 'summary': summary, 'bullets': bullets})

  def react(self, mid, emoji, remove=False):
    from urllib.parse import quote
    return self.request('DELETE' if remove else 'PUT',
                        f'/api/v1/messages/{int(mid)}/reactions/{quote(emoji, safe="")}')

  def history(self, with_, limit=20):
    from urllib.parse import quote
    return self.request('GET', f'/api/v1/history?with={quote(with_)}&limit={int(limit)}')
