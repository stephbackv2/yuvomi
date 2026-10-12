/** Scheduling boundaries share task visibility and require both module rights. */
import express from 'express';
import { createLogger } from '../logger.js';
import { taskSessionTargets, completeTaskSession, plannableTasks, readTaskSessions, scheduleTaskSession, updateTaskSession, removeTaskSession, sessionModuleAllowed } from '../services/task-sessions.js';
import * as db from '../db.js';
import { serializeEvent, getUserId } from './calendar/helpers.js';
const log = createLogger('TaskSessions');
const router = express.Router();
function allowed(req, res, access) {
  if (sessionModuleAllowed(req, access)) return true;
  res.status(403).json({ error: 'Task and calendar access required.', code: 403 }); return false;
}
function sendError(res, error) {
  const status = error.status || 500;
  if (status === 500) log.error('Task session command failed:', error);
  res.status(status).json({ error: status === 500 ? 'Internal error.' : error.message, code: status });
}
router.get('/plannable', (req, res) => {
  try { if (allowed(req, res, 'read')) res.json({ data: plannableTasks(getUserId(req), req.query.assigned_to === undefined ? getUserId(req) : Number(req.query.assigned_to)) }); }
  catch (error) { sendError(res, error); }
});
router.get('/:id/session-targets', (req, res) => {
  try { if (allowed(req, res, 'read')) res.json({ data: taskSessionTargets(Number(req.params.id), getUserId(req)) }); }
  catch (error) { sendError(res, error); }
});
router.get('/:id/sessions', (req, res) => {
  try { if (allowed(req, res, 'read')) res.json({ data: readTaskSessions(Number(req.params.id), getUserId(req)).map(e => serializeEvent(e, db.get())) }); }
  catch (error) { sendError(res, error); }
});
router.post('/:id/sessions', (req, res) => {
  try {
    if (!allowed(req, res, 'write')) return;
    const event = scheduleTaskSession({ taskId: Number(req.params.id), actor: getUserId(req), body: req.body || {} });
    res.status(201).json({ data: serializeEvent(event, db.get()) });
  } catch (error) { sendError(res, error); }
});
router.post('/:id/sessions/:sessionId/complete', (req, res) => {
  try {
    if (!allowed(req, res, 'write')) return;
    const event = completeTaskSession({ taskId: Number(req.params.id), sessionId: Number(req.params.sessionId), actor: getUserId(req) });
    res.json({ data: serializeEvent(event, db.get()) });
  } catch (error) { sendError(res, error); }
});
router.put('/:id/sessions/:sessionId', (req, res) => {
  try {
    if (!allowed(req, res, 'write')) return;
    const event = updateTaskSession({ taskId: Number(req.params.id), sessionId: Number(req.params.sessionId), actor: getUserId(req), body: req.body || {} });
    res.json({ data: serializeEvent(event, db.get()) });
  } catch (error) { sendError(res, error); }
});
router.delete('/:id/sessions/:sessionId', (req, res) => {
  try {
    if (!allowed(req, res, 'write')) return;
    removeTaskSession({ taskId: Number(req.params.id), sessionId: Number(req.params.sessionId), actor: getUserId(req) });
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});
export default router;
