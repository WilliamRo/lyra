# =============================================================================
# backup.py: Consistent online backups and verified restores (stdlib only).
# =============================================================================

from datetime import datetime
import os
from pathlib import Path
import shutil
import sqlite3


TABLES = ('users', 'principals', 'credentials', 'invites', 'pools', 'presence', 'conversations',
          'conversation_members', 'messages', 'delivery_attempts', 'reactions', 'events')


def row_counts(path):
  conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
  try:
    return {t: conn.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in TABLES}
  finally:
    conn.close()


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
  src = sqlite3.connect(str(db_path))
  dst = sqlite3.connect(str(target))
  try:
    src.backup(dst)
    ok = dst.execute('PRAGMA integrity_check').fetchone()[0]
  finally:
    dst.close()
    src.close()
  os.chmod(target, 0o600)
  if ok != 'ok':
    raise RuntimeError(f'backup integrity check failed: {ok}')
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
  if db_path.exists():
    if not force:
      raise FileExistsError(f'{db_path} exists; pass --force to move it aside')
    aside = db_path.with_suffix(f'.replaced-{datetime.now().strftime("%Y%m%d-%H%M%S")}')
    shutil.move(str(db_path), str(aside))
    for ext in ('-wal', '-shm'):
      side = Path(str(db_path) + ext)
      if side.exists():
        side.unlink()
  db_path.parent.mkdir(parents=True, exist_ok=True)
  shutil.copy2(src, db_path)
  os.chmod(db_path, 0o600)
  return {'restored': str(db_path), 'rows': row_counts(db_path)}
