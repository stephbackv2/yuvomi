/** Effective session participants are snapshots; access still belongs to the parent task. */
import * as db from '../db.js';
import { resolvePermissions } from '../permissions.js';
import { markEventOutbound } from './calendar-outbound.js';
import { setSessionDestination } from './task-session-targets.js';

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function taskParticipants(task) {
  const ids = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id').all(task.id).map(row => row.user_id);
  if (task.assigned_to && !ids.includes(task.assigned_to)) ids.push(task.assigned_to);
  return { primary: task.assigned_to, participants: ids, mode: 'inherited' };
}
export function validateSessionParticipants(assignment) {
  for (const id of assignment.participants) {
    const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user || db.get().prepare('SELECT 1 FROM housekeeping_workers WHERE user_id = ?').get(id)) fail('Invalid session participant.');
    const rights = resolvePermissions(db.get(), user).modules;
    if (rights.tasks === 'none' || rights.calendar === 'none') fail('Participant cannot access task sessions.');
  }
  return assignment;
}
export function resolveSessionAssignment(task, body, before = null) {
  const changed = ['session_assignment_mode', 'assigned_to', 'assigned_users'].some(key => Object.hasOwn(body, key));
  if (!changed && before) return null;
  const mode = body.session_assignment_mode ?? before?.session_assignment_mode ?? 'inherited';
  if (!['inherited', 'override'].includes(mode)) fail('Invalid session assignment mode.');
  if (mode === 'inherited') {
    if (Object.hasOwn(body, 'assigned_to') || Object.hasOwn(body, 'assigned_users')) fail('Inherited sessions use the current task assignments.');
    // Editing an inherited snapshot does not reassign elapsed or reopened history.
    if (before?.session_assignment_mode === 'inherited') return null;
    return validateSessionParticipants(taskParticipants(task));
  }
  const primary = body.assigned_to ?? (before?.session_assignment_mode === 'override' ? before.assigned_to : null);
  const participants = body.assigned_users ?? (before?.session_assignment_mode === 'override'
    ? db.get().prepare('SELECT user_id FROM event_assignments WHERE event_id = ?').all(before.id).map(row => row.user_id) : [primary]);
  if (!Number.isSafeInteger(primary) || primary <= 0 || !Array.isArray(participants) || !participants.length
    || participants.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(participants).size !== participants.length || !participants.includes(primary)) {
    fail('Choose a primary assignee and valid session participants.');
  }
  return validateSessionParticipants({ primary, participants, mode });
}
export function writeSessionAssignment(id, assignment) {
  db.get().prepare('UPDATE calendar_events SET assigned_to = ?, session_assignment_mode = ? WHERE id = ?').run(assignment.primary, assignment.mode, id);
  db.get().prepare('DELETE FROM event_assignments WHERE event_id = ?').run(id);
  for (const user of assignment.participants) db.get().prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, user);
}
/** Called inside the task definition transaction; a rejected move rolls everything back. */
export function followTaskSessionAssignments(previousAssignment, task, actor, moves = []) {
  if (!Array.isArray(moves) || moves.some(move => !move || !Number.isSafeInteger(move.session_id) || !Object.hasOwn(move, 'publication_target'))
    || new Set(moves.map(move => move.session_id)).size !== moves.length) fail('Invalid session calendar moves.');
  // The caller captures the old participant list before replacing the task assignments.
  const oldIds = previousAssignment.participants;
  const after = taskParticipants(task);
  const changed = previousAssignment.primary !== task.assigned_to || oldIds.length !== after.participants.length || oldIds.some(id => !after.participants.includes(id));
  const sessions = changed ? db.get().prepare(`SELECT * FROM calendar_events WHERE task_id = ?
    AND session_assignment_mode = 'inherited' AND session_status = 'unfinished'`).all(task.id)
    .filter(session => Date.parse(session.start_datetime) > Date.now()) : [];
  if (moves.some(move => !sessions.some(session => session.id === move.session_id && session.assigned_to !== after.primary))) fail('Calendar moves apply only to reassigned future inherited sessions.');
  if (sessions.length) validateSessionParticipants(after);
  for (const session of sessions) {
    writeSessionAssignment(session.id, after);
    const move = moves.find(move => move.session_id === session.id);
    if (move) setSessionDestination(session, { ...task, assigned_to: after.primary }, actor, move);
    const updated = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(session.id);
    markEventOutbound(session, updated);
  }
}
