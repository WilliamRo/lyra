"""Projects, membership and task assignments share one transaction per mutation."""

import re
import unicodedata

from .db import loads
from .events import ApiError


PROJECT_STATES = ('active', 'paused', 'completed', 'archived')
TASK_STATES = ('open', 'in_progress', 'blocked', 'done')


def _text(value, field, required=False):
  if value is None and not required:
    return None
  if not isinstance(value, str) or (required and not value.strip()):
    raise ApiError(422, 'bad_' + field, 'invalid ' + field)
  return value.strip()


def _ids(values, field):
  if not isinstance(values, list) or any(type(v) is not int or not 0 < v < 2**63 for v in values):
    raise ApiError(422, 'bad_' + field, 'expected a list of principal IDs')
  return set(values)


def _state(value, allowed):
  if value not in allowed:
    raise ApiError(422, 'bad_status', 'unknown status')
  return value


def _person(row):
  return {**dict(row), 'avatar': loads(row['avatar'])}


def _principals(c, relation, key, rid):
  # The relation and join column come only from the two call sites below.
  extra = ', x.role AS project_role, x.joined_at' if relation == 'project_members' else ', x.assigned_at'
  return [_person(row) for row in c.execute(
    'SELECT p.id, p.handle, p.display_name, p.kind, p.role, p.avatar' + extra +
    f' FROM {relation} x JOIN principals p ON p.id=x.principal_id WHERE x.{key}=? '
    'ORDER BY p.display_name, p.id', (rid,))]


