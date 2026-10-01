/**
 * Server-authoritative calendar edit orchestration.
 *
 * The ordinary PUT route remains responsible for the long-standing full event
 * update contract. This service handles the additional scoped contract used by
 * drag, resize, and an editor opened on a recurring occurrence. Every local
 * shape change and its durable provider operation are committed in one SQLite
 * transaction.
 */

import { hasAnyOccurrence, rruleLine } from './recurrence.js';
import { expandRecurringEvents, loadEventExceptions } from './calendar-events.js';
import {
  householdTimeZone,
  hasExplicitZone,
  localToUTC,
  storedToInstantMs,
  shiftDateKey,
  utcToWall,
} from '../utils/timezone.js';
import {
  calendarEditSyncForEvent,
  queueCalendarEditOperation,
  activeCalendarEditOperations,
  retainCalendarRecoveryError,
} from './calendar-edit-operations.js';
import { markEventOutbound } from './calendar-outbound.js';
import {
  caldavTarget,
  createAttachmentDocument,
  eventIcon,
  googleTarget,
  outlookTarget,
  parseAssignedTo,
  setEventAssignments,
} from '../routes/calendar/helpers.js';
import {
  collectErrors,
  color,
  datetime,
  MAX_TEXT,
  MAX_TITLE,
  rrule,
  str,
} from '../middleware/validate.js';
import { normalizeVisibility } from './visibility.js';
import {
  eventEditMetadata,
  eventRevisionToken,
  getEditCapabilities,
  recurrenceParent,
  providerForEvent,
  remoteReference,
} from './calendar-edit-metadata.js';

export class CalendarEditError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.name = 'CalendarEditError';
    this.status = status;
    this.code = status;
    Object.assign(this, details);
  }
}

const EDIT_SCOPES = new Set(['this', 'following', 'series']);
const REMOTE_PROVIDERS = new Set(['google', 'caldav']);
const EVENT_FIELDS = [
  'title', 'description', 'start_datetime', 'end_datetime', 'all_day',
  'location', 'color', 'recurrence_rule', 'visibility', 'icon', 'countdown',
];

function dbOrDefault(database) {
  if (!database) throw new Error('calendar-edit requires a database connection');
  return database;
}

function own(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

function copyEventSnapshot(event) {
  const snapshot = {};
  for (const key of EVENT_FIELDS) snapshot[key] = event?.[key] ?? null;
  snapshot.external_source = event?.external_source ?? 'local';
  snapshot.external_calendar_id = event?.external_calendar_id ?? null;
  snapshot.calendar_ref_id = event?.calendar_ref_id ?? null;
  snapshot.target_google_calendar_id = event?.target_google_calendar_id ?? null;
  snapshot.target_caldav_account_id = event?.target_caldav_account_id ?? null;
  snapshot.target_caldav_calendar_url = event?.target_caldav_calendar_url ?? null;
  snapshot.target_outlook_account_id = event?.target_outlook_account_id ?? null;
  snapshot.target_outlook_calendar_id = event?.target_outlook_calendar_id ?? null;
  snapshot.tzid = event?.tzid ?? null;
  return snapshot;
}

function assignmentIds(database, event) {
  try {
    return database.prepare(
      'SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id'
    ).all(event.id).map((row) => Number(row.user_id));
  } catch {
    return event?.assigned_to ? [Number(event.assigned_to)] : [];
  }
}

function sameIds(left, right) {
  const a = [...new Set((left || []).map(Number).filter(Number.isFinite))].sort((x, y) => x - y);
  const b = [...new Set((right || []).map(Number).filter(Number.isFinite))].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function semanticEditValue(database, key, value, event) {
  if (['start_datetime', 'end_datetime'].includes(key)) {
    if (event.all_day) return String(value || event.start_datetime || '').slice(0, 10);
    return recurringWallValue(database, value, event).replace(/(T\d{2}:\d{2}):00$/, '$1');
  }
  if (key === 'recurrence_rule') return String(value || '').replace(/^RRULE:/i, '').toUpperCase().split(';').filter(Boolean).sort().join(';');
  if (['all_day', 'countdown'].includes(key)) return value ? 1 : 0;
  return value === null || value === undefined ? '' : String(value);
}

// Capture user intent before the scoped service transforms an occurrence range
// into a master range or truncates its rule. Form field presence is not intent.
function captureEditIntent(database, event, body, normalized, occurrenceStart) {
  const selected = { ...event, start_datetime: occurrenceStart,
    end_datetime: occurrenceEnd(database, event, occurrenceStart) };
  const fields = {};
  const keys = [...EVENT_FIELDS, ...Object.keys(copyEventSnapshot(event)).filter((key) => key.startsWith('target_'))];
  for (const key of keys) {
    if (!own(body, key)) continue;
    const next = ['start_datetime', 'end_datetime'].includes(key) && body[key]
      ? body[key] : normalized.next[key];
    if (semanticEditValue(database, key, next, { ...selected, all_day: normalized.next.all_day })
        !== semanticEditValue(database, key, selected[key], selected)) fields[key] = next;
  }
  // A body drag promises the complete preview, even when an edge happens to
  // equal the prior edge. Resizes instead retain just the changed boundary.
  if (body.edit_action === 'move' && (own(fields, 'start_datetime') || own(fields, 'end_datetime'))) {
    fields.start_datetime = normalized.next.start_datetime;
    fields.end_datetime = normalized.next.end_datetime;
  }
  const discardedSplit = activeCalendarEditOperations(null, database).find((operation) => operation.event_id === event.id
    && operation.scope === 'following' && operation.payload?.parent_event_id
    && operation.payload.parent_event_id !== event.id && !operation.payload.after?.external_calendar_id);
  const originalSelection = discardedSplit ? shiftRecurringTemporal(database, occurrenceStart,
    -recurringDeltaBetween(database, discardedSplit.occurrence_start, event.start_datetime, event), event, !!event.all_day) : null;
  return { fields, before_occurrence_start: occurrenceStart,
    ...(originalSelection ? { original_occurrence_start: originalSelection } : {}),
    action: body.edit_action || null,
    before_occurrence_end: selected.end_datetime, before_all_day: event.all_day,
    selected_before: copyEventSnapshot(selected),
    ...(own(body, 'assigned_to') && !sameIds(normalized.assignmentIds, assignmentIds(database, event))
      ? { assigned_to: normalized.assignmentIds } : {}) };
}

function throwValidationErrors(results) {
  const errors = collectErrors(results);
  if (errors.length) throw new CalendarEditError(errors.join(' '), 400);
}

/**
 * Normalize the full editor body as well as the small drag/resize patch.  The
 * editor deliberately sends its complete form for every scope, so unchanged
 * assignments, targets, and countdown values must survive a scoped save too.
 */
function normalizeScopeBody(body, event, database) {
  const next = copyEventSnapshot(event);

  const title = own(body, 'title')
    ? str(body.title, 'Titel', { max: MAX_TITLE, required: false }) : null;
  const description = own(body, 'description')
    ? str(body.description, 'Beschreibung', { max: MAX_TEXT, required: false }) : null;
  const location = own(body, 'location')
    ? str(body.location, 'Ort', { max: MAX_TITLE, required: false }) : null;
  const start = own(body, 'start_datetime')
    ? datetime(body.start_datetime, 'Startdatum') : null;
  const end = own(body, 'end_datetime')
    ? datetime(body.end_datetime, 'Enddatum') : null;
  const colour = own(body, 'color') ? color(body.color, 'Farbe') : null;
  const recurrenceChanged = own(body, 'recurrence_rule')
    && String(body.recurrence_rule || '') !== String(event.recurrence_rule || '');
  const recurrence = recurrenceChanged ? rrule(body.recurrence_rule, 'Wiederholung') : null;
  throwValidationErrors([title, description, location, start, end, colour, recurrence].filter(Boolean));

  if (title && title.value !== null) next.title = title.value;
  if (description) next.description = description.value;
  if (location) next.location = location.value;
  if (start && start.value !== null) next.start_datetime = start.value;
  if (end) next.end_datetime = end.value;
  if (colour) next.color = colour.value;
  if (own(body, 'all_day')) next.all_day = body.all_day ? 1 : 0;
  if (own(body, 'icon')) {
    next.icon = eventIcon(body.icon);
    if (!next.icon) throw new CalendarEditError('icon: invalid calendar event icon.', 400);
  }
  if (own(body, 'visibility')) next.visibility = normalizeVisibility(body.visibility, event.visibility);
  if (own(body, 'countdown')) next.countdown = body.countdown ? 1 : 0;
  if (recurrenceChanged) next.recurrence_rule = recurrence?.value ?? null;

  let assignmentIds = null;
  if (own(body, 'assigned_to')) {
    assignmentIds = parseAssignedTo(body.assigned_to);
    next.assigned_to = assignmentIds[0] ?? null;
  }

  if (own(body, 'target_caldav_account_id') || own(body, 'target_caldav_calendar_url')) {
    const target = caldavTarget(body);
    if (target.error) throw new CalendarEditError(target.error, 400);
    next.target_caldav_account_id = target.value.accountId;
    next.target_caldav_calendar_url = target.value.calendarUrl;
  }
  if (own(body, 'target_google_calendar_id')) {
    const target = googleTarget(body);
    if (target.error) throw new CalendarEditError(target.error, 400);
    next.target_google_calendar_id = target.value;
  }
  if (own(body, 'target_outlook_account_id') || own(body, 'target_outlook_calendar_id')) {
    const target = outlookTarget(body);
    if (target.error) throw new CalendarEditError(target.error, 400);
    next.target_outlook_account_id = target.value.accountId;
    next.target_outlook_calendar_id = target.value.calendarId;
  }
  if (next.title !== null && next.title !== undefined && String(next.title).trim() === '') {
    throw new CalendarEditError('title must not be empty.', 400);
  }
  if (next.start_datetime === null || next.start_datetime === undefined || String(next.start_datetime).trim() === '') {
    throw new CalendarEditError('start_datetime is required for a scoped edit.', 400);
  }
  return { next, assignmentIds };
}

function dateParts(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value ?? ''));
  if (!m) return null;
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4] || 0), minute: Number(m[5] || 0), second: Number(m[6] || 0),
  };
}

