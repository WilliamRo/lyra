# =============================================================================
# events.py: API errors, the transition-only event log, and wake-ups.
# =============================================================================

import threading

from .db import dumps, loads


class ApiError(Exception):
  """An error with an HTTP status and a stable machine-readable code."""

  def __init__(self, status, code, message='', **extra):
    super().__init__(message or code)
    self.status = status
    self.code = code
    self.message = message or code
    self.extra = extra

  def body(self):
    return {'error': self.code, 'message': self.message, **self.extra}


class EventLog:
  """Append events inside caller transactions; wake SSE readers after commit."""

  def __init__(self, db, clock):
    self.db = db
    self.clock = clock
    self.cv = threading.Condition()

  def append(self, conn, type_, **payload):
    conn.execute(
      'INSERT INTO events(ts, type, payload) VALUES (?, ?, ?)',
      (self.clock(), type_, dumps(payload)),
    )

  def notify(self):
    with self.cv:
      self.cv.notify_all()

  def latest_id(self):
    row = self.db.one('SELECT MAX(id) FROM events')
    return int(row[0] or 0)

  def since(self, last_id, limit=200):
    rows = self.db.all(
      'SELECT id, ts, type, payload FROM events WHERE id > ? ORDER BY id LIMIT ?',
      (int(last_id), int(limit)),
    )
    return [{'id': r['id'], 'ts': r['ts'], 'type': r['type'], 'payload': loads(r['payload'], {})}
            for r in rows]

  def wait(self, last_id, timeout):
    """Block until an event newer than last_id exists or timeout passes."""
    with self.cv:
      if self.latest_id() > last_id:
        return True
      self.cv.wait(timeout)
    return self.latest_id() > last_id

  def prune(self, conn, before_ts):
    conn.execute('DELETE FROM events WHERE ts < ?', (before_ts,))
