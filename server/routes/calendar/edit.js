/**
 * Server-authoritative calendar gesture/editor edits.
 *
 * The legacy PUT handler remains in crud.js.  This router only claims a PUT
 * when the request explicitly carries edit_scope, keeping older clients on
 * their existing validation and outbound path.
 */

import express from 'express';
import * as db from '../../db.js';
import { visibilityWhere } from '../../services/visibility.js';
import {
  applyScopedCalendarEdit,
  CalendarEditError,
  checkRevision,
  resolveCalendarRecoveryFields,
} from '../../services/calendar-edit.js';
import {
  eventEditMetadata,
  getEditCapabilities,
} from '../../services/calendar-edit-metadata.js';
import {
  resolveCalendarEditConflict,
  retryCalendarEditOperations,
  discardCalendarRecovery,
} from '../../services/calendar-edit-operations.js';
import {
  flushOutbound,
  refreshCalendarProvider,
} from '../../services/calendar-outbound.js';
import {
  StorageError,
  cleanupStagedUpload,
  stageDocumentUpload,
} from '../../services/document-storage.js';
import {
  ASSIGNED_USERS_SQL,
  getUserId,
  parseAttachment,
  sendStorageError,
  serializeEvent,
} from './helpers.js';

const router = express.Router();

function eventId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function loadVisibleEvent(id, req) {
  const userId = getUserId(req);
  return db.get().prepare(`
    SELECT e.*,
           ${ASSIGNED_USERS_SQL}
    FROM calendar_events e
    WHERE e.id = ?
      AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
  `).get(id, userId, userId);
}

function loadEvent(id) {
  return db.get().prepare(`
    SELECT e.*,
           ${ASSIGNED_USERS_SQL}
    FROM calendar_events e
    WHERE e.id = ?
  `).get(id);
}

function resolveScopedEvent(event, req, body) {
  if (!event?.exception_of_event_id || body?.edit_scope === 'this') {
    return { event, body };
  }
  const parent = loadVisibleEvent(event.exception_of_event_id, req);
  if (!parent) {
    throw new CalendarEditError('The recurrence parent is no longer available.', 409);
  }
  if (body?.expected_parent_revision === undefined
      || body.expected_parent_revision === null
      || body.expected_parent_revision === '') {
    throw new CalendarEditError('expected_parent_revision is required for a parent scope.', 409, {
      conflict: {
        expected_revision: null,
        actual_revision: eventEditMetadata(db.get(), parent).revision,
      },
      data: { recurrence_parent: { id: parent.id } },
    });
  }
  const parentBody = {
    ...body,
    occurrence_start: event.exception_original_start || body.occurrence_start || event.start_datetime,
    expected_revision: body.expected_parent_revision,
  };
  // Detached rows intentionally have no recurrence rule of their own.  The
  // full editor still serializes that empty field, so inheriting it onto the
  // resolved parent would silently remove the series on a title-only save.
  // A client that intentionally changes/removes the parent rule must opt in
  // with recurrence_rule_explicit: true; this keeps legacy partial PUTs and
  // complete editor payloads compatible while retaining an explicit removal
  // path.
  const recurrenceWasExplicit = body.recurrence_rule_explicit === true;
  const emptyRecurrence = body.recurrence_rule === null
    || body.recurrence_rule === undefined
    || String(body.recurrence_rule).trim() === '';
  if (!recurrenceWasExplicit && emptyRecurrence && !event.recurrence_rule && parent.recurrence_rule) {
    parentBody.recurrence_rule = parent.recurrence_rule;
  }
  return { event: parent, body: parentBody };
}

