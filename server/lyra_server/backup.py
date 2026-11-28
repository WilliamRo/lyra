# =============================================================================
# backup.py: Consistent online backups and verified restores (stdlib only).
# =============================================================================

from datetime import datetime
import hashlib
import os
import re
import tempfile
from pathlib import Path
import shutil
import sqlite3


TABLES = ('users', 'principals', 'credentials', 'invites', 'pools', 'presence', 'conversations',
          'conversation_members', 'messages', 'delivery_attempts', 'reactions', 'events',
          'attachments', 'message_attachments')


def row_counts(path):
  conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
  try:
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {t: conn.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in TABLES if t in names}
  finally:
    conn.close()


def _assets(conn):
  if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachments'").fetchone():
    return conn.execute('SELECT id, storage_relpath, sha256 FROM attachments')
  return ()


def _asset_path(root, rel):
  if not re.fullmatch(r'[0-9a-f]{2}/[0-9a-f]+\.(?:png|jpg|gif|webp)', rel):
    raise ValueError('invalid attachment storage path in backup')
  path = (root / rel).resolve()
  path.relative_to(root.resolve())
  return path


def _verify(data, digest):
  if hashlib.sha256(data).hexdigest() != digest:
    raise ValueError('attachment backup checksum mismatch')


def backup(db_path, out=None, keep=14):
  """Copy a live WAL database with the sqlite3 backup API, then rotate."""
  db_path = Path(db_path)
  if not db_path.exists():
    raise FileNotFoundError(f'no database at {db_path}')
  if out:
    target = Path(out)
    rotate_dir = None
  else:
    rotate_dir = db_path.parent / 'backups'
    rotate_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    target = rotate_dir / f'lyra-{stamp}.sqlite'
  target.parent.mkdir(parents=True, exist_ok=True)
  if target.resolve() == db_path.resolve():
    raise ValueError('backup target must differ from the live database')
  fd, temp = tempfile.mkstemp(dir=target.parent)
  os.close(fd)
  src = sqlite3.connect(str(db_path))
  dst = sqlite3.connect(temp)
  try:
    # Keep the orphan sweeper from removing files between the snapshot and the copy.
    guard = sqlite3.connect(str(db_path), timeout=30)
    try:
      guard.execute('BEGIN IMMEDIATE')
      src.backup(dst)
      dst.execute('PRAGMA journal_mode=DELETE')
      dst.execute('CREATE TABLE backup_image_bytes (id INTEGER PRIMARY KEY, content BLOB NOT NULL)')
      assets = list(_assets(dst))
      bound = {r[0] for r in dst.execute('SELECT attachment_id FROM message_attachments')} if assets else set()
      def pack(aid, rel, digest):
        data = _asset_path(db_path.parent / 'attachments', rel).read_bytes()
        _verify(data, digest)
        dst.execute('INSERT INTO backup_image_bytes VALUES (?, ?)', (aid, data))
      for asset in assets:
        if asset[0] not in bound:
          pack(*asset)
    finally:
      guard.close()
    # Bound images are immutable. Copy them without blocking live writers.
    for asset in assets:
      if asset[0] in bound:
        pack(*asset)
    dst.commit()
    ok = dst.execute('PRAGMA integrity_check').fetchone()[0]
    if ok != 'ok':
      raise RuntimeError(f'backup integrity check failed: {ok}')
    dst.close()
    os.replace(temp, target)
  finally:
    dst.close()
    src.close()
    Path(temp).unlink(missing_ok=True)
  removed = []
  if rotate_dir and keep > 0:
    snaps = sorted(rotate_dir.glob('lyra-*.sqlite'))
    for old in snaps[:-keep]:
      old.unlink()
      removed.append(old.name)
  return {'backup': str(target), 'integrity': ok, 'rows': row_counts(target), 'rotated': removed}


def restore(src, db_path, force=False):
  """Restore into a data directory; refuses to overwrite unless forced."""
  src = Path(src)
  db_path = Path(db_path)
  conn = sqlite3.connect(f'file:{src}?mode=ro', uri=True)
  try:
    ok = conn.execute('PRAGMA integrity_check').fetchone()[0]
  finally:
    conn.close()
  if ok != 'ok':
    raise RuntimeError(f'source integrity check failed: {ok}')
  if db_path.exists() and not force:
    raise FileExistsError(f'{db_path} exists; pass --force to move it aside')
  if src.resolve() == db_path.resolve():
    raise ValueError('restore target must differ from the snapshot')
  db_path.parent.mkdir(parents=True, exist_ok=True)
  with tempfile.TemporaryDirectory(dir=db_path.parent) as work:
    staged = Path(work) / 'restore.sqlite'
    shutil.copy2(src, staged)
    staged_db = sqlite3.connect(str(staged))
    try:
      packed = staged_db.execute("SELECT 1 FROM sqlite_master WHERE name='backup_image_bytes'").fetchone()
      root = db_path.parent / 'attachments'
      for aid, rel, digest in _assets(staged_db):
        target = _asset_path(root, rel)
        row = staged_db.execute('SELECT content FROM backup_image_bytes WHERE id=?', (aid,)).fetchone() if packed else None
        if row is None:
          raise ValueError(f'snapshot has no file for attachment {aid}')
        _verify(row[0], digest)
        root.mkdir(mode=0o700, exist_ok=True)
        target.parent.mkdir(mode=0o700, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=work, delete=False) as image:
          image.write(row[0])
        os.replace(image.name, target)
      if packed:
        staged_db.execute('DROP TABLE backup_image_bytes')
        staged_db.commit()
        staged_db.execute('VACUUM')
    finally:
      staged_db.close()
    _install_restored(staged, db_path)
  return {'restored': str(db_path), 'rows': row_counts(db_path)}


def _install_restored(staged, db_path):
  if db_path.exists():
    aside = db_path.with_suffix(f'.replaced-{datetime.now().strftime("%Y%m%d-%H%M%S")}')
    shutil.move(str(db_path), str(aside))
    for ext in ('-wal', '-shm'):
      side = Path(str(db_path) + ext)
      if side.exists():
        side.unlink()
  os.chmod(staged, 0o600)
  os.replace(staged, db_path)
