# =============================================================================
# db.py: Single-connection SQLite (WAL) with a process lock and migrations.
# =============================================================================

from contextlib import contextmanager
from importlib import resources
import json
import os
from pathlib import Path
import sqlite3
import threading


SCHEMA_VERSION = 1


def _schema_sql():
  return resources.files('lyra_server').joinpath('schema.sql').read_text('utf-8')


class Database:
  """Serialize all access through one connection; every call is short."""

  def __init__(self, path):
    self.path = Path(path)
    self.path.parent.mkdir(parents=True, exist_ok=True)
    try:
      os.chmod(self.path.parent, 0o700)
    except OSError:
      pass
    self.lock = threading.RLock()
    self.conn = sqlite3.connect(
      str(self.path), check_same_thread=False, isolation_level=None, timeout=30,
    )
    self.conn.row_factory = sqlite3.Row
    self.conn.execute('PRAGMA journal_mode=WAL')
    self.conn.execute('PRAGMA foreign_keys=ON')
    self.conn.execute('PRAGMA synchronous=NORMAL')
    try:
      os.chmod(self.path, 0o600)
    except OSError:
      pass
    self._migrate()

  # --- schema --------------------------------------------------------------

  def _version(self):
    try:
      row = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
      return int(row[0]) if row else 0
    except sqlite3.OperationalError:
      return 0

  def _migrate(self):
    with self.lock:
      v = self._version()
      if v == 0:
        self.conn.executescript('BEGIN;' + _schema_sql() + 'COMMIT;')
        self.conn.execute(
          "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
          (str(SCHEMA_VERSION),),
        )
      elif v > SCHEMA_VERSION:
        raise RuntimeError(f'database schema {v} is newer than this server ({SCHEMA_VERSION})')

  # --- access --------------------------------------------------------------

  @contextmanager
  def tx(self):
    """Exclusive write transaction; yields the connection."""
    with self.lock:
      self.conn.execute('BEGIN IMMEDIATE')
      try:
        yield self.conn
      except BaseException:
        self.conn.execute('ROLLBACK')
        raise
      else:
        self.conn.execute('COMMIT')

  def one(self, sql, args=()):
    with self.lock:
      return self.conn.execute(sql, args).fetchone()

  def all(self, sql, args=()):
    with self.lock:
      return self.conn.execute(sql, args).fetchall()

  def close(self):
    with self.lock:
      self.conn.close()


def loads(text, default=None):
  if not text:
    return default
  try:
    return json.loads(text)
  except ValueError:
    return default


def dumps(value):
  return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
