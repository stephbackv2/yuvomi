/** Local task allocations use calendar event identities, times and rendering.
 * No outbound target or recurrence is created by scheduling an allocation.
 */
import * as db from '../db.js';
import { visibilityWhere } from './visibility.js';
import { taskScopeWhere } from './task-scope.js';
import { resolvePermissions, moduleAccessVerdict } from '../permissions.js';
import { tokenAllows } from '../scopes.js';
import { householdTimeZone, isValidTimeZone, storedToInstantMs, utcToWall, todayKey, hasExplicitZone } from '../utils/timezone.js';
import { setAssignments } from '../utils/task-assignments.js';
import { markTodoOutbound } from './caldav-todo-outbound.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function sessionModuleAllowed(req, access = 'read') {
  const id = req.authUserId || req.user?.id || req.session?.userId;
  const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return false;
  const permissions = resolvePermissions(db.get(), user).modules;
  return ['tasks', 'calendar'].every(key => permissions[key] !== 'none'
    && (access !== 'write' || permissions[key] === 'write')
    && moduleAccessVerdict(req.sessionModuleAccess, key, access) === 'allow'
    && tokenAllows(req.authScopes, key, access));
}

function visibleTask(id, actor) {
  const task = db.get().prepare(`SELECT t.* FROM tasks t WHERE t.id = @id
    AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@actor')}`).get({ id, actor });
  if (!task) fail('Task not found.', 404);
  return task;
}

export function plannableTasks(actor) {
  return db.get().prepare(`SELECT t.* FROM tasks t WHERE
    ${taskScopeWhere('t', { bind: '@today' })}
    AND t.status <> 'done' AND t.archived_at IS NULL
    AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@actor')}
    AND (t.assigned_to = @actor OR EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.user_id = @actor)
      OR (t.assigned_to IS NULL AND NOT EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id)))
    ORDER BY t.due_date IS NULL, t.due_date, t.id`).all({ actor, today: todayKey(db.get()) });
}

export function readTaskSessions(taskId, actor) {
  visibleTask(taskId, actor);
  return db.get().prepare(`SELECT e.*,
    (SELECT json_group_array(json_object('id', u.id, 'display_name', u.display_name, 'color', u.avatar_color, 'avatar_data', u.avatar_data))
      FROM event_assignments a JOIN users u ON u.id = a.user_id WHERE a.event_id = e.id) AS assigned_users_json
    FROM calendar_events e WHERE e.task_id = ? ORDER BY e.start_datetime, e.id`).all(taskId);
}

function interval(body) {
  const tzid = body.tzid ?? householdTimeZone(db.get());
  if (!isValidTimeZone(tzid)) fail('Invalid session timezone.');
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) fail('Invalid session time.');
    const [year, month, day, hour, minute] = value.match(/\d+/g).slice(0, 5).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.toISOString().slice(0, 10) !== value.slice(0, 10) || hour > 23 || minute > 59) fail('Invalid session date.');
    const instant = storedToInstantMs(value, tzid);
    if (!Number.isFinite(instant)) fail('Invalid session time.');
    // Reject invalid dates and nonexistent DST wall times rather than silently
    // allocating a different slot. Explicit offsets identify ambiguous instants.
    if (!hasExplicitZone(value)) {
      const wall = utcToWall(new Date(instant).toISOString(), tzid);
      if (`${wall.date}T${wall.time}`.slice(0, 16) !== value.slice(0, 16)) fail('Invalid session wall time.');
    }
    return instant;
  };
  const start = parse(body.start_datetime);
  const end = body.end_datetime == null ? start + 30 * 60_000 : parse(body.end_datetime);
  if (end <= start) fail('Session end must follow its start.');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), tzid };
}

export function scheduleTaskSession({ taskId, actor, body }) {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) fail('Invalid task id.');
  if (['assigned_to', 'assigned_users', 'task_id', 'recurrence_rule', 'sync_target'].some(key => Object.hasOwn(body, key))) fail('Session assignment and destination are inherited.');
  const times = interval(body);
  return db.get().transaction(() => {
    const task = visibleTask(taskId, actor);
    if (task.parent_task_id || task.status === 'done' || task.archived_at || (task.start_date && task.start_date > todayKey(db.get()))) fail('Task is not schedulable.', 409);
    let participants = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id').all(taskId).map(a => a.user_id);
    if (task.assigned_to && !participants.includes(task.assigned_to)) participants.push(task.assigned_to);
    const unassigned = !participants.length;
    if (!unassigned && !task.assigned_to) fail('Task needs an explicit primary assignee.');
    if (unassigned) participants = [actor];
    for (const id of participants) {
      const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!user || db.get().prepare('SELECT 1 FROM housekeeping_workers WHERE user_id = ?').get(id)) fail('Invalid session participant.');
      const permissions = resolvePermissions(db.get(), user).modules;
      if (permissions.tasks === 'none' || permissions.calendar === 'none') fail('Participant cannot access task sessions.');
    }
    if (unassigned) {
      db.get().prepare('UPDATE tasks SET assigned_to = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\') WHERE id = ?').run(actor, taskId);
      setAssignments(db.get(), taskId, [actor]);
      markTodoOutbound('tasks', task, { ...task, assigned_to: actor });
    }
    const id = Number(db.get().prepare(`INSERT INTO calendar_events
      (title, start_datetime, end_datetime, tzid, created_by, assigned_to, visibility, task_id, session_status, session_assignment_mode, icon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unfinished', 'inherited', 'check-square')`).run(
      task.title, times.start, times.end, times.tzid, actor, task.assigned_to || actor, task.visibility, taskId).lastInsertRowid);
    for (const uid of participants) db.get().prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, uid);
    return readTaskSessions(taskId, actor).find(e => e.id === id);
  })();
}