class ProjectsMixin:
  def projects_view(self, project_id=None):
    with self.db.lock:
      c = self.db.conn
      query = 'SELECT * FROM projects'
      rows = c.execute(query + (' WHERE id=?' if project_id is not None else '') + ' ORDER BY id',
                       (project_id,) if project_id is not None else ())
      result = []
      for project in rows:
        pid = project['id']
        members = _principals(c, 'project_members', 'project_id', pid)
        pm = next((p for p in members if p['id'] == project['pm_principal_id']), None)
        tasks = [{**dict(t), 'assignees': _principals(c, 'task_assignees', 'task_id', t['id'])}
                 for t in c.execute('SELECT * FROM tasks WHERE project_id=? ORDER BY id', (pid,))]
        result.append({**dict(project), 'members': members, 'tasks': tasks,
                       'pm': {k: pm[k] for k in ('id', 'handle', 'display_name', 'avatar')} if pm else None})
      return result

  def _project_access(self, c, actor, admin, project, action, task_id=None):
    if admin or c.execute("SELECT 1 FROM principals WHERE id=? AND role='consul' AND status='admitted'",
                          (actor['id'],)).fetchone():
      return
    if project and project['pm_principal_id'] == actor['id']:
      return
    if action == 'create_task' and c.execute(
        'SELECT 1 FROM project_members WHERE project_id=? AND principal_id=?',
        (project['id'], actor['id'])).fetchone():
      return
    if action == 'edit_task' and c.execute(
        'SELECT 1 FROM task_assignees WHERE task_id=? AND principal_id=?', (task_id, actor['id'])).fetchone():
      return
    raise ApiError(403, 'project_forbidden', 'insufficient project permissions')

  def _set_members(self, c, pid, pm, member_ids, now):
    existing = {r[0] for r in c.execute('SELECT principal_id FROM project_members WHERE project_id=?', (pid,))}
    wanted = existing.copy() if member_ids is None else _ids(member_ids, 'members')
    if pm is not None:
      wanted.update(_ids([pm], 'members'))
    for person in wanted - existing:
      if not c.execute("SELECT 1 FROM principals WHERE id=? AND status='admitted'", (person,)).fetchone():
        raise ApiError(422, 'bad_members', 'members must be admitted principals')
      c.execute('INSERT INTO project_members(project_id, principal_id, joined_at) VALUES (?, ?, ?)',
                (pid, person, now))
    removed = existing - wanted
    if removed:
      c.executemany('DELETE FROM project_members WHERE project_id=? AND principal_id=?',
                    ((pid, person) for person in removed))
      # Validate the final set even when one update removes several co-assignees.
      if c.execute("""SELECT 1 FROM tasks t WHERE project_id=? AND status!='done' AND NOT EXISTS
          (SELECT 1 FROM task_assignees a JOIN project_members m ON m.principal_id=a.principal_id
           WHERE a.task_id=t.id AND m.project_id=t.project_id) LIMIT 1""", (pid,)).fetchone():
        raise ApiError(409, 'member_has_sole_task', 'reassign unfinished tasks before removing members')
      c.executemany("""DELETE FROM task_assignees WHERE principal_id=? AND task_id IN
          (SELECT id FROM tasks WHERE project_id=? AND status!='done')""", ((p, pid) for p in removed))
    c.execute("UPDATE project_members SET role=CASE WHEN principal_id=? THEN 'pm' ELSE 'member' END "
              'WHERE project_id=?', (pm, pid))

  def save_project(self, actor, admin, data, pid=None):
    now = self.now()
    with self.db.tx() as c:
      old = c.execute('SELECT * FROM projects WHERE id=?', (pid,)).fetchone() if pid is not None else None
      if pid is not None and not old:
        raise ApiError(404, 'no_project', 'unknown project')
      self._project_access(c, actor, admin, old, 'edit_project')
      fields = {**(dict(old) if old else {}), **data}
      name = _text(fields.get('name'), 'name', required=True)
      description = _text(fields.get('description'), 'description')
      status = _state(fields.get('status', 'active'), PROJECT_STATES)
      pm = fields.get('pm_principal_id')
      if pm is not None:
        _ids([pm], 'members')
        if not c.execute("SELECT 1 FROM principals WHERE id=? AND status='admitted'", (pm,)).fetchone():
          raise ApiError(422, 'bad_members', 'the project manager must be an admitted principal')
      if 'member_ids' in data and data['member_ids'] is None:
        raise ApiError(422, 'bad_members', 'expected a list of principal IDs')
      if old:
        c.execute('UPDATE projects SET name=?, description=?, status=?, pm_principal_id=?, updated_at=? WHERE id=?',
                  (name, description, status, pm, now, pid))
      else:
        slug = data.get('slug')
        if slug is None:
          slug = re.sub(r'[^\w]+', '-', unicodedata.normalize('NFKC', name).casefold()).strip('-')
        if not isinstance(slug, str) or not re.fullmatch(r'[\w]+(?:-[\w]+)*', slug) or len(slug) > 128:
          raise ApiError(422, 'bad_slug', 'provide a slug with words separated by hyphens')
        if c.execute('SELECT 1 FROM projects WHERE slug=?', (slug,)).fetchone():
          raise ApiError(409, 'slug_exists', 'project slug already exists')
        pid = c.execute('INSERT INTO projects(slug,name,description,status,pm_principal_id,created_at,updated_at) '
                        'VALUES (?,?,?,?,?,?,?)', (slug, name, description, status, pm, now, now)).lastrowid
      self._set_members(c, pid, pm, data.get('member_ids'), now)
      self.events.append(c, 'project', id=pid, project_id=pid)
      project = self.projects_view(pid)[0]
    self.events.notify()
    return {'project': project}

  def save_task(self, actor, admin, data, pid=None, tid=None):
    now = self.now()
    with self.db.tx() as c:
      old = c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone() if tid is not None else None
      if tid is not None and not old:
        raise ApiError(404, 'no_task', 'unknown task')
      pid = old['project_id'] if old else pid
      project = c.execute('SELECT * FROM projects WHERE id=?', (pid,)).fetchone()
      if not project:
        raise ApiError(404, 'no_project', 'unknown project')
      self._project_access(c, actor, admin, project, 'edit_task' if old else 'create_task', tid)
      fields = {**(dict(old) if old else {}), **data}
      title = _text(fields.get('title'), 'title', required=True)
      description = _text(fields.get('description'), 'description')
      status = _state(fields.get('status', 'open'), TASK_STATES)
      priority = fields.get('priority', 0)
      if type(priority) is not int or not -(2**63) <= priority < 2**63:
        raise ApiError(422, 'bad_priority', 'priority must be an integer')
      current = {r[0] for r in c.execute('SELECT principal_id FROM task_assignees WHERE task_id=?', (tid,))}
      assignees = _ids(data['assignee_ids'], 'assignees') if 'assignee_ids' in data else current
      members = {r[0] for r in c.execute('SELECT principal_id FROM project_members WHERE project_id=?', (pid,))}
      if not assignees or not assignees <= members:
        raise ApiError(422, 'bad_assignees', 'assign at least one current project member')
      if old:
        c.execute('UPDATE tasks SET title=?, description=?, status=?, priority=?, updated_at=? WHERE id=?',
                  (title, description, status, priority, now, tid))
      else:
        tid = c.execute('INSERT INTO tasks(project_id,title,description,status,priority,created_by_principal_id,'
                        'created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
                        (pid, title, description, status, priority, actor['id'], now, now)).lastrowid
      c.executemany('DELETE FROM task_assignees WHERE task_id=? AND principal_id=?',
                    ((tid, p) for p in current - assignees))
      c.executemany('INSERT INTO task_assignees VALUES (?, ?, ?)', ((tid, p, now) for p in assignees - current))
      c.execute('UPDATE projects SET updated_at=? WHERE id=?', (now, pid))
      self.events.append(c, 'project', id=pid, project_id=pid, task_id=tid)
      task = {**dict(c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone()),
              'assignees': _principals(c, 'task_assignees', 'task_id', tid)}
    self.events.notify()
    return {'task': task}
