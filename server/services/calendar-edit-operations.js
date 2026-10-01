/**
 * Durable queue for provider work created by a scoped calendar edit.
 *
 * The route owns the local transaction and writes one complete before/after
 * payload. Provider adapters claim these rows later and report the provider's
 * actual outcome. Keeping this queue separate from `outbound_dirty` preserves
 * the established normal PUT path while making recurring occurrence edits
 * explicit and retryable.
 */

import { randomBytes } from 'node:crypto';
import * as dbmod from '../db.js';
import { utcToWall } from '../utils/timezone.js';

export const SCOPED_OPERATION_STATUSES = ['pending', 'processing', 'retry', 'error', 'completed'];
// A provider worker may disappear after claiming a row.  The lease is short
// enough to make a crashed edit visible on the next sync, while leaving enough
// time for one network request and its conditional response.
export const SCOPED_OPERATION_LEASE_MS = 5 * 60 * 1000;

function databaseOrDefault(database) {
  return database || dbmod.get();
}

function nowIso() {
  return new Date().toISOString();
}

function leaseExpiry(stamp = Date.now()) {
  return new Date(stamp + SCOPED_OPERATION_LEASE_MS).toISOString();
}

function newClaimToken() {
  return randomBytes(24).toString('base64url');
}

function normalizeClaim(claim) {
  if (!claim || typeof claim !== 'object') return null;
  const token = claim.claim_token ?? claim.claimToken;
  const generation = claim.claim_generation ?? claim.claimGeneration;
  if (typeof token !== 'string' || !token) return null;
  const parsedGeneration = Number(generation);
  if (!Number.isSafeInteger(parsedGeneration) || parsedGeneration < 1) return null;
  return { token, generation: parsedGeneration };
}

function claimWhere(claim) {
  const normalized = normalizeClaim(claim);
  return normalized
    ? { sql: 'claim_token = ? AND claim_generation = ?', values: [normalized.token, normalized.generation] }
    : null;
}

function boundedError(error) {
  const message = error?.message || String(error || 'Provider operation failed.');
  return message.slice(0, 500);
}

function hasQueue(database) {
  try {
    database.prepare('SELECT 1 FROM calendar_edit_operations LIMIT 1').get();
    return true;
  } catch (error) {
    if (String(error?.message || '').includes('no such table')) return false;
    throw error;
  }
}

/**
 * Queue one provider operation inside the caller's local transaction.
 * @returns {number|null} operation id
 */
export function queueCalendarEditOperation({
  eventId,
  source,
  scope,
  occurrenceStart = null,
  payload,
  createdBy = null,
}, database = null) {
  const d = databaseOrDefault(database);
  if (!eventId || !['google', 'caldav', 'apple'].includes(source)) return null;
  if (!['this', 'following', 'series'].includes(scope)) return null;
  if (!payload || typeof payload !== 'object') throw new TypeError('A scoped edit payload is required.');
  if (!hasQueue(d)) return null;

  const json = JSON.stringify(payload);
  const result = d.prepare(`
    INSERT INTO calendar_edit_operations
      (event_id, source, scope, operation, occurrence_start, payload_json,
       status, attempts, last_error, created_by, created_at, updated_at,
       claim_expires_at, retryable)
    VALUES (?, ?, ?, 'scoped_edit', ?, ?, 'pending', 0, NULL, ?, ?, ?, NULL, 1)
  `).run(eventId, source, scope, occurrenceStart, json, createdBy, nowIso(), nowIso());
  d.prepare(`
    UPDATE calendar_events
    SET sync_state = 'pending', sync_error = NULL
    WHERE id = ?
  `).run(eventId);
  return Number(result.lastInsertRowid);
}

/**
 * Return processing rows whose worker lease expired to retryable work.  This is
 * deliberately called by every queue entry point, including metadata reads, so
 * a crashed worker cannot leave an event looking permanently busy until a full
 * provider restart.
 */
export function recoverExpiredCalendarEditOperations(database = null) {
  const d = databaseOrDefault(database);
  if (!hasQueue(d)) return 0;
  const now = nowIso();
  const rows = d.prepare(`
    SELECT id, event_id, claim_token, claim_generation
    FROM calendar_edit_operations
    WHERE status = 'processing'
      AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
  `).all(now);
  if (!rows.length) return 0;
  const update = d.prepare(`
    UPDATE calendar_edit_operations
    SET status = 'retry', retryable = 1,
        last_error = COALESCE(last_error, 'Provider operation lease expired; retrying.'),
        claimed_at = NULL, claim_expires_at = NULL, claim_token = NULL, updated_at = ?
    WHERE id = ? AND status = 'processing'
      AND claim_token = ? AND claim_generation = ?
  `);
  let recovered = 0;
  for (const row of rows) {
    const result = update.run(now, row.id, row.claim_token, row.claim_generation);
    if (result.changes === 1) {
      recovered++;
      refreshEventSyncState(row.event_id, d);
    }
  }
  return recovered;
}

function parseOperation(row) {
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
  let progress = null;
  try { progress = row.progress_json ? JSON.parse(row.progress_json) : null; } catch { progress = null; }
  return { ...row, payload, progress };
}

function operationIdentity(operation) {
  const payload = operation?.payload || {};
  const provider = payload.provider && typeof payload.provider === 'object'
    ? payload.provider : {};
  return {
    // Progress is durable before completion and may contain a continuation
    // accepted by the provider while the local row still has no external id.
    provider_ids: [
      operation?.progress?.old_master?.id, operation?.progress?.old_master?.uid,
      operation?.progress?.continuation_master?.id, operation?.progress?.continuation_master?.uid,
      ...Object.values(operation?.progress?.exception_operations || {}).map((item) => (
        item?.id || item?.providerUid || item?.provider_uid || item?.eventId
      )),
    ].filter(Boolean).map(String),
    event_id: operation?.event_id ?? payload.event_id ?? null,
    parent_event_id: payload.parent_event_id ?? null,
    master_external_id: payload.master_external_id
      ?? provider.masterId
      ?? provider.eventId
      ?? provider.uid
      ?? null,
    provider_uid: provider.uid
      ?? provider.eventId
      ?? payload.provider_uid
      ?? null,
    target_calendar_id: payload.target_calendar_id
      ?? provider.calendarId
      ?? provider.calendarUrl
      ?? null,
    provider_revision: payload.provider_revision
      ?? provider.etag
      ?? null,
  };
}

