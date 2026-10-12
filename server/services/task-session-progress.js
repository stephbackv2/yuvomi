/** Batch read model: duration weights belong to retained session identities. */
import * as db from '../db.js';

export function attachTaskSessionProgress(tasks) {
  if (!tasks.length) return tasks;
  const progress = new Map(tasks.map(task => [task.id, { session_count: 0, total_ms: 0, completed_ms: 0, percentage: 0 }]));
  const sessions = db.get().prepare(`SELECT task_id, start_datetime, end_datetime, session_status FROM calendar_events
    WHERE task_id IN (${tasks.map(() => '?').join(',')})`).all(...tasks.map(task => task.id));
  for (const session of sessions) {
    const work = progress.get(session.task_id);
    const duration = Date.parse(session.end_datetime) - Date.parse(session.start_datetime);
    work.session_count++;
    work.total_ms += duration;
    if (session.session_status === 'completed') work.completed_ms += duration;
  }
  for (const task of tasks) {
    const work = progress.get(task.id);
    work.percentage = work.total_ms > 0 ? work.completed_ms / work.total_ms * 100 : 0;
    task.scheduled_work = work;
  }
  return tasks;
}