function sendEditError(res, error) {
  if (!(error instanceof CalendarEditError)) {
    return res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
  const response = { error: error.message, code: error.status || 400 };
  if (error.reason) response.reason = error.reason;
  if (error.conflict) response.conflict = error.conflict;
  if (error.data) response.data = error.data;
  return res.status(error.status || 400).json(response);
}

async function prepareAttachmentChange(body) {
  const dataProvided = Object.hasOwn(body || {}, 'attachment_data');
  const replacementRequested = typeof body?.attachment_data === 'string'
    && body.attachment_data.trim() !== '';
  const removalRequested = body?.remove_attachment === true
    || (dataProvided && body.attachment_data === null);
  if (body?.remove_attachment !== undefined && typeof body.remove_attachment !== 'boolean') {
    throw new CalendarEditError('remove_attachment: muss ein Boolean sein.', 400);
  }
  if (replacementRequested && removalRequested) {
    throw new CalendarEditError('attachment_data und remove_attachment widersprechen sich.', 400);
  }
  if (replacementRequested) {
    let attachment;
    try {
      attachment = parseAttachment(body.attachment_data);
    } catch (error) {
      throw new CalendarEditError(error.message, 400);
    }
    let stagedUpload;
    try {
      stagedUpload = await stageDocumentUpload({
        buffer: attachment.buffer,
        mime: attachment.mime,
        category: 'other',
        originalName: body.attachment_name || 'Attachment',
      });
    } catch (error) {
      throw error;
    }
    return { mode: 'replace', attachment, stagedUpload, body };
  }
  return removalRequested ? { mode: 'remove', body } : null;
}

// GET /api/v1/calendar/:id/edit-context
router.get('/:id/edit-context', (req, res) => {
  try {
    const id = eventId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const event = loadVisibleEvent(id, req);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    const metadata = eventEditMetadata(db.get(), event);
    return res.json({
      data: {
        id,
        revision: metadata.revision,
        edit_capabilities: metadata.edit_capabilities,
        exception_summary: metadata.exception_summary,
        sync: metadata.sync,
        ...(metadata.original_occurrence_start
          ? { original_occurrence_start: metadata.original_occurrence_start } : {}),
        ...(metadata.recurrence_parent
          ? { recurrence_parent: metadata.recurrence_parent } : {}),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/calendar/:id/retry-sync
router.post('/:id/retry-sync', (req, res) => {
  try {
    const id = eventId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const event = loadVisibleEvent(id, req);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    const changed = retryCalendarEditOperations(id, db.get());
    const current = loadEvent(id) || event;
    res.json({ data: serializeEvent(current, db.get()) });
    if (changed) {
      flushOutbound().catch(() => {});
    }
    return undefined;
  } catch (error) {
    return res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// POST /api/v1/calendar/:id/reload-sync
// An explicit conflict reload releases the stale local edit from inbound
// protection.  It never marks the provider write complete and never retries it.
router.post('/:id/reload-sync', (req, res) => {
  try {
    const id = eventId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const event = loadVisibleEvent(id, req);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    const rawOperationId = req.body?.operation_id;
    const operationId = rawOperationId === undefined || rawOperationId === null || rawOperationId === ''
      ? null : eventId(rawOperationId);
    if (rawOperationId !== undefined && rawOperationId !== null && rawOperationId !== '' && !operationId) {
      return res.status(400).json({ error: 'Ungültige Operations-ID.', code: 400 });
    }
    // Capture sources before Reload can roll an unaccepted continuation back
    // into its parent and move the audit operation to that surviving row.
    const sources = db.get().prepare(`
      SELECT DISTINCT source FROM calendar_edit_operations
      WHERE event_id = ? AND status = 'error' AND failure_kind = 'provider_conflict'
        AND resolution IS NULL AND (? IS NULL OR id = ?)
    `).all(id, operationId, operationId).map((row) => row.source);
    const resolved = resolveCalendarEditConflict(id, operationId, db.get());
    const current = loadEvent(id) || event;
    const response = res.json({
      data: serializeEvent(current, db.get()),
      reload: { resolved_operations: resolved },
    });
    if (resolved) {
      for (const source of sources) {
        refreshCalendarProvider(source).catch(() => {});
      }
    }
    return response;
  } catch (error) {
    return res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// Explicit exceptional choices retain the usual successful-save flow.
router.post('/:id/resolve-recovery', (req, res) => {
  try {
    const id = eventId(req.params.id);
    const event = id && loadVisibleEvent(id, req);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    const current = resolveCalendarRecoveryFields({ database: db.get(), eventId: id,
      operationId: eventId(req.body?.operation_id), choices: req.body?.choices,
      expectedRevision: req.body?.expected_revision });
    res.json({ data: serializeEvent(current, db.get()) });
    flushOutbound().catch(() => {});
    return undefined;
  } catch (error) { return sendEditError(res, error); }
});

router.post('/:id/discard-recovery', (req, res) => {
  try {
    const id = eventId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const event = loadVisibleEvent(id, req);
    if (!event) {
      const discarded = db.get().prepare(`SELECT 1 FROM calendar_edit_operations
        WHERE resolution = 'discard_unsaved' AND created_by = ? AND json_extract(payload_json, '$.event_id') = ?`)
        .get(getUserId(req), id);
      if (discarded) return res.json({ data: null, recovery: { discarded: false } });
      return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    }
    const result = discardCalendarRecovery(id, db.get());
    return res.json({ data: loadEvent(id) ? serializeEvent(loadEvent(id), db.get()) : null, recovery: result });
  } catch (error) { return res.status(500).json({ error: 'Interner Fehler', code: 500 }); }
});

// PUT /api/v1/calendar/:id (scoped form)
router.put('/:id', async (req, res, next) => {
  // Presence is intentional: an invalid explicit scope must be rejected rather
  // than silently interpreted as a legacy full-event PUT.
  if (!Object.hasOwn(req.body || {}, 'edit_scope')) return next();
  let stagedUpload = null;
  try {
    const id = eventId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const selectedEvent = loadVisibleEvent(id, req);
    if (!selectedEvent) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    if (eventEditMetadata(db.get(), selectedEvent).sync.recovery) {
      throw new CalendarEditError('Review or discard retained changes before editing the original event.', 409, { reason: 'calendar_recovery_required' });
    }
    const resolved = resolveScopedEvent(selectedEvent, req, req.body || {});
    const event = resolved.event;
    const body = resolved.body || {};
    // Reject stale/read-only writes before staging an attachment in a remote
    // storage backend.  The service repeats these guards inside its transaction
    // so callers that use it directly retain the same invariant.
    try {
      checkRevision(event, body.expected_revision);
    } catch (error) {
      if (error instanceof CalendarEditError) return sendEditError(res, error);
      throw error;
    }
    const capabilities = getEditCapabilities(db.get(), event);
    if (!capabilities.editable) {
      return sendEditError(res, new CalendarEditError('This calendar event is read-only.', 409, {
        reason: capabilities.read_only_reason,
        data: { edit_capabilities: capabilities },
      }));
    }
    if (!capabilities.scopes?.[body.edit_scope]) {
      return sendEditError(res, new CalendarEditError('This provider does not support scoped edits.', 409, {
        reason: capabilities.scope_reason || 'provider_scope_unsupported',
        data: { edit_capabilities: capabilities },
      }));
    }
    const attachmentChange = await prepareAttachmentChange(body);
    stagedUpload = attachmentChange?.stagedUpload || null;
    const result = applyScopedCalendarEdit({
      database: db.get(),
      event,
      body,
      actorId: getUserId(req),
      attachmentChange,
    });
    // The transaction now owns the staged object through its document row.
    if (attachmentChange?.committed) stagedUpload = null;
    const current = loadEvent(result.eventId) || result.data;
    res.json({
      data: serializeEvent(current, db.get()),
      edit: result.edit,
    });
    return undefined;
  } catch (error) {
    if (stagedUpload) {
      try { await cleanupStagedUpload(stagedUpload); } catch { /* preserve the original response */ }
    }
    if (error instanceof StorageError) {
      sendStorageError(res, error, 'Der Anhang konnte nicht gespeichert werden.');
      return undefined;
    }
    if (error instanceof CalendarEditError) return sendEditError(res, error);
    return res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