function providerDetail(details, camel, snake = camel) {
  if (!details || typeof details !== 'object') return null;
  return details[camel] ?? details[snake] ?? null;
}

function mergeProviderExceptionResults(payload, details) {
  const results = details?.exceptionOperations || details?.exception_operations;
  if (!Array.isArray(results) || !results.length || !payload?.split) return payload;
  const operations = Array.isArray(payload.split.exception_operations)
    ? payload.split.exception_operations : [];
  if (!operations.length) return payload;
  const updated = operations.map((item, index) => {
    const result = results[index] || results.find((candidate) => (
      candidate?.previous_original_start
      && candidate.previous_original_start === item.previous_original_start
    ));
    if (!result || typeof result !== 'object') return item;
    const providerUid = result.providerUid ?? result.provider_uid ?? result.eventId ?? null;
    const providerEtag = result.providerEtag ?? result.provider_etag ?? result.etag ?? null;
    const provider = {
      ...(item.provider || {}),
      ...(providerUid ? { eventId: providerUid } : {}),
      ...(providerEtag ? { etag: providerEtag } : {}),
    };
    return {
      ...item,
      ...(providerUid ? { eventId: providerUid } : {}),
      ...(providerEtag ? { etag: providerEtag } : {}),
      provider,
      provider_result: result,
    };
  });
  return { ...payload, split: { ...payload.split, exception_operations: updated } };
}

function exceptionResult(details, item, index) {
  const results = details?.exceptionOperations || details?.exception_operations;
  if (!Array.isArray(results)) return null;
  return results[index] || results.find((candidate) => (
    candidate?.local_event_id && candidate.local_event_id === item.local_event_id
  )) || results.find((candidate) => (
    candidate?.previous_original_start
      && candidate.previous_original_start === item.previous_original_start
  )) || null;
}

function acceptedReloadExceptions(operation, continuation) {
  const items = operation.payload?.split?.exception_operations || [];
  return items.map((item, index) => {
    const key = String(item.local_event_id ?? item.localEventId
      ?? item.previous_original_start ?? item.original_start ?? index);
    const accepted = operation.progress?.exception_operations?.[key];
    if (operation.source === 'google' && !accepted?.accepted) return null;
    if (operation.source === 'caldav' && continuation.accepted !== true) return null;
    const start = String(item.continuation_start || item.original_start || '');
    const zone = operation.payload?.split?.new_master?.tzid || operation.payload?.tzid || operation.payload?.provider?.tzid;
    const wall = zone && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(start) ? utcToWall(start, zone) : null;
    const date = wall?.date || start.slice(0, 10);
    return {
      local_event_id: item.local_event_id,
      providerUid: operation.source === 'google' ? accepted.provider_uid
        : item.local_event_id && date ? continuation.id + '::' + date : null,
      providerEtag: operation.source === 'google' ? accepted.etag : continuation.etag,
      providerObjectUrl: continuation.url,
      providerCalendarId: operation.source === 'google' ? operation.payload.target_calendar_id : null,
      providerCalendarUrl: operation.source === 'caldav' ? operation.payload.target_calendar_id : null,
    };
  });
}