function wallMs(value) {
  const p = dateParts(value);
  if (!p) return null;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function temporalMs(database, value, allDay = false) {
  if (!value) return null;
  if (allDay) {
    const p = dateParts(value);
    return p ? Date.UTC(p.year, p.month - 1, p.day) : null;
  }
  return storedToInstantMs(String(value), householdTimeZone(database));
}

function deltaBetween(database, from, to, allDay = false) {
  const left = allDay ? wallMs(from) : temporalMs(database, from, false);
  const right = allDay ? wallMs(to) : temporalMs(database, to, false);
  return left === null || right === null ? null : right - left;
}

// A recurring rule describes a civil clock, even when its stored values are
// provider instants.  Comparing those instants across a DST boundary turns a
// one-hour wall-clock move into zero or two hours on the master.  Resolve
// explicit values through the event's TZID first, then compare the resulting
// wall values just like local, zone-less rows.
function recurringWallValue(database, value, event) {
  const raw = String(value ?? '');
  if (!raw) return raw;
  if (!hasExplicitZone(raw)) return raw;
  const zone = event?.tzid || householdTimeZone(database);
  const wall = utcToWall(raw, zone);
  return wall ? `${wall.date}T${wall.time}` : raw;
}

function recurringDeltaBetween(database, from, to, event, allDay = false) {
  const left = recurringWallValue(database, from, event);
  const right = recurringWallValue(database, to, event);
  return wallMs(right) === null || wallMs(left) === null
    ? null : wallMs(right) - wallMs(left);
}

function preserveShape(value, original) {
  if (hasExplicitZone(original)) return value.toISOString().replace('.000Z', 'Z');
  const p = utcToWall(value.toISOString(), 'UTC');
  if (!p) return value.toISOString().replace('.000Z', 'Z');
  const seconds = String(original).length > 16 ? `:${p.time.slice(6, 8)}` : '';
  return `${p.date}T${p.time.slice(0, 5)}${seconds}`;
}

function shiftTemporal(database, value, delta, allDay = false) {
  if (!value || !Number.isFinite(delta)) return value;
  if (allDay || String(value).length <= 10) {
    return shiftDateKey(String(value).slice(0, 10), Math.round(delta / 86400000));
  }
  const base = hasExplicitZone(value) ? new Date(value) : new Date(`${String(value).slice(0, 19)}Z`);
  if (Number.isNaN(base.getTime())) return value;
  return preserveShape(new Date(base.getTime() + delta), value);
}

function shiftRecurringTemporal(database, value, delta, event, allDay = false) {
  if (!value || !Number.isFinite(delta)) return value;
  if (allDay || String(value).length <= 10) {
    return shiftDateKey(String(value).slice(0, 10), Math.round(delta / 86400000));
  }
  const original = String(value);
  const wall = recurringWallValue(database, original, event);
  const base = wallMs(wall);
  if (base === null) return value;
  const shifted = new Date(base + delta);
  const p = utcToWall(shifted.toISOString(), 'UTC');
  if (!p) return value;
  const local = `${p.date}T${p.time}`;
  if (hasExplicitZone(original)) {
    return localToUTC(local, event?.tzid || householdTimeZone(database));
  }
  const seconds = original.length > 16 ? `:${p.time.slice(6, 8)}` : '';
  return `${p.date}T${p.time.slice(0, 5)}${seconds}`;
}

function occurrenceEnd(database, event, occurrenceStart) {
  if (!event.end_datetime) return null;
  const duration = event.recurrence_rule
    ? recurringDeltaBetween(database, event.start_datetime, event.end_datetime, event, !!event.all_day)
    : deltaBetween(database, event.start_datetime, event.end_datetime, !!event.all_day);
  return duration === null
    ? event.end_datetime
    : (event.recurrence_rule
      ? shiftRecurringTemporal(database, occurrenceStart, duration, event, !!event.all_day)
      : shiftTemporal(database, occurrenceStart, duration, !!event.all_day));
}

function validateResultShape(database, next) {
  const start = String(next.start_datetime || '');
  const end = next.end_datetime === null || next.end_datetime === undefined
    ? null : String(next.end_datetime);
  if (!dateParts(start)) throw new CalendarEditError('start_datetime is invalid.', 400);
  if (next.all_day) {
    next.start_datetime = start.slice(0, 10);
    // Yuvomi stores an all-day range with an inclusive end date.  Keeping a
    // null end is also meaningful for imported single-day rows; provider
    // adapters convert it to their exclusive DATE representation on outbound.
    next.end_datetime = end ? end.slice(0, 10) : null;
    if (next.end_datetime && next.end_datetime < next.start_datetime) {
      throw new CalendarEditError('All-day events must not end before they start.', 400);
    }
    return next;
  }
  if (end) {
    const startMs = temporalMs(database, start);
    const endMs = temporalMs(database, end);
    if (startMs === null || endMs === null || endMs <= startMs) {
      throw new CalendarEditError('Timed events must end after they start.', 400);
    }
  }
  return next;
}

function truncateRuleBefore(rule, occurrenceStart) {
  const raw = String(rule || '').replace(/^RRULE:/i, '');
  const date = String(occurrenceStart || '').slice(0, 10).replace(/-/g, '');
  if (!/^\d{8}$/.test(date)) return null;
  const before = shiftDateKey(String(occurrenceStart).slice(0, 10), -1).replace(/-/g, '');
  const parts = raw.split(';').filter((part) => part && !/^(UNTIL|COUNT)=/i.test(part));
  if (!parts.some((part) => /^FREQ=/i.test(part))) return null;
  parts.push(`UNTIL=${before}`);
  const out = parts.join(';');
  return /^RRULE:/i.test(String(rule)) ? rruleLine(out) : out;
}

function recurrenceCount(rule) {
  const match = /(?:^|;)COUNT=(\d+)/i.exec(String(rule || '').replace(/^RRULE:/i, ''));
  return match ? Number(match[1]) : null;
}

function recurrenceOrdinal(database, event, occurrenceStart) {
  const targetDate = String(occurrenceStart || '').slice(0, 10);
  const firstDate = String(event.start_datetime || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDate)
      || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)
      || targetDate < firstDate) return null;
  // COUNT is defined over rule occurrences before EXDATE removal.  Passing no
  // exception map therefore gives the provider and local split the same
  // remaining count even when an earlier occurrence is already excepted.
  const rows = expandRecurringEvents([event], firstDate, targetDate, null);
  const index = rows.findIndex((row) => (
    sameOccurrenceIdentity(row.start_datetime, occurrenceStart, !!event.all_day)
  ));
  return index < 0 ? null : index + 1;
}

