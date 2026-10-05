/**
 * Read-only capability and synchronization metadata for calendar events.
 * This module deliberately accepts a database argument and has no route/helper
 * imports, so the serializer can use it without creating an import cycle.
 */

import { calendarEditSyncForEvent } from './calendar-edit-operations.js';

const REMOTE_SOURCES = new Set(['google', 'caldav', 'apple', 'ics']);
const SCOPED_SOURCES = new Set(['local', 'google', 'caldav']);

function providerForEvent(event) {
  if (!event) return 'local';
  if (REMOTE_SOURCES.has(event.external_source)) return event.external_source;
  if (event.calendar_ref_id || event.subscription_id) return event.external_source || 'caldav';
  return 'local';
}

function readConfig(database, key) {
  try { return database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null; }
  catch { return null; }
}

function remoteReference(event) {
  return !!(event?.external_calendar_id || event?.calendar_ref_id || event?.subscription_id);
}

function caldavWritable(database, event) {
  const calendarUrl = event.target_caldav_calendar_url
    || (event.calendar_ref_id
      ? database.prepare(`
          SELECT external_id FROM external_calendars
          WHERE id = ? AND source = 'caldav'
        `).get(event.calendar_ref_id)?.external_id
      : null);
  if (!calendarUrl) return { editable: false, reason: 'missing_provider_target' };
  try {
    const selection = database.prepare(`
      SELECT c.enabled, c.write_capability
      FROM caldav_calendar_selection c
      JOIN caldav_accounts a ON a.id = c.account_id
      WHERE c.calendar_url = ?
        AND c.enabled = 1
      LIMIT 1
    `).get(calendarUrl);
    if (!selection) return { editable: false, reason: 'provider_unavailable' };
    if (selection.write_capability === 'write') return { editable: true, reason: null };
    if (selection.write_capability === 'read') return { editable: false, reason: 'provider_readonly' };
    // A configured account is not evidence that this individual collection
    // accepts writes.  The sync provider must refresh this field from the
    // collection's DAV privileges before the editor may mutate local state.
    return { editable: false, reason: 'provider_capability_unknown' };
  } catch {
    // A test database or an old installation may not have provider tables yet.
    return { editable: false, reason: 'provider_unavailable' };
  }
}

function providerWriteCapability(database, event, provider) {
  if (!remoteReference(event)) return { editable: true, reason: null };
  if (provider === 'ics') return { editable: false, reason: 'ics_subscription' };
  if (provider === 'google') {
    if (readConfig(database, 'google_readonly') === '1') {
      return { editable: false, reason: 'provider_readonly' };
    }
    if (!readConfig(database, 'google_refresh_token')) {
      return { editable: false, reason: 'provider_unavailable' };
    }
    const calendarId = event.calendar_ref_id
      ? database.prepare(`
          SELECT external_id FROM external_calendars
          WHERE id = ? AND source = 'google'
        `).get(event.calendar_ref_id)?.external_id
      : event.target_google_calendar_id;
    let selection;
    try {
      selection = calendarId
        ? database.prepare(`
            SELECT access_role, enabled
            FROM google_calendar_selection
            WHERE calendar_id = ?
          `).get(calendarId)
        : null;
    } catch {
      selection = null;
    }
    if (selection && Number(selection.enabled) === 0) {
      return { editable: false, reason: 'provider_unavailable' };
    }
    if (selection?.access_role === 'owner' || selection?.access_role === 'writer') {
      return { editable: true, reason: null };
    }
    if (selection?.access_role) return { editable: false, reason: 'provider_readonly' };
    return { editable: false, reason: 'provider_capability_unknown' };
  }
  if (provider === 'caldav') return caldavWritable(database, event);
  if (provider === 'apple') {
    const configured = readConfig(database, 'apple_caldav_url') || process.env.APPLE_CALDAV_URL;
    return configured
      ? { editable: true, reason: null }
      : { editable: false, reason: 'provider_unavailable' };
  }
  return { editable: true, reason: null };
}

export function getEditCapabilities(database, event) {
  const provider = providerForEvent(event);
  const writable = event?.task_id
    ? { editable: false, reason: 'task_session' }
    : providerWriteCapability(database, event, provider);
  const recurring = !!event?.recurrence_rule;
  const editable = writable.editable;
  const scoped = SCOPED_SOURCES.has(provider);
  return {
    editable,
    read_only: !editable,
    read_only_reason: writable.reason,
    scope_reason: scoped ? null : (writable.reason || 'provider_scope_unsupported'),
    provider,
    scopes: {
      // A direct gesture on a non-recurring event is still a valid `this`
      // edit.  Only following/series need a recurrence rule to address more
      // than one occurrence.
      this: editable && scoped,
      following: editable && scoped && recurring,
      series: editable && scoped,
    },
    move: editable && scoped,
    resize: editable && scoped,
  };
}

