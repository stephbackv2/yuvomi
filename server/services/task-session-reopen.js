/** Reopen retained work using the parent's existing completion undo workflow. */
import * as db from '../db.js';
import { readTaskSessions } from './task-sessions.js';
import { transitionTaskStatus } from './task-transitions.js';

export function reopenTaskSession({ taskId, sessionId, actor }) {
  if (![taskId, sessionId].every(id => Number.isSafeInteger(id) && id > 0)) {
    throw Object.assign(new Error('Invalid session id.'), { status: 400 });
  }
  return db.get().transaction(() => {
    // This read enforces current parent visibility, not historical participants.
    const session = readTaskSessions(taskId, actor).find(event => event.id === sessionId);
    if (!session) throw Object.assign(new Error('Session not found.'), { status: 404 });
    if (session.session_status === 'completed') {
      const task = db.get().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
      if (task.status === 'done') {
        transitionTaskStatus({ taskId, status: 'in_progress', actingUserId: actor });
      }
      // Undo while this row is still completed: an archived parent's cleanup
      // trigger must not discard the retained session as a future allocation.
      db.get().prepare(`UPDATE calendar_events SET session_status = 'unfinished',
        session_completed_at = NULL, session_completed_by = NULL,
        edit_revision = edit_revision + 1 WHERE id = ?`).run(sessionId);
    }
    return readTaskSessions(taskId, actor).find(event => event.id === sessionId);
  })();
}
