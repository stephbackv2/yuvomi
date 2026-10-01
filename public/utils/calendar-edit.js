/**
 * Pure helpers for calendar direct manipulation.
 *
 * The calendar stores both wall-clock values (local events) and explicit
 * instants (provider events). Geometry is always calculated from the household
 * display zone; the browser's zone never participates in a gesture.
 */

import {
  addZonedElapsedMinutes,
  hasExplicitZone,
  zonedDateKey,
  zonedDateTimeToInstant,
  zonedTimeKey,
} from '/utils/timezone.js';

export const CALENDAR_SNAP_MINUTES = 15;
export const CALENDAR_MIN_TIMED_MINUTES = 15;
export const CALENDAR_DEFAULT_TIMED_MINUTES = 60;

const MINUTES_PER_DAY = 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

export function isDateKey(value) {
  return DATE_RE.test(String(value ?? ''));
}

export function isTimeKey(value) {
  return TIME_RE.test(String(value ?? ''));
}

export function timeToMinutes(value) {
  if (!isTimeKey(value)) return 0;
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

export function dateKeyToDay(value) {
  if (!isDateKey(value)) return NaN;
  const [year, month, day] = String(value).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function dayToDateKey(day) {
  if (!Number.isFinite(day)) return '';
  const date = new Date(Math.round(day) * DAY_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addCalendarDays(dateKey, days) {
  const day = dateKeyToDay(dateKey);
  return dayToDateKey(day + Math.trunc(days));
}

export function dayDifference(from, to) {
  return dateKeyToDay(to) - dateKeyToDay(from);
}

export function civilMinute(dateKey, timeKey = '00:00') {
  return dateKeyToDay(dateKey) * MINUTES_PER_DAY + timeToMinutes(timeKey);
}

export function civilParts(totalMinutes) {
  const total = Math.round(Number(totalMinutes));
  const day = Math.floor(total / MINUTES_PER_DAY);
  const minute = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return {
    date: dayToDateKey(day),
    time: `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`,
    minute,
    day,
  };
}

export function snapCalendarMinutes(minutes, mode = 'round') {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric)) return 0;
  const factor = numeric / CALENDAR_SNAP_MINUTES;
  const snapped = mode === 'floor' ? Math.floor(factor) : mode === 'ceil' ? Math.ceil(factor) : Math.round(factor);
  return snapped * CALENDAR_SNAP_MINUTES;
}

export function snapCalendarTime(time, mode = 'round') {
  const minutes = snapCalendarMinutes(timeToMinutes(time), mode);
  const safe = Math.min(minutes, MINUTES_PER_DAY - CALENDAR_SNAP_MINUTES);
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
}

function dateTimeParts(value) {
  const raw = String(value ?? '');
  const date = zonedDateKey(raw) || raw.slice(0, 10);
  const time = raw.length > 10 ? (zonedTimeKey(raw) || raw.slice(11, 16)) : '00:00';
  return {
    date: isDateKey(date) ? date : '',
    time: isTimeKey(time) ? time : '00:00',
  };
}

function explicitDurationMinutes(startValue, endValue) {
  if (!hasExplicitZone(startValue) || !hasExplicitZone(endValue)) return null;
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.max(CALENDAR_MIN_TIMED_MINUTES, Math.round((end - start) / 60000));
}

function usesElapsedClock(event) {
  return !event?.all_day
    && !isRecurringEvent(event)
    && Boolean(event?.start_datetime)
    && Boolean(event?.end_datetime);
}

function elapsedStartInstant(event, start) {
  if (!usesElapsedClock(event)) return NaN;
  if (hasExplicitZone(event.start_datetime)) {
    const parsed = new Date(event.start_datetime).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return zonedDateTimeToInstant(start.date, start.time);
}

function wallPartsAtInstant(epoch) {
  const date = zonedDateKey(new Date(epoch));
  const time = zonedTimeKey(new Date(epoch));
  return date && time ? { date, time } : null;
}

function timedEndParts(event, start, duration) {
  if (usesElapsedClock(event)) {
    const elapsed = addZonedElapsedMinutes(start.date, start.time, duration);
    if (elapsed) return elapsed;
  }
  return civilParts(civilMinute(start.date, start.time) + duration);
}

function occupiedTimedEndDate(startDate, endDate, endTime) {
  if (endDate > startDate && endTime === '00:00') return addCalendarDays(endDate, -1);
  return endDate;
}

export function timedDurationMinutes(event) {
  const start = dateTimeParts(event?.start_datetime);
  const end = dateTimeParts(event?.end_datetime);
  const explicit = explicitDurationMinutes(event?.start_datetime, event?.end_datetime);
  if (explicit !== null && !isRecurringEvent(event)) return explicit;
  if (!start.date) return CALENDAR_DEFAULT_TIMED_MINUTES;
  if (!event?.end_datetime) return CALENDAR_DEFAULT_TIMED_MINUTES;
  let duration = civilMinute(end.date, end.time) - civilMinute(start.date, start.time);
  while (duration <= 0) duration += MINUTES_PER_DAY;
  return Math.max(CALENDAR_MIN_TIMED_MINUTES, duration);
}

export function occupiedDateRange(event) {
  const start = dateTimeParts(event?.start_datetime);
  if (!start.date) return { start: '', end: '', days: 0 };
  const end = dateTimeParts(event?.end_datetime || event?.start_datetime);
  let endDate = end.date || start.date;
  if (!event?.all_day && event?.end_datetime) {
    const end = timedEndParts(event, start, timedDurationMinutes(event));
    endDate = occupiedTimedEndDate(start.date, end.date, end.time);
  }
  if (dateKeyToDay(endDate) < dateKeyToDay(start.date)) endDate = start.date;
  return {
    start: start.date,
    end: endDate,
    days: Math.max(1, dayDifference(start.date, endDate) + 1),
  };
}

export function eventRange(event) {
  const start = dateTimeParts(event?.start_datetime);
  if (!start.date) return null;
  if (event?.all_day) {
    const dates = occupiedDateRange(event);
    return {
      allDay: true,
      startDate: dates.start,
      endDate: dates.end,
      startMinute: civilMinute(dates.start),
      endMinute: civilMinute(addCalendarDays(dates.end, 1)),
      durationMinutes: dates.days * MINUTES_PER_DAY,
      durationDays: dates.days,
    };
  }
  const startMinute = civilMinute(start.date, start.time);
  const durationMinutes = timedDurationMinutes(event);
  const end = timedEndParts(event, start, durationMinutes);
  const occupiedEndDate = occupiedTimedEndDate(start.date, end.date, end.time);
  const range = {
    allDay: false,
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    startMinute,
    endMinute: civilMinute(end.date, end.time),
    durationMinutes: Math.max(CALENDAR_MIN_TIMED_MINUTES, durationMinutes),
    durationDays: Math.max(1, dayDifference(start.date, occupiedEndDate) + 1),
  };
  if (usesElapsedClock(event)) {
    const startEpoch = elapsedStartInstant(event, start);
    if (Number.isFinite(startEpoch)) {
      range.startEpoch = startEpoch;
      range.endEpoch = startEpoch + durationMinutes * 60000;
    }
  }
  return range;
}

export function patchForRange(event, range) {
  if (!range) return null;
  if (range.allDay) {
    return {
      start_datetime: range.startDate,
      end_datetime: range.endDate,
      all_day: 1,
    };
  }
  return {
    start_datetime: `${range.startDate}T${range.startTime}`,
    end_datetime: `${range.endDate}T${range.endTime}`,
    all_day: 0,
  };
}

export function previewEvent(event, range) {
  const patch = patchForRange(event, range);
  return patch ? { ...event, ...patch } : { ...event };
}

function targetCivilMinute(target) {
  if (!target?.date) return NaN;
  return civilMinute(target.date, target.time || '00:00');
}

/**
 * Move a body while keeping the point grabbed inside the event fixed. The
 * offset includes the horizontal day offset in multi-day views.
 */
export function moveEventRange(event, target, {
  grabOffsetMinutes = 0,
  targetKind = 'grid',
} = {}) {
  const current = eventRange(event);
  if (!current || !target?.date) return null;

  if (current.allDay && targetKind === 'grid') {
    const start = targetCivilMinute(target);
    // An all-day body has no meaningful vertical offset. A body drop onto the
    // timed grid starts the one-hour conversion at the dropped wall-clock
    // position; the horizontal segment offset only applies while staying in
    // an all-day row.
    const snapped = snapCalendarMinutes(start);
    const end = snapped + CALENDAR_DEFAULT_TIMED_MINUTES;
    return eventRange(previewEvent(event, {
      allDay: false,
      startDate: civilParts(snapped).date,
      startTime: civilParts(snapped).time,
      endDate: civilParts(end).date,
      endTime: civilParts(end).time,
    }));
  }

  if (!current.allDay && targetKind === 'all-day') {
    const targetDay = dateKeyToDay(target.date) - Math.floor(grabOffsetMinutes / MINUTES_PER_DAY);
    const startDate = dayToDateKey(targetDay);
    const endDate = addCalendarDays(startDate, current.durationDays - 1);
    return {
      allDay: true,
      startDate,
      endDate,
      startMinute: civilMinute(startDate),
      endMinute: civilMinute(addCalendarDays(endDate, 1)),
      durationMinutes: current.durationDays * MINUTES_PER_DAY,
      durationDays: current.durationDays,
    };
  }

  if (current.allDay) {
    const targetDay = dateKeyToDay(target.date) - Math.floor(grabOffsetMinutes / MINUTES_PER_DAY);
    const startDate = dayToDateKey(targetDay);
    const endDate = addCalendarDays(startDate, current.durationDays - 1);
    return {
      allDay: true,
      startDate,
      endDate,
      startMinute: civilMinute(startDate),
      endMinute: civilMinute(addCalendarDays(endDate, 1)),
      durationMinutes: current.durationDays * MINUTES_PER_DAY,
      durationDays: current.durationDays,
    };
  }

  const pointer = targetCivilMinute(target);
  if (!Number.isFinite(pointer)) return null;
  const snappedStart = snapCalendarMinutes(pointer - grabOffsetMinutes);
  const start = civilParts(snappedStart);
  const end = timedEndParts(event, start, current.durationMinutes);
  const endMinute = civilMinute(end.date, end.time);
  const occupiedEndDate = occupiedTimedEndDate(start.date, end.date, end.time);
  return {
    allDay: false,
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    startMinute: snappedStart,
    endMinute,
    durationMinutes: current.durationMinutes,
    durationDays: Math.max(1, dayDifference(start.date, occupiedEndDate) + 1),
  };
}

export function resizeEventRange(event, edge, target, { allDaySpan = false } = {}) {
  const current = eventRange(event);
  if (!current || !target?.date) return null;
  if (current.allDay) {
    const day = dateKeyToDay(target.date);
    const startDay = dateKeyToDay(current.startDate);
    const endDay = dateKeyToDay(current.endDate);
    const nextStart = edge === 'start' ? dayToDateKey(Math.min(day, endDay)) : current.startDate;
    const nextEnd = edge === 'end' ? dayToDateKey(Math.max(day, startDay)) : current.endDate;
    return {
      allDay: true,
      startDate: nextStart,
      endDate: nextEnd,
      startMinute: civilMinute(nextStart),
      endMinute: civilMinute(addCalendarDays(nextEnd, 1)),
      durationMinutes: (dayDifference(nextStart, nextEnd) + 1) * MINUTES_PER_DAY,
      durationDays: dayDifference(nextStart, nextEnd) + 1,
    };
  }

  // Multi-day timed events are rendered in the all-day row in week/day views,
  // but resizing them must keep their timed representation. The horizontal
  // handle changes the civil date and retains the edge's wall-clock time;
  // the normal timed branch below still enforces the 15-minute minimum.
  if (allDaySpan) {
    return resizeEventRange(event, edge, {
      ...target,
      time: edge === 'start' ? current.startTime : current.endTime,
    });
  }

  const targetMinute = targetCivilMinute(target);
  if (!Number.isFinite(targetMinute)) return null;
  if (usesElapsedClock(event)) {
    const startEpoch = Number.isFinite(current.startEpoch)
      ? current.startEpoch
      : elapsedStartInstant(event, { date: current.startDate, time: current.startTime });
    const endEpoch = Number.isFinite(current.endEpoch)
      ? current.endEpoch
      : startEpoch + current.durationMinutes * 60000;
    const targetEpoch = zonedDateTimeToInstant(target.date, target.time);
    if (Number.isFinite(startEpoch) && Number.isFinite(endEpoch) && Number.isFinite(targetEpoch)) {
      const minimum = CALENDAR_MIN_TIMED_MINUTES * 60000;
      if (edge === 'start') {
        const nextStartEpoch = Math.min(targetEpoch, endEpoch - minimum);
        const nextStart = wallPartsAtInstant(nextStartEpoch);
        const end = wallPartsAtInstant(endEpoch);
        if (!nextStart || !end) return null;
        return {
          ...current,
          startDate: nextStart.date,
          startTime: nextStart.time,
          startMinute: civilMinute(nextStart.date, nextStart.time),
          endDate: end.date,
          endTime: end.time,
          endMinute: civilMinute(end.date, end.time),
          durationMinutes: Math.max(CALENDAR_MIN_TIMED_MINUTES, Math.round((endEpoch - nextStartEpoch) / 60000)),
          durationDays: Math.max(1, dayDifference(nextStart.date, occupiedTimedEndDate(nextStart.date, end.date, end.time)) + 1),
          startEpoch: nextStartEpoch,
          endEpoch,
        };
      }
      const nextEndEpoch = Math.max(targetEpoch, startEpoch + minimum);
      const start = wallPartsAtInstant(startEpoch);
      const nextEnd = wallPartsAtInstant(nextEndEpoch);
      if (!start || !nextEnd) return null;
      return {
        ...current,
        startDate: start.date,
        startTime: start.time,
        endDate: nextEnd.date,
        endTime: nextEnd.time,
        startMinute: civilMinute(start.date, start.time),
        endMinute: civilMinute(nextEnd.date, nextEnd.time),
        durationMinutes: Math.max(CALENDAR_MIN_TIMED_MINUTES, Math.round((nextEndEpoch - startEpoch) / 60000)),
        durationDays: Math.max(1, dayDifference(start.date, occupiedTimedEndDate(start.date, nextEnd.date, nextEnd.time)) + 1),
        startEpoch,
        endEpoch: nextEndEpoch,
      };
    }
  }
  if (edge === 'start') {
    const maxStart = current.endMinute - CALENDAR_MIN_TIMED_MINUTES;
    const startMinute = Math.min(snapCalendarMinutes(targetMinute), maxStart);
    const start = civilParts(startMinute);
    const end = civilParts(current.endMinute);
    return {
      ...current,
      startDate: start.date,
      startTime: start.time,
      startMinute,
      durationMinutes: current.endMinute - startMinute,
      durationDays: Math.max(1, dayDifference(start.date, end.date) + 1),
    };
  }
  const minEnd = current.startMinute + CALENDAR_MIN_TIMED_MINUTES;
  const endMinute = Math.max(snapCalendarMinutes(targetMinute), minEnd);
  const end = civilParts(endMinute);
  return {
    ...current,
    endDate: end.date,
    endTime: end.time,
    endMinute,
    durationMinutes: endMinute - current.startMinute,
    durationDays: Math.max(1, dayDifference(current.startDate, end.date) + 1),
  };
}

/**
 * Detached occurrences are ordinary rows in the calendar feed, but their
 * parent series is the object that owns `following` and `series` edits.  The
 * server sends the parent envelope explicitly; callers must never infer a
 * parent from the detached row's current date or title.
 */
export function recurrenceParent(event) {
  const parent = firstDefined(event?.recurrence_parent, event?.recurrenceParent);
  return parent && typeof parent === 'object' ? parent : null;
}

export function isDetachedEvent(event) {
  return Boolean(
    event?.exception_of_event_id
      || event?.original_occurrence_start
      || event?.exception_original_start
      || recurrenceParent(event)
  );
}

export function eventOccurrenceStart(event) {
  return firstDefined(
    event?.original_occurrence_start,
    event?.exception_original_start,
    event?.start_datetime,
    null
  );
}

export function recurrenceParentRevision(event) {
  const parent = recurrenceParent(event);
  return firstDefined(event?.parent_revision, parent?.revision, null);
}

/**
 * Returns the recurrence fields for a scoped editor save. Detached rows do not
 * own a rule: an unchanged parent rule is sent as an empty value so the server
 * can inherit it, while a deliberate parent rule edit is marked explicitly.
 */
export function scopedRecurrencePayload(event, recurrenceRule, scope = 'this') {
  if (!isDetachedEvent(event)) return { recurrence_rule: recurrenceRule ?? null };

  const ownRule = firstDefined(event?.recurrence_rule, null) ?? null;
  if (scope === 'this') return { recurrence_rule: ownRule };

  const parentRule = firstDefined(recurrenceParent(event)?.recurrence_rule, null) ?? null;
  const current = typeof recurrenceRule === 'string' && recurrenceRule.trim()
    ? recurrenceRule
    : null;
  const inherited = typeof parentRule === 'string' && parentRule.trim()
    ? parentRule
    : null;
  if (current === inherited) return { recurrence_rule: null };
  return { recurrence_rule: current, recurrence_rule_explicit: true };
}

export function isRecurringEvent(event) {
  return Boolean(
    event?.recurrence_rule
      || event?.is_recurring_instance
      || event?.recurrence_template_id
      || isDetachedEvent(event)
  );
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function eventRevision(event) {
  return firstDefined(event?.revision, event?.edit_revision, event?.meta?.revision, null);
}

export function editCapabilities(event) {
  const raw = firstDefined(event?.edit_capabilities, event?.editCapabilities, event?.capabilities, {});
  const caps = raw && typeof raw === 'object' ? raw : {};
  const canEdit = firstDefined(caps.editable, caps.can_edit, event?.editable, event?.can_edit);
  const canMove = firstDefined(caps.move, caps.can_move, caps.movable, event?.movable, canEdit);
  const canResize = firstDefined(caps.resize, caps.can_resize, caps.resizable, event?.resizable, canEdit);
  const scopes = caps.scopes && typeof caps.scopes === 'object' ? caps.scopes : {};
  const canChangeScope = firstDefined(
    caps.can_change_scope,
    caps.scoped_edit,
    scopes.this,
    canEdit
  );
  const reason = firstDefined(
    caps.read_only_reason,
    caps.reason,
    caps.block_reason,
    event?.edit_block_reason,
    event?.read_only_reason,
    event?.readonly_reason,
    ''
  );
  const readOnly = Boolean(firstDefined(caps.read_only, event?.read_only, event?.readonly, false));
  return {
    ...caps,
    can_edit: !readOnly && (canEdit === undefined ? true : Boolean(canEdit)),
    can_move: !readOnly && (canMove === undefined ? true : Boolean(canMove)),
    can_resize: !readOnly && (canResize === undefined ? true : Boolean(canResize)),
    can_change_scope: !readOnly && (canChangeScope === undefined ? true : Boolean(canChangeScope)),
    read_only: readOnly,
    scopes,
    reason: String(reason || ''),
  };
}

export function isEditAllowed(event, action = 'edit') {
  const caps = editCapabilities(event);
  if (action === 'move') return caps.can_edit && caps.can_move;
  if (action === 'resize') return caps.can_edit && caps.can_resize;
  return caps.can_edit;
}

export function editBlockReason(event) {
  return editCapabilities(event).reason;
}

export function syncMetadata(event) {
  const sync = firstDefined(event?.sync, event?.sync_metadata, event?.syncMeta, {});
  const source = typeof sync === 'object' ? sync : {};
  return {
    ...source,
    state: firstDefined(source.state, source.status, event?.sync_state, event?.sync_status, null),
    error: firstDefined(source.error, source.error_message, event?.sync_error, null),
    retryable: Boolean(firstDefined(source.retryable, event?.sync_retryable, false)),
    provider: firstDefined(source.provider, source.source, event?.external_source, null),
  };
}

export function exceptionSummary(event) {
  const summary = firstDefined(event?.exception_summary, event?.exceptionSummary, event?.exceptions, null);
  if (!summary) return null;
  if (Array.isArray(summary)) return { count: summary.length, complete: true, items: summary };
  if (typeof summary !== 'object') return null;
  return {
    ...summary,
    count: Number(firstDefined(summary.count, summary.total, summary.exception_count, summary.items?.length, 0)),
    known: Boolean(firstDefined(summary.known, summary.complete, summary.reliably_known, false)),
    complete: Boolean(firstDefined(summary.known, summary.complete, summary.reliably_known, false)),
    truncated: Boolean(summary.truncated),
    items: Array.isArray(summary.items) ? summary.items : Array.isArray(summary.exceptions) ? summary.exceptions : [],
  };
}

export function directEditBody(event, range, { scope = 'this' } = {}) {
  const patch = patchForRange(event, range);
  if (!patch) return null;
  const body = {
    ...patch,
    edit_scope: scope,
    occurrence_start: eventOccurrenceStart(event),
    expected_revision: eventRevision(event),
  };
  const parentRevision = recurrenceParentRevision(event);
  if (scope !== 'this' && parentRevision !== null && parentRevision !== undefined) {
    body.expected_parent_revision = parentRevision;
  }
  return body;
}

export function responseEvent(response) {
  return response?.data?.event ?? response?.data ?? response?.event ?? null;
}

export function isConflictError(error) {
  return Number(error?.status ?? error?.code ?? error?.data?.code) === 409
    || error?.data?.error_code === 'CONCURRENT_CALENDAR_EDIT'
    || error?.data?.code === 'CONCURRENT_CALENDAR_EDIT';
}