function dateOnly(value) {
  const raw = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

function readExceptionRows(database, eventId) {
  try {
    return database.prepare(`
      SELECT exception_date
      FROM calendar_event_exceptions
      WHERE event_id = ?
      ORDER BY exception_date
    `).all(eventId);
  } catch { return []; }
}

function readOverrideRows(database, eventId) {
  try {
    return database.prepare(`
      SELECT start_datetime, end_datetime,
             exception_original_start, exception_original_end
      FROM calendar_events
      WHERE exception_of_event_id = ?
      ORDER BY exception_original_start, id
    `).all(eventId);
  } catch { return []; }
}

/**
 * Build the reliable exception list exposed to the scope dialog. Unknown
 * provider state is represented explicitly rather than being presented as an
 * empty complete list.
 */
export function getExceptionSummary(database, event) {
  if (!event?.id || !event.recurrence_rule) {
    return { known: true, count: 0, items: [], truncated: false };
  }
  const exceptionRows = readExceptionRows(database, event.id);
  const overrideRows = readOverrideRows(database, event.id);
  const source = providerForEvent(event);
  // A local exception table is complete for local series.  A remote series is
  // complete only after the provider has supplied a conditional baseline; an
  // old/imported row without an observed ETag may have remote exceptions that
  // have not reached this database yet, so expose the list as partial.
  const known = source === 'local'
    || (['google', 'caldav', 'apple'].includes(source) && event.provider_revision != null);
  const byDate = new Map();
  for (const row of exceptionRows) {
    const key = dateOnly(row.exception_date);
    if (key) byDate.set(key, {
      original_start: key,
      current_start: key,
      original_end: null,
      current_end: null,
      state: 'preserved',
    });
  }
  for (const row of overrideRows) {
    const key = String(row.exception_original_start || row.start_datetime || '').trim();
    if (!key) continue;
    // An EXDATE is stored as a date while a detached override retains its
    // original date-time.  They describe one exception; collapse the date-only
    // marker before exposing the complete summary to the scope dialog.
    const dateKey = dateOnly(key);
    if (dateKey && byDate.has(dateKey)) byDate.delete(dateKey);
    byDate.set(key, {
      original_start: row.exception_original_start || key,
      current_start: row.start_datetime || null,
      original_end: row.exception_original_end || null,
      current_end: row.end_datetime || null,
      state: 'preserved',
    });
  }
  const all = [...byDate.values()].sort((a, b) => String(a.original_start).localeCompare(String(b.original_start)));
  const limit = 50;
  return {
    known,
    count: all.length,
    items: all.slice(0, limit),
    truncated: all.length > limit,
  };
}

export function eventRevisionToken(event) {
  const localRevision = event?.edit_revision !== undefined && event?.edit_revision !== null
    ? String(event.edit_revision)
    : String(event?.updated_at || '0');
  // The provider token is part of the opaque revision.  It changes when an
  // inbound sync observes a remote ETag/UID revision, so a client holding an
  // older local row cannot overwrite a newer remote object accidentally.
  const providerRevision = event?.provider_revision == null
    ? null : String(event.provider_revision);
  const revision = providerRevision
    ? `${localRevision}@${Buffer.from(providerRevision).toString('base64url')}`
    : localRevision;
  return revision;
}

function recurrenceParent(database, event) {
  const parentId = Number(event?.exception_of_event_id);
  if (!Number.isSafeInteger(parentId) || parentId < 1) return null;
  try {
    return database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(parentId) || null;
  } catch {
    return null;
  }
}

export function eventEditMetadata(database, event) {
  const parent = recurrenceParent(database, event);
  const capabilities = getEditCapabilities(database, event);
  const parentCapabilities = parent ? getEditCapabilities(database, parent) : null;
  if (parent) {
    capabilities.scopes = {
      this: capabilities.scopes.this,
      following: parentCapabilities.scopes.following,
      series: parentCapabilities.scopes.series,
    };
  }
  return {
    revision: eventRevisionToken(event),
    edit_capabilities: capabilities,
    sync: event?.id ? calendarEditSyncForEvent(event.id, database) : {
      state: 'clean', operation_id: null, source: null, error: null, attempts: 0, retryable: false,
    },
    // A detached row has no children of its own.  Parent scopes must expose
    // the series exception context so the editor can warn about overlaps and
    // preserve the parent's known exception list.
    exception_summary: getExceptionSummary(database, parent || event),
    ...(parent ? {
      original_occurrence_start: event.exception_original_start || event.start_datetime,
      recurrence_parent: {
        id: parent.id,
        revision: eventRevisionToken(parent),
        start_datetime: parent.start_datetime,
        end_datetime: parent.end_datetime,
        recurrence_rule: parent.recurrence_rule,
      },
    } : {}),
  };
}

export { providerForEvent, remoteReference, recurrenceParent };