function countFollowingOccurrences(rule, ordinal) {
  const count = recurrenceCount(rule);
  if (count === null || ordinal === null) return rule;
  const remaining = count - ordinal + 1;
  if (remaining < 1) return null;
  const raw = String(rule);
  const replacement = `COUNT=${remaining}`;
  const replaced = raw.replace(/COUNT=\d+/i, replacement);
  return replaced === raw ? raw : replaced;
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Move explicit weekly weekday selectors together with a whole-series gesture.
 * DTSTART alone is not enough when a rule contains BYDAY: rrule expansion will
 * otherwise keep the old weekdays and produce a visibly different schedule.
 * Ordinal selectors such as -1SU retain their ordinal while their weekday is
 * shifted by the same civil-day delta as DTSTART.
 */
function shiftWeeklyBydayRule(rule, dayDelta) {
  if (!Number.isInteger(dayDelta) || dayDelta === 0 || !rule) return rule;
  const raw = String(rule).replace(/^RRULE:/i, '');
  const parts = raw.split(';');
  const frequency = parts.find((part) => /^FREQ=/i.test(part));
  const bydayIndex = parts.findIndex((part) => /^BYDAY=/i.test(part));
  if (!frequency || !/^FREQ=WEEKLY$/i.test(frequency) || bydayIndex < 0) return rule;
  const shifted = parts[bydayIndex].replace(/^BYDAY=/i, '').split(',').map((token) => {
    const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
    if (!match) return token;
    const index = WEEKDAY_CODES.indexOf(match[2].toUpperCase());
    if (index < 0) return token;
    const next = WEEKDAY_CODES[((index + dayDelta) % 7 + 7) % 7];
    return `${match[1] || ''}${next}`;
  }).join(',');
  parts[bydayIndex] = `BYDAY=${shifted}`;
  const output = parts.join(';');
  return /^RRULE:/i.test(String(rule)) ? rruleLine(output) : output;
}

function recurringDateDelta(database, from, to, event) {
  const left = String(recurringWallValue(database, from, event) || '').slice(0, 10);
  const right = String(recurringWallValue(database, to, event) || '').slice(0, 10);
  const leftMs = wallMs(left);
  const rightMs = wallMs(right);
  if (leftMs === null || rightMs === null) return null;
  return Math.round((rightMs - leftMs) / 86400000);
}

function exceptionAtOrAfter(database, value, cut, event) {
  const left = wallMs(recurringWallValue(database, value, event));
  const right = wallMs(recurringWallValue(database, cut, event));
  return left !== null && right !== null && left >= right;
}

function exceptionIdentityMatches(left, right, allDay = false) {
  if (!left || !right) return false;
  return sameOccurrenceIdentity(left, right, allDay)
    || String(left).slice(0, 10) === String(right).slice(0, 10);
}

/**
 * Build explicit provider work for detached exceptions that move to a new
 * following master.  `original_start` is deliberately the continuation's
 * schedule identity; `previous_original_start` retains the old master's
 * identity so an adapter can explain or reconcile the transfer.  The event
 * snapshot remains the edited occurrence's actual range (for example 12:00),
 * rather than the shifted regular slot (for example 11:00).
 */
function followingExceptionOperations(
  database,
  parent,
  continuationId,
  occurrenceStart,
  splitDelta,
  exceptionSummary,
) {
  const allDay = !!parent?.all_day;
  const continuation = database.prepare('SELECT start_datetime FROM calendar_events WHERE id = ?').get(continuationId);
  const dateDelta = recurringDateDelta(database, occurrenceStart, continuation?.start_datetime, parent);
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT *
      FROM calendar_events
      WHERE exception_of_event_id = ?
        AND substr(COALESCE(exception_original_start, start_datetime), 1, 10) >= ?
      ORDER BY exception_original_start, id
    `).all(continuationId, String(occurrenceStart).slice(0, 10));
  } catch { /* Focused legacy schemas may omit detached identity columns. */ }

  let dates = [];
  try {
    dates = database.prepare(`
      SELECT exception_date
      FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date >= ?
      ORDER BY exception_date
    `).all(continuationId, String(occurrenceStart).slice(0, 10));
  } catch { /* Focused legacy schemas may omit EXDATE rows. */ }

  const entries = rows.map((row) => ({
    original: row.exception_original_start || row.start_datetime,
    row,
  }));
  for (const row of dates) {
    if (rows.some((override) => exceptionIdentityMatches(
      override.exception_original_start || override.start_datetime,
      row.exception_date,
      allDay,
    ))) continue;
    entries.push({ original: row.exception_date, row: null });
  }
  for (const item of (Array.isArray(exceptionSummary?.items) ? exceptionSummary.items : [])) {
    const original = item?.original_start;
    if (!exceptionAtOrAfter(database, original, occurrenceStart, parent)) continue;
    if (!entries.some((entry) => exceptionIdentityMatches(entry.original, original, allDay))) {
      entries.push({ original, row: null, summary: item });
    }
  }

  const seen = new Set();
  return entries
    .filter((entry) => exceptionAtOrAfter(database, entry.original, occurrenceStart, parent))
    .map((entry) => {
      const previous = String(entry.original);
      const key = `${previous.slice(0, 19)}\u0000${entry.row?.id || ''}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const originalStart = allDay || previous.length <= 10
        ? shiftDateKey(previous.slice(0, 10), dateDelta || 0)
        : splitDelta === null ? previous
          : shiftRecurringTemporal(database, previous, splitDelta, parent, allDay);
      const row = entry.row;
      // The old provider instance id/ETag belongs to the pre-split master and
      // must not short-circuit continuation lookup. Retain them as trace data;
      // the adapter resolves the new continuation instance and captures its
      // own conditional ETag before patching.
      const provider = {
        ...(row?.external_calendar_id ? { previousEventId: row.external_calendar_id } : {}),
        ...(row?.provider_revision ? { previousEtag: row.provider_revision } : {}),
        ...(row?.external_object_url ? { previousObjectUrl: row.external_object_url } : {}),
      };
      const operation = {
        method: row ? 'patch' : (entry.summary?.current_start ? 'patch' : 'delete'),
        ...(row?.id ? { local_event_id: row.id } : {}),
        // Keep the source identity in original_start for audit/reconciliation.
        // continuation_start is the new regular slot the provider must resolve
        // after the continuation master has been created.
        original_start: previous,
        continuation_start: originalStart,
        previous_original_start: previous,
        occurrence_start: originalStart,
        provider,
      };
      if (row) operation.event = copyEventSnapshot(row);
      else if (entry.summary?.current_start) {
        // A provider exception may be known through EXDATE metadata before it
        // has been materialized locally. Keep this an explicit operation; an
        // adapter must fetch its current remote body before applying it.
        operation.event = null;
      }
      return operation;
    })
    .filter(Boolean);
}

function isAtSeriesStart(event, occurrenceStart) {
  const original = String(event.start_datetime || '');
  const occurrence = String(occurrenceStart || '');
  if (original === occurrence) return true;
  // All-day and provider values may carry different seconds/offset notation;
  // the date identity is still the authoritative first occurrence key here.
  return !!event.all_day && original.slice(0, 10) === occurrence.slice(0, 10);
}

function sameOccurrenceIdentity(left, right, allDay = false) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (allDay) return a.slice(0, 10) === b.slice(0, 10);
  return a === b || a.slice(0, 16) === b.slice(0, 16);
}

function occurrenceExists(database, event, occurrenceStart) {
  if (!event.recurrence_rule) {
    return sameOccurrenceIdentity(event.start_datetime, occurrenceStart, !!event.all_day)
      || sameOccurrenceIdentity(event.exception_original_start, occurrenceStart, !!event.all_day);
  }
  // A detached occurrence is represented by an EXDATE on the master plus a
  // child row.  Parent-scoped edits arrive through that child id, so the
  // original identity is valid even though normal expansion quite correctly
  // omits the excluded occurrence.
  try {
    const detached = database.prepare(`
      SELECT exception_original_start
      FROM calendar_events
      WHERE exception_of_event_id = ?
    `).all(event.id);
    if (detached.some((row) => sameOccurrenceIdentity(
      row.exception_original_start, occurrenceStart, !!event.all_day,
    ))) return true;
  } catch { /* Focused legacy schemas may omit detached identity columns. */ }
  const date = String(occurrenceStart).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  let exceptions = new Map();
  try { exceptions = loadEventExceptions(database, [event.id]); } catch { /* old focused schema */ }
  const matches = expandRecurringEvents([event], date, date, exceptions);
  return matches.some((row) => sameOccurrenceIdentity(row.start_datetime, occurrenceStart, !!event.all_day));
}

function copyAssignments(d, fromId, toId) {
  try {
    d.prepare(`
      INSERT OR IGNORE INTO event_assignments (event_id, user_id)
      SELECT ?, user_id FROM event_assignments WHERE event_id = ?
    `).run(toId, fromId);
  } catch { /* Older focused test schemas may omit assignments. */ }
}

