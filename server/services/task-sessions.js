/** Shared task allocations keep calendar identities and use existing provider publication. */
import { attachTaskSessionProgress } from './task-session-progress.js';
import { randomUUID } from 'node:crypto';
import * as db from '../db.js';
import { sessionTargets, resolveSessionTarget, setSessionDestination } from './task-session-targets.js';
import { resolveSessionAssignment, writeSessionAssignment, taskParticipants, validateSessionParticipants, followTaskSessionAssignments } from './task-session-assignments.js';
import { visibilityWhere } from './visibility.js';
import { taskScopeWhere } from './task-scope.js';
import { resolvePermissions, moduleAccessVerdict } from '../permissions.js';
import { tokenAllows } from '../scopes.js';
import { householdTimeZone, isValidTimeZone, storedToInstantMs, utcToWall, todayKey, hasExplicitZone } from '../utils/timezone.js';
import { setAssignments } from '../utils/task-assignments.js';
import { markTodoOutbound } from './caldav-todo-outbound.js';
import { markEventOutbound, queueEventDeletion } from './calendar-outbound.js';
import { transitionTaskStatus } from './task-transitions.js';
import { eventRevisionToken } from './calendar-edit-metadata.js';

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

export function plannableTasks(actor, assignee = actor) {
  if (!Number.isSafeInteger(assignee) || assignee <= 0) fail("Invalid assignee.");
  return attachTaskSessionProgress(db.get().prepare(`SELECT t.*, (SELECT COUNT(*) FROM calendar_events e WHERE e.task_id = t.id) AS session_count FROM tasks t WHERE
    ${taskScopeWhere('t', { bind: '@today' })}
    AND t.status <> 'done' AND t.archived_at IS NULL
    AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@actor')}
    AND (t.assigned_to = @assignee OR EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.user_id = @assignee)
      OR (t.assigned_to IS NULL AND NOT EXISTS (SELECT 1 FROM task_assignments a WHERE a.task_id = t.id)))
    ORDER BY t.due_date IS NULL, t.due_date, t.id`).all({ actor, assignee, today: todayKey(db.get()) }));
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
  const duration = body.duration_minutes ?? 30;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) fail('Invalid session duration.');
  const end = body.end_datetime == null ? start + duration * 60_000 : parse(body.end_datetime);
  if (!Number.isFinite(end) || Math.abs(end) > 8.64e15 || end <= start) fail('Session end must follow its start.');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), tzid };
}

export function scheduleTaskSession({ taskId, actor, body }) {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) fail('Invalid task id.');
  if (['task_id', 'recurrence_rule', 'sync_target'].some(key => Object.hasOwn(body, key))) fail('Session assignment and destination are inherited.');
  const times = interval(body);
  return db.get().transaction(() => {
    const task = visibleTask(taskId, actor);
    if (task.parent_task_id || task.status === 'done' || task.archived_at || (task.start_date && task.start_date > todayKey(db.get()))) fail('Task is not schedulable.', 409);
    const inherited = taskParticipants(task);
    const unassigned = !inherited.participants.length;
    if (!unassigned && !inherited.primary) fail('Task needs an explicit primary assignee.');
    const assignment = resolveSessionAssignment(task, body);
    if (assignment.mode === 'inherited' && unassigned) {
      assignment.primary = actor; assignment.participants = [actor];
      validateSessionParticipants(assignment);
    }
    const target = resolveSessionTarget({ ...task, assigned_to: assignment.primary }, actor, body);
    if (unassigned && assignment.mode === 'inherited') {
      db.get().prepare('UPDATE tasks SET assigned_to = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\') WHERE id = ?').run(actor, taskId);
      setAssignments(db.get(), taskId, [actor]);
      followTaskSessionAssignments(inherited, { ...task, assigned_to: actor }, actor);
      markTodoOutbound('tasks', task, { ...task, assigned_to: actor });
    }
    const id = Number(db.get().prepare(`INSERT INTO calendar_events
      (title, start_datetime, end_datetime, tzid, created_by, assigned_to, visibility, task_id, session_status, session_assignment_mode, icon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unfinished', 'inherited', 'check-square')`).run(
      task.title, times.start, times.end, times.tzid, actor, assignment.primary, task.visibility, taskId).lastInsertRowid);
    db.get().prepare(`UPDATE calendar_events SET target_google_calendar_id = ?, target_caldav_account_id = ?, target_caldav_calendar_url = ?,
      target_outlook_account_id = ?, target_outlook_calendar_id = ?, outbound_dirty = ?, session_publication_uid = ? WHERE id = ?`).run(
      target.target_google_calendar_id, target.target_caldav_account_id, target.target_caldav_calendar_url,
      target.target_outlook_account_id, target.target_outlook_calendar_id, Object.values(target).some(Boolean) ? 1 : 0, randomUUID(), id);
    writeSessionAssignment(id, assignment);
    return readTaskSessions(taskId, actor).find(e => e.id === id);
  })();
}


