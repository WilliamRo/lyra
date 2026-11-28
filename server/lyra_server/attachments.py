"""Disk-backed images. Only authenticated attachment routes expose their contents."""

import hashlib
import os
import re
import secrets
import tempfile

from .events import ApiError


def image_type(data):
  if data.startswith(b'\x89PNG\r\n\x1a\n'):
    return 'image/png', 'png'
  if data.startswith(b'\xff\xd8\xff'):
    return 'image/jpeg', 'jpg'
  if data.startswith((b'GIF87a', b'GIF89a')):
    return 'image/gif', 'gif'
  if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
    return 'image/webp', 'webp'
  raise ApiError(415, 'unsupported_media_type', 'expected a PNG, JPEG, GIF, or WebP image')


def safe_filename(name, ext):
  leaf = (name or '').replace('\\', '/').rsplit('/', 1)[-1]
  stem = leaf.rsplit('.', 1)[0] if '.' in leaf else leaf
  stem = re.sub(r'[^\w .()-]', '_', stem)[:120].strip(' .')
  return f'{stem or "image"}.{ext}'


def attachment_view(row):
  return {**{k: row[k] for k in ('id', 'mime_type', 'filename', 'size_bytes', 'sha256',
                                 'created_at')}, 'url': f'/api/v1/attachments/{row["id"]}'}


class AttachmentMixin:
  def upload_attachment(self, uploader, data, filename=None):
    if not data:
      raise ApiError(422, 'empty_attachment', 'image is empty')
    if len(data) > self.settings.max_attachment_bytes:
      raise ApiError(413, 'attachment_too_large', 'image exceeds the upload limit')
    mime, ext = image_type(data)
    filename = safe_filename(filename, ext)
    digest = hashlib.sha256(data).hexdigest()
    token = secrets.token_hex(24)
    rel = f'{token[:2]}/{token}.{ext}'
    root = self.settings.attachments_path
    root.mkdir(mode=0o700, exist_ok=True)
    path = root / rel
    path.parent.mkdir(mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
      with os.fdopen(fd, 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
      with self.db.tx() as c:
        os.replace(tmp, path)
        cur = c.execute('INSERT INTO attachments(uploader_id, sha256, mime_type, filename, '
                        'size_bytes, storage_relpath, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        (uploader['id'], digest, mime, filename, len(data), rel, self.now()))
        row = c.execute('SELECT * FROM attachments WHERE id=?', (cur.lastrowid,)).fetchone()
    except BaseException:
      path.unlink(missing_ok=True)
      raise
    finally:
      if os.path.exists(tmp):
        os.unlink(tmp)
    return attachment_view(row)

  def read_attachment(self, viewer, aid, include_all=False):
    with self.db.lock:
      row = self.db.one('SELECT a.*, m.conversation_id FROM attachments a '
                        'LEFT JOIN message_attachments ma ON ma.attachment_id=a.id '
                        'LEFT JOIN messages m ON m.id=ma.message_id WHERE a.id=?', (aid,))
      if not row:
        raise ApiError(404, 'no_attachment', 'unknown attachment')
      cid = row['conversation_id']
      allowed = row['uploader_id'] == viewer['id'] if cid is None else (
        include_all or self._is_member(self.db.conn, cid, viewer['id']))
      if not allowed:
        raise ApiError(403, 'attachment_forbidden', 'attachment is private')
      return row, (self.settings.attachments_path / row['storage_relpath']).read_bytes()

  def validate_attachment_ids(self, ids):
    if ids is None:
      return []
    if (not isinstance(ids, list) or len(ids) > self.settings.max_attachments_per_message
        or any(type(i) is not int or not 0 < i < 2**63 for i in ids) or len(set(ids)) != len(ids)):
      raise ApiError(422, 'bad_attachment_ids', 'expected an ordered list of unique image IDs within the limit')
    return ids

  def bind_attachments(self, c, ids, mid, sender_id):
    for position, aid in enumerate(ids):
      row = c.execute('SELECT uploader_id FROM attachments WHERE id=?', (aid,)).fetchone()
      if not row:
        raise ApiError(404, 'no_attachment', 'unknown attachment')
      if row['uploader_id'] != sender_id:
        raise ApiError(403, 'attachment_forbidden', 'only the uploader can send this image')
      if c.execute('SELECT 1 FROM message_attachments WHERE attachment_id=?', (aid,)).fetchone():
        raise ApiError(409, 'attachment_in_use', 'image already belongs to a message')
      c.execute('INSERT INTO message_attachments VALUES (?, ?, ?)', (mid, aid, position))

  def message_attachments(self, mid):
    rows = self.db.all('SELECT a.* FROM message_attachments ma JOIN attachments a '
                       'ON ma.attachment_id=a.id WHERE ma.message_id=? ORDER BY ma.position', (mid,))
    return [attachment_view(row) for row in rows]

  def excerpt(self, row, limit):
    if row['body'].strip():
      return row['body'][:limit]
    count = self.db.one('SELECT COUNT(*) FROM message_attachments WHERE message_id=?', (row['id'],))[0]
    return '[Image]' if count == 1 else f'[Image x{count}]' if count else ''

  def sweep_orphan_attachments(self, c, now):
    rows = c.execute('SELECT id, storage_relpath FROM attachments a WHERE created_at < ? '
                     'AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id=a.id)',
                     (now - self.settings.orphan_attachment_ttl_sec,)).fetchall()
    for row in rows:
      try:
        (self.settings.attachments_path / row['storage_relpath']).unlink(missing_ok=True)
      except OSError:
        # A file in use on Windows can be retried on the next sweep.
        continue
      c.execute('DELETE FROM attachments WHERE id=?', (row['id'],))