function copyReminders(d, fromId, toId, delta, allDay) {
  let rows;
  try {
    rows = d.prepare(`
      SELECT remind_at, dismissed, created_by, assigned_from
      FROM reminders WHERE entity_type = 'event' AND entity_id = ?
      ORDER BY id
    `).all(fromId);
  } catch {
    try {
      rows = d.prepare(`
        SELECT remind_at, dismissed, created_by
        FROM reminders WHERE entity_type = 'event' AND entity_id = ?
        ORDER BY id
      `).all(fromId);
    } catch { return; }
  }
  for (const row of rows) {
    const remindAt = shiftTemporal(d, row.remind_at, delta, allDay);
    try {
      d.prepare(`
        INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by, assigned_from)
        VALUES ('event', ?, ?, ?, ?, ?)
      `).run(toId, remindAt, row.dismissed ? 1 : 0, row.created_by, row.assigned_from ?? null);
    } catch {
      d.prepare(`
        INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by)
        VALUES ('event', ?, ?, ?, ?)
      `).run(toId, remindAt, row.dismissed ? 1 : 0, row.created_by);
    }
  }
}

function materializeAttachmentChange(d, change, actorId) {
  if (!change || change.mode !== 'replace' || change.documentId) return change;
  change.documentId = Number(createAttachmentDocument(
    d,
    change.attachment,
    change.stagedUpload,
    change.body || {},
    actorId,
  ));
  change.committed = true;
  return change;
}

function attachmentValues(event, change) {
  if (!change) {
    return {
      attachment_name: event.attachment_name ?? null,
      attachment_mime: event.attachment_mime ?? null,
      attachment_size: event.attachment_size ?? null,
      attachment_data: event.attachment_data ?? null,
      attachment_document_id: event.attachment_document_id ?? null,
    };
  }
  if (change.mode === 'remove') {
    return {
      attachment_name: null,
      attachment_mime: null,
      attachment_size: null,
      attachment_data: null,
      attachment_document_id: null,
    };
  }
  return {
    attachment_name: change.body?.attachment_name || 'Attachment',
    attachment_mime: change.attachment?.mime ?? null,
    attachment_size: change.attachment?.size ?? null,
    attachment_data: null,
    attachment_document_id: change.documentId ?? null,
  };
}

function reanchorReminders(d, eventId, delta, allDay) {
  if (!delta) return;
  let rows;
  try {
    rows = d.prepare(`
      SELECT id, remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?
    `).all(eventId);
  } catch { return; }
  const update = d.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?');
  for (const row of rows) update.run(shiftTemporal(d, row.remind_at, delta, allDay), row.id);
}

function insertDetachedEvent(
  d,
  event,
  next,
  occurrenceStart,
  occurrenceEnd,
  actorId,
  {
    assignmentIds: requestedAssignments = null,
    attachmentChange = null,
    reminderDelta = null,
  } = {},
) {
  materializeAttachmentChange(d, attachmentChange, actorId);
  const attachments = attachmentValues(event, attachmentChange);
  const result = d.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location, color,
       icon, assigned_to, created_by, external_calendar_id, external_source,
       recurrence_rule, subscription_id, user_modified, color_modified,
       calendar_ref_id, attachment_name, attachment_mime, attachment_size,
       attachment_data, attachment_document_id, target_caldav_account_id,
       target_caldav_calendar_url, target_google_calendar_id,
       target_outlook_account_id, target_outlook_calendar_id, visibility,
       tzid, outbound_dirty, outbound_attempts, outbound_move_to,
       external_object_url, countdown, edit_revision, sync_state, sync_error,
       exception_of_event_id, exception_original_start, exception_original_end)
    VALUES (
      @title, @description, @start_datetime, @end_datetime, @all_day, @location, @color,
      @icon, @assigned_to, @created_by, NULL, @external_source, NULL, @subscription_id,
      @user_modified, @color_modified, @calendar_ref_id, @attachment_name,
      @attachment_mime, @attachment_size, @attachment_data, @attachment_document_id,
      @target_caldav_account_id, @target_caldav_calendar_url, @target_google_calendar_id,
      @target_outlook_account_id, @target_outlook_calendar_id, @visibility, @tzid,
      0, 0, NULL, @external_object_url, @countdown, 1, 'clean', NULL,
      @exception_of_event_id, @exception_original_start, @exception_original_end
    )
  `).run({
    title: next.title,
    description: next.description,
    start_datetime: next.start_datetime,
    end_datetime: next.end_datetime,
    all_day: next.all_day,
    location: next.location,
    color: next.color,
    icon: next.icon || event.icon || 'calendar',
    assigned_to: requestedAssignments ? (requestedAssignments[0] ?? null) : (event.assigned_to ?? null),
    created_by: actorId || event.created_by,
    external_source: event.external_source || 'local',
    subscription_id: event.subscription_id ?? null,
    user_modified: REMOTE_PROVIDERS.has(providerForEvent(event)) ? 1 : (event.user_modified || 0),
    color_modified: event.color_modified || 0,
    calendar_ref_id: event.calendar_ref_id ?? null,
    attachment_name: attachments.attachment_name,
    attachment_mime: attachments.attachment_mime,
    attachment_size: attachments.attachment_size,
    attachment_data: attachments.attachment_data,
    attachment_document_id: attachments.attachment_document_id,
    target_caldav_account_id: next.target_caldav_account_id ?? null,
    target_caldav_calendar_url: next.target_caldav_calendar_url ?? null,
    target_google_calendar_id: next.target_google_calendar_id ?? null,
    target_outlook_account_id: next.target_outlook_account_id ?? null,
    target_outlook_calendar_id: next.target_outlook_calendar_id ?? null,
    visibility: next.visibility ?? event.visibility ?? 'all',
    tzid: event.tzid ?? null,
    external_object_url: event.external_object_url ?? null,
    countdown: next.countdown ? 1 : 0,
    exception_of_event_id: event.id,
    exception_original_start: occurrenceStart,
    exception_original_end: occurrenceEnd,
  });
  const id = Number(result.lastInsertRowid);
  copyAssignments(d, event.id, id);
  if (requestedAssignments && !sameIds(requestedAssignments, assignmentIds(d, event))) {
    setEventAssignments(d, id, requestedAssignments);
  }
  const delta = reminderDelta ?? deltaBetween(d, occurrenceStart, next.start_datetime, !!next.all_day) ?? 0;
  copyReminders(d, event.id, id, delta, !!next.all_day);
  return id;
}

function updateEventRow(
  d,
  event,
  next,
  {
    actorId,
    reanchor = true,
    assignmentIds: requestedAssignments = null,
    attachmentChange = null,
  } = {},
) {
  materializeAttachmentChange(d, attachmentChange, actorId);
  const attachments = attachmentValues(event, attachmentChange);
  const startDelta = deltaBetween(d, event.start_datetime, next.start_datetime, !!event.all_day);
  const changedStart = next.start_datetime !== event.start_datetime;
  const changedColor = own(next, 'color') && String(next.color ?? '').toLowerCase() !== String(event.color ?? '').toLowerCase();
  const userModified = remoteReference(event) && event.external_source !== 'local' ? 1 : (event.user_modified || 0);
  const colorModified = changedColor ? 1 : (event.color_modified || 0);
  d.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?, all_day = ?,
        location = ?, color = ?, icon = ?, recurrence_rule = ?, visibility = ?,
        assigned_to = ?, attachment_name = ?, attachment_mime = ?, attachment_size = ?,
        attachment_data = ?, attachment_document_id = ?,
        target_caldav_account_id = ?, target_caldav_calendar_url = ?,
        target_google_calendar_id = ?, target_outlook_account_id = ?,
        target_outlook_calendar_id = ?, countdown = ?,
        user_modified = ?, color_modified = ?, edit_revision = edit_revision + 1,
        sync_error = NULL
    WHERE id = ?
  `).run(
    next.title, next.description, next.start_datetime, next.end_datetime, next.all_day,
    next.location, next.color, next.icon || event.icon || 'calendar',
    next.recurrence_rule ?? null, next.visibility ?? event.visibility ?? 'all',
    requestedAssignments ? (requestedAssignments[0] ?? null) : (event.assigned_to ?? null),
    attachments.attachment_name, attachments.attachment_mime, attachments.attachment_size,
    attachments.attachment_data, attachments.attachment_document_id,
    next.target_caldav_account_id ?? null, next.target_caldav_calendar_url ?? null,
    next.target_google_calendar_id ?? null, next.target_outlook_account_id ?? null,
    next.target_outlook_calendar_id ?? null, next.countdown ? 1 : 0,
    userModified, colorModified, event.id,
  );
  if (requestedAssignments && !sameIds(requestedAssignments, assignmentIds(d, event))) {
    setEventAssignments(d, event.id, requestedAssignments);
  }
  if (reanchor && changedStart && startDelta !== null) {
    reanchorReminders(d, event.id, startDelta, !!event.all_day);
  }
  return { ...event, ...next, user_modified: userModified, color_modified: colorModified };
}

