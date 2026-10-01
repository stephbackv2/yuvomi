/**
 * Pure interaction and provider-contract coverage for calendar direct edits.
 *
 * Run: node --loader ./test/test-browser-loader.mjs --test test/test-calendar-direct-manipulation.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  directEditBody,
  editCapabilities,
  eventRange,
  exceptionSummary,
  eventOccurrenceStart,
  isEditAllowed,
  isDetachedEvent,
  moveEventRange,
  patchForRange,
  recurrenceParentRevision,
  resizeEventRange,
  scopedRecurrencePayload,
  syncMetadata,
} from '../public/utils/calendar-edit.js';
import { setDisplayTimeZone } from '../public/utils/timezone.js';

const timed = (start, end, extra = {}) => ({
  id: 4,
  start_datetime: start,
  end_datetime: end,
  all_day: 0,
  revision: 'rev-4',
  ...extra,
});

test('15-minute move preserves the grabbed offset, duration, and midnight crossing', () => {
  const event = timed('2026-09-22T23:45', '2026-09-23T00:30');
  const range = moveEventRange(event, { kind: 'grid', date: '2026-09-24', time: '09:07' }, {
    grabOffsetMinutes: 15,
    targetKind: 'grid',
  });

  assert.equal(range.startDate, '2026-09-24');
  assert.equal(range.startTime, '08:45');
  assert.equal(range.endDate, '2026-09-24');
  assert.equal(range.endTime, '09:30');
  assert.deepEqual(patchForRange(event, range), {
    start_datetime: '2026-09-24T08:45',
    end_datetime: '2026-09-24T09:30',
    all_day: 0,
  });
});

test('ordinary provider events preserve elapsed duration across display-zone DST while recurring clocks stay civil', () => {
  setDisplayTimeZone('Europe/Berlin');
  try {
    const ordinary = timed('2026-10-24T23:30:00Z', '2026-10-25T02:30:00Z');
    const range = eventRange(ordinary);
    assert.equal(range.startDate, '2026-10-25');
    assert.equal(range.startTime, '01:30');
    assert.equal(range.endDate, '2026-10-25');
    assert.equal(range.endTime, '03:30');
    assert.equal(range.durationMinutes, 180);

    const moved = moveEventRange(ordinary, { kind: 'grid', date: '2026-10-25', time: '01:30' }, {
      targetKind: 'grid',
    });
    assert.equal(moved.endDate, '2026-10-25');
    assert.equal(moved.endTime, '03:30');

    const recurring = timed('2026-10-24T23:30:00Z', '2026-10-25T02:30:00Z', {
      recurrence_rule: 'FREQ=DAILY',
    });
    const recurringRange = eventRange(recurring);
    assert.equal(recurringRange.durationMinutes, 120);
    assert.equal(recurringRange.endTime, '03:30');
  } finally {
    setDisplayTimeZone(null);
  }
});

test('body drops convert between timed and all-day without accidental resize', () => {
  const timedEvent = timed('2026-09-22T22:00', '2026-09-23T01:00');
  const allDay = moveEventRange(timedEvent, { kind: 'all-day', date: '2026-09-27' }, {
    grabOffsetMinutes: 0,
    targetKind: 'all-day',
  });
  assert.deepEqual(patchForRange(timedEvent, allDay), {
    start_datetime: '2026-09-27',
    end_datetime: '2026-09-28',
    all_day: 1,
  });

  const timedAgain = moveEventRange(
    { id: 5, start_datetime: '2026-09-27', end_datetime: '2026-09-28', all_day: 1 },
    { kind: 'grid', date: '2026-09-29', time: '13:07' },
    { targetKind: 'grid' },
  );
  assert.equal(timedAgain.durationMinutes, 60);
  assert.deepEqual(patchForRange({}, timedAgain), {
    start_datetime: '2026-09-29T13:00',
    end_datetime: '2026-09-29T14:00',
    all_day: 0,
  });

  const midnightEvent = timed('2026-09-22T23:30', '2026-09-23T00:00');
  const midnightDrop = moveEventRange(midnightEvent, { kind: 'all-day', date: '2026-09-29' }, {
    targetKind: 'all-day',
  });
  assert.equal(midnightDrop.durationDays, 1);
  assert.deepEqual(patchForRange(midnightEvent, midnightDrop), {
    start_datetime: '2026-09-29',
    end_datetime: '2026-09-29',
    all_day: 1,
  });
});

test('resize clamps timed and all-day ranges to their minimum without swapping edges', () => {
  const event = timed('2026-09-22T09:00', '2026-09-22T10:00');
  const start = resizeEventRange(event, 'start', {
    kind: 'grid', date: '2026-09-22', time: '12:00',
  });
  assert.equal(start.startTime, '09:45');
  assert.equal(start.endTime, '10:00');
  assert.equal(start.durationMinutes, 15);

  const end = resizeEventRange(event, 'end', {
    kind: 'grid', date: '2026-09-22', time: '08:00',
  });
  assert.equal(end.startTime, '09:00');
  assert.equal(end.endTime, '09:15');

  const allDay = { id: 8, start_datetime: '2026-09-22', end_datetime: '2026-09-24', all_day: 1 };
  const allDayStart = resizeEventRange(allDay, 'start', { kind: 'all-day', date: '2026-09-25' });
  assert.equal(allDayStart.startDate, '2026-09-24');
  assert.equal(allDayStart.endDate, '2026-09-24');

  const multiDayTimed = timed('2026-09-22T22:00', '2026-09-23T02:00');
  const multiDayEnd = resizeEventRange(multiDayTimed, 'end', {
    kind: 'all-day', date: '2026-09-25',
  }, { allDaySpan: true });
  assert.equal(multiDayEnd.allDay, false);
  assert.equal(multiDayEnd.endDate, '2026-09-25');
  assert.equal(multiDayEnd.endTime, '02:00');
});

test('provider capabilities, sync state, exceptions, and optimistic concurrency use the shared envelope', () => {
  const event = timed('2026-09-22T09:00', '2026-09-22T10:00', {
    edit_capabilities: {
      editable: true,
      read_only: false,
      read_only_reason: null,
      provider: 'google',
      scopes: { this: true, following: false, series: true },
      move: true,
      resize: false,
    },
    sync: { state: 'error', error: 'provider unavailable', retryable: true, source: 'google' },
    exception_summary: {
      known: false,
      count: 7,
      items: [],
      truncated: true,
    },
  });

  assert.equal(isEditAllowed(event, 'move'), true);
  assert.equal(isEditAllowed(event, 'resize'), false);
  assert.deepEqual(editCapabilities(event).scopes, { this: true, following: false, series: true });
  assert.equal(syncMetadata(event).state, 'error');
  assert.equal(syncMetadata(event).retryable, true);
  assert.equal(exceptionSummary(event).known, false);
  assert.equal(exceptionSummary(event).count, 7);

  const body = directEditBody(event, eventRange(event), { scope: 'this' });
  assert.equal(body.edit_scope, 'this');
  assert.equal(body.occurrence_start, '2026-09-22T09:00');
  assert.equal(body.expected_revision, 'rev-4');
});

test('read-only metadata blocks every direct edit action and keeps the reason', () => {
  const event = timed('2026-09-22T09:00', '2026-09-22T10:00', {
    edit_capabilities: {
      editable: false,
      read_only: true,
      read_only_reason: 'Google calendar is read-only',
      move: false,
      resize: false,
      scopes: { this: false, following: false, series: false },
    },
  });
  const caps = editCapabilities(event);
  assert.equal(caps.reason, 'Google calendar is read-only');
  assert.equal(isEditAllowed(event, 'edit'), false);
  assert.equal(isEditAllowed(event, 'move'), false);
  assert.equal(isEditAllowed(event, 'resize'), false);
});

test('detached occurrences submit the explicit original occurrence and parent revision', () => {
  const event = timed('2026-09-29T09:00', '2026-09-29T10:00', {
    exception_of_event_id: 91,
    original_occurrence_start: '2026-09-22T09:00',
    recurrence_parent: {
      id: 91,
      revision: 'parent-rev-8',
      start_datetime: '2026-09-01T09:00',
      end_datetime: '2026-09-01T10:00',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
    },
  });

  assert.equal(isDetachedEvent(event), true);
  assert.equal(eventOccurrenceStart(event), '2026-09-22T09:00');
  assert.equal(recurrenceParentRevision(event), 'parent-rev-8');

  const body = directEditBody(event, eventRange(event), { scope: 'following' });
  assert.equal(body.edit_scope, 'following');
  assert.equal(body.occurrence_start, '2026-09-22T09:00');
  assert.equal(body.expected_revision, 'rev-4');
  assert.equal(body.expected_parent_revision, 'parent-rev-8');
});

test('a detached row without a parent envelope cannot guess a parent revision', () => {
  const event = timed('2026-09-29T09:00', '2026-09-29T10:00', {
    exception_of_event_id: 91,
    original_occurrence_start: '2026-09-22T09:00',
  });
  const body = directEditBody(event, eventRange(event), { scope: 'series' });
  assert.equal(body.occurrence_start, '2026-09-22T09:00');
  assert.equal('expected_parent_revision' in body, false);
});

test('detached parent recurrence is inherited unless the editor explicitly changes it', () => {
  const event = timed('2026-09-29T09:00', '2026-09-29T10:00', {
    exception_of_event_id: 91,
    recurrence_rule: null,
    recurrence_parent: { id: 91, revision: 'parent-rev-8', recurrence_rule: 'FREQ=DAILY;COUNT=3' },
  });

  assert.deepEqual(scopedRecurrencePayload(event, 'FREQ=DAILY;COUNT=3', 'series'), {
    recurrence_rule: null,
  });
  assert.deepEqual(scopedRecurrencePayload(event, null, 'series'), {
    recurrence_rule: null,
    recurrence_rule_explicit: true,
  });
  assert.deepEqual(scopedRecurrencePayload(event, 'FREQ=WEEKLY', 'following'), {
    recurrence_rule: 'FREQ=WEEKLY',
    recurrence_rule_explicit: true,
  });
  assert.deepEqual(scopedRecurrencePayload(event, null, 'this'), {
    recurrence_rule: null,
  });
  assert.deepEqual(scopedRecurrencePayload(timed('2026-09-29T09:00', '2026-09-29T10:00'), 'FREQ=WEEKLY', 'series'), {
    recurrence_rule: 'FREQ=WEEKLY',
  });
});

test('sync reload/retry exposes refresh failures and dragging uses tint state', () => {
  const calendarSource = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert.match(calendarSource, /id: 'detail-sync-reload'/);
  assert.match(calendarSource, /t\('common\.reload'\)/);
  assert.match(calendarSource, /reloadCalendarEventsOnly\(\{ throwOnError: true \}\)/);

  const calendarStyles = readFileSync(new URL('../public/styles/calendar.css', import.meta.url), 'utf8');
  const draggingBlock = calendarStyles.match(
    /\[data-calendar-direct-event\]\.is-calendar-dragging\s*\{([^}]*)\}/,
  );
  assert.ok(draggingBlock, 'dragging state styles are present');
  assert.doesNotMatch(draggingBlock[1], /\bopacity\s*:/);
  assert.match(draggingBlock[1], /background:\s*color-mix\([^;]*var\(--tint-raised\)/);
});
