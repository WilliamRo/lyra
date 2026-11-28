# =============================================================================
# messaging.py: Conversations, messages, reactions, and the delivery queue.
# =============================================================================

import secrets
import threading
import time
import unicodedata

from .db import dumps, loads
from .events import ApiError


PRIORITY = {'queue': 0, 'jump': 1}
FINAL_STATES = ('delivered', 'failed')


def valid_emoji(emoji):
  e = str(emoji or '').strip()
  if not e or len(e.encode('utf-8')) > 32:
    return None
  if any(unicodedata.category(ch)[0] in ('C', 'Z') and ch not in '‍️' for ch in e):
    return None
  return e


class MessagingMixin:

  def _init_messaging(self):
    self.delivery_cv = threading.Condition()

  def delivery_cv_notify(self):
    with self.delivery_cv:
      self.delivery_cv.notify_all()

  # --- conversations -------------------------------------------------------

  def _principal(self, c, pid):
    return c.execute('SELECT * FROM principals WHERE id=?', (pid,)).fetchone()

  def _conversation_for(self, c, a, b, now):
    key = f'{min(a["id"], b["id"])}:{max(a["id"], b["id"])}'
    row = c.execute('SELECT * FROM conversations WHERE dm_pair_key=?', (key,)).fetchone()
    if row:
      return row
    kind = 'owner_agent' if 'owner' in (a['kind'], b['kind']) else 'agent_agent'
    cur = c.execute('INSERT INTO conversations(kind, dm_pair_key, created_at) VALUES (?, ?, ?)',
                    (kind, key, now))
    for p in (a, b):
      c.execute('INSERT INTO conversation_members(conversation_id, principal_id) VALUES (?, ?)',
                (cur.lastrowid, p['id']))
    return c.execute('SELECT * FROM conversations WHERE id=?', (cur.lastrowid,)).fetchone()

  def _is_member(self, c, conv_id, pid):
    return c.execute('SELECT 1 FROM conversation_members WHERE conversation_id=? AND principal_id=?',
                     (conv_id, pid)).fetchone() is not None

  def resolve_recipient(self, c, to):
    """Accept a principal id, an agent handle, or 'owner'."""
    if isinstance(to, int) or (isinstance(to, str) and to.isdigit()):
      row = self._principal(c, int(to))
    else:
      row = c.execute("SELECT * FROM principals WHERE handle=? AND status='admitted'",
                      (str(to or '').strip().lower(),)).fetchone()
    if not row:
      raise ApiError(404, 'no_recipient', 'unknown recipient')
    if row['status'] != 'admitted':
      raise ApiError(409, 'recipient_not_admitted', 'recipient is revoked')
    return row

  # --- send and reply ------------------------------------------------------

  def send(self, sender, to, body, mode=None, client_msg_id=None, reply_to_id=None,
           attachment_ids=None):
    """Sender always comes from the credential, never from the request body."""
    body = str(body or '')
    ids = self.validate_attachment_ids(attachment_ids)
    if not body.strip() and not ids:
      raise ApiError(422, 'empty_body', 'message body is empty')
    if len(body) > self.settings.max_message_chars:
      raise ApiError(413, 'body_too_long', 'message is too long')
    client_msg_id = (str(client_msg_id)[:64] if client_msg_id else None)
    now = self.now()
    with self.db.tx() as c:
      if client_msg_id:
        dup = c.execute('SELECT id FROM messages WHERE sender_id=? AND client_msg_id=?',
                        (sender['id'], client_msg_id)).fetchone()
        if dup:
          return {'message': self.message_view(dup['id'], c=c), 'duplicate': True}
      if reply_to_id is not None:
        orig = c.execute('SELECT * FROM messages WHERE id=?', (reply_to_id,)).fetchone()
        if not orig:
          raise ApiError(404, 'no_message', 'unknown message')
        conv = c.execute('SELECT * FROM conversations WHERE id=?',
                         (orig['conversation_id'],)).fetchone()
        if not self._is_member(c, conv['id'], sender['id']):
          if sender['kind'] == 'owner' and conv['kind'] == 'agent_agent':
            raise ApiError(403, 'read_only',
                           'agent-to-agent conversations are read-only for the owner')
          raise ApiError(403, 'not_member', 'you are not in this conversation')
        other = c.execute('SELECT principal_id FROM conversation_members WHERE conversation_id=? '
                          'AND principal_id != ?', (conv['id'], sender['id'])).fetchone()
        recipient = self._principal(c, other['principal_id'])
        if recipient['status'] != 'admitted':
          raise ApiError(409, 'recipient_not_admitted', 'recipient is revoked')
      else:
        recipient = self.resolve_recipient(c, to)
        if recipient['id'] == sender['id']:
          raise ApiError(422, 'self_message', 'cannot message yourself')
        conv = self._conversation_for(c, sender, recipient, now)
      if sender['kind'] == 'owner' and conv['kind'] == 'agent_agent':
        raise ApiError(403, 'read_only', 'agent-to-agent conversations are read-only for the owner')

      # i. Mode must be one the recipient currently advertises.
      mode = (mode or 'queue').lower()
      if mode not in PRIORITY:
        raise ApiError(422, 'bad_mode', 'mode must be queue or jump')
      if recipient['kind'] == 'agent':
        if ids and not self.recipient_supports_images(recipient['id']):
          raise ApiError(422, 'recipient_no_images', 'recipient does not support image attachments')
        modes = self.recipient_modes(recipient['id'])
        if mode not in modes:
          raise ApiError(422, 'mode_unsupported', f'recipient supports only {modes}',
                         supported=modes)
      else:
        mode = 'queue'

      # ii. Loop guard on agent-to-agent traffic.
      if conv['kind'] == 'agent_agent':
        n = c.execute('SELECT COUNT(*) FROM messages WHERE conversation_id=? AND created_at > ?',
                      (conv['id'], now - 3600)).fetchone()[0]
        if n >= self.settings.agent_rate_per_hour:
          raise ApiError(429, 'agent_rate_limited',
                         f'agent-to-agent limit of {self.settings.agent_rate_per_hour} '
                         'messages per hour reached; ask the owner')

      # iii. The owner reads on the board, so owner-bound messages are delivered at once.
      to_owner = recipient['kind'] == 'owner'
      cur = c.execute(
        'INSERT INTO messages(conversation_id, sender_id, recipient_id, body, reply_to_id, mode, '
        'priority, state, client_msg_id, created_at, delivered_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (conv['id'], sender['id'], recipient['id'], body, reply_to_id, mode, PRIORITY[mode],
         'delivered' if to_owner else 'waiting', client_msg_id, now, now if to_owner else None),
      )
      self.bind_attachments(c, ids, cur.lastrowid, sender['id'])
      if sender['kind'] == 'agent' and (reply_to_id is not None or to_owner):
        active = c.execute("""SELECT p.message_id FROM message_progress p JOIN messages m
            ON m.id=p.message_id WHERE m.conversation_id=? AND m.recipient_id=? AND p.phase!='done'""",
                           (conv['id'], sender['id'])).fetchall()
        for row in active:
          c.execute("UPDATE message_progress SET phase='done', updated_at=? WHERE message_id=?", (now, row[0]))
          self.events.append(c, 'message_progress', id=row[0], conversation_id=conv['id'], phase='done')
      self.events.append(c, 'message', id=cur.lastrowid, conversation_id=conv['id'],
                         state='delivered' if to_owner else 'waiting')
      view = self.message_view(cur.lastrowid, c=c)
    self.events.notify()
    if not to_owner:
      self.delivery_cv_notify()
    return {'message': view, 'duplicate': False}

  def reply(self, sender, message_id, body, mode=None, client_msg_id=None, attachment_ids=None):
    return self.send(sender, None, body, mode=mode, client_msg_id=client_msg_id,
                     reply_to_id=int(message_id), attachment_ids=attachment_ids)

  def set_progress(self, actor, mid, data):
    phase = data.get('phase')
    if phase not in ('thinking', 'working', 'done'):
      raise ApiError(422, 'bad_progress', 'unknown progress phase')
    summary = data.get('summary')
    if summary is not None and not isinstance(summary, str):
      raise ApiError(422, 'bad_progress', 'summary must be text')
    summary = summary[:240] if summary else None
    bullets = data.get('bullets')
    if bullets is not None:
      if not isinstance(bullets, list) or len(bullets) > 12:
        raise ApiError(422, 'bad_progress', 'expected at most 12 bullets')
      cleaned = []
      for b in bullets:
        if (not isinstance(b, dict) or not isinstance(b.get('text'), str) or not b['text'].strip()
            or b.get('state') not in ('done', 'active', 'pending')):
          raise ApiError(422, 'bad_progress', 'invalid progress bullet')
        cleaned.append({'text': b['text'][:200], 'state': b['state']})
      bullets = cleaned
    now = self.now()
    with self.db.tx() as c:
      m = c.execute('SELECT recipient_id, conversation_id FROM messages WHERE id=?', (mid,)).fetchone()
      if not m:
        raise ApiError(404, 'no_message', 'unknown message')
      if m['recipient_id'] != actor['id']:
        raise ApiError(403, 'not_recipient', 'only the recipient can update progress')
      c.execute("""INSERT INTO message_progress VALUES (?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
          phase=excluded.phase, summary=excluded.summary, bullets=excluded.bullets, updated_at=excluded.updated_at""",
                (mid, phase, summary, dumps(bullets) if bullets is not None else None, now))
      self.events.append(c, 'message_progress', id=mid, conversation_id=m['conversation_id'], phase=phase)
    self.events.notify()
    return {'ok': True, 'progress': {'phase': phase, 'summary': summary, 'bullets': bullets, 'updated_at': now}}

  def pin_conversation(self, cid, pinned):
    with self.db.tx() as c:
      row = c.execute('SELECT pinned, pinned_at FROM conversations WHERE id=?', (cid,)).fetchone()
      if row is None:
        raise ApiError(404, 'no_conversation', 'unknown conversation')
      at = row['pinned_at']
      if bool(row['pinned']) != pinned:
        at = self.now() if pinned else None
        c.execute('UPDATE conversations SET pinned=?, pinned_at=? WHERE id=?', (int(pinned), at, cid))
        self.events.append(c, 'conversation', id=cid, conversation_id=cid, pinned=pinned)
    self.events.notify()
    return {'pinned': pinned, 'pinned_at': at}

  def mark_read(self, viewer, cid, mid, admin=False):
    with self.db.tx() as c:
      if not c.execute('SELECT 1 FROM conversations WHERE id=?', (cid,)).fetchone():
        raise ApiError(404, 'no_conversation', 'unknown conversation')
      if not admin and not self._is_member(c, cid, viewer['id']):
        raise ApiError(403, 'not_member', 'you are not in this conversation')
      if mid is None:
        mid = c.execute('SELECT COALESCE(MAX(id),0) FROM messages WHERE conversation_id=?', (cid,)).fetchone()[0]
      elif type(mid) is not int or not 0 <= mid < 2**63 or (mid and not c.execute(
          'SELECT 1 FROM messages WHERE conversation_id=? AND id=?', (cid, mid)).fetchone()):
        raise ApiError(422, 'bad_read_cursor', 'expected a message ID from this conversation')
      key = (viewer['id'], cid)
      previous = c.execute('SELECT last_read_message_id FROM conversation_reads WHERE principal_id=? AND conversation_id=?',
                           key).fetchone()
      if previous is None or previous[0] < mid:
        c.execute("""INSERT INTO conversation_reads VALUES (?,?,?,?) ON CONFLICT(principal_id,conversation_id)
            DO UPDATE SET last_read_message_id=excluded.last_read_message_id, updated_at=excluded.updated_at""",
                  (*key, mid, self.now()))
        self.events.append(c, 'conversation', id=cid, conversation_id=cid, principal_id=viewer['id'])
      else:
        mid = previous[0]
    self.events.notify()
    return {'conversation_id': cid, 'last_read_message_id': mid}

  # --- reactions -----------------------------------------------------------

  def react(self, reactor, message_id, emoji, add=True):
    e = valid_emoji(emoji)
    if not e:
      raise ApiError(422, 'bad_emoji', 'emoji must be 1 to 32 bytes with no spaces or controls')
    with self.db.tx() as c:
      m = c.execute('SELECT * FROM messages WHERE id=?', (message_id,)).fetchone()
      if not m:
        raise ApiError(404, 'no_message', 'unknown message')
      conv = c.execute('SELECT * FROM conversations WHERE id=?', (m['conversation_id'],)).fetchone()
      if not self._is_member(c, conv['id'], reactor['id']):
        if reactor['kind'] == 'owner' and conv['kind'] == 'agent_agent':
          raise ApiError(403, 'read_only', 'agent-to-agent conversations are read-only for the owner')
        raise ApiError(403, 'not_member', 'you are not in this conversation')
      if add:
        c.execute('INSERT OR IGNORE INTO reactions(message_id, reactor_id, emoji, created_at) '
                  'VALUES (?, ?, ?, ?)', (message_id, reactor['id'], e, self.now()))
      else:
        c.execute('DELETE FROM reactions WHERE message_id=? AND reactor_id=? AND emoji=?',
                  (message_id, reactor['id'], e))
      self.events.append(c, 'reaction', message_id=message_id, conversation_id=conv['id'])
    self.events.notify()
    return {'ok': True, 'reactions': self._reactions(message_id)}

  # --- read views ----------------------------------------------------------

  def _reactions(self, message_id, c=None):
    q = ('SELECT r.emoji, r.reactor_id, p.display_name FROM reactions r JOIN principals p '
         'ON p.id = r.reactor_id WHERE r.message_id=? ORDER BY r.created_at')
    rows = (c.execute(q, (message_id,)).fetchall() if c else self.db.all(q, (message_id,)))
    return [{'emoji': r['emoji'], 'by': r['reactor_id'], 'by_name': r['display_name']} for r in rows]

  def message_view(self, mid, c=None):
    q = ('SELECT m.*, s.display_name AS sender_name, s.handle AS sender_handle, '
         's.kind AS sender_kind, r.display_name AS recipient_name, r.handle AS recipient_handle, '
         's.avatar AS sender_avatar, r.avatar AS recipient_avatar, s.role AS sender_role, r.role AS recipient_role, '
         'r.kind AS recipient_kind, cv.kind AS conversation_kind FROM messages m '
         'JOIN principals s ON s.id = m.sender_id JOIN principals r ON r.id = m.recipient_id '
         'JOIN conversations cv ON cv.id = m.conversation_id WHERE m.id=?')
    m = c.execute(q, (mid,)).fetchone() if c else self.db.one(q, (mid,))
    if not m:
      return None
    reply_to = None
    if m['reply_to_id']:
      qq = ('SELECT m.id, m.body, p.display_name FROM messages m JOIN principals p '
            'ON p.id = m.sender_id WHERE m.id=?')
      o = c.execute(qq, (m['reply_to_id'],)).fetchone() if c else self.db.one(qq, (m['reply_to_id'],))
      if o:
        reply_to = {'id': o['id'], 'sender_name': o['display_name'], 'excerpt': self.excerpt(o, 160)}
    return {
      'id': m['id'], 'conversation_id': m['conversation_id'],
      'conversation_kind': m['conversation_kind'],
      'progress': self._progress_view(mid),
      'sender': {'id': m['sender_id'], 'display_name': m['sender_name'],
                 'handle': m['sender_handle'], 'kind': m['sender_kind'], 'role': m['sender_role'], 'avatar': loads(m['sender_avatar'])},
      'recipient': {'id': m['recipient_id'], 'display_name': m['recipient_name'],
                    'handle': m['recipient_handle'], 'kind': m['recipient_kind'], 'role': m['recipient_role'], 'avatar': loads(m['recipient_avatar'])},
      'attachments': self.message_attachments(mid),
      'body': m['body'], 'reply_to': reply_to, 'mode': m['mode'], 'state': m['state'],
      'state_reason': m['state_reason'], 'attempts': m['attempts'], 'retry': bool(m['retry']),
      'created_at': m['created_at'], 'delivered_at': m['delivered_at'],
      'failed_at': m['failed_at'], 'reactions': self._reactions(m['id'], c=c),
      'queue_position': self._queue_position(m, c) if m['state'] == 'waiting' else None,
    }

  def _progress_view(self, mid):
    row = self.db.one("SELECT phase,summary,bullets,updated_at FROM message_progress WHERE message_id=? AND phase!='done'", (mid,))
    return {**dict(row), 'bullets': loads(row['bullets'])} if row else None

  def _queue_position(self, m, c=None):
    q = ("SELECT COUNT(*) FROM messages WHERE recipient_id=? AND state='waiting' AND "
         '(priority > ? OR (priority = ? AND (created_at < ? OR (created_at = ? AND id < ?))))')
    args = (m['recipient_id'], m['priority'], m['priority'], m['created_at'], m['created_at'], m['id'])
    row = c.execute(q, args).fetchone() if c else self.db.one(q, args)
    return int(row[0]) + 1

  def conversations_for(self, viewer, include_all=False):
    """Admin sees every conversation (agent-to-agent read-only); agents see their own."""
    if include_all:
      rows = self.db.all('SELECT * FROM conversations ORDER BY id')
    else:
      rows = self.db.all('SELECT cv.* FROM conversations cv JOIN conversation_members cm ON '
                         'cm.conversation_id = cv.id WHERE cm.principal_id=? ORDER BY cv.id',
                         (viewer['id'],))
    out = []
    for cv in rows:
      members = self.db.all('SELECT p.id, p.display_name, p.handle, p.kind, p.status, p.role, p.avatar FROM '
                            'conversation_members cm JOIN principals p ON p.id = cm.principal_id '
                            'WHERE cm.conversation_id=? ORDER BY p.kind DESC, p.display_name',
                            (cv['id'],))
      last = self.db.one('SELECT id, body, created_at, sender_id FROM messages WHERE '
                         'conversation_id=? ORDER BY id DESC LIMIT 1', (cv['id'],))
      member_ids = [m['id'] for m in members]
      cursor = self.db.one('SELECT last_read_message_id FROM conversation_reads WHERE principal_id=? AND conversation_id=?',
                           (viewer['id'], cv['id']))
      mid = cursor[0] if cursor else 0
      unread = self.db.one('SELECT COUNT(*) FROM messages WHERE conversation_id=? AND id>? AND sender_id!=?',
                           (cv['id'], mid, viewer['id']))[0]
      out.append({
        'id': cv['id'], 'kind': cv['kind'],
        'pinned': bool(cv['pinned']), 'pinned_at': cv['pinned_at'], 'unread_count': unread, 'last_read_message_id': mid,
        'members': [{**dict(m), 'avatar': loads(m['avatar'])} for m in members],
        'read_only': viewer['kind'] == 'owner' and viewer['id'] not in member_ids,
        'last': ({'id': last['id'], 'excerpt': self.excerpt(last, 120), 'created_at': last['created_at'],
                  'sender_id': last['sender_id']} if last else None),
      })
    out.sort(key=lambda x: (not x['pinned'], -(x['pinned_at'] or 0) if x['pinned'] else
                            -(x['last']['created_at'] if x['last'] else 0), -x['id']))
    return out

  def conversation_messages(self, viewer, conv_id, after=0, limit=200, include_all=False):
    conv = self.db.one('SELECT * FROM conversations WHERE id=?', (conv_id,))
    if not conv:
      raise ApiError(404, 'no_conversation', 'unknown conversation')
    member = self.db.one('SELECT 1 FROM conversation_members WHERE conversation_id=? AND '
                         'principal_id=?', (conv_id, viewer['id'])) is not None
    if not member and not include_all:
      raise ApiError(403, 'not_member', 'you are not in this conversation')
    ids = self.db.all('SELECT id FROM messages WHERE conversation_id=? AND id > ? ORDER BY id '
                      'LIMIT ?', (conv_id, int(after), min(int(limit), 500)))
    return {'conversation_id': conv_id, 'kind': conv['kind'], 'read_only': not member,
            'messages': [self.message_view(r['id']) for r in ids]}

  def history_with(self, agent, handle, limit=20):
    with self.db.tx() as c:
      other = self.resolve_recipient(c, handle) if handle != 'owner' else c.execute(
        "SELECT * FROM principals WHERE kind='owner'").fetchone()
      key = f'{min(agent["id"], other["id"])}:{max(agent["id"], other["id"])}'
      conv = c.execute('SELECT id FROM conversations WHERE dm_pair_key=?', (key,)).fetchone()
    if not conv:
      return {'conversation_id': None, 'messages': []}
    rows = self.db.all('SELECT id FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?',
                       (conv['id'], min(int(limit), 200)))
    return {'conversation_id': conv['id'],
            'messages': [self.message_view(r['id']) for r in reversed(rows)]}

  # --- delivery queue ------------------------------------------------------

  def _set_state(self, c, mid, state, reason, now):
    if state == 'delivered':
      c.execute("UPDATE messages SET state='delivered', state_reason=?, delivered_at=?, "
                'lease_id=NULL, lease_until=NULL WHERE id=?', (reason, now, mid))
    elif state == 'failed':
      c.execute("UPDATE messages SET state='failed', state_reason=?, failed_at=?, lease_id=NULL, "
                'lease_until=NULL WHERE id=?', (reason, now, mid))
    else:
      c.execute('UPDATE messages SET state=?, state_reason=?, lease_id=NULL, lease_until=NULL '
                'WHERE id=?', (state, reason, mid))
    m = c.execute('SELECT conversation_id FROM messages WHERE id=?', (mid,)).fetchone()
    self.events.append(c, 'message_state', id=mid, state=state, reason=reason,
                       conversation_id=m['conversation_id'] if m else None)

  def _try_claim(self, agent):
    now = self.now()
    s = self.settings
    with self.db.tx() as c:
      while True:
        m = c.execute(
          "SELECT * FROM messages WHERE recipient_id=? AND state='waiting' AND "
          '(lease_until IS NULL OR lease_until < ?) ORDER BY priority DESC, created_at, id LIMIT 1',
          (agent['id'], now),
        ).fetchone()
        if not m:
          return None
        if m['attempts'] >= s.max_attempts:
          self._set_state(c, m['id'], 'failed', 'delivery attempts exhausted', now)
          continue
        lease_id = 'ls_' + secrets.token_urlsafe(18)
        until = now + s.lease_sec
        c.execute('UPDATE messages SET lease_id=?, lease_until=?, attempts=attempts+1 WHERE id=?',
                  (lease_id, until, m['id']))
        c.execute('INSERT INTO delivery_attempts(message_id, lease_id, claimed_at, lease_until) '
                  'VALUES (?, ?, ?, ?)', (m['id'], lease_id, now, until))
        view = self.message_view(m['id'], c=c)
        return {'lease_id': lease_id, 'lease_until': until, 'attempt': m['attempts'] + 1,
                'message': view}

  def claim(self, agent, wait=25.0):
    """Long-poll for the next deliverable message; returns None on timeout."""
    deadline = time.monotonic() + max(0.0, min(float(wait), 55.0))
    while True:
      if not self.principal_for_id_active(agent['id']):
        raise ApiError(401, 'revoked', 'credential is no longer valid')
      got = self._try_claim(agent)
      if got:
        self.events.notify()
        return got
      left = deadline - time.monotonic()
      if left <= 0:
        return None
      with self.delivery_cv:
        self.delivery_cv.wait(min(left, 5.0))

  def principal_for_id_active(self, pid):
    return self.db.one("SELECT 1 FROM principals WHERE id=? AND status='admitted'", (pid,))

  def ack(self, agent, lease_id, outcome, reason=None):
    """Record a handoff outcome; stale leases cannot close a newer attempt."""
    if outcome not in ('delivered', 'unconfirmed', 'failed'):
      raise ApiError(422, 'bad_outcome', 'outcome must be delivered, unconfirmed or failed')
    now = self.now()
    with self.db.tx() as c:
      att = c.execute('SELECT * FROM delivery_attempts WHERE lease_id=?', (lease_id,)).fetchone()
      if not att:
        raise ApiError(404, 'no_lease', 'unknown lease')
      m = c.execute('SELECT * FROM messages WHERE id=?', (att['message_id'],)).fetchone()
      if m['recipient_id'] != agent['id']:
        raise ApiError(403, 'not_recipient', 'this lease belongs to another agent')
      if att['outcome']:
        if att['outcome'] == outcome:
          return {'ok': True, 'state': m['state'], 'idempotent': True}
        raise ApiError(409, 'lease_closed', 'this lease already has an outcome', state=m['state'])
      if m['state'] in FINAL_STATES:
        raise ApiError(409, 'message_final', 'message already final', state=m['state'])
      newer_active = (m['lease_id'] and m['lease_id'] != lease_id and m['lease_until']
                      and m['lease_until'] >= now)
      if newer_active:
        raise ApiError(409, 'stale_lease', 'a newer delivery attempt holds this message')
      c.execute('UPDATE delivery_attempts SET outcome=?, outcome_at=? WHERE id=?',
                (outcome, now, att['id']))
      if outcome == 'delivered':
        self._set_state(c, m['id'], 'delivered', None, now)
        # A fast reply can arrive before the transport acknowledges the handoff.
        answered = c.execute("""SELECT 1 FROM messages WHERE conversation_id=? AND sender_id=? AND id>?
            AND (reply_to_id=? OR recipient_id IN (SELECT id FROM principals WHERE kind='owner')) LIMIT 1""",
                             (m['conversation_id'], agent['id'], m['id'], m['id'])).fetchone()
        if not answered and c.execute("INSERT OR IGNORE INTO message_progress(message_id,phase,updated_at) "
                                      "VALUES (?,'thinking',?)", (m['id'], now)).rowcount:
          self.events.append(c, 'message_progress', id=m['id'], conversation_id=m['conversation_id'], phase='thinking')
      elif outcome == 'unconfirmed':
        self._set_state(c, m['id'], 'unconfirmed',
                        _clip_reason(reason) or 'handoff could not be confirmed', now)
      else:
        self._set_state(c, m['id'], 'failed', _clip_reason(reason) or 'connector error', now)
    self.events.notify()
    return {'ok': True, 'state': outcome}

  def retry(self, mid):
    """Owner-initiated retry of an unconfirmed message; marked so agents can de-duplicate."""
    with self.db.tx() as c:
      m = c.execute('SELECT * FROM messages WHERE id=?', (mid,)).fetchone()
      if not m:
        raise ApiError(404, 'no_message', 'unknown message')
      if m['state'] != 'unconfirmed':
        raise ApiError(409, 'not_unconfirmed', 'only unconfirmed messages can be retried')
      c.execute("UPDATE messages SET state='waiting', state_reason='owner retry', retry=1, "
                'lease_id=NULL, lease_until=NULL, created_at=created_at WHERE id=?', (mid,))
      self.events.append(c, 'message_state', id=mid, state='waiting', reason='owner retry',
                         conversation_id=m['conversation_id'])
    self.events.notify()
    self.delivery_cv_notify()
    return {'ok': True}

  def sweep_messages(self, c, now):
    """Expire undelivered messages after the TTL (D4); leases simply lapse."""
    ttl = self.settings.message_ttl_sec
    rows = c.execute("SELECT id FROM messages WHERE state='waiting' AND created_at < ?",
                     (now - ttl,)).fetchall()
    hours = ttl / 3600
    label = f'{hours:g} hours' if hours >= 1 else f'{ttl} seconds'
    for r in rows:
      self._set_state(c, r['id'], 'failed', f'not delivered within {label}', now)
    lapsed = c.execute("SELECT COUNT(*) FROM messages WHERE state='waiting' AND lease_until IS "
                       'NOT NULL AND lease_until < ?', (now,)).fetchone()[0]
    return len(rows), lapsed

  def waiting_counts(self, pid):
    rows = self.db.all('SELECT state, COUNT(*) AS n FROM messages WHERE recipient_id=? AND state IN '
                       "('waiting', 'unconfirmed') GROUP BY state", (pid,))
    return {r['state']: r['n'] for r in rows}


def _clip_reason(reason):
  return str(reason).strip()[:200] if reason else None