function moveFollowingExceptions(d, fromId, toId, cutDate) {
  const movedDates = [];
  try {
    const rows = d.prepare(`
      SELECT exception_date FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date >= ?
      ORDER BY exception_date
    `).all(fromId, cutDate);
    const insert = d.prepare(
      'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)'
    );
    const remove = d.prepare(
      'DELETE FROM calendar_event_exceptions WHERE event_id = ? AND exception_date = ?'
    );
    for (const row of rows) {
      insert.run(toId, row.exception_date);
      remove.run(fromId, row.exception_date);
      movedDates.push(row.exception_date);
    }
  } catch { /* Focused legacy schemas may omit EXDATE rows. */ }

  // A scoped "this" edit has two local pieces: the EXDATE above and a
  // detached event carrying the edited fields. Move the detached row with its
  // original occurrence identity when that occurrence belongs to the
  // continuation. Leaving it attached to the truncated master would render
  // the exception in the wrong series and make a later retry duplicate it.
  try {
    const rows = d.prepare(`
      SELECT id
      FROM calendar_events
      WHERE exception_of_event_id = ?
        AND substr(COALESCE(exception_original_start, start_datetime), 1, 10) >= ?
      ORDER BY id
    `).all(fromId, cutDate);
    const move = d.prepare(`
      UPDATE calendar_events
      SET exception_of_event_id = ?
      WHERE id = ? AND exception_of_event_id = ?
    `);
    for (const row of rows) move.run(toId, row.id, fromId);
  } catch { /* Focused legacy schemas may omit detached identity columns. */ }
  return movedDates;
}

function operationPayload({
  database,
  event,
  next,
  scope,
  occurrenceStart,
  eventId,
  parentEventId = null,
  expectedParentRevision = null,
  exceptionSummary,
  split = null,
  intent = null,
}) {
  const provider = providerForEvent(event);
  const targetCalendarId = provider === 'google'
    ? (event.target_google_calendar_id || (() => {
      try {
        return database.prepare(`
          SELECT external_id FROM external_calendars
          WHERE id = ? AND source = 'google'
        `).get(event.calendar_ref_id)?.external_id || null;
      } catch { return null; }
    })())
    : provider === 'caldav'
      ? (event.target_caldav_calendar_url || (() => {
        try {
          return database.prepare(`
            SELECT external_id FROM external_calendars
            WHERE id = ? AND source = 'caldav'
          `).get(event.calendar_ref_id)?.external_id || null;
        } catch { return null; }
      })())
      : null;
  const providerIdentity = {
    masterId: event.external_calendar_id || null,
    eventId: event.external_calendar_id || null,
    uid: event.external_calendar_id || null,
    calendarId: provider === 'google' ? targetCalendarId : null,
    calendarUrl: provider === 'caldav' ? targetCalendarId : null,
    objectUrl: event.external_object_url || null,
    etag: event.provider_revision || null,
  };
  return {
    event_id: eventId,
    parent_event_id: parentEventId,
    source: provider,
    scope,
    occurrence_start: occurrenceStart,
    expected_revision: eventRevisionToken(event),
    provider_revision: event.provider_revision || null,
    before: copyEventSnapshot(event),
    after: copyEventSnapshot(next),
    master_external_id: event.external_calendar_id || null,
    target_calendar_id: targetCalendarId,
    expected_parent_revision: expectedParentRevision,
    provider: providerIdentity,
    ...(split ? { split } : {}),
    exception_summary: exceptionSummary,
    ...(intent ? { edit_intent: intent } : {}),
  };
}

function checkRevision(event, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return;
  const actual = eventRevisionToken(event);
  if (String(expectedRevision) !== actual) {
    throw new CalendarEditError('Calendar event changed on server; reload before saving.', 409, {
      conflict: { expected_revision: String(expectedRevision), actual_revision: actual },
    });
  }
}

/**
 * Apply a scoped edit. The caller must have loaded a visible event and checked
 * authentication. The returned ids describe every local row touched.
 */