function visibleSession(taskId, sessionId, actor) {
  if (![taskId, sessionId].every(id => Number.isSafeInteger(id) && id > 0)) fail('Invalid session id.');
  visibleTask(taskId, actor);
  const session = db.get().prepare('SELECT * FROM calendar_events WHERE id = ? AND task_id = ?').get(sessionId, taskId);
  if (!session) fail('Session not found.', 404);
  return session;
}

export function removeTaskSession({ taskId, sessionId, actor }) {
  return db.get().transaction(() => {
    const session = visibleSession(taskId, sessionId, actor);
    queueEventDeletion(session, db.get());
    db.get().prepare('DELETE FROM calendar_events WHERE id = ?').run(sessionId);
  })();
}

export function updateTaskSession({ taskId, sessionId, actor, body }) {
  const allowed = ['start_datetime', 'end_datetime', 'duration_minutes', 'tzid', 'expected_revision', 'publication_target', 'session_assignment_mode', 'assigned_to', 'assigned_users'];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('Only session time, assignment and destination can be changed.');
  return db.get().transaction(() => {
    const before = visibleSession(taskId, sessionId, actor);
    if (before.session_status === 'completed') fail('Reopen the session before editing its duration.', 409);
    if (body.expected_revision !== undefined && String(body.expected_revision) !== eventRevisionToken(before)) fail('Session changed. Reload before editing.', 409);
    const assignment = resolveSessionAssignment(visibleTask(taskId, actor), body, before);
    if (assignment) writeSessionAssignment(sessionId, assignment);
    const times = interval({ start_datetime: body.start_datetime ?? before.start_datetime,
      end_datetime: body.end_datetime, tzid: body.tzid ?? before.tzid,
      duration_minutes: body.duration_minutes ?? (Date.parse(before.end_datetime) - Date.parse(before.start_datetime)) / 60_000 });
    db.get().prepare('UPDATE calendar_events SET start_datetime = ?, end_datetime = ?, tzid = ? WHERE id = ?')
      .run(times.start, times.end, times.tzid, sessionId);
    if (Object.hasOwn(body, 'publication_target')) {
      setSessionDestination(before, { ...visibleTask(taskId, actor), assigned_to: assignment ? assignment.primary : before.assigned_to }, actor, body);
    }
    const after = readTaskSessions(taskId, actor).find(event => event.id === sessionId);
    markEventOutbound(before, after);
    return readTaskSessions(taskId, actor).find(event => event.id === sessionId);
  })();
}

/** Only an explicit, first completion can advance the parent lifecycle. */
export function completeTaskSession({ taskId, sessionId, actor }) {
  return db.get().transaction(() => {
    const session = visibleSession(taskId, sessionId, actor);
    if (session.session_status !== 'completed') {
      const task = visibleTask(taskId, actor);
      if (task.status === 'done' || task.archived_at) fail('Task is already finished.', 409);
      db.get().prepare(`UPDATE calendar_events SET session_status = 'completed',
        session_completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), session_completed_by = ?, edit_revision = edit_revision + 1 WHERE id = ?`).run(actor, sessionId);
      const unfinished = db.get().prepare("SELECT 1 FROM calendar_events WHERE task_id = ? AND session_status = 'unfinished' LIMIT 1").get(taskId);
      transitionTaskStatus({ taskId, status: unfinished ? 'in_progress' : 'done', actingUserId: actor });
    }
    return readTaskSessions(taskId, actor).find(event => event.id === sessionId);
  })();
}

export function taskSessionTargets(taskId, actor, query = {}) {
  const task = visibleTask(taskId, actor);
  let primary = task.assigned_to;
  if (query.session_id !== undefined) primary = visibleSession(taskId, Number(query.session_id), actor).assigned_to;
  if (query.assigned_to !== undefined) {
    primary = query.assigned_to === '' ? actor : Number(query.assigned_to);
    validateSessionParticipants({ participants: [primary] });
  }
  return sessionTargets({ ...task, assigned_to: primary }, actor);
}