function reconcileProviderExceptionIdentities(database, operation, payload, details) {
  const items = payload?.split?.exception_operations;
  if (!Array.isArray(items) || !items.length) return;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const result = exceptionResult(details, item, index);
    if (!result || typeof result !== 'object') continue;
    const providerUid = result.providerUid ?? result.provider_uid ?? result.eventId ?? null;
    const providerEtag = result.providerEtag ?? result.provider_etag ?? result.etag ?? null;
    const providerObjectUrl = result.providerObjectUrl ?? result.provider_object_url ?? null;
    const providerCalendarUrl = result.providerCalendarUrl ?? result.provider_calendar_url ?? null;
    const providerCalendarId = result.providerCalendarId ?? result.provider_calendar_id ?? null;
    const providerCalendarRefId = result.providerCalendarRefId ?? result.provider_calendar_ref_id ?? null;
    if (!providerUid && !providerEtag && !providerObjectUrl) continue;

    let eventId = Number(item.local_event_id);
    if (!Number.isSafeInteger(eventId) || eventId < 1) {
      try {
        eventId = database.prepare(`
          SELECT id FROM calendar_events
          WHERE exception_of_event_id = ?
            AND exception_original_start IN (?, ?)
          ORDER BY id LIMIT 1
        `).get(
          operation.event_id,
          item.original_start || item.previous_original_start || null,
          item.previous_original_start || item.original_start || null,
        )?.id;
      } catch { eventId = null; }
    }
    if (!eventId) continue;
    const fields = [];
    const values = [];
    if (providerUid) { fields.push('external_calendar_id = ?'); values.push(String(providerUid)); }
    if (operation.source) { fields.push('external_source = ?'); values.push(operation.source); }
    if (providerObjectUrl) { fields.push('external_object_url = ?'); values.push(String(providerObjectUrl)); }
    if (providerEtag) { fields.push('provider_revision = ?'); values.push(String(providerEtag)); }
    if (providerCalendarRefId !== null && providerCalendarRefId !== undefined) {
      fields.push('calendar_ref_id = ?'); values.push(Number(providerCalendarRefId) || null);
    }
    if (operation.source === 'google' && providerCalendarId) {
      fields.push('target_google_calendar_id = ?'); values.push(String(providerCalendarId));
    }
    if (operation.source === 'caldav' && providerCalendarUrl) {
      fields.push('target_caldav_calendar_url = ?'); values.push(String(providerCalendarUrl));
    }
    if (!fields.length) continue;
    try {
      const previous = database.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(eventId);
      database.prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ?`)
        .run(...values, eventId);
      // A newer occurrence edit may have been queued before this transfer was
      // accepted. Rebind only that known identity transition, retaining its
      // captured conditional revision against any later external change.
      if (operation.source === 'google' && providerUid && providerEtag) {
        for (const sibling of activeCalendarEditOperations('google', database)) {
          if (sibling.id === operation.id || sibling.event_id !== eventId || sibling.scope !== 'this'
              || sibling.status === 'processing') continue;
          const provider = sibling.payload?.provider || {};
          if (provider.occurrenceId && provider.occurrenceId !== previous?.external_calendar_id) continue;
          const nextPayload = { ...sibling.payload, provider: { ...provider,
            occurrenceId: providerUid, occurrenceEtag: providerEtag } };
          database.prepare('UPDATE calendar_edit_operations SET payload_json = ? WHERE id = ?')
            .run(JSON.stringify(nextPayload), sibling.id);
        }
      }
    } catch (error) {
      if (!/no such column/i.test(String(error?.message || ''))) throw error;
    }
  }
}

function reconcileProviderExclusionDates(database, operation, payload, actualDates = null) {
  const exclusions = (payload?.split?.exception_operations || []).filter((item) => (
    String(item.method).toLowerCase() === 'delete' && !item.local_event_id
  ));
  if (!exclusions.length) return;
  const zone = payload.split?.new_master?.tzid;
  const dateKey = (value) => {
    const raw = String(value || '');
    const wall = zone && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? utcToWall(raw, zone) : null;
    return wall?.date || raw.slice(0, 10);
  };
  // DATE exclusions move by civil dates. Remove the source identities as a
  // batch before adding continuation identities, so daily series cannot retain
  // both an old canceled day and the rebased canceled day after inbound.
  for (const item of exclusions) database.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ? AND exception_date = ?')
    .run(operation.event_id, dateKey(item.previous_original_start || item.original_start));
  const dates = actualDates || exclusions.map((item) => dateKey(item.continuation_start || item.occurrence_start));
  for (const date of dates) database.prepare('INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
    .run(operation.event_id, date);
}

/**
 * Reconcile the provider identity returned after a durable operation.  A
 * detached local row starts without an external id; following creates a new
 * provider master; and `this` providers may return an occurrence id such as
 * CalDAV UID::date. Persisting that identity on the operation's event row lets
 * the next inbound sync match the result without inventing a duplicate.
 */

function reconcileProviderIdentity(database, operation, details) {
  const providerUid = providerDetail(details, 'providerUid', 'provider_uid');
  const providerObjectUrl = providerDetail(details, 'providerObjectUrl', 'provider_object_url');
  const providerCalendarUrl = providerDetail(details, 'providerCalendarUrl', 'provider_calendar_url');
  const providerCalendarId = providerDetail(details, 'providerCalendarId', 'provider_calendar_id');
  let providerCalendarRefId = providerDetail(details, 'providerCalendarRefId', 'provider_calendar_ref_id');
  if (providerCalendarRefId == null && (providerCalendarId || providerCalendarUrl)) {
    try {
      providerCalendarRefId = database.prepare(
        'SELECT id FROM external_calendars WHERE source = ? AND external_id = ?'
      ).get(operation.source, providerCalendarId || providerCalendarUrl)?.id ?? null;
    } catch (error) {
      if (!/no such (table|column)/i.test(String(error?.message || ''))) throw error;
    }
  }
  const providerEtag = providerDetail(details, 'providerEtag', 'provider_etag')
    ?? providerDetail(details, 'etag', 'eTag');
  if (!operation?.event_id) return;

  const fields = [];
  const values = [];
  if (providerUid) {
    fields.push('external_calendar_id = ?');
    values.push(String(providerUid));
  }
  if (operation.source) {
    fields.push('external_source = ?');
    values.push(operation.source);
  }
  if (providerObjectUrl) {
    fields.push('external_object_url = ?');
    values.push(String(providerObjectUrl));
  }
  if (providerCalendarRefId !== null && providerCalendarRefId !== undefined) {
    fields.push('calendar_ref_id = ?');
    values.push(Number(providerCalendarRefId) || null);
  }
  if (operation.source === 'google' && providerCalendarId) {
    fields.push('target_google_calendar_id = ?');
    values.push(String(providerCalendarId));
  }
  if (operation.source === 'caldav' && providerCalendarUrl) {
    fields.push('target_caldav_calendar_url = ?');
    values.push(String(providerCalendarUrl));
  }
  if (providerEtag) {
    fields.push('provider_revision = ?');
    values.push(String(providerEtag));
  }
  if (!fields.length) return;
  try {
    database.prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values, operation.event_id);
  } catch (error) {
    // Focused provider tests may use a pre-migration event table. Completion
    // remains durable in the operation row; only a missing migration column is
    // tolerated here.
    if (!/no such column/i.test(String(error?.message || ''))) throw error;
    if (providerEtag) {
      try {
        database.prepare('UPDATE calendar_events SET provider_revision = ? WHERE id = ?')
          .run(String(providerEtag), operation.event_id);
      } catch (fallbackError) {
        if (!/no such column/i.test(String(fallbackError?.message || ''))) throw fallbackError;
      }
    }
  }
}

/** Provider-facing list of work waiting for this source. */
export function pendingCalendarEditOperations(source = null, database = null) {
  const d = databaseOrDefault(database);
  if (!hasQueue(d)) return [];
  recoverExpiredCalendarEditOperations(d);
  const rows = source
    ? d.prepare(`
        SELECT * FROM calendar_edit_operations
        WHERE source = ? AND status IN ('pending', 'retry')
          AND resolution IS NULL
        ORDER BY id
      `).all(source)
    : d.prepare(`
        SELECT * FROM calendar_edit_operations
        WHERE status IN ('pending', 'retry')
          AND resolution IS NULL
        ORDER BY id
      `).all();
  return rows.map(parseOperation).filter((operation) => !operation.payload?.split_reload_dependency && !operation.payload?.provider_dependency_operation_id);
}

/**
 * All durable work that can affect a provider identity, including a claimed
 * operation currently in flight or a failed operation awaiting user retry.
 * Inbound sync uses this view to protect both the master row and any detached
 * or continuation row named by the payload from an older provider snapshot.
 */
export function activeCalendarEditOperations(source = null, database = null) {
  const d = databaseOrDefault(database);
  if (!hasQueue(d)) return [];
  recoverExpiredCalendarEditOperations(d);
  const rows = source
    ? d.prepare(`
        SELECT * FROM calendar_edit_operations
        WHERE source = ? AND status IN ('pending', 'processing', 'retry', 'error')
          AND resolution IS NULL
        ORDER BY id
      `).all(source)
    : d.prepare(`
        SELECT * FROM calendar_edit_operations
        WHERE status IN ('pending', 'processing', 'retry', 'error')
          AND resolution IS NULL
        ORDER BY id
      `).all();
  return rows.map((row) => {
    const operation = parseOperation(row);
    return { ...operation, identity: operationIdentity(operation) };
  });
}

/**
 * Atomically claim a pending/retry row. A second sync worker receives null and
 * must leave the operation to the worker that owns it.
 */
export function claimCalendarEditOperation(id, database = null) {
  const d = databaseOrDefault(database);
  if (!hasQueue(d)) return null;
  recoverExpiredCalendarEditOperations(d);
  const waiting = parseOperation(d.prepare('SELECT * FROM calendar_edit_operations WHERE id = ?').get(id));
  if (waiting?.payload?.split_reload_dependency || waiting?.payload?.provider_dependency_operation_id) return null;
  const stamp = nowIso();
  const token = newClaimToken();
  const result = d.prepare(`
    UPDATE calendar_edit_operations
    SET status = 'processing', attempts = attempts + 1,
        claimed_at = ?, claim_expires_at = ?, claim_token = ?,
        claim_generation = COALESCE(claim_generation, 0) + 1,
        updated_at = ?, retryable = 1
    WHERE id = ? AND status IN ('pending', 'retry')
      AND resolution IS NULL
  `).run(stamp, leaseExpiry(Date.parse(stamp)), token, stamp, id);
  if (result.changes !== 1) return null;
  return parseOperation(d.prepare('SELECT * FROM calendar_edit_operations WHERE id = ?').get(id));
}

function refreshEventSyncState(eventId, database) {
  if (!eventId || !hasQueue(database)) return;
  const outstanding = database.prepare(`
    SELECT status, last_error, attempts
    FROM calendar_edit_operations
    WHERE event_id = ? AND status IN ('pending', 'processing', 'retry', 'error')
      AND resolution IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(eventId);
  if (!outstanding) {
    database.prepare(`
      UPDATE calendar_events SET sync_state = 'clean', sync_error = NULL WHERE id = ?
    `).run(eventId);
    return;
  }
  const state = outstanding.status === 'error' ? 'error' : 'pending';
  database.prepare(`
    UPDATE calendar_events SET sync_state = ?, sync_error = ? WHERE id = ?
  `).run(state, outstanding.last_error || null, eventId);
}

/**
 * Checkpoint provider progress while a worker owns the lease.  A late worker
 * must not be able to replace a newer worker's continuation id or ETag.
 */
export function updateCalendarEditOperationProgress(
  id,
  progress,
  database = null,
  claim = null,
) {
  const d = databaseOrDefault(database);
  const guard = claimWhere(claim);
  if (!hasQueue(d) || !guard || !progress || typeof progress !== 'object') return false;
  const stamp = nowIso();
  const result = d.prepare(`
    UPDATE calendar_edit_operations
    SET progress_json = ?, progress_updated_at = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND ${guard.sql}
  `).run(JSON.stringify(progress), stamp, stamp, id, ...guard.values);
  if (result.changes !== 1) return false;
  return parseOperation(d.prepare('SELECT * FROM calendar_edit_operations WHERE id = ?').get(id));
}

/** Mark a row complete only after a provider has accepted the exact operation. */
export function completeCalendarEditOperation(id, details = {}, database = null, claim = null) {
  const d = databaseOrDefault(database);
  const guard = claimWhere(claim);
  if (!hasQueue(d) || !guard) return false;
  const stamp = nowIso();
  const operation = d.prepare(`
    SELECT event_id, source, scope, payload_json
    FROM calendar_edit_operations WHERE id = ?
  `).get(id);
  if (!operation) return false;
  // A savepoint also works inside an existing transaction and with the
  // focused SQLite test handles. Status, result, identities and sync state
  // either become durable together or all remain owned by the same claim.
  d.exec('SAVEPOINT calendar_edit_completion');
  try {
    const changed = d.prepare(`
      UPDATE calendar_edit_operations
      SET status = 'completed', last_error = NULL, retryable = 0,
          claimed_at = NULL, claim_expires_at = NULL, claim_token = NULL,
          resolution = NULL, failure_kind = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND ${guard.sql}
    `).run(stamp, stamp, id, ...guard.values);
    if (changed.changes !== 1) {
      d.exec('RELEASE calendar_edit_completion');
      return false;
    }

    // Provider adapters may learn a remote occurrence id or etag while applying
    // the operation. Keep that information in the payload without making the
    // core schema provider-specific.
    let payload = {};
    try { payload = JSON.parse(operation.payload_json) || {}; } catch { /* keep empty */ }
    if (details && typeof details === 'object' && Object.keys(details).length) {
      payload.provider_result = details;
      payload = mergeProviderExceptionResults(payload, details);
      d.prepare('UPDATE calendar_edit_operations SET payload_json = ?, updated_at = ? WHERE id = ? AND status = \'completed\'')
        .run(JSON.stringify(payload), nowIso(), id);
    }
    reconcileProviderIdentity(d, operation, details);
    reconcileProviderExceptionIdentities(d, operation, payload, details);
    reconcileProviderExclusionDates(d, operation, payload);
    // Dependent occurrence/following edits can now target the accepted master.
    // They retain their own payload and intent, rather than being marked done.
    for (const dependentId of payload.split_reload_dependents || []) {
      const dependent = parseOperation(d.prepare('SELECT * FROM calendar_edit_operations WHERE id = ? AND resolution IS NULL').get(dependentId));
      if (dependent?.payload?.provider_dependency_operation_id !== id || dependent.status === 'processing') continue;
      const provider = { ...dependent.payload.provider,
        masterId: details.providerUid, eventId: details.providerUid, uid: details.providerUid,
        etag: details.providerEtag, objectUrl: details.providerObjectUrl,
      };
      const nextPayload = { ...dependent.payload, master_external_id: details.providerUid,
        provider_revision: details.providerEtag, provider };
      delete nextPayload.provider_dependency_operation_id;
      d.prepare('UPDATE calendar_edit_operations SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify(nextPayload), dependent.id);
    }
    refreshEventSyncState(operation.event_id, d);
    d.exec('RELEASE calendar_edit_completion');
    return true;
  } catch (error) {
    d.exec('ROLLBACK TO calendar_edit_completion');
    d.exec('RELEASE calendar_edit_completion');
    throw error;
  }
}

/** Record a bounded provider failure and retain the operation for retry when requested. */
export function failCalendarEditOperation(
  id,
  error,
  { retryable = true, conflict = false } = {},
  database = null,
  claim = null,
) {
  const d = databaseOrDefault(database);
  const guard = claimWhere(claim);
  if (!hasQueue(d) || !guard) return false;
  const operation = d.prepare('SELECT event_id FROM calendar_edit_operations WHERE id = ?').get(id);
  if (!operation) return false;
  const statusCode = Number(error?.status ?? error?.code ?? error?.response?.status) || null;
  const providerConflict = conflict || error?.conflict === true || statusCode === 409 || statusCode === 412;
  const stamp = nowIso();
  const status = retryable ? 'retry' : 'error';
  const message = boundedError(error);
  const changed = d.prepare(`
    UPDATE calendar_edit_operations
    SET status = ?, retryable = ?, last_error = ?, failure_kind = ?, resolution = NULL,
        updated_at = ?, claimed_at = NULL, claim_expires_at = NULL, claim_token = NULL
    WHERE id = ? AND status = 'processing' AND ${guard.sql}
  `).run(
    status, retryable ? 1 : 0, message, providerConflict ? 'provider_conflict' : null,
    stamp, id, ...guard.values,
  );
  if (changed.changes !== 1) return false;
  d.prepare(`
    UPDATE calendar_events
    SET sync_state = ?, sync_error = ?
    WHERE id = ?
  `).run(retryable ? 'pending' : 'error', message, operation.event_id);
  return true;
}

/**
 * Explicitly discard one provider conflict after the user chooses Reload.
 * Keeping the row as an audit record while adding a resolution lets inbound
 * sync stop protecting the stale local edit without claiming provider success.
 */
export function resolveCalendarEditConflict(eventId, operationId = null, database = null) {
  const d = databaseOrDefault(database);
  if (!hasQueue(d)) return 0;
  const candidates = d.prepare(`
    SELECT * FROM calendar_edit_operations
    WHERE event_id = ? AND status = 'error'
      AND failure_kind = 'provider_conflict' AND resolution IS NULL
      AND (? IS NULL OR id = ?)
  `).all(eventId, operationId, operationId).map(parseOperation);
  if (!candidates.length) return 0;
  d.exec('SAVEPOINT calendar_edit_reload');
  try {
    const stamp = nowIso();
    for (const operation of candidates) {
      d.prepare(`
        UPDATE calendar_edit_operations
        SET resolution = 'reload', retryable = 0, updated_at = ?,
            claimed_at = NULL, claim_expires_at = NULL, claim_token = NULL
        WHERE id = ?
      `).run(stamp, operation.id);
      let readbackId = eventId;
      const parentId = operation.payload?.parent_event_id;
      if (operation.scope === 'following' && parentId && parentId !== eventId) {
        const continuation = operation.progress?.continuation_master;
        const row = d.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(eventId);
        const siblings = activeCalendarEditOperations(null, d).filter((item) => (
          item.event_id === eventId || item.payload?.parent_event_id === eventId
        ));
        if (operation.source === 'caldav' && continuation?.id && continuation.attempted === true
            && continuation.accepted !== true) {
          // An attempted create is not proof of acceptance. Keep the local
          // identity graph protected until its actual resource is read back.
          const payload = { ...operation.payload, reload_readback_pending: true };
          d.prepare('UPDATE calendar_edit_operations SET payload_json = ? WHERE id = ?')
            .run(JSON.stringify(payload), operation.id);
        } else if (continuation?.id && (continuation.accepted === true || continuation.attempted === true)) {
          // Never delete a provider continuation accepted before a later failure.
          // Its readback must update the existing optimistic row.
          reconcileProviderIdentity(d, operation, {
            providerUid: continuation.id, providerEtag: continuation.etag,
            providerObjectUrl: continuation.url,
            providerCalendarId: operation.source === 'google' ? operation.identity?.target_calendar_id
              || operation.payload?.target_calendar_id : null,
            providerCalendarUrl: operation.source === 'caldav' ? operation.payload?.target_calendar_id : null,
          });
          reconcileProviderExceptionIdentities(d, operation, operation.payload, {
            exceptionOperations: acceptedReloadExceptions(operation, continuation),
          });
        } else if (!row?.external_calendar_id && !siblings.length
            && operation.progress?.old_master?.accepted !== true) {
          // The first master write was rejected. Undo only this local split;
          // authoritative inbound restores the parent fields and rule. Restore
          // moved exceptions without overwriting their independently edited data.
          d.prepare(`
            INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
            SELECT ?, exception_date FROM calendar_event_exceptions WHERE event_id = ?
          `).run(parentId, eventId);
          d.prepare(`
            UPDATE calendar_events SET exception_of_event_id = ?
            WHERE exception_of_event_id = ?
          `).run(parentId, eventId);
          d.prepare('UPDATE calendar_edit_operations SET event_id = ? WHERE id = ?').run(parentId, operation.id);
          d.prepare("DELETE FROM reminders WHERE entity_type = 'event' AND entity_id = ?").run(eventId);
          d.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
          readbackId = parentId;
        } else if (!row?.external_calendar_id && siblings.length
            && operation.progress?.old_master?.accepted !== true) {
          // Preserve newer child intent, but wait for a concrete authoritative
          // parent before regenerating the chosen tail with its fresh revision.
          for (const sibling of siblings) {
            const payload = { ...sibling.payload, split_reload_dependency: {
              parent_event_id: parentId, discarded_operation_id: operation.id,
              continuation_event_id: eventId, occurrence_start: operation.occurrence_start,
              confirmed_base: operation.payload.before,
              failed_continuation: operation.payload.after,
            } };
            d.prepare(`UPDATE calendar_edit_operations SET payload_json = ?, updated_at = ?,
              status = 'pending', failure_kind = NULL, last_error = NULL,
              claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL,
              claim_generation = claim_generation + 1 WHERE id = ?`)
              .run(JSON.stringify(payload), stamp, sibling.id);
          }
          d.prepare(`
            INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
            SELECT ?, exception_date FROM calendar_event_exceptions WHERE event_id = ?
          `).run(parentId, eventId);
          d.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(eventId);
          d.prepare('UPDATE calendar_events SET exception_of_event_id = ? WHERE exception_of_event_id = ?')
            .run(parentId, eventId);
          d.prepare('UPDATE calendar_edit_operations SET event_id = ? WHERE id = ?').run(parentId, operation.id);
          readbackId = parentId;
        }
      }
      d.prepare(`
        UPDATE calendar_events SET sync_state = 'pending',
          sync_error = 'Provider conflict discarded; waiting for authoritative refresh.'
        WHERE id = ?
      `).run(readbackId);
      // Newer operations keep their own visible error/pending state.
      const outstanding = d.prepare(`
        SELECT 1 FROM calendar_edit_operations WHERE event_id = ?
          AND status IN ('pending', 'processing', 'retry', 'error') AND resolution IS NULL
      `).get(readbackId);
      if (outstanding) refreshEventSyncState(readbackId, d);
    }
    d.exec('RELEASE calendar_edit_reload');
    return candidates.length;
  } catch (error) {
    d.exec('ROLLBACK TO calendar_edit_reload');
    d.exec('RELEASE calendar_edit_reload');
    throw error;
  }
}


/** Resolved uncertain writes still own their local identity graph until readback. */
export function pendingCalendarEditReadbacks(source, database = null) {
  const d = databaseOrDefault(database);
  if (!hasQueue(d)) return [];
  return d.prepare("SELECT * FROM calendar_edit_operations WHERE source = ? AND resolution = 'reload'")
    .all(source).map(parseOperation).filter((operation) => operation.payload?.reload_readback_pending);
}

/** Terminal recovery retains the user's data and fences every prior claim. */
function retainedCalendarChanges(payload) {
  const intent = payload?.edit_intent;
  return { ...(intent?.fields || {}),
    ...(Array.isArray(intent?.assigned_to) ? { assigned_to: intent.assigned_to } : {}),
  };
}

export function retainCalendarRecoveryError(operations, kind, message, database = null, recovery = {}) {
  const d = databaseOrDefault(database);
  for (const operation of operations) {
    const payload = { ...operation.payload, recovery: {
      parent_event_id: operation.payload?.split_reload_dependency?.parent_event_id ?? operation.payload?.parent_event_id,
      retained_changes: retainedCalendarChanges(operation.payload), ...recovery,
    } };
    d.prepare(`UPDATE calendar_edit_operations SET status = 'error', retryable = 0,
      failure_kind = ?, last_error = ?, payload_json = ?, claim_token = NULL,
      claim_expires_at = NULL, claimed_at = NULL, claim_generation = claim_generation + 1
      WHERE id = ? AND resolution IS NULL`).run(kind, message, JSON.stringify(payload), operation.id);
    d.prepare("UPDATE calendar_events SET sync_state = 'error', sync_error = ? WHERE id = ?")
      .run(message, operation.event_id);
  }
}

/** Local discard never enters the outbound deletion queue. */
export function discardCalendarRecovery(eventId, database = null) {
  const d = databaseOrDefault(database);
  const operations = activeCalendarEditOperations(null, d).filter((operation) => operation.event_id === eventId
    && (operation.payload?.recovery || operation.payload?.split_reload_dependency));
  if (!operations.length) return { discarded: false };
  d.exec('SAVEPOINT calendar_recovery_discard');
  try {
    const parentId = operations[0].payload.recovery?.parent_event_id
      ?? operations[0].payload.split_reload_dependency?.parent_event_id;
    for (const operation of operations) {
      const payload = { ...operation.payload, recovery: null, reload_readback_pending: false };
      d.prepare(`UPDATE calendar_edit_operations SET resolution = 'discard_unsaved', retryable = 0,
        payload_json = ?, claim_token = NULL, claim_expires_at = NULL, claimed_at = NULL,
        claim_generation = claim_generation + 1 WHERE id = ?`).run(JSON.stringify(payload), operation.id);
    }
    const siblings = activeCalendarEditOperations(null, d).filter((operation) => operation.payload?.parent_event_id === eventId);
    if (siblings.length) retainCalendarRecoveryError(siblings, 'recovery_occurrence_missing',
      'The selected occurrence no longer exists. Review changes and the original series, choose an existing occurrence, or discard unsaved changes.', d,
      { parent_event_id: parentId });
    if (parentId && parentId !== eventId) {
      d.prepare('UPDATE calendar_events SET exception_of_event_id = ? WHERE exception_of_event_id = ?').run(parentId, eventId);
      d.prepare("DELETE FROM reminders WHERE entity_type = 'event' AND entity_id = ?").run(eventId);
      d.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
    } else {
      const authoritative = operations[0].payload.recovery?.authoritative;
      if (!authoritative) throw new Error('Authoritative recovery data is unavailable.');
      const fields = ['title', 'description', 'location', 'start_datetime', 'end_datetime', 'all_day', 'recurrence_rule'];
      d.prepare(`UPDATE calendar_events SET ${fields.map((key) => key + ' = ?').join(', ')}, sync_state = 'clean', sync_error = NULL WHERE id = ?`)
        .run(...fields.map((key) => authoritative[key] ?? null), eventId);
    }
    d.exec('RELEASE calendar_recovery_discard');
    return { discarded: true, parent_event_id: parentId ?? null };
  } catch (error) {
    d.exec('ROLLBACK TO calendar_recovery_discard');
    d.exec('RELEASE calendar_recovery_discard');
    throw error;
  }
}

/** Only a complete successful collection fetch can establish resource absence. */
export function reconcileAbsentCalendarReadbacks(calendarUrl, presentUids, { complete = false } = {}, database = null) {
  if (!complete) return 0;
  const d = databaseOrDefault(database);
  let resolved = 0;
  for (const operation of pendingCalendarEditReadbacks('caldav', d)) {
    if (operation.payload.target_calendar_id !== calendarUrl || presentUids.has(operation.progress?.continuation_master?.id)) continue;
    d.exec('SAVEPOINT calendar_absent_readback');
    try {
      const ids = new Set([operation.event_id, ...(operation.payload.split?.exception_operations || []).map((item) => item.local_event_id)].filter(Boolean));
      const newer = activeCalendarEditOperations('caldav', d).filter((candidate) => ids.has(candidate.event_id) || ids.has(candidate.payload?.parent_event_id));
      if (newer.length) retainCalendarRecoveryError(newer, 'recovery_occurrence_missing',
        'The selected occurrence no longer exists. Review changes and the original series, choose an existing occurrence, or discard unsaved changes.', d,
        { parent_event_id: operation.payload.parent_event_id });
      for (const id of ids) {
        if (id === operation.payload.parent_event_id || newer.some((candidate) => candidate.event_id === id || candidate.payload?.parent_event_id === id)) continue;
        d.prepare("DELETE FROM reminders WHERE entity_type = 'event' AND entity_id = ?").run(id);
        d.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
      }
      const payload = { ...operation.payload, reload_readback_pending: false, provider_readback_result: { absent: true, calendarUrl } };
      d.prepare('UPDATE calendar_edit_operations SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), operation.id);
      d.exec('RELEASE calendar_absent_readback');
      resolved++;
    } catch (error) {
      d.exec('ROLLBACK TO calendar_absent_readback');
      d.exec('RELEASE calendar_absent_readback');
      throw error;
    }
  }
  return resolved;
}

/** Adopt only identities actually present in an authoritative fetched resource. */
export function reconcileCalendarEditReadback(details, database = null) {
  const d = databaseOrDefault(database);
  const rows = pendingCalendarEditReadbacks('caldav', d).filter((operation) => (
    operation.progress?.continuation_master?.id === details.providerUid
      && operation.payload.target_calendar_id === details.providerCalendarUrl
  ));
  if (!rows.length) return false;
  d.exec('SAVEPOINT calendar_edit_readback');
  try {
    for (const operation of rows) {
      const continuation = { ...operation.progress.continuation_master,
        id: details.providerUid, etag: details.providerEtag, url: details.providerObjectUrl };
      const present = new Set(details.componentIds || []);
      const results = acceptedReloadExceptions(operation, { ...continuation, accepted: true })
        .map((result) => result?.providerUid && present.has(result.providerUid) ? result : null);
      reconcileProviderIdentity(d, operation, details);
      reconcileProviderExceptionIdentities(d, operation, operation.payload, { exceptionOperations: results });
      reconcileProviderExclusionDates(d, operation, operation.payload, details.exdates || []);
      const missing = (operation.payload.split?.exception_operations || []).filter((item, index) => (
        item.local_event_id && !results[index]
      ));
      // A missing component is an authoritative removal. Preserve newer work;
      // otherwise remove its local row and reminder together, without an orphan.
      for (const item of missing) {
        const newer = activeCalendarEditOperations('caldav', d).filter((candidate) => candidate.event_id === item.local_event_id);
        if (newer.length) {
          retainCalendarRecoveryError(newer, 'recovery_occurrence_missing',
            'The selected occurrence no longer exists. Review changes and the original series, choose an existing occurrence, or discard unsaved changes.', d,
            { parent_event_id: operation.event_id });
          continue;
        }
        d.prepare("DELETE FROM reminders WHERE entity_type = 'event' AND entity_id = ?").run(item.local_event_id);
        d.prepare('DELETE FROM calendar_events WHERE id = ?').run(item.local_event_id);
      }
      const payload = { ...operation.payload, reload_readback_pending: false,
        provider_readback_result: { ...details, componentIds: [...present] } };
      d.prepare('UPDATE calendar_edit_operations SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify(payload), operation.id);
      // The attempted write remains uncertain in progress. Readback confirms
      // current provider identity, not success of the discarded stale write.
    }
    d.exec('RELEASE calendar_edit_readback');
    return true;
  } catch (error) {
    d.exec('ROLLBACK TO calendar_edit_readback');
    d.exec('RELEASE calendar_edit_readback');
    throw error;
  }
}

/**
 * Finish the visible state transition started by an explicit conflict reload.
 * The resolved queue row remains as an audit record, but the event must stop
 * advertising `pending` as soon as the provider has actually delivered the
 * authoritative object.  Provider inbound code calls this only after matching
 * a concrete remote row; a successful sync run that did not contain the event
 * therefore cannot clear the user's pending state by accident.
 */
export function clearCalendarEditSyncAfterReadback(
  eventId,
  source,
  database = null,
) {
  const d = databaseOrDefault(database);
  if (!eventId || !['google', 'caldav', 'apple'].includes(source) || !hasQueue(d)) return false;
  const resolved = d.prepare(`
    SELECT 1
    FROM calendar_edit_operations
    WHERE event_id = ? AND source = ?
      AND status = 'error' AND failure_kind = 'provider_conflict'
      AND resolution = 'reload'
      AND COALESCE(json_extract(payload_json, '$.reload_readback_pending'), 0) = 0
    LIMIT 1
  `).get(eventId, source);
  if (!resolved) return false;
  // A user may have made another edit while the conflict dialog was open.
  // The provider readback resolves only the selected stale operation; it must
  // not make a newer pending/retry/processing operation look clean.
  const outstanding = d.prepare(`
    SELECT 1
    FROM calendar_edit_operations
    WHERE event_id = ?
      AND status IN ('pending', 'processing', 'retry', 'error')
      AND resolution IS NULL
    LIMIT 1
  `).get(eventId);
  if (outstanding) return false;
  const result = d.prepare(`
    UPDATE calendar_events
    SET sync_state = 'clean', sync_error = NULL
    WHERE id = ? AND sync_state = 'pending'
  `).run(eventId);
  return result.changes === 1;
}

/** Reset retryable/error work for one event and make it eligible for a retry. */
export function retryCalendarEditOperations(eventId, database = null) {
  const d = databaseOrDefault(database);
  if (!hasQueue(d)) return 0;
  recoverExpiredCalendarEditOperations(d);
  const stamp = nowIso();
  const result = d.prepare(`
    UPDATE calendar_edit_operations
    SET status = 'pending', retryable = 1, last_error = NULL,
        failure_kind = NULL, resolution = NULL,
        claimed_at = NULL, claim_expires_at = NULL, claim_token = NULL, updated_at = ?
    WHERE event_id = ? AND status IN ('retry', 'error') AND retryable = 1
      AND resolution IS NULL
  `).run(stamp, eventId);
  if (result.changes) {
    d.prepare(`UPDATE calendar_events SET sync_state = 'pending', sync_error = NULL WHERE id = ?`)
      .run(eventId);
  }
  return result.changes;
}

export function calendarEditSyncForEvent(eventId, database = null) {
  const d = databaseOrDefault(database);
  recoverExpiredCalendarEditOperations(d);
  let operation = null;
  let operations = [];
  if (hasQueue(d)) {
    operations = d.prepare(`
      SELECT id, source, status, last_error, attempts, retryable,
             failure_kind, progress_json, payload_json
      FROM calendar_edit_operations
      WHERE event_id = ? AND status IN ('pending', 'processing', 'retry', 'error')
        AND resolution IS NULL
      ORDER BY id DESC
    `).all(eventId);
    // A retained conflict remains actionable when a newer independent edit
    // waits behind it. A newest-only summary would hide the required choice.
    operation = operations.find((item) => item.failure_kind === 'recovery_field_conflict')
      || operations.find((item) => item.failure_kind?.startsWith('recovery_')) || operations[0] || null;
  }
  let event = null;
  try {
    event = d.prepare(
      'SELECT sync_state, sync_error, outbound_dirty, outbound_attempts, external_source FROM calendar_events WHERE id = ?'
    ).get(eventId) || null;
  } catch {
    event = null;
  }
  // Retryable failures stay in the durable `retry` queue for the provider's
  // next run, but are exposed as an error to the client so the existing detail
  // action can offer an explicit retry/reload choice instead of hiding the
  // failure behind a perpetual pending badge.
  let progress = null;
  try { progress = operation?.progress_json ? JSON.parse(operation.progress_json) : null; } catch { progress = null; }
  let payload = null;
  try { payload = operation?.payload_json ? JSON.parse(operation.payload_json) : null; } catch { payload = null; }
  let recovery = payload?.recovery ?? (payload?.split_reload_dependency ? {
    parent_event_id: payload.split_reload_dependency.parent_event_id,
    retained_changes: retainedCalendarChanges(payload), waiting: true,
  } : null);
  if (recovery) {
    const retained = {}; const conflicts = new Map();
    for (const item of [...operations].reverse()) {
      let candidate;
      try { candidate = JSON.parse(item.payload_json); } catch { continue; }
      const parentId = candidate.recovery?.parent_event_id ?? candidate.split_reload_dependency?.parent_event_id;
      if (parentId !== recovery.parent_event_id) continue;
      Object.assign(retained, retainedCalendarChanges(candidate));
      for (const conflict of candidate.recovery?.conflicts || []) conflicts.set(conflict.field, conflict);
    }
    recovery = { ...recovery, retained_changes: retained, conflicts: [...conflicts.values()] };
  }
  const state = operation?.status === 'error' || operation?.status === 'retry'
    ? 'error'
    : operation || event?.sync_state === 'pending' || event?.outbound_dirty
      ? 'pending'
      : event?.sync_state === 'error' ? 'error' : 'clean';
  return {
    state,
    operation_id: operation?.id ?? null,
    source: operation?.source ?? (event?.outbound_dirty ? event.external_source : null),
    error: operation?.last_error ?? event?.sync_error ?? null,
    attempts: operation?.attempts ?? event?.outbound_attempts ?? 0,
    retryable: operation ? !!operation.retryable : state === 'pending',
    conflict: operation?.failure_kind === 'provider_conflict',
    failure_kind: operation?.failure_kind ?? null,
    recovery,
    progress,
  };
}

export function parseScopedOperationPayload(operation) {
  if (!operation) return null;
  return operation.payload || parseOperation(operation)?.payload || null;
}

// Compatibility aliases for provider wrappers and tests.
export const listScopedOperations = pendingCalendarEditOperations;
export const claimScopedOperation = claimCalendarEditOperation;
export const completeScopedOperation = completeCalendarEditOperation;
export const failScopedOperation = failCalendarEditOperation;