export function applyScopedCalendarEdit({
  database,
  event,
  body,
  actorId = null,
  attachmentChange = null,
}) {
  const d = dbOrDefault(database);
  const scope = body?.edit_scope;
  if (!EDIT_SCOPES.has(scope)) throw new CalendarEditError('edit_scope must be this, following, or series.', 400);
  checkRevision(event, body.expected_revision);

  const capabilities = getEditCapabilities(d, event);
  if (!capabilities.editable) {
    throw new CalendarEditError('This calendar event is read-only.', 409, {
      reason: capabilities.read_only_reason,
      data: { edit_capabilities: capabilities },
    });
  }
  if (!capabilities.scopes?.[scope]) {
    throw new CalendarEditError('This provider does not support scoped edits.', 409, {
      reason: capabilities.scope_reason || 'provider_scope_unsupported',
      data: { edit_capabilities: capabilities },
    });
  }
  const recurring = !!event.recurrence_rule;
  const occurrenceStart = body.occurrence_start || event.start_datetime;
  if (recurring && !body.occurrence_start) {
    throw new CalendarEditError('occurrence_start is required for a recurring scoped edit.', 400);
  }
  if (!dateParts(occurrenceStart)) throw new CalendarEditError('occurrence_start is invalid.', 400);
  if (!recurring && scope === 'following') {
    // A single event has no following occurrence.  `this` and `series` both
    // address that one row, which keeps direct gestures compatible with the
    // editor's default scope.
    throw new CalendarEditError('Only recurring events support this edit scope.', 400);
  }
  if (recurring && !occurrenceExists(d, event, occurrenceStart)) {
    throw new CalendarEditError('The requested occurrence does not exist.', 400);
  }

  const providerEvent = recurrenceParent(d, event) || event;
  const beforeSummary = eventEditMetadata(d, providerEvent).exception_summary;
  const source = providerForEvent(providerEvent);
  const result = d.transaction(() => {
    const normalized = normalizeScopeBody(body, event, d);
    const editIntent = captureEditIntent(d, event, body, normalized, occurrenceStart);
    const next = normalized.next;
    const requestedAssignments = normalized.assignmentIds;
    const recurrenceChanged = own(body, 'recurrence_rule')
      && String(next.recurrence_rule || '') !== String(event.recurrence_rule || '');
    if (recurring && scope === 'this' && recurrenceChanged) {
      throw new CalendarEditError(
        'Changing recurrence requires the whole series or the following scope.',
        400,
      );
    }
    let eventId = event.id;
    let parentEventId = null;
    let operationIds = [];
    let touchedEventIds = [event.id];
    let resultingEvent;

    if (scope === 'this' && recurring) {
      const originalEnd = occurrenceEnd(d, event, occurrenceStart);
      if (!own(body, 'start_datetime')) next.start_datetime = occurrenceStart;
      if (!own(body, 'end_datetime')) next.end_datetime = occurrenceEnd(d, event, occurrenceStart);
      if (!own(body, 'all_day')) next.all_day = event.all_day ? 1 : 0;
      validateResultShape(d, next);
      eventId = insertDetachedEvent(
        d,
        event,
        next,
        occurrenceStart,
        originalEnd,
        actorId,
        {
          assignmentIds: requestedAssignments,
          attachmentChange,
          reminderDelta: recurringDeltaBetween(
            d, occurrenceStart, next.start_datetime, event, !!event.all_day,
          ),
        },
      );
      parentEventId = event.id;
      touchedEventIds.push(eventId);
      d.prepare(`
        INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
        VALUES (?, ?)
      `).run(event.id, String(occurrenceStart).slice(0, 10));
      resultingEvent = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
    } else if (scope === 'following' && !isAtSeriesStart(event, occurrenceStart)) {
      const truncated = truncateRuleBefore(event.recurrence_rule, occurrenceStart);
      if (!truncated || !hasAnyOccurrence(event.start_datetime, truncated)) {
        throw new CalendarEditError('The preceding part of the series would be empty.', 400);
      }
      const originalEnd = occurrenceEnd(d, event, occurrenceStart);
      if (!own(body, 'start_datetime')) next.start_datetime = occurrenceStart;
      if (!own(body, 'end_datetime')) next.end_datetime = originalEnd;
      if (!own(body, 'all_day')) next.all_day = event.all_day ? 1 : 0;
      const ordinal = recurrenceOrdinal(d, event, occurrenceStart);
      next.recurrence_rule = countFollowingOccurrences(
        recurrenceChanged ? next.recurrence_rule : event.recurrence_rule,
        ordinal,
      );
      if (!next.recurrence_rule) {
        throw new CalendarEditError('The following series would have no remaining occurrences.', 400);
      }
      if (!recurrenceChanged) {
        next.recurrence_rule = shiftWeeklyBydayRule(
          next.recurrence_rule,
          recurringDateDelta(d, occurrenceStart, next.start_datetime, event),
        );
      }
      validateResultShape(d, next);
      resultingEvent = updateEventRow(d, event, { ...event, recurrence_rule: truncated }, { actorId, reanchor: false });
      resultingEvent = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
      eventId = insertDetachedEvent(
        d,
        event,
        next,
        occurrenceStart,
        originalEnd,
        actorId,
        {
          assignmentIds: requestedAssignments,
          attachmentChange,
          reminderDelta: recurringDeltaBetween(
            d, event.start_datetime, next.start_datetime, event, !!event.all_day,
          ),
        },
      );
      // The new row is a series master, not a detached exception.
      d.prepare(`
        UPDATE calendar_events
        SET recurrence_rule = ?, exception_of_event_id = NULL,
            exception_original_start = NULL, exception_original_end = NULL
        WHERE id = ?
      `).run(next.recurrence_rule, eventId);
      moveFollowingExceptions(d, event.id, eventId, String(occurrenceStart).slice(0, 10));
      resultingEvent = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
      touchedEventIds.push(eventId);
      parentEventId = event.id;
    } else {
      // `following` at the first occurrence has the same meaning as `series`;
      // a non-recurring `series` is also a regular one-row edit.
      const basis = recurring ? occurrenceStart : event.start_datetime;
      if (recurring) {
        const originalOccurrenceEnd = occurrenceEnd(d, event, occurrenceStart);
        const originalDuration = originalOccurrenceEnd
          ? recurringDeltaBetween(d, occurrenceStart, originalOccurrenceEnd, event, !!event.all_day)
          : null;
        const requestedDuration = own(body, 'start_datetime') && own(body, 'end_datetime')
          && next.end_datetime
          ? recurringDeltaBetween(d, next.start_datetime, next.end_datetime, event, !!event.all_day)
          : null;
        const startDelta = own(body, 'start_datetime')
          ? recurringDeltaBetween(d, basis, next.start_datetime, event, !!event.all_day)
          : 0;
        const endDelta = own(body, 'end_datetime') && originalOccurrenceEnd && next.end_datetime
          ? recurringDeltaBetween(d, originalOccurrenceEnd, next.end_datetime, event, !!event.all_day)
          : 0;
        if ((own(body, 'start_datetime') && startDelta === null)
            || (own(body, 'end_datetime') && endDelta === null)) {
          throw new CalendarEditError('The recurring occurrence range is invalid.', 400);
        }
        const isMove = own(body, 'start_datetime')
          && own(body, 'end_datetime')
          && originalDuration !== null
          && requestedDuration === originalDuration;
        if (isMove) {
          // The editor sends the selected occurrence's complete range.  Move
          // both master edges by the same gesture delta; copying the later
          // occurrence's end date would accidentally make an eight-day master.
          next.start_datetime = shiftRecurringTemporal(
            d, event.start_datetime, startDelta, event, !!event.all_day,
          );
          next.end_datetime = event.end_datetime
            ? shiftRecurringTemporal(d, event.end_datetime, startDelta, event, !!event.all_day)
            : null;
        } else {
          next.start_datetime = own(body, 'start_datetime')
            ? shiftRecurringTemporal(d, event.start_datetime, startDelta, event, !!event.all_day)
            : event.start_datetime;
          if (own(body, 'end_datetime')) {
            next.end_datetime = event.end_datetime
              ? shiftRecurringTemporal(d, event.end_datetime, endDelta, event, !!event.all_day)
              : next.end_datetime;
          } else if (own(body, 'start_datetime') && event.end_datetime) {
            next.end_datetime = shiftRecurringTemporal(
              d, event.end_datetime, startDelta, event, !!event.all_day,
            );
          }
        }
      } else if (own(body, 'start_datetime')) {
        const delta = deltaBetween(d, basis, next.start_datetime, !!event.all_day);
        if (delta === null) throw new CalendarEditError('start_datetime is invalid.', 400);
        if (!own(body, 'end_datetime') && event.end_datetime) {
          next.end_datetime = shiftTemporal(d, event.end_datetime, delta, !!event.all_day);
        }
      }
      if (!own(body, 'start_datetime') && !own(body, 'end_datetime')) {
        next.start_datetime = event.start_datetime;
        next.end_datetime = event.end_datetime;
      }
      if (recurring && !recurrenceChanged && scope !== 'this') {
        next.recurrence_rule = shiftWeeklyBydayRule(
          next.recurrence_rule,
          recurringDateDelta(d, basis, next.start_datetime, event),
        );
      }
      validateResultShape(d, next);
      resultingEvent = updateEventRow(d, event, next, {
        actorId,
        assignmentIds: requestedAssignments,
        attachmentChange,
      });
    }

    const afterEvent = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
    if (REMOTE_PROVIDERS.has(source) && remoteReference(providerEvent)) {
      let split = null;
      if (scope === 'following') {
        const masterAfter = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
        const exceptionOperations = eventId === event.id ? [] : followingExceptionOperations(
          d,
          providerEvent,
          eventId,
          occurrenceStart,
          recurringDeltaBetween(d, occurrenceStart, afterEvent.start_datetime, providerEvent, !!providerEvent.all_day),
          beforeSummary,
        );
        split = {
          master_after: copyEventSnapshot(masterAfter),
          new_master: copyEventSnapshot(afterEvent),
          ...(exceptionOperations.length ? { exception_operations: exceptionOperations } : {}),
        };
      }
      const payload = operationPayload({
        database: d,
        event: providerEvent,
        next: afterEvent,
        scope,
        occurrenceStart,
        eventId,
        parentEventId: parentEventId || (providerEvent.id !== event.id ? providerEvent.id : null),
        expectedParentRevision: body.expected_parent_revision ?? null,
        exceptionSummary: beforeSummary,
        split,
        intent: editIntent,
      });
      // The parent owns the recurrence identity, but Google's detached
      // instance has its own immutable conditional revision for this edit.
      if (source === 'google' && scope === 'this' && event.id !== providerEvent.id) {
        payload.provider.occurrenceId = event.external_calendar_id || null;
        payload.provider.occurrenceEtag = event.provider_revision || null;
      }
      const opId = queueCalendarEditOperation({
        eventId,
        source,
        scope,
        occurrenceStart,
        payload,
        createdBy: actorId,
      }, d);
      if (opId) operationIds.push(opId);
    }

    resultingEvent = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
    // Remote rows use the durable scoped operation above. Only local-origin
    // rows with a selected provider target follow the established provider
    // target scanner; marking remote rows here would enqueue a duplicate
    // ordinary update after the scoped operation has already run.
    if (event.external_source === 'local' || resultingEvent.external_source === 'local') {
      markEventOutbound(event, resultingEvent);
    }
    if (scope === 'following' && eventId !== event.id && event.external_source === 'local') {
      const truncated = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
      markEventOutbound(event, truncated);
    }
    return { event: resultingEvent, eventId, touchedEventIds, operationIds, scope };
  })();

  const responseEvent = result.event;
  return {
    ...result,
    data: responseEvent,
    metadata: eventEditMetadata(d, responseEvent),
    edit: {
      scope: result.scope,
      event_ids: result.touchedEventIds,
      operation_ids: result.operationIds,
      sync: calendarEditSyncForEvent(result.eventId, d),
    },
  };
}


function recoveryIntent(operation) {
  if (operation.payload?.edit_intent) return operation.payload.edit_intent;
  const { before = {}, after = {} } = operation.payload || {};
  const basis = operation.scope === 'series' ? before.start_datetime : operation.occurrence_start;
  const fields = Object.fromEntries(EVENT_FIELDS.filter((key) => {
    if (['start_datetime', 'end_datetime'].includes(key) && operation.scope !== 'series') return false;
    return before[key] !== after[key];
  }).map((key) => [key, after[key]]));
  return { fields, before_occurrence_start: basis, before_all_day: before.all_day };
}

