/**
 * Modul: Kalender (Calendar) - Orchestrator
 * Zweck: Mountet die Kalender-Sub-Router (Lese/Google/Apple/Abos/Feed/CRUD/CalDAV)
 *        unter dem gemeinsamen Basispfad. Aufgeteilt aus dem vormaligen God-File
 *        server/routes/calendar.js; Route-Pfade und Reihenfolge bleiben identisch.
 *
 * Reihenfolge-Vertrag: Alle spezifischen Pfade (/google, /apple, /subscriptions,
 * /feed, /holidays, /upcoming, /search, /sync-targets) MÜSSEN vor dem CRUD-Router
 * (mit /:id) gemountet werden, sonst würde /:id sie verschlucken. CalDAV nutzt
 * ausschließlich Mehr-Segment-Pfade und kollidiert daher nicht mit /:id.
 *
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { sessionModuleAllowed } from '../services/task-sessions.js';
import { visibilityWhere } from '../services/visibility.js';

import readRouter from './calendar/read.js';
import googleRouter from './calendar/google.js';
import appleRouter from './calendar/apple.js';
import subscriptionsRouter from './calendar/subscriptions.js';
import feedRouter from './calendar/feed.js';
import crudRouter from './calendar/crud.js';
import caldavRouter from './calendar/caldav.js';
import outlookRouter from './calendar/outlook.js';
import syncTargetsRouter from './calendar/sync-targets.js';
import editRouter from './calendar/edit.js';
import { googleTarget, getUserId } from './calendar/helpers.js';

const log = createLogger('Calendar');
const router = express.Router();
// Sessions are task commands. Ordinary event editors must not alter or publish
// them, and clients without task access cannot read their calendar projection.
router.use((req, res, next) => {
  try {
    res.locals.taskSessionsReadable = sessionModuleAllowed(req);
    const match = /^\/(\d+)(?:\/|$)/.exec(req.path);
    if (match) {
      const event = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(Number(match[1]));
      if (event?.task_id) {
        const visible = db.get().prepare(`SELECT e.id FROM calendar_events e WHERE e.id = ?
          AND ${visibilityWhere('e', 'event_assignments', 'event_id')}`).get(event.id, getUserId(req), getUserId(req));
        if (!visible || !res.locals.taskSessionsReadable) return res.status(404).json({ error: 'Task session not found.', code: 404 });
        if (req.method !== 'GET') return res.status(409).json({ error: 'Use task session commands.', code: 409 });
      }
    }
    next();
  } catch (error) {
    log.error('Calendar session boundary failed:', error);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.use(readRouter);
router.use(googleRouter);
router.use(appleRouter);
router.use(subscriptionsRouter);
router.use(feedRouter);
router.use(syncTargetsRouter);
// Scoped gesture/editor paths must run before the compatibility CRUD router.
router.use(editRouter);
router.use(crudRouter);
router.use(caldavRouter);
// Outlook nutzt wie CalDAV ausschließlich Mehr-Segment-Pfade (/outlook/...)
// und kollidiert daher nicht mit /:id.
router.use(outlookRouter);

export default router;

// Nur für Tests re-exportiert (test/test-google-multi.js) - Fläche unverändert.
export const __test = { googleTarget };