function rebaseRecoveryBody(d, operation, parent, occurrenceStart) {
  const intent = recoveryIntent(operation);
  const body = { edit_scope: operation.scope, occurrence_start: occurrenceStart,
    expected_revision: eventRevisionToken(parent), ...intent.fields };
  if (own(intent, 'assigned_to')) body.assigned_to = intent.assigned_to;
  const original = originalRecoverySelection(d, operation);
  // Shift only between the selected occurrence and the preserved tail cutoff.
  // The chosen civil target itself is absolute, never a delta from optimistic UI.
  const days = recurringDateDelta(d, original, occurrenceStart, parent);
  for (const key of ['start_datetime', 'end_datetime']) if (own(intent.fields, key)) {
    const target = recurringWallValue(d, intent.fields[key], operation.payload.before);
    body[key] = target ? shiftDateKey(target.slice(0, 10), days || 0) + target.slice(10) : null;
  }
  const choices = operation.payload.recovery_choices || {};
  for (const [key, choice] of Object.entries(choices)) if (choice === 'provider') delete body[key];
  if (own(body, 'start_datetime') || own(body, 'end_datetime')) {
    if (!own(body, 'start_datetime')) body.start_datetime = recurringWallValue(d, occurrenceStart, parent);
    if (!own(body, 'end_datetime')) body.end_datetime = recurringWallValue(d, occurrenceEnd(d, parent, occurrenceStart), parent) || null;
  }
  return body;
}

function originalRecoverySelection(d, operation) {
  if (operation.payload.edit_intent?.original_occurrence_start) return operation.payload.edit_intent.original_occurrence_start;
  const dependency = operation.payload.split_reload_dependency;
  if (!dependency?.failed_continuation) return operation.occurrence_start;
  const delta = recurringDeltaBetween(d, dependency.occurrence_start,
    dependency.failed_continuation.start_datetime, dependency.confirmed_base);
  return shiftRecurringTemporal(d, operation.occurrence_start, -delta, dependency.failed_continuation,
    !!dependency.confirmed_base.all_day);
}

function recoveryConflicts(d, operation, parent) {
  const intent = recoveryIntent(operation);
  const base = operation.payload.split_reload_dependency?.confirmed_base;
  if (!base) return [];
  const selectedStart = originalRecoverySelection(d, operation);
  const date = String(recurringWallValue(d, selectedStart, base)).slice(0, 10);
  const selected = expandRecurringEvents([parent], date, date, null)[0];
  if (!selected) return [];
  const original = expandRecurringEvents([base], date, date, null)[0] || base;
  const conflicts = [];
  for (const [field, local] of Object.entries(intent.fields)) {
    const choice = operation.payload.recovery_choices?.[field];
    if (choice === 'provider') continue;
    // Detached fields belong to the exception, not the master. A master title
    // change is independent of the exception's deliberately different title.
    if (operation.scope === 'this' && ['title', 'description', 'location', 'recurrence_rule'].includes(field)) continue;
    // A local choice approves the provider value actually displayed then. A
    // subsequent incompatible change to that value requires a fresh choice;
    // unrelated revision changes do not invalidate the user's field decision.
    const chosenValue = choice === 'local' ? operation.payload.recovery_choice_values?.[field] : null;
    const before = chosenValue ? semanticEditValue(d, field, chosenValue.provider,
      { ...selected, all_day: chosenValue.all_day }) : semanticEditValue(d, field, original[field], original);
    const remote = semanticEditValue(d, field, selected[field], selected);
    const wanted = semanticEditValue(d, field, local, { ...selected, all_day: intent.fields.all_day ?? selected.all_day });
    if (before !== remote && remote !== wanted) conflicts.push({ field, base: chosenValue?.provider ?? original[field] ?? null,
      local, provider: selected[field] ?? null });
  }
  return conflicts;
}

function retainRecoveredRow(d, result, retainedId, authoritativeId, actorId) {
  if (result.eventId === retainedId) return retainedId;
  const retained = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(retainedId);
  const targetId = result.eventId === authoritativeId ? authoritativeId : retainedId;
  const removedId = targetId === authoritativeId ? retainedId : result.eventId;
  if (targetId === retainedId) updateEventRow(d, retained, result.event, { actorId });
  else {
    // Following at the first occurrence uses the existing provider row. Merge
    // local metadata into it; never delete that authoritative row or its data.
    d.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) SELECT ?, user_id FROM event_assignments WHERE event_id = ?')
      .run(targetId, retainedId);
    d.prepare("UPDATE reminders SET entity_id = ? WHERE entity_type = 'event' AND entity_id = ?")
      .run(targetId, retainedId);
    d.prepare('UPDATE calendar_edit_operations SET event_id = ? WHERE event_id = ?').run(targetId, retainedId);
  }
  d.prepare('UPDATE calendar_events SET exception_of_event_id = ? WHERE exception_of_event_id = ?')
    .run(targetId, removedId);
  d.prepare('INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) SELECT ?, exception_date FROM calendar_event_exceptions WHERE event_id = ?')
    .run(targetId, removedId);
  for (const id of result.operationIds) {
    const row = d.prepare('SELECT payload_json FROM calendar_edit_operations WHERE id = ?').get(id);
    const payload = { ...JSON.parse(row.payload_json), event_id: targetId };
    d.prepare('UPDATE calendar_edit_operations SET event_id = ?, payload_json = ? WHERE id = ?')
      .run(targetId, JSON.stringify(payload), id);
  }
  d.prepare("DELETE FROM reminders WHERE entity_type = 'event' AND entity_id = ?").run(removedId);
  d.prepare('DELETE FROM calendar_events WHERE id = ?').run(removedId);
  return targetId;
}

function unavailableRecovery(d, operations, childId) {
  const message = 'The selected occurrence no longer exists on the provider. Review changes and the original series, choose an existing occurrence, or discard unsaved changes.';
  retainCalendarRecoveryError(operations, 'recovery_occurrence_missing', message, d);
  d.prepare("UPDATE calendar_events SET sync_state = 'error', sync_error = ? WHERE id = ?").run(message, childId);
}

/** Rebuild newer intent and its complete split payload from authoritative data. */
export function recoverFollowingCalendarEditAfterReadback(parentId, source, database) {
  const d = dbOrDefault(database);
  const waiting = activeCalendarEditOperations(source, d).filter((operation) => (
    operation.payload?.split_reload_dependency?.parent_event_id === parentId
      && operation.failure_kind !== 'recovery_occurrence_missing'
  ));
  const childIds = [...new Set(waiting.map((operation) => operation.payload.split_reload_dependency.continuation_event_id))];
  for (const childId of childIds) {
    try { d.transaction(() => {
    const dependents = waiting.filter((operation) => operation.payload.split_reload_dependency.continuation_event_id === childId);
    const series = dependents.filter((operation) => operation.event_id === childId && operation.scope === 'series');
    const parent = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(parentId);
    const child = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(childId);
    if (!child) return;
    if (!parent?.external_calendar_id) { unavailableRecovery(d, dependents, childId); return; }
    if (!parent.provider_revision) return;
    const date = String(dependents[0].payload.split_reload_dependency.occurrence_start).slice(0, 10);
    const occurrence = parent.recurrence_rule
      ? expandRecurringEvents([parent], date, date, loadEventExceptions(d, [parentId]))[0]
      : String(recurringWallValue(d, parent.start_datetime, parent)).slice(0, 10) === date ? parent : null;
    if (!occurrence) { unavailableRecovery(d, dependents, childId); return; }
    const latestFields = new Map();
    for (const operation of dependents) for (const field of Object.keys(recoveryIntent(operation).fields)) {
      latestFields.set(operation.event_id + ':' + operation.scope + ':' + field, operation.id);
    }
    const reviewed = dependents.map((operation) => ({ operation,
      conflicts: recoveryConflicts(d, operation, parent).filter(({ field }) =>
        latestFields.get(operation.event_id + ':' + operation.scope + ':' + field) === operation.id) }));
    // Reconcile every dependent on this readback. An obsolete conflict must not
    // retain an older revision while another field still requires a choice.
    for (const { operation, conflicts } of reviewed) {
      if (conflicts.length) retainCalendarRecoveryError([operation],
        'recovery_field_conflict', 'Both you and the provider changed the same field. Review changes and choose which value to keep.', d,
        { parent_event_id: parentId, authoritative: copyEventSnapshot(parent),
          authoritative_revision: eventRevisionToken(parent), conflicts });
      else if (operation.failure_kind === 'recovery_field_conflict') {
        const payload = { ...operation.payload, recovery: null };
        d.prepare(`UPDATE calendar_edit_operations SET payload_json = ?, status = 'pending', retryable = 1,
          failure_kind = NULL, last_error = NULL WHERE id = ? AND resolution IS NULL`)
          .run(JSON.stringify(payload), operation.id);
      }
    }
    if (reviewed.some((item) => item.conflicts.length)) return;
    const atStart = sameOccurrenceIdentity(parent.start_datetime, occurrence.start_datetime, !!parent.all_day);
    const body = { edit_scope: atStart ? 'series' : 'following', occurrence_start: occurrence.start_datetime,
      expected_revision: eventRevisionToken(parent) };
    for (const operation of series) {
      const intent = recoveryIntent(operation);
      const chosen = rebaseRecoveryBody(d, operation, parent, occurrence.start_datetime);
      for (const key of Object.keys(intent.fields)) {
        if (own(chosen, key)) body[key] = chosen[key];
        else if (operation.payload.recovery_choices?.[key] === 'provider') delete body[key];
      }
      if (own(intent, 'assigned_to')) body.assigned_to = intent.assigned_to;
    }
    if (series.length) {
      if (own(body, 'start_datetime') || own(body, 'end_datetime')) {
        if (!own(body, 'start_datetime')) body.start_datetime = recurringWallValue(d, occurrence.start_datetime, parent);
        if (!own(body, 'end_datetime')) body.end_datetime = recurringWallValue(d, occurrenceEnd(d, parent, occurrence.start_datetime), parent) || null;
      }
      if (own(body, 'recurrence_rule') && !atStart) {
        const ordinal = recurrenceOrdinal(d, parent, occurrence.start_datetime);
        body.recurrence_rule = String(body.recurrence_rule || '').replace(/COUNT=(\d+)/i,
          (_, count) => 'COUNT=' + (Number(count) + ordinal - 1));
      }
    }
    const actorId = dependents.at(-1).created_by;
    validateRecoveryRange(d, parent, body);
    const recovered = applyScopedCalendarEdit({ database: d, event: parent, body, actorId });
    const canonicalId = retainRecoveredRow(d, recovered, childId, parentId, actorId);
    const prerequisiteId = recovered.operationIds[0];
    for (const operation of series) d.prepare(`
      UPDATE calendar_edit_operations SET resolution = 'replaced_after_reload', retryable = 0,
        claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL,
        claim_generation = claim_generation + 1 WHERE id = ?
    `).run(operation.id);
    // Rebuild dependent snapshots now through the same scoped service. Their
    // provider identities/revisions are released only after the fenced parent
    // operation is accepted; stale claims cannot publish these replacements.
    for (const operation of dependents.filter((item) => !series.some((edit) => edit.id === item.id))) {
      const oldParent = operation.payload.parent_event_id === childId ? canonicalId : operation.payload.parent_event_id;
      const basisId = operation.scope === 'this' ? operation.event_id : oldParent || canonicalId;
      const basis = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(basisId);
      const master = operation.scope === 'this' ? d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(basis.exception_of_event_id) : basis;
      let selected;
      if (operation.scope === 'this') selected = basis.exception_original_start || basis.start_datetime;
      else {
        const oldDate = String(originalRecoverySelection(d, operation)).slice(0, 10);
        const candidate = expandRecurringEvents([master], oldDate, oldDate, null)[0];
        selected = candidate?.start_datetime;
      }
      if (!selected) { unavailableRecovery(d, [operation], operation.event_id); continue; }
      const nextBody = rebaseRecoveryBody(d, operation, basis, selected);
      validateRecoveryRange(d, basis, nextBody);
      if (operation.scope === 'following' && sameOccurrenceIdentity(master.start_datetime, selected, !!master.all_day)) nextBody.edit_scope = 'series';
      const next = applyScopedCalendarEdit({ database: d, event: basis, body: nextBody, actorId: operation.created_by });
      const targetId = retainRecoveredRow(d, next, operation.event_id, master.id, operation.created_by);
      const generated = d.prepare('SELECT * FROM calendar_edit_operations WHERE id = ?').get(next.operationIds[0]);
      const payload = { ...JSON.parse(generated.payload_json), event_id: targetId,
        provider_dependency_operation_id: prerequisiteId, rebased_after_reload: operation.id };
      d.prepare(`
        UPDATE calendar_edit_operations SET event_id = ?, scope = ?, occurrence_start = ?, payload_json = ?,
          progress_json = NULL, status = 'pending', retryable = 1, resolution = NULL,
          failure_kind = NULL, last_error = NULL, claim_token = NULL, claim_expires_at = NULL,
          claimed_at = NULL, claim_generation = claim_generation + 1 WHERE id = ?
      `).run(targetId, generated.scope, generated.occurrence_start, JSON.stringify(payload), operation.id);
      d.prepare('DELETE FROM calendar_edit_operations WHERE id = ?').run(generated.id);
    }
    const baseOperation = d.prepare('SELECT payload_json FROM calendar_edit_operations WHERE id = ?').get(prerequisiteId);
    const payload = { ...JSON.parse(baseOperation.payload_json), recovered_from_operations: series.map((item) => item.id),
      split_reload_dependents: dependents.filter((item) => !series.some((edit) => edit.id === item.id)).map((item) => item.id) };
    d.prepare('UPDATE calendar_edit_operations SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), prerequisiteId);
    d.prepare("UPDATE calendar_events SET sync_state = 'pending', sync_error = NULL WHERE id = ?").run(canonicalId);
    })(); } catch (error) {
      if (!(error instanceof CalendarEditError)) throw error;
      const retained = waiting.filter((operation) => operation.payload.split_reload_dependency.continuation_event_id === childId);
      retainCalendarRecoveryError(retained, 'recovery_invalid_range',
        'The retained time range is invalid. Review changes and the original event, or discard unsaved changes.', d);
    }
  }
}

function validateRecoveryRange(d, event, body) {
  if (!own(body, 'start_datetime') && !own(body, 'end_datetime') && !own(body, 'all_day')) return;
  const selected = body.occurrence_start || event.start_datetime;
  const next = { ...event, start_datetime: selected, end_datetime: occurrenceEnd(d, event, selected), ...body };
  validateResultShape(d, next);
  if (!next.all_day && next.end_datetime && deltaBetween(d, next.start_datetime, next.end_datetime) < 15 * 60000) {
    throw new CalendarEditError('Recovered timed intervals require at least 15 minutes.', 400);
  }
}

/** Explicit field choices are revision-fenced and use the same recovery path. */
export function resolveCalendarRecoveryFields({ database, eventId, operationId, choices, expectedRevision }) {
  const d = dbOrDefault(database);
  return d.transaction(() => {
    const operation = activeCalendarEditOperations(null, d).find((item) => item.id === operationId && item.event_id === eventId);
    if (operation?.failure_kind !== 'recovery_field_conflict') throw new CalendarEditError('Recovery conflict is no longer available.', 409);
    const parentId = operation.payload.recovery.parent_event_id;
    const parent = d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(parentId);
    if (!parent) throw new CalendarEditError('The original event no longer exists.', 409);
    if (!expectedRevision) throw new CalendarEditError('expected_revision is required.', 400);
    if (expectedRevision !== operation.payload.recovery.authoritative_revision) {
      throw new CalendarEditError('Displayed recovery choices are stale. Review the refreshed changes.', 409);
    }
    checkRevision(parent, expectedRevision);
    const related = activeCalendarEditOperations(operation.source, d).filter((item) => item.event_id === eventId
      && item.failure_kind === 'recovery_field_conflict' && item.payload.recovery?.parent_event_id === parentId);
    if (related.some((item) => item.payload.recovery.authoritative_revision !== expectedRevision)) {
      throw new CalendarEditError('Displayed recovery choices are stale. Review the refreshed changes.', 409);
    }
    const conflicts = related.flatMap((item) => item.payload.recovery.conflicts || []);
    if (!choices || !Object.keys(choices).length
        || Object.entries(choices).some(([field, choice]) => !['local', 'provider'].includes(choice)
          || !conflicts.some((item) => item.field === field))) {
      throw new CalendarEditError('Choose a value for at least one displayed conflicting field.', 400);
    }
    for (const item of related) {
      const fieldChoices = Object.fromEntries((item.payload.recovery.conflicts || [])
        .filter(({ field }) => own(choices, field)).map(({ field }) => [field, choices[field]]));
      if (!Object.keys(fieldChoices).length) continue;
      const choiceValues = Object.fromEntries((item.payload.recovery.conflicts || [])
        .filter(({ field }) => own(fieldChoices, field)).map((conflict) => [conflict.field,
          { provider: conflict.provider, all_day: item.payload.recovery.authoritative?.all_day }]));
      const payload = { ...item.payload, recovery_choices: { ...item.payload.recovery_choices, ...fieldChoices },
        recovery_choice_values: { ...item.payload.recovery_choice_values, ...choiceValues }, recovery: null };
      d.prepare(`UPDATE calendar_edit_operations SET payload_json = ?, status = 'pending', retryable = 1,
        failure_kind = NULL, last_error = NULL WHERE id = ?`).run(JSON.stringify(payload), item.id);
    }
    recoverFollowingCalendarEditAfterReadback(parentId, operation.source, d);
    return d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId)
      || d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(parentId);
  })();
}

export { truncateRuleBefore, checkRevision, validateResultShape };
