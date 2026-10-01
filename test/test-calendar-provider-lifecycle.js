/**
 * Google scoped-edit lifecycle regressions.
 *
 * These cases exercise the public calendar route, the durable scoped-operation
 * queue, and the injected Google adapter seam without creating a real Google
 * client.  Every provider call consumes the operation created by the route in
 * that test; no queue payload is fabricated by the test.
 */

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
for (const key of [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
]) delete process.env[key];

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
let db = dbmod.get();
// Observe the route's fire-and-forget refresh boundary without starting any
// background network work. Actual provider inbound is exercised below.
const refreshRequests = [];
const outbound = await import('../server/services/calendar-outbound.js');
mock.module('../server/services/calendar-outbound.js', { exports: {
  ...outbound, refreshCalendarProvider: async (source) => { refreshRequests.push(source); },
} });
const { __test: googleCalendarTest } = await import('../server/services/google-calendar.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const {
  claimCalendarEditOperation,
  completeCalendarEditOperation,
  updateCalendarEditOperationProgress,
  failCalendarEditOperation,
} = await import('../server/services/calendar-edit-operations.js');

const caldavSync = await import('../server/services/caldav-sync.js');
const { __test: caldavTest } = caldavSync;
const { parseICS } = await import('../server/services/ics-parser.js');
const { fetchCalendarObjects: installedCalendarObjects } = await import('tsdav');
const { withCalendarObjectUrlFilter } = await import('../server/utils/caldav-client.js');
const { expandRecurringEvents, loadEventExceptions } = await import('../server/services/calendar-events.js');

const userId = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('calendar-lifecycle', 'Calendar Lifecycle', 'x', 'admin')"
).run().lastInsertRowid);

// Like the direct handler fixtures in test-carddav.js, invoke the actual
// route stack with auth context and response methods, without a server.
function routes(router) {
  return router.stack.flatMap((layer) => layer.route ? [layer.route]
    : layer.handle?.stack ? routes(layer.handle) : []);
}

async function call(method, path, body) {
  const match = /^\/(\d+)(\/(?:reload-sync|resolve-recovery|discard-recovery))?$/.exec(path);
  assert.ok(match, 'The fixture must name a supported actual calendar route.');
  const routePath = match[2] ? '/:id' + match[2] : '/:id';
  const refreshCount = refreshRequests.length;
  const expectedSource = match[2] === '/reload-sync' ? row(Number(match[1]))?.external_source : null;
  const matches = routes(calendarRouter).filter((route) => route.path === routePath && route.methods[method.toLowerCase()]);
  assert.ok(matches.length, method + ' ' + routePath + ' must exist');
  const req = {
    method, params: { id: match[1] }, query: {}, body: body || {}, headers: {},
    authUserId: userId, authRole: 'admin', session: { userId, role: 'admin' },
  };
  const res = {
    statusCode: 200, data: null, sent: false,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; this.sent = true; return this; },
    end() { this.sent = true; return this; },
  };
  for (const route of matches) {
    let nextRoute = false;
    for (const layer of route.stack) {
      await layer.handle(req, res, (error) => {
        if (error === 'route') nextRoute = true;
        else if (error) throw error;
      });
      if (nextRoute || res.sent) break;
    }
    if (res.sent) {
      if (match[2] === '/reload-sync' && res.statusCode === 200 && res.data?.reload?.resolved_operations) {
        assert.deepEqual(refreshRequests.slice(refreshCount), [expectedSource],
          'Reload must request one authoritative refresh of the actual provider');
      }
      return { status: res.statusCode, body: res.data };
    }
  }
  throw new Error('Calendar route did not respond.');
}

function row(id) {
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
}

function operation(id) {
  const result = db.prepare('SELECT * FROM calendar_edit_operations WHERE id = ?').get(id);
  return result ? { ...result, payload: JSON.parse(result.payload_json) } : null;
}

async function resolveFieldConflicts(id, choice = 'local') {
  const current = (await call('GET', '/' + id)).body.data;
  assert.equal(current.sync.failure_kind, 'recovery_field_conflict');
  assert.equal(current.sync.state, 'error');
  assert.equal(current.sync.retryable, false);
  assert.ok(current.sync.recovery.conflicts.length);
  const parent = (await call('GET', '/' + current.sync.recovery.parent_event_id)).body.data;
  const response = await call('POST', '/' + id + '/resolve-recovery', {
    operation_id: current.sync.operation_id, expected_revision: parent.revision,
    choices: Object.fromEntries(current.sync.recovery.conflicts.map(({ field }) => [field, choice])),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response;
}

function reset() {
  refreshRequests.length = 0;
  db.prepare('DELETE FROM calendar_edit_operations').run();
  db.prepare('DELETE FROM calendar_event_exceptions').run();
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('DELETE FROM external_calendars').run();
  db.prepare('DELETE FROM caldav_calendar_selection').run();
  db.prepare('DELETE FROM caldav_accounts').run();
  db.prepare('DELETE FROM google_calendar_selection').run();
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'google_%' OR key LIKE 'calendar_provider_%'").run();
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('google_access_token', 'test-access')").run();
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('google_refresh_token', 'test-refresh')").run();
}

function googleCalendar(calendarId, name = calendarId) {
  const refId = googleCalendarTest.upsertExternalCalendar('google', calendarId, name, '#4285F4');
  db.prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, enabled, access_role)
    VALUES (?, ?, 1, 'writer')
  `).run(calendarId, name);
  return refId;
}

function importedMaster({ calendarRefId, calendarId, externalId, title = 'Imported series', rule = 'FREQ=WEEKLY;COUNT=6', etag = '"master-v1"' }) {
  const result = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, recurrence_rule,
       external_calendar_id, external_source, calendar_ref_id,
       target_google_calendar_id, provider_revision, created_by, visibility)
    VALUES (?, '2035-04-05T09:00', '2035-04-05T10:00', 0, ?, ?, 'google', ?,
            NULL, ?, ?, 'all')
  `).run(title, rule, externalId, calendarRefId, etag, userId);
  assert.equal(row(result.lastInsertRowid).target_google_calendar_id, null);
  assert.equal(googleCalendarTest.currentGoogleCalendarId(row(result.lastInsertRowid)), calendarId);
  return Number(result.lastInsertRowid);
}

function writableCalendar({ calendarId, instances = [], onPatch, onInsert } = {}) {
  const calls = { meta: [], instances: [], patches: [], inserts: [] };
  const instanceByMaster = new Map();
  for (const entry of instances) {
    const key = entry.masterId || '*';
    const list = instanceByMaster.get(key) || [];
    list.push(entry.item);
    instanceByMaster.set(key, list);
  }
  const calendar = {
    calls,
    colors: { get: async () => ({ data: { event: {} } }) },
    calendarList: {
      get: async (params) => {
        calls.meta.push(params);
        return {
          data: {
            accessRole: 'writer',
            timeZone: 'Europe/Berlin',
            summary: calendarId,
            backgroundColor: '#4285F4',
          },
        };
      },
    },
    events: {
      list: async () => ({ data: { items: [] } }),
      instances: async (params) => {
        calls.instances.push(params);
        const items = instanceByMaster.get(params.eventId) || instanceByMaster.get('*') || [];
        return { data: { items } };
      },
      patch: async (params) => {
        calls.patches.push(params);
        return onPatch ? onPatch(params) : { data: { id: params.eventId, etag: '"patched"' } };
      },
      insert: async (params) => {
        calls.inserts.push(params);
        return onInsert ? onInsert(params) : { data: { id: 'inserted-continuation', etag: '"inserted-v1"' } };
      },
    },
  };
  return calendar;
}

function masterItem(id, {
  title = 'Remote master',
  etag = '"master-remote"',
  start = '2035-04-05T09:00:00Z',
  end = '2035-04-05T10:00:00Z',
  rule = 'FREQ=WEEKLY;COUNT=6',
} = {}) {
  return {
    id,
    etag,
    summary: title,
    status: 'confirmed',
    recurrence: [`RRULE:${rule}`],
    start: { dateTime: start, timeZone: 'Europe/Berlin' },
    end: { dateTime: end, timeZone: 'Europe/Berlin' },
  };
}

function occurrenceItem(id, masterId, originalStart, {
  title = 'Remote exception',
  etag = '"exception-remote"',
  start = '2035-04-26T12:00:00Z',
  end = '2035-04-26T13:00:00Z',
} = {}) {
  return {
    id,
    etag,
    recurringEventId: masterId,
    originalStartTime: { dateTime: originalStart },
    status: 'confirmed',
    summary: title,
    start: { dateTime: start, timeZone: 'Europe/Berlin' },
    end: { dateTime: end, timeZone: 'Europe/Berlin' },
  };
}

test('Google this lifecycle uses imported calendar_ref_id, reconciles the occurrence, and reuses it', async () => {
  reset();
  const calendarId = 'imported-this@group.calendar.google.com';
  const calendarRefId = googleCalendar(calendarId, 'Imported this');
  const masterId = importedMaster({
    calendarRefId,
    calendarId,
    externalId: 'imported-this-master',
    title: 'Original title',
  });

  const before = (await call('GET', `/${masterId}`)).body.data;
  const firstEdit = await call('PUT', `/${masterId}`, {
    edit_scope: 'this',
    occurrence_start: '2035-04-12T09:00',
    expected_revision: before.revision,
    title: 'Moved occurrence',
    start_datetime: '2035-04-12T11:00',
    end_datetime: '2035-04-12T12:00',
  });
  assert.equal(firstEdit.status, 200, JSON.stringify(firstEdit.body));
  const detachedId = firstEdit.body.data.id;
  const firstOperationId = firstEdit.body.edit.operation_ids[0];
  const firstOperation = operation(firstOperationId);
  assert.equal(firstOperation.status, 'pending');
  assert.equal(firstOperation.payload.target_calendar_id, calendarId);
  assert.equal(firstOperation.payload.provider.calendarId, calendarId);
  assert.equal(firstOperation.payload.provider.masterId, 'imported-this-master');
  assert.equal(row(detachedId).target_google_calendar_id, null);

  const occurrenceId = 'imported-this-master_20350412T090000Z';
  const firstCalendar = writableCalendar({
    calendarId,
    instances: [{
      masterId: 'imported-this-master',
      item: {
        id: occurrenceId,
        etag: '"occurrence-v1"',
        originalStartTime: { dateTime: '2035-04-12T09:00:00Z' },
      },
    }],
    onPatch: (params) => ({ data: { id: params.eventId, etag: '"occurrence-v2"' } }),
  });
  const pushed = await googleCalendarTest.processScopedOperations(firstCalendar, new Map());
  assert.deepEqual(pushed, { completed: 1, retry: 0, error: 0, conflict: 0 });
  assert.equal(firstCalendar.calls.meta[0].calendarId, calendarId);
  assert.equal(firstCalendar.calls.instances[0].eventId, 'imported-this-master');
  assert.equal(firstCalendar.calls.patches.length, 1);
  assert.equal(firstCalendar.calls.patches[0].calendarId, calendarId);
  assert.equal(firstCalendar.calls.patches[0].eventId, occurrenceId);
  assert.equal(firstCalendar.calls.patches[0].headers['If-Match'], '"occurrence-v1"');

  const completedRow = row(detachedId);
  assert.equal(operation(firstOperationId).status, 'completed');
  assert.equal(completedRow.external_source, 'google');
  assert.equal(completedRow.external_calendar_id, occurrenceId);
  assert.equal(completedRow.calendar_ref_id, calendarRefId);
  assert.equal(completedRow.target_google_calendar_id, calendarId);
  assert.equal(completedRow.provider_revision, '"occurrence-v2"');

  googleCalendarTest.upsertGoogleEvents([
    masterItem('imported-this-master', { etag: '"master-v2"', title: 'Remote master refresh' }),
    occurrenceItem(occurrenceId, 'imported-this-master', '2035-04-12T09:00:00Z', {
      title: 'Moved occurrence',
      etag: '"occurrence-v2"',
      start: '2035-04-12T11:00:00Z',
      end: '2035-04-12T12:00:00Z',
    }),
  ], calendarRefId);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM calendar_events WHERE external_source = 'google'").get().count,
    2,
    'inbound refresh must update the existing master and occurrence rather than duplicate either',
  );
  assert.equal(row(detachedId).external_calendar_id, occurrenceId);

  const secondBefore = (await call('GET', `/${detachedId}`)).body.data;
  const secondEdit = await call('PUT', `/${detachedId}`, {
    edit_scope: 'this',
    occurrence_start: '2035-04-12T09:00',
    expected_revision: secondBefore.revision,
    title: 'Second occurrence edit',
  });
  assert.equal(secondEdit.status, 200, JSON.stringify(secondEdit.body));
  const secondOperationId = secondEdit.body.edit.operation_ids[0];
  assert.equal(operation(secondOperationId).payload.provider.masterId, 'imported-this-master');

  const secondCalendar = writableCalendar({
    calendarId,
    onPatch: (params) => {
      if (params.headers['If-Match'] !== '"occurrence-v2"') {
        throw Object.assign(new Error('Wrong occurrence revision'), { code: 412 });
      }
      return { data: { id: params.eventId, etag: '"occurrence-v3"' } };
    },
  });
  assert.deepEqual(
    await googleCalendarTest.processScopedOperations(secondCalendar, new Map()),
    { completed: 1, retry: 0, error: 0, conflict: 0 },
  );
  assert.equal(secondCalendar.calls.patches.length, 1);
  assert.equal(secondCalendar.calls.patches[0].eventId, occurrenceId,
    'a second edit on the detached row must address the reconciled occurrence');
  assert.equal(operation(secondOperationId).status, 'completed');

  const thirdEdit = await call('PUT', `/${detachedId}`, {
    edit_scope: 'this', occurrence_start: '2035-04-12T09:00',
    expected_revision: (await call('GET', `/${detachedId}`)).body.data.revision,
    title: 'Concurrent occurrence edit',
  });
  assert.equal(thirdEdit.status, 200);
  googleCalendarTest.upsertGoogleEvents([occurrenceItem(occurrenceId, 'imported-this-master', '2035-04-12T09:00:00Z', {
    etag: '"occurrence-v4"',
  })], calendarRefId);
  const thirdCalendar = writableCalendar({ calendarId, onPatch: (params) => {
    assert.equal(params.headers['If-Match'], '"occurrence-v3"');
    throw Object.assign(new Error('Occurrence changed externally to v4'), { code: 412 });
  } });
  assert.equal((await googleCalendarTest.processScopedOperations(thirdCalendar, new Map())).conflict, 1);
});

test('Google following lifecycle transfers a later exception to the rebased continuation and keeps one row', async () => {
  reset();
  const calendarId = 'imported-following@group.calendar.google.com';
  const calendarRefId = googleCalendar(calendarId, 'Imported following');
  const masterId = importedMaster({
    calendarRefId,
    calendarId,
    externalId: 'imported-following-master',
    title: 'Following source',
  });

  const beforeThis = (await call('GET', `/${masterId}`)).body.data;
  const thisEdit = await call('PUT', `/${masterId}`, {
    edit_scope: 'this',
    occurrence_start: '2035-04-26T09:00',
    expected_revision: beforeThis.revision,
    title: 'Later actual exception',
    start_datetime: '2035-04-26T12:00',
    end_datetime: '2035-04-26T13:00',
  });
  assert.equal(thisEdit.status, 200, JSON.stringify(thisEdit.body));
  const exceptionId = thisEdit.body.data.id;
  const thisOperationId = thisEdit.body.edit.operation_ids[0];
  assert.equal(operation(thisOperationId).payload.target_calendar_id, calendarId);
  const oldExceptionId = 'imported-following-master_20350426T090000Z';
  const thisCalendar = writableCalendar({
    calendarId,
    instances: [{
      masterId: 'imported-following-master',
      item: {
        id: oldExceptionId,
        etag: '"old-exception-v1"',
        originalStartTime: { dateTime: '2035-04-26T09:00:00Z' },
      },
    }],
    onPatch: (params) => ({ data: { id: params.eventId, etag: '"old-exception-v2"' } }),
  });
  assert.deepEqual(
    await googleCalendarTest.processScopedOperations(thisCalendar, new Map()),
    { completed: 1, retry: 0, error: 0, conflict: 0 },
  );
  assert.equal(row(exceptionId).external_calendar_id, oldExceptionId);
  assert.equal(row(exceptionId).provider_revision, '"old-exception-v2"');

  // A real inbound refresh between the two edits must reconcile the same
  // master and detached exception instead of adding another local row.
  googleCalendarTest.upsertGoogleEvents([
    masterItem('imported-following-master', { etag: '"following-master-v2"' }),
    occurrenceItem(oldExceptionId, 'imported-following-master', '2035-04-26T09:00:00Z', {
      title: 'Later actual exception',
      etag: '"old-exception-v2"',
    }),
  ], calendarRefId);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM calendar_events WHERE external_source = 'google'").get().count,
    2,
  );

  const beforeFollowing = (await call('GET', `/${masterId}`)).body.data;
  const followingEdit = await call('PUT', `/${masterId}`, {
    edit_scope: 'following',
    occurrence_start: '2035-04-12T09:00',
    expected_revision: beforeFollowing.revision,
    title: 'Following continuation',
    start_datetime: '2035-04-12T11:00',
    end_datetime: '2035-04-12T12:00',
  });
  assert.equal(followingEdit.status, 200, JSON.stringify(followingEdit.body));
  const continuationId = followingEdit.body.data.id;
  const followingOperationId = followingEdit.body.edit.operation_ids[0];
  const followingOperation = operation(followingOperationId);
  assert.equal(followingOperation.status, 'pending');
  assert.equal(followingOperation.payload.target_calendar_id, calendarId);
  assert.equal(followingOperation.payload.provider.masterId, 'imported-following-master');
  assert.equal(followingOperation.payload.split.new_master.start_datetime, '2035-04-12T11:00');
  const exceptionOperations = followingOperation.payload.split.exception_operations;
  assert.equal(exceptionOperations.length, 1);
  assert.equal(exceptionOperations[0].original_start, '2035-04-26T09:00');
  assert.equal(exceptionOperations[0].continuation_start, '2035-04-26T11:00');
  assert.match(exceptionOperations[0].event.start_datetime, /^2035-04-26T12:00/);

  const continuationProviderId = 'imported-following-continuation';
  const continuationExceptionId = `${continuationProviderId}_20350426T110000Z`;
  const masterPatches = [];
  const exceptionPatches = [];
  const followingCalendar = writableCalendar({
    calendarId,
    onPatch: (params) => {
      if (params.eventId === 'imported-following-master') {
        masterPatches.push(params);
        return { data: { id: params.eventId, etag: '"following-master-v3"' } };
      }
      exceptionPatches.push(params);
      return { data: { id: params.eventId, etag: '"continuation-exception-v2"' } };
    },
    onInsert: () => ({ data: { id: continuationProviderId, etag: '"continuation-v1"' } }),
  });
  followingCalendar.events.instances = async (params) => {
    followingCalendar.calls.instances.push(params);
    assert.equal(params.eventId, continuationProviderId);
    return {
      data: {
        items: [{
          id: continuationExceptionId,
          etag: '"continuation-exception-v1"',
          originalStartTime: { dateTime: '2035-04-26T11:00:00Z' },
        }],
      },
    };
  };
  assert.deepEqual(
    await googleCalendarTest.processScopedOperations(followingCalendar, new Map()),
    { completed: 1, retry: 0, error: 0, conflict: 0 },
  );
  assert.equal(masterPatches.length, 1);
  assert.equal(followingCalendar.calls.inserts.length, 1);
  assert.equal(exceptionPatches.length, 1);
  assert.equal(exceptionPatches[0].eventId, continuationExceptionId);
  assert.equal(exceptionPatches[0].headers['If-Match'], '"continuation-exception-v1"');
  assert.equal(exceptionPatches[0].requestBody.start.dateTime, '2035-04-26T12:00:00Z');
  assert.equal(operation(followingOperationId).status, 'completed');
  assert.equal(row(continuationId).external_calendar_id, continuationProviderId);
  assert.equal(row(continuationId).calendar_ref_id, calendarRefId);
  assert.equal(row(continuationId).target_google_calendar_id, calendarId);
  assert.equal(row(continuationId).provider_revision, '"continuation-v1"');

  // The exception operation result must carry the continuation instance ID
  // back to the existing detached row before the next inbound refresh.
  assert.equal(row(exceptionId).external_calendar_id, continuationExceptionId);
  googleCalendarTest.upsertGoogleEvents([
    masterItem('imported-following-master', {
      etag: '"following-master-v3"',
      rule: 'FREQ=WEEKLY;COUNT=1',
    }),
    masterItem(continuationProviderId, {
      title: 'Following continuation',
      etag: '"continuation-v1"',
      start: '2035-04-12T11:00:00Z',
      end: '2035-04-12T12:00:00Z',
      rule: 'FREQ=WEEKLY;COUNT=5',
    }),
    occurrenceItem(continuationExceptionId, continuationProviderId, '2035-04-26T11:00:00Z', {
      title: 'Later actual exception',
      etag: '"continuation-exception-v2"',
    }),
  ], calendarRefId);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM calendar_events WHERE external_source = 'google'").get().count,
    3,
    'inbound refresh must keep the old master, continuation, and one transferred exception',
  );
  assert.equal(row(exceptionId).external_calendar_id, continuationExceptionId);

  const continuationBefore = (await call('GET', `/${continuationId}`)).body.data;
  const secondEdit = await call('PUT', `/${continuationId}`, {
    edit_scope: 'series',
    occurrence_start: continuationBefore.start_datetime,
    expected_revision: continuationBefore.revision,
    title: 'Continuation second edit',
  });
  assert.equal(secondEdit.status, 200, JSON.stringify(secondEdit.body));
  const secondOperationId = secondEdit.body.edit.operation_ids[0];
  assert.equal(operation(secondOperationId).payload.provider.masterId, continuationProviderId);
  const secondCalendar = writableCalendar({
    calendarId,
    onPatch: (params) => ({ data: { id: params.eventId, etag: '"continuation-v2"' } }),
  });
  assert.deepEqual(
    await googleCalendarTest.processScopedOperations(secondCalendar, new Map()),
    { completed: 1, retry: 0, error: 0, conflict: 0 },
  );
  assert.equal(secondCalendar.calls.patches[0].eventId, continuationProviderId);
});

test('Google inbound preserves the locally edited range while a scoped operation is pending and failed', async () => {
  reset();
  const calendarId = 'imported-guard@group.calendar.google.com';
  const calendarRefId = googleCalendar(calendarId, 'Imported guard');
  const masterId = importedMaster({
    calendarRefId,
    calendarId,
    externalId: 'imported-guard-master',
    title: 'Guard source',
  });

  const before = (await call('GET', `/${masterId}`)).body.data;
  const edit = await call('PUT', `/${masterId}`, {
    edit_scope: 'series',
    occurrence_start: before.start_datetime,
    expected_revision: before.revision,
    title: 'Local title while provider is pending',
    start_datetime: '2035-04-05T11:00',
    end_datetime: '2035-04-05T12:00',
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const operationId = edit.body.edit.operation_ids[0];
  assert.equal(row(masterId).start_datetime, '2035-04-05T11:00');
  assert.equal(operation(operationId).status, 'pending');

  const stale = masterItem('imported-guard-master', {
    title: 'Stale Google title',
    etag: '"guard-remote-v2"',
    start: '2035-04-05T09:00:00Z',
    end: '2035-04-05T10:00:00Z',
  });
  googleCalendarTest.upsertGoogleEvents([stale], calendarRefId);
  assert.equal(row(masterId).title, 'Local title while provider is pending');
  assert.equal(row(masterId).start_datetime, '2035-04-05T11:00');
  assert.equal(row(masterId).provider_revision, '"guard-remote-v2"');

  const claim = claimCalendarEditOperation(operationId, db);
  assert.ok(claim);
  assert.ok(failCalendarEditOperation(
    operationId,
    new Error('temporary Google outage'),
    { retryable: false },
    db,
    claim,
  ));
  assert.equal(operation(operationId).status, 'error');
  assert.equal(row(masterId).sync_state, 'error');

  googleCalendarTest.upsertGoogleEvents([{
    ...stale,
    etag: '"guard-remote-v3"',
    summary: 'Another stale Google title',
  }], calendarRefId);
  assert.equal(row(masterId).title, 'Local title while provider is pending');
  assert.equal(row(masterId).start_datetime, '2035-04-05T11:00');
  assert.equal(row(masterId).provider_revision, '"guard-remote-v3"');
});

// Follow-up regressions consume route-generated operations throughout.
async function followingGoogle({ withException = false, twoExceptions = false,
  newStart = '2035-04-12T11:00', newEnd = '2035-04-12T12:00' } = {}) {
  const calendarId = 'followup@group.calendar.google.com';
  const calendarRefId = googleCalendar(calendarId);
  const masterId = importedMaster({ calendarRefId, calendarId, externalId: 'followup-master' });
  let exceptionId = null; let secondExceptionId = null;
  if (withException) {
    const exception = await call('PUT', `/${masterId}`, {
      edit_scope: 'this', occurrence_start: '2035-04-26T09:00',
      expected_revision: (await call('GET', `/${masterId}`)).body.data.revision,
      title: 'Unrelated exception', start_datetime: '2035-04-26T12:00', end_datetime: '2035-04-26T13:00',
    });
    assert.equal(exception.status, 200);
    exceptionId = exception.body.data.id;
    const claim = claimCalendarEditOperation(exception.body.edit.operation_ids[0], db);
    assert.ok(completeCalendarEditOperation(claim.id, {
      providerUid: 'followup-master_exception', providerEtag: '"exception-v2"', providerCalendarId: calendarId,
    }, db, claim));
  }
  if (twoExceptions) {
    const second = await call('PUT', '/' + masterId, {
      edit_scope: 'this', occurrence_start: '2035-05-03T09:00',
      expected_revision: (await call('GET', '/' + masterId)).body.data.revision,
      title: 'Second exception', start_datetime: '2035-05-03T13:00', end_datetime: '2035-05-03T14:00',
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    secondExceptionId = second.body.data.id;
    const claim = claimCalendarEditOperation(second.body.edit.operation_ids[0], db);
    assert.ok(completeCalendarEditOperation(claim.id, {
      providerUid: 'followup-master_exception_two', providerEtag: '"exception-two-v2"', providerCalendarId: calendarId,
    }, db, claim));
  }
  const edited = await call('PUT', `/${masterId}`, {
    edit_scope: 'following', occurrence_start: '2035-04-12T09:00',
    expected_revision: (await call('GET', `/${masterId}`)).body.data.revision,
    title: 'Continuation', start_datetime: newStart, end_datetime: newEnd,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  return { calendarId, calendarRefId, masterId, exceptionId, secondExceptionId,
    continuationId: edited.body.data.id, operationId: edited.body.edit.operation_ids[0] };
}

for (const uncertain of [false, true]) {
  test(`Google inbound before retry protects a ${uncertain ? 'lost-response' : 'checkpointed'} continuation`, async () => {
    reset();
    const f = await followingGoogle({ withException: true });
    let continuation;
    const calendar = writableCalendar({ calendarId: f.calendarId, onInsert: (params) => {
      continuation = { ...params.requestBody, id: 'followup-continuation', etag: '"continuation-v1"' };
      if (uncertain) throw Object.assign(new Error('Insert response lost'), { code: 503 });
      return { data: continuation };
    } });
    let retry = false;
    calendar.events.list = async ({ privateExtendedProperty }) => ({ data: { items:
      continuation && privateExtendedProperty?.[0]?.startsWith('yuvomiScopedOperation=') ? [continuation] : [] } });
    calendar.events.instances = async () => {
      if (!retry) throw Object.assign(new Error('Exception lookup unavailable'), { code: 503 });
      return { data: { items: [{ id: 'followup-continuation_exception', etag: '"new-exception-v1"',
        originalStartTime: { dateTime: '2035-04-26T11:00:00Z' } }] } };
    };
    assert.equal((await googleCalendarTest.processScopedOperations(calendar, new Map())).retry, 1);
    const progress = JSON.parse(operation(f.operationId).progress_json);
    assert.equal(progress.continuation_master?.accepted === true, !uncertain);
    googleCalendarTest.upsertGoogleEvents([continuation], f.calendarRefId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_source='google'").get().n, 3,
      'inbound must protect the existing continuation before retry');
    assert.equal(row(f.continuationId).title, 'Continuation');
    retry = true;
    assert.equal((await googleCalendarTest.processScopedOperations(calendar, new Map())).completed, 1);
    assert.equal(calendar.calls.inserts.length, 1, 'retry must use checkpoint/marker readback');
    assert.equal(row(f.continuationId).external_calendar_id, continuation.id);
    googleCalendarTest.upsertGoogleEvents([continuation], f.calendarRefId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_source='google'").get().n, 3);
  });
}

test('following Reload rolls back an unaccepted split and preserves exceptions and active parent edits', async () => {
  reset();
  const f = await followingGoogle({ withException: true });
  const calendar = writableCalendar({ calendarId: f.calendarId, onPatch: () => {
    throw Object.assign(new Error('Master changed externally'), { code: 412 });
  } });
  assert.equal((await googleCalendarTest.processScopedOperations(calendar, new Map())).conflict, 1);
  const sibling = await call('PUT', `/${f.masterId}`, {
    edit_scope: 'series', occurrence_start: '2035-04-05T09:00',
    expected_revision: (await call('GET', `/${f.masterId}`)).body.data.revision,
    title: 'Newer parent edit',
  });
  assert.equal(sibling.status, 200);
  const siblingId = sibling.body.edit.operation_ids[0];
  const reload = await call('POST', `/${f.continuationId}/reload-sync`, { operation_id: f.operationId });
  assert.equal(reload.status, 200);
  assert.equal(reload.body.reload.resolved_operations, 1);
  googleCalendarTest.upsertGoogleEvents([masterItem('followup-master')], f.calendarRefId);
  assert.equal(row(f.continuationId), undefined, 'unaccepted continuation must disappear');
  assert.equal(row(f.exceptionId).exception_of_event_id, f.masterId);
  assert.equal(row(f.exceptionId).title, 'Unrelated exception');
  assert.equal(row(f.masterId).title, 'Newer parent edit');
  assert.equal(operation(siblingId).status, 'pending');
  const siblingClaim = claimCalendarEditOperation(siblingId, db);
  assert.ok(completeCalendarEditOperation(siblingId, {}, db, siblingClaim));
  googleCalendarTest.upsertGoogleEvents([masterItem('followup-master')], f.calendarRefId);
  assert.equal(row(f.masterId).recurrence_rule, 'RRULE:FREQ=WEEKLY;COUNT=6');
  assert.equal(row(f.masterId).sync_state, 'clean');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 2);
});

test('following Reload retains a remotely accepted continuation after a later conflict', async () => {
  reset();
  const f = await followingGoogle({ withException: true });
  let continuation;
  const calendar = writableCalendar({ calendarId: f.calendarId, onInsert: (params) => {
    continuation = { ...params.requestBody, id: 'accepted-continuation', etag: '"accepted-v1"' };
    return { data: continuation };
  } });
  calendar.events.instances = async () => { throw Object.assign(new Error('Exception externally changed'), { code: 412 }); };
  assert.equal((await googleCalendarTest.processScopedOperations(calendar, new Map())).conflict, 1);
  assert.equal((await call('POST', `/${f.continuationId}/reload-sync`, { operation_id: f.operationId })).status, 200);
  googleCalendarTest.upsertGoogleEvents([continuation], f.calendarRefId);
  assert.ok(row(f.continuationId));
  assert.equal(row(f.continuationId).external_calendar_id, continuation.id);
  assert.equal(row(f.continuationId).sync_state, 'clean');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 3);
});

async function followingCalDAV({ allDay = false, exdate = false, utcExdate = false, dst = false, convertAllDay = false, convertTimed = false, rebase = false, withException = false, lateDaily = false, conversionHour = 15, newStart = null, newEnd = null } = {}) {
  const calendarUrl = 'https://dav.example/followup/';
  const uid = 'followup-dav@example.test';
  const accountId = Number(db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('Followup', 'https://dav.example/', 'fixture', 'fixture')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, enabled, write_capability)
    VALUES (?, ?, 'Followup', 1, 'write')`).run(accountId, calendarUrl);
  const calendarRefId = Number(db.prepare(`INSERT INTO external_calendars (source, external_id, name)
    VALUES ('caldav', ?, 'Followup')`).run(calendarUrl).lastInsertRowid);
  const masterId = Number(db.prepare(`INSERT INTO calendar_events
    (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, external_source,
     external_calendar_id, calendar_ref_id, external_object_url, provider_revision, created_by)
    VALUES ('Original', ?, ?, ?, '${lateDaily ? 'FREQ=DAILY;COUNT=30' : 'FREQ=WEEKLY;COUNT=6'}', ?, 'caldav', ?, ?, ?, '"dav-v1"', ?)`)
    .run(allDay ? '2035-04-05' : dst ? '2035-03-03T08:00:00Z' : '2035-04-05T07:00:00Z', allDay ? '2035-04-05' : dst ? '2035-03-03T09:00:00Z' : '2035-04-05T08:00:00Z',
      allDay ? 1 : 0, allDay ? null : 'Europe/Berlin', uid, calendarRefId, `${calendarUrl}old.ics`, userId).lastInsertRowid);
  if (exdate) db.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
    .run(masterId, dst ? '2035-03-17' : '2035-04-26');
  let original = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Original', 'SEQUENCE:2',
    allDay ? 'DTSTART;VALUE=DATE:20350405' : dst ? 'DTSTART;TZID=Europe/Berlin:20350303T090000' : 'DTSTART;TZID=Europe/Berlin:20350405T090000',
    allDay ? 'DTEND;VALUE=DATE:20350406' : dst ? 'DTEND;TZID=Europe/Berlin:20350303T100000' : 'DTEND;TZID=Europe/Berlin:20350405T100000',
    lateDaily ? 'RRULE:FREQ=DAILY;COUNT=30' : 'RRULE:FREQ=WEEKLY;COUNT=6',
    ...(exdate ? [allDay ? 'EXDATE;VALUE=DATE:20350426' : utcExdate ? (dst ? 'EXDATE:20350317T080000Z' : 'EXDATE:20350426T070000Z') : 'EXDATE;TZID=Europe/Berlin:20350426T090000'] : []),
    'ATTENDEE;CN=Fixture:mailto:fixture@example.test', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  let exceptionId = null;
  if (withException) {
    const detached = await call('PUT', '/' + masterId, {
      edit_scope: 'this', occurrence_start: '2035-04-26T07:00:00Z',
      expected_revision: (await call('GET', '/' + masterId)).body.data.revision,
      title: 'Detached intent', start_datetime: '2035-04-26T12:00', end_datetime: '2035-04-26T13:00',
    });
    assert.equal(detached.status, 200, JSON.stringify(detached.body));
    exceptionId = detached.body.data.id;
    const objects = new Map([[uid, { url: calendarUrl + 'old.ics', data: original, etag: '"dav-v1"', calendarUrl }]]);
    const calendars = new Map([[calendarUrl, { url: calendarUrl, writable: true }]]);
    assert.equal((await pushCalDAV({ updateCalendarObject: async ({ calendarObject }) => {
      original = calendarObject.data;
      objects.set(uid, { ...objects.get(uid), data: original, etag: '"dav-detached-v2"' });
      return { etag: '"dav-detached-v2"' };
    } }, { objects, calendars, calendarUrl })).completed, 1);
    db.prepare('UPDATE calendar_events SET provider_revision = ? WHERE id = ?').run('"dav-detached-v2"', masterId);
  }
  const edited = await call('PUT', `/${masterId}`, {
    edit_scope: 'following', occurrence_start: allDay ? '2035-04-12' : dst ? '2035-03-10T08:00:00Z' : '2035-04-12T07:00:00Z',
    expected_revision: (await call('GET', `/${masterId}`)).body.data.revision,
    title: 'Continuation', all_day: convertTimed ? 0 : convertAllDay ? 1 : (allDay ? 1 : 0), start_datetime: convertTimed ? (lateDaily ? '2035-04-13T' + String(conversionHour).padStart(2, '0') + ':00' : '2035-04-13T11:00') : convertAllDay ? (rebase ? '2035-04-13' : '2035-04-12') : allDay ? '2035-04-13' : dst ? '2035-03-24T11:00' : '2035-04-12T11:00',
    end_datetime: convertTimed ? (lateDaily ? '2035-04-13T' + String(conversionHour + 1).padStart(2, '0') + ':00' : '2035-04-13T12:00') : convertAllDay ? (rebase ? '2035-04-14' : '2035-04-12') : allDay ? '2035-04-13' : dst ? '2035-03-24T12:00' : '2035-04-12T12:00',
    ...(newStart ? { start_datetime: newStart } : {}), ...(newEnd ? { end_datetime: newEnd } : {}),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const objects = new Map([[uid, { url: `${calendarUrl}old.ics`, data: original, etag: row(masterId).provider_revision, calendarUrl }]]);
  const calendars = new Map([[calendarUrl, { url: calendarUrl, writable: true }]]);
  return { uid, calendarUrl, calendarRefId, masterId, exceptionId, objects, calendars,
    continuationId: edited.body.data.id, operationId: edited.body.edit.operation_ids[0] };
}

async function pushCalDAV(client, fixture) {
  return caldavTest.processScopedOperations(client, fixture.objects, fixture.calendars, new Set([fixture.calendarUrl]));
}

async function inboundCalDAV(fixture, { beforeRetry = true } = {}) {
  const client = {
    fetchCalendars: async () => [...fixture.calendars.values()],
    fetchCalendarObjects: async () => Object.assign([...fixture.objects.values()], { complete: true }),
    updateCalendarObject: async () => { throw new Error('Inbound probe must precede retry'); },
    createCalendarObject: async () => { throw new Error('Inbound probe must not create'); },
  };
  // Pause the queued retry while this actual sync delivers the inbound objects.
  const claim = beforeRetry ? claimCalendarEditOperation(fixture.operationId, db) : null;
  assert.equal((await caldavSync.sync({ createClient: async () => client })).success, true);
  if (claim) assert.ok(failCalendarEditOperation(claim.id, new Error('Resume retry'), { retryable: true }, db, claim));
}

for (const form of ['timezone', 'date', 'utc']) {
  const allDay = form === 'date';
  test(`CalDAV route split retains EXDATE-only cancellation (${form})`, async () => {
    reset();
    const f = await followingCalDAV({ allDay, exdate: true, utcExdate: form === 'utc' });
    const exclusion = operation(f.operationId).payload.split.exception_operations;
    assert.equal(exclusion.length, 1);
    assert.equal(exclusion[0].method, 'delete');
    assert.equal(operation(f.operationId).payload.split.exception_components, undefined);
    let continuation;
    const client = {
      updateCalendarObject: async () => ({ etag: '"dav-v2"' }),
      createCalendarObject: async (params) => {
        continuation = params.iCalString;
        return { etag: '"new-v1"' };
      },
    };
    assert.equal((await pushCalDAV(client, f)).completed, 1);
    assert.match(continuation, allDay ? /EXDATE;VALUE=DATE:20350427/ : form === 'utc' ? /EXDATE:20350426T090000Z/ : /EXDATE;TZID=Europe\/Berlin:20350426T110000/);
    const parsed = parseICS(continuation)[0];
    assert.ok(parsed.exdates.includes(allDay ? '2035-04-27' : '2035-04-26'));
    assert.equal(new Set(continuation.match(/^UID:.*$/gm)).size, 1);
    if (allDay) assert.match(continuation, /DTEND;VALUE=DATE:20350414/);
    f.objects.set(row(f.continuationId).external_calendar_id, {
      url: row(f.continuationId).external_object_url, data: continuation, etag: '"new-v1"', calendarUrl: f.calendarUrl,
    });
    await inboundCalDAV(f, { beforeRetry: false });
    const events = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-05-20', loadEventExceptions(db, [f.continuationId]));
    assert.ok(!events.some((event) => event.start_datetime.slice(0, 10) === (allDay ? '2035-04-27' : '2035-04-26')));
  });
}

for (const externalChange of [false, true]) {
  test(`CalDAV lost old-master response ${externalChange ? 'still detects external change' : 'recovers accepted PUT'}`, async () => {
    reset();
    const f = await followingCalDAV({ exdate: true });
    let updates = 0;
    let creates = 0;
    const client = {
      updateCalendarObject: async ({ calendarObject }) => {
        updates++;
        assert.equal(calendarObject.etag, '"dav-v1"');
        f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"dav-v2"' });
        throw Object.assign(new Error('PUT accepted, transport response lost'), { code: 503 });
      },
      createCalendarObject: async () => { creates++; return { etag: '"new-v1"' }; },
    };
    assert.equal((await pushCalDAV(client, f)).retry, 1);
    assert.notEqual(JSON.parse(operation(f.operationId).progress_json || '{}').old_master?.accepted, true);
    if (externalChange) f.objects.get(f.uid).data = f.objects.get(f.uid).data.replace('SUMMARY:Original', 'SUMMARY:External');
    const retry = await pushCalDAV(client, f);
    assert.equal(externalChange ? retry.conflict : retry.completed, 1);
    assert.equal(updates, 1);
    assert.equal(creates, externalChange ? 0 : 1);
  });
}

for (const uncertain of [false, true]) {
  test(`CalDAV inbound before retry protects a ${uncertain ? 'lost-response' : 'checkpointed'} continuation`, async () => {
    reset();
    const f = await followingCalDAV();
    let creates = 0;
    const client = {
      updateCalendarObject: async ({ calendarObject }) => {
        assert.equal(calendarObject.etag, '"dav-v1"');
        f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"dav-v2"' });
        return { etag: '"dav-v2"' };
      },
      createCalendarObject: async ({ filename, iCalString }) => {
        creates++;
        const uid = parseICS(iCalString)[0].uid;
        f.objects.set(uid, { url: `${f.calendarUrl}${filename}`, data: iCalString, etag: '"new-v1"', calendarUrl: f.calendarUrl });
        if (uncertain) throw Object.assign(new Error('Create accepted, response lost'), { code: 503 });
        return { etag: '"new-v1"' };
      },
    };
    if (!uncertain) db.exec(`CREATE TRIGGER fail_after_checkpoint BEFORE UPDATE OF status ON calendar_edit_operations
      WHEN NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'completion failure after accepted checkpoint'); END;`);
    assert.equal((await pushCalDAV(client, f)).retry, 1);
    db.exec('DROP TRIGGER IF EXISTS fail_after_checkpoint');
    assert.equal(JSON.parse(operation(f.operationId).progress_json).continuation_master.accepted === true, !uncertain);
    await inboundCalDAV(f);
    assert.ok(row(f.continuationId), 'the original optimistic continuation must survive inbound');
    assert.equal(operation(f.operationId).status, 'retry');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_source='caldav'").get().n, 2);
    assert.equal((await pushCalDAV(client, f)).completed, 1);
    assert.equal(creates, 1);
    await inboundCalDAV(f, { beforeRetry: false });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE external_source='caldav'").get().n, 2);
  });
}

test('completion rolls back status and all identities on fault, survives reopen, and fences stale workers', async () => {
  reset();
  const f = await followingGoogle({ withException: true });
  const claim = claimCalendarEditOperation(f.operationId, db);
  const details = {
    providerUid: 'atomic-continuation', providerEtag: '"atomic-v1"', providerCalendarId: f.calendarId,
    providerCalendarRefId: f.calendarRefId,
    exceptionOperations: [{ local_event_id: f.exceptionId, providerUid: 'atomic-exception', providerEtag: '"atomic-ex-v1"' }],
  };
  assert.ok(updateCalendarEditOperationProgress(claim.id, {
    old_master: { accepted: true, id: 'followup-master', etag: '"master-v2"' },
    continuation_master: { accepted: true, id: details.providerUid, etag: details.providerEtag },
  }, db, claim));
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const directory = await mkdtemp(join(tmpdir(), 'yuvomi-calendar-completion-'));
  const path = join(directory, 'disposable.sqlite');
  const originalDb = db;
  await db.backup(path);
  let reopened = new Database(path);
  try {
    const faultDb = new Proxy(reopened, { get(target, name) {
      if (name === 'prepare') return (sql) => {
        const statement = target.prepare(sql);
        if (/SET status = 'completed'/.test(sql)) return new Proxy(statement, { get(st, method) {
          if (method === 'run') return (...values) => { st.run(...values); throw new Error('Crash immediately after status write'); };
          return typeof st[method] === 'function' ? st[method].bind(st) : st[method];
        } });
        return statement;
      };
      return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
    } });
    assert.throws(() => completeCalendarEditOperation(claim.id, details, faultDb, claim), /Crash immediately/);
    reopened.close();
    reopened = new Database(path);
    db = reopened;
    dbmod._setTestDatabase(db);
    assert.equal(operation(claim.id).status, 'processing', 'failed transaction remains recoverable after reopen');
    assert.equal(row(f.continuationId).external_calendar_id, null);
    assert.equal(row(f.exceptionId).external_calendar_id, 'followup-master_exception');
    googleCalendarTest.upsertGoogleEvents([masterItem(details.providerUid)], f.calendarRefId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 3);
    db.prepare("UPDATE calendar_edit_operations SET claim_expires_at = '2000-01-01T00:00:00Z' WHERE id=?").run(claim.id);
    const replacement = claimCalendarEditOperation(claim.id, db);
    assert.ok(replacement);
    assert.equal(completeCalendarEditOperation(claim.id, details, db, claim), false);
    assert.equal(updateCalendarEditOperationProgress(claim.id, { invalid: true }, db, claim), false);
    assert.equal(failCalendarEditOperation(claim.id, new Error('stale'), {}, db, claim), false);
    assert.ok(completeCalendarEditOperation(claim.id, details, db, replacement));
    assert.equal(operation(claim.id).status, 'completed');
    assert.equal(operation(claim.id).payload.provider_result.providerUid, details.providerUid);
    assert.equal(row(f.continuationId).external_calendar_id, details.providerUid);
    assert.equal(row(f.continuationId).sync_state, 'clean');
    assert.equal(row(f.exceptionId).external_calendar_id, 'atomic-exception');
    assert.equal(row(f.exceptionId).provider_revision, '"atomic-ex-v1"');
    googleCalendarTest.upsertGoogleEvents([masterItem(details.providerUid)], f.calendarRefId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 3);
  } finally {
    dbmod._resetTestDatabase();
    db = originalDb;
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CalDAV following Reload converges to an unsplit authoritative master without an orphan', async () => {
  reset();
  const f = await followingCalDAV({ exdate: true });
  const client = { updateCalendarObject: async ({ calendarObject }) => {
    assert.equal(calendarObject.etag, '"dav-v1"');
    throw Object.assign(new Error('First old-master write rejected'), { code: 412 });
  } };
  assert.equal((await pushCalDAV(client, f)).conflict, 1);
  const reload = await call('POST', `/${f.continuationId}/reload-sync`, { operation_id: f.operationId });
  assert.equal(reload.status, 200);
  assert.equal(reload.body.reload.resolved_operations, 1);
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(row(f.continuationId), undefined);
  assert.equal(row(f.masterId).sync_state, 'clean');
  assert.equal(row(f.masterId).recurrence_rule, 'RRULE:FREQ=WEEKLY;COUNT=6');
  assert.ok(loadEventExceptions(db, [f.masterId]).get(f.masterId).has('2035-04-26'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 1);
});

test('CalDAV uncertain continuation readback rejects a different external body', async () => {
  reset();
  const f = await followingCalDAV();
  let creates = 0;
  const client = {
    updateCalendarObject: async ({ calendarObject }) => {
      f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"dav-v2"' });
      return { etag: '"dav-v2"' };
    },
    createCalendarObject: async ({ filename, iCalString }) => {
      creates++;
      const uid = parseICS(iCalString)[0].uid;
      f.objects.set(uid, { url: `${f.calendarUrl}${filename}`, data: iCalString.replace('SUMMARY:Continuation', 'SUMMARY:External'),
        etag: '"external-v2"', calendarUrl: f.calendarUrl });
      throw Object.assign(new Error('Create accepted, response lost'), { code: 503 });
    },
  };
  assert.equal((await pushCalDAV(client, f)).retry, 1);
  assert.equal((await pushCalDAV(client, f)).conflict, 1);
  assert.equal(creates, 1);
});

test('CalDAV UTC EXDATE rebasing follows the recurrence clock across DST', async () => {
  reset();
  const f = await followingCalDAV({ exdate: true, utcExdate: true, dst: true });
  let continuation;
  const client = {
    updateCalendarObject: async () => ({ etag: '"dav-v2"' }),
    createCalendarObject: async ({ iCalString }) => { continuation = iCalString; return { etag: '"new-v1"' }; },
  };
  assert.equal((await pushCalDAV(client, f)).completed, 1);
  assert.match(continuation, /EXDATE:20350331T090000Z/,
    '11:00 Berlin after DST is 09:00 UTC, rather than a fixed elapsed shift');
  assert.doesNotMatch(continuation, /EXDATE:20350331T100000Z/);
});

test('Reload with continuation sibling must converge without dropping the newer edit', async () => {
  reset(); const f = await followingGoogle();
  const failed = writableCalendar({ calendarId: f.calendarId, onPatch: () => { throw Object.assign(new Error('external master change'), { code: 412 }); } });
  assert.equal((await googleCalendarTest.processScopedOperations(failed, new Map())).conflict, 1);
  db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(f.continuationId,userId);
  const reminder = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-12T10:30',?)").run(f.continuationId,userId).lastInsertRowid);
  const newer = await call('PUT', '/' + f.continuationId, {
    edit_scope: 'series', occurrence_start: '2035-04-12T11:00', title: 'Newer continuation edit',
    expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision,
  });
  assert.equal(newer.status, 200, JSON.stringify(newer.body));
  const reload = await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
  assert.equal(reload.status, 200);
  // No provider call is eligible until an authoritative unsplit master arrives.
  const failedCalls = failed.calls.patches.length;
  await googleCalendarTest.processScopedOperations(failed, new Map());
  assert.equal(failed.calls.patches.length, failedCalls);
  const authoritative = masterItem('followup-master', { title: 'Authoritative original', etag: '"fresh-v9"',
    start: '2035-04-05T07:00:00Z', end: '2035-04-05T08:00:00Z' });
  googleCalendarTest.upsertGoogleEvents([authoritative], f.calendarRefId);
  await resolveFieldConflicts(f.continuationId);
  let accepted;
  const provider = writableCalendar({ calendarId: f.calendarId, onPatch: (params) => {
    assert.equal(params.eventId, 'followup-master');
    assert.equal(params.headers['If-Match'], '"fresh-v9"');
    assert.match(params.requestBody.recurrence[0], /UNTIL=20350411/);
    assert.equal(params.requestBody.summary, 'Authoritative original');
    return { data: { id: params.eventId, etag: '"fresh-v10"' } };
  }, onInsert: (params) => {
    assert.equal(params.requestBody.summary, 'Newer continuation edit');
    assert.equal(Date.parse(params.requestBody.start.dateTime), Date.parse('2035-04-12T07:00:00Z'));
    accepted = { ...params.requestBody, id: 'recovered-child', etag: '"child-v1"' };
    return { data: accepted };
  } });
  const siblingResult = await googleCalendarTest.processScopedOperations(provider, new Map());
  googleCalendarTest.upsertGoogleEvents([{ ...authoritative, recurrence: provider.calls.patches[0].requestBody.recurrence }, accepted], f.calendarRefId);
  googleCalendarTest.upsertGoogleEvents([accepted], f.calendarRefId);
  assert.equal(provider.calls.inserts.length, 1);
  assert.equal(row(f.continuationId).external_calendar_id, 'recovered-child');
  assert.equal(row(f.continuationId).title, 'Newer continuation edit');
  assert.equal(db.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').get(f.continuationId).user_id,userId);
  assert.equal(db.prepare('SELECT entity_id,remind_at FROM reminders WHERE id=?').get(reminder).entity_id,f.continuationId);
  assert.equal(db.prepare('SELECT remind_at FROM reminders WHERE id=?').get(reminder).remind_at,'2035-04-12T08:30');
  assert.equal(operation(newer.body.edit.operation_ids[0]).resolution, 'replaced_after_reload');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 2);
  const earlier = expandRecurringEvents([row(f.masterId)], '2035-04-05', '2035-04-11', null);
  assert.equal(earlier.length, 1);
  assert.equal(earlier[0].title, 'Authoritative original');
  assert.equal(earlier[0].start_datetime, authoritative.start.dateTime);

  assert.equal(siblingResult.completed, 1, 'newer continuation edit must have a viable provider identity/recovery, not a permanent missing-ID retry');
});

test('timed-to-all-day following conversion preserves DATE-compatible cancellation', async () => {
  reset(); const f = await followingCalDAV({ exdate: true, convertAllDay: true });
  let continuation;
  const result = await pushCalDAV({ updateCalendarObject: async () => ({ etag: '"v2"' }), createCalendarObject: async p => { continuation = p.iCalString; return { etag: '"new-v1"' }; } }, f);
  assert.equal(result.completed, 1);

  assert.match(continuation, /DTSTART;VALUE=DATE:20350412/);
  assert.match(continuation, /EXDATE;VALUE=DATE:20350426/, 'DATE master must keep future cancellation in DATE form');
  assert.doesNotMatch(continuation, /EXDATE;TZID=/, 'timed exclusion cannot remain against a DATE master');
});

test('accepted continuation Reload reconciles partially accepted exception identities', async () => {
  reset(); const f = await followingGoogle({ withException: true, twoExceptions: true });
  let continuation; let acceptedException;
  const calendar = writableCalendar({ calendarId: f.calendarId, onInsert: p => { continuation = { ...p.requestBody, id: 'partial-continuation', etag: '"new-master-v1"' }; return { data: continuation }; }, onPatch: p => {
    if (p.eventId === 'partial-exception-two') throw Object.assign(new Error('second exception conflict'), { code: 412 });
    if (p.eventId === 'partial-exception-one') acceptedException = occurrenceItem(p.eventId, 'partial-continuation', '2035-04-26T11:00:00Z', { etag: '"new-exception-v2"' });
    return { data: { id: p.eventId, etag: '"new-exception-v2"' } };
  } });
  calendar.events.instances = async () => ({ data: { items: [
    { id: 'partial-exception-one', etag: '"one-v1"', originalStartTime: { dateTime: '2035-04-26T11:00:00Z' } },
    { id: 'partial-exception-two', etag: '"two-v1"', originalStartTime: { dateTime: '2035-05-03T11:00:00Z' } },
  ] } });
  assert.equal((await googleCalendarTest.processScopedOperations(calendar, new Map())).conflict, 1);
  assert.ok(acceptedException, 'first exception accepted before second conflicts');
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(f.exceptionId, userId);
  const reminder = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-26T10:30',?)").run(f.exceptionId,userId).lastInsertRowid);
  const sibling = await call('PUT', '/' + f.exceptionId, { edit_scope: 'this', title: 'Newer exception intent',
    occurrence_start: row(f.exceptionId).start_datetime,
    expected_revision: (await call('GET', '/' + f.exceptionId)).body.data.revision });
  assert.equal(sibling.status, 200, JSON.stringify(sibling.body));
  const before = db.prepare('SELECT id,title,external_calendar_id,exception_of_event_id FROM calendar_events').all();
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  googleCalendarTest.upsertGoogleEvents([continuation, acceptedException], f.calendarRefId);
  const after = db.prepare('SELECT id,title,external_calendar_id,exception_of_event_id FROM calendar_events').all();

  assert.equal(after.length, before.length, 'readback must reuse accepted local exception row, not duplicate it');
  assert.equal(row(f.exceptionId).external_calendar_id, 'partial-exception-one');
  googleCalendarTest.upsertGoogleEvents([continuation, acceptedException], f.calendarRefId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, before.length);
  assert.equal(row(f.exceptionId).title, 'Newer exception intent');
  assert.equal(row(f.secondExceptionId).external_calendar_id, 'followup-master_exception_two');
  assert.equal(operation(sibling.body.edit.operation_ids[0]).status, 'pending');
  assert.equal(db.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').get(f.exceptionId).user_id,userId);
  assert.equal(db.prepare('SELECT entity_id,remind_at FROM reminders WHERE id=?').get(reminder).entity_id,f.exceptionId);
  const finalProvider = writableCalendar({ calendarId: f.calendarId, onPatch: (params) => {
    assert.equal(params.eventId, 'partial-exception-one');
    assert.equal(params.headers['If-Match'], '"new-exception-v2"');
    assert.equal(params.requestBody.summary, 'Newer exception intent');
    return { data: { id: params.eventId, etag: '"new-exception-v3"' } };
  } });
  assert.equal((await googleCalendarTest.processScopedOperations(finalProvider, new Map())).completed,1);
  assert.equal(operation(sibling.body.edit.operation_ids[0]).status,'completed');
});

for (const variant of [
  { name: 'TZID timed to DATE with rebasing', options: { convertAllDay: true, rebase: true }, date: '2035-04-27', allDay: true },
  { name: 'UTC timed to DATE with rebasing', options: { convertAllDay: true, rebase: true, utcExdate: true }, date: '2035-04-27', allDay: true },
  { name: 'UTC timed to DATE across DST', options: { convertAllDay: true, rebase: true, utcExdate: true, dst: true }, date: '2035-04-20', allDay: true },
  { name: 'DATE to timed with rebasing', options: { allDay: true, convertTimed: true }, date: '2035-04-27', allDay: false },
]) {
  test('CalDAV conversion cancellation survives inbound: ' + variant.name, async () => {
    reset();
    const f = await followingCalDAV({ exdate: true, ...variant.options });
    let continuation;
    const client = {
      updateCalendarObject: async ({ calendarObject }) => {
        f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"old-v2"' });
        return { etag: '"old-v2"' };
      },
      createCalendarObject: async ({ filename, iCalString }) => {
        continuation = iCalString;
        const uid = parseICS(iCalString)[0].uid;
        f.objects.set(uid, { url: f.calendarUrl + filename, data: iCalString, etag: '"new-v1"', calendarUrl: f.calendarUrl });
        return { etag: '"new-v1"' };
      },
    };
    assert.equal((await pushCalDAV(client, f)).completed, 1);
    const date = variant.date.replaceAll('-', '');
    assert.ok(continuation.includes(variant.allDay ? 'EXDATE;VALUE=DATE:' + date : 'EXDATE;TZID=Europe/Berlin:' + date + 'T110000'));
    assert.equal(new Set(continuation.match(/^UID:.*$/gm)).size, 1);
    if (variant.allDay) {
      assert.equal(row(f.continuationId).end_datetime, '2035-04-14');
      assert.match(continuation, /DTEND;VALUE=DATE:20350415/);
      assert.doesNotMatch(continuation, /EXDATE[^:]*:.*T/);
    } else {
      assert.doesNotMatch(continuation, /EXDATE;VALUE=DATE/);
    }
    await inboundCalDAV(f, { beforeRetry: false });
    await inboundCalDAV(f, { beforeRetry: false });
    const events = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-05-30', loadEventExceptions(db, [f.continuationId]));
    assert.ok(!events.some((event) => event.start_datetime.slice(0, 10) === variant.date));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 2);
  });
}

test('CalDAV Reload adopts accepted detached identities atomically and inbound reuses local rows', async () => {
  reset();
  const f = await followingCalDAV({ withException: true });
  db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(f.exceptionId,userId);
  const reminder = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-26T10:00',?)").run(f.exceptionId,userId).lastInsertRowid);
  const originalDb = db;
  const faultDb = new Proxy(db, { get(target, name) {
    if (name === 'prepare') return (sql) => {
      if (/SET status = 'completed'/.test(sql)) throw Object.assign(new Error('Conflict after accepted resource checkpoint'), { code: 412 });
      return target.prepare(sql);
    };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  dbmod._setTestDatabase(faultDb);
  try {
    assert.equal((await pushCalDAV({
      updateCalendarObject: async ({ calendarObject }) => {
        f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"old-v3"' });
        return { etag: '"old-v3"' };
      },
      createCalendarObject: async ({ filename, iCalString }) => {
        const uid = parseICS(iCalString)[0].uid;
        assert.equal((iCalString.match(/BEGIN:VEVENT/g) || []).length, 2);
        assert.equal(new Set(iCalString.match(/^UID:.*$/gm)).size, 1);
        f.objects.set(uid, { url: f.calendarUrl + filename, data: iCalString, etag: '"new-v1"', calendarUrl: f.calendarUrl });
        return { etag: '"new-v1"' };
      },
    }, f)).conflict, 1);
  } finally { dbmod._setTestDatabase(originalDb); }
  const accepted = JSON.parse(operation(f.operationId).progress_json).continuation_master;
  assert.equal(accepted.accepted,true);
  db.exec(`CREATE TRIGGER fail_reload_exception BEFORE UPDATE OF external_calendar_id ON calendar_events
    WHEN OLD.id = ${f.exceptionId}
    BEGIN SELECT RAISE(ABORT, 'exception identity adoption fault'); END;`);
  assert.equal((await call('POST','/' + f.continuationId + '/reload-sync',{operation_id:f.operationId})).status,500);
  assert.equal(operation(f.operationId).resolution,null);
  assert.equal(row(f.continuationId).external_calendar_id,null);
  db.exec('DROP TRIGGER fail_reload_exception');
  assert.equal((await call('POST','/' + f.continuationId + '/reload-sync',{operation_id:f.operationId})).status,200);
  assert.equal(row(f.exceptionId).external_calendar_id,accepted.id + '::2035-04-26');
  await inboundCalDAV(f,{beforeRetry:false});
  await inboundCalDAV(f,{beforeRetry:false});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,3);
  assert.equal(row(f.exceptionId).exception_of_event_id,f.continuationId);
  assert.equal(db.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').get(f.exceptionId).user_id,userId);
  assert.equal(db.prepare('SELECT entity_id FROM reminders WHERE id=?').get(reminder).entity_id,f.exceptionId);
});

test('accepted Google exception Reload readback cannot insert a duplicate when no sibling protects it', async () => {
  reset();
  const f = await followingGoogle({ withException: true, twoExceptions: true });
  let continuation;
  let acceptedException;
  const provider = writableCalendar({ calendarId: f.calendarId, onInsert: (params) => {
    continuation = { ...params.requestBody, id: 'isolated-continuation', etag: '"new-master-v1"' };
    return { data: continuation };
  }, onPatch: (params) => {
    if (params.eventId === 'followup-master') return { data: { id: params.eventId, etag: '"old-v2"' } };
    if (params.eventId === 'isolated-exception-two') {
      assert.equal(params.headers['If-Match'], '"two-v1"');
      throw Object.assign(new Error('Second instance rejected'), { code: 412 });
    }
    assert.equal(params.eventId,'isolated-exception-one');
    assert.equal(params.headers['If-Match'],'"one-v1"');
    acceptedException = occurrenceItem(params.eventId,'isolated-continuation','2035-04-26T11:00:00Z',{etag:'"one-v2"'});
    return { data: acceptedException };
  } });
  provider.events.instances = async () => ({ data: { items: [
    { id:'isolated-exception-one',etag:'"one-v1"',originalStartTime:{dateTime:'2035-04-26T11:00:00Z'} },
    { id:'isolated-exception-two',etag:'"two-v1"',originalStartTime:{dateTime:'2035-05-03T11:00:00Z'} },
  ] } });
  assert.equal((await googleCalendarTest.processScopedOperations(provider,new Map())).conflict,1);
  assert.equal((await call('POST','/' + f.continuationId + '/reload-sync',{operation_id:f.operationId})).status,200);
  googleCalendarTest.upsertGoogleEvents([continuation,acceptedException],f.calendarRefId);
  googleCalendarTest.upsertGoogleEvents([continuation,acceptedException],f.calendarRefId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,4);
  assert.equal(row(f.exceptionId).external_calendar_id,'isolated-exception-one');
});

test('CalDAV child series intent recovers from the authoritative unsplit parent and preserves earlier occurrences', async () => {
  reset();
  const f = await followingCalDAV();
  assert.equal((await pushCalDAV({updateCalendarObject:async () => {throw Object.assign(new Error('Old master conflict'),{code:412});}},f)).conflict,1);
  const displayedOccurrence = expandRecurringEvents([row(f.continuationId)],'2035-04-12','2035-04-12',null)[0].start_datetime;
  const sibling = await call('PUT','/' + f.continuationId,{edit_scope:'series',occurrence_start:displayedOccurrence,
    expected_revision:(await call('GET','/' + f.continuationId)).body.data.revision,title:'Latest CalDAV child intent'});
  assert.equal(sibling.status,200,JSON.stringify(sibling.body));
  assert.equal((await call('POST','/' + f.continuationId + '/reload-sync',{operation_id:f.operationId})).status,200);
  f.objects.set(f.uid,{...f.objects.get(f.uid),etag:'"fresh-v9"'});
  let updates=0;
  let inserts=0;
  const client={
    fetchCalendars:async () => [...f.calendars.values()],
    fetchCalendarObjects:async () => [...f.objects.values()],
    updateCalendarObject:async ({calendarObject}) => {
      updates++;
      assert.equal(calendarObject.etag,'"fresh-v9"');
      assert.match(calendarObject.data,/DTSTART;TZID=Europe\/Berlin:20350405T090000/);
      assert.match(calendarObject.data,/SUMMARY:Original/);
      assert.match(calendarObject.data,/RRULE:FREQ=WEEKLY;UNTIL=20350411/);
      f.objects.set(f.uid,{...f.objects.get(f.uid),data:calendarObject.data,etag:'"fresh-v10"'});
      return {etag:'"fresh-v10"'};
    },
    createCalendarObject:async ({filename,iCalString}) => {
      inserts++;
      assert.match(iCalString,/SUMMARY:Latest CalDAV child intent/);
      assert.match(iCalString,/DTSTART;TZID=Europe\/Berlin:20350412T090000/);
      const uid=parseICS(iCalString)[0].uid;
      f.objects.set(uid,{url:f.calendarUrl + filename,data:iCalString,etag:'"child-v1"',calendarUrl:f.calendarUrl});
      return {etag:'"child-v1"'};
    },
  };
  assert.equal((await caldavSync.sync({createClient:async () => client})).success,true);
  assert.equal(updates,1);
  assert.equal(inserts,1);
  assert.equal(operation(sibling.body.edit.operation_ids[0]).resolution,'replaced_after_reload');
  assert.equal(row(f.continuationId).title,'Latest CalDAV child intent');
  assert.ok(row(f.continuationId).external_calendar_id);
  await inboundCalDAV(f,{beforeRetry:false});
  await inboundCalDAV(f,{beforeRetry:false});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,2);
  const earlier=expandRecurringEvents([row(f.masterId)],'2035-04-05','2035-04-11',null);
  assert.equal(earlier.length,1);
  assert.equal(earlier[0].title,'Original');
  assert.equal(Date.parse(earlier[0].start_datetime),Date.parse('2035-04-05T07:00:00Z'));
});

const { pendingCalendarEditOperations: supplementalPending } = await import('../server/services/calendar-edit-operations.js');
test('supplemental waiting detached occurrence edit must recover and complete', async () => {
  reset(); const f = await followingGoogle({ withException: true });
  const rejected = writableCalendar({ calendarId: f.calendarId, onPatch: () => { throw Object.assign(new Error('Original master changed'), { code: 412 }); } });
  assert.equal((await googleCalendarTest.processScopedOperations(rejected, new Map())).conflict, 1);
  const newer = await call('PUT', '/' + f.exceptionId, { edit_scope: 'this',
    occurrence_start: row(f.exceptionId).exception_original_start, title: 'Newer exception intent',
    expected_revision: (await call('GET', '/' + f.exceptionId)).body.data.revision });
  assert.equal(newer.status, 200, JSON.stringify(newer.body));
  const staleClaim = claimCalendarEditOperation(newer.body.edit.operation_ids[0], db);
  assert.ok(staleClaim);
  db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(f.exceptionId,userId);
  const reminder = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-26T10:00',?)").run(f.exceptionId,userId).lastInsertRowid);
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  assert.equal(completeCalendarEditOperation(staleClaim.id, { providerUid: 'stale' }, db, staleClaim), false);
  assert.equal(updateCalendarEditOperationProgress(staleClaim.id, { phase: 'stale' }, db, staleClaim), false);
  assert.equal(failCalendarEditOperation(staleClaim.id, new Error('stale'), {}, db, staleClaim), false);
  const master = masterItem('followup-master', { etag: '"fresh-v9"', start: '2035-04-05T07:00:00Z', end: '2035-04-05T08:00:00Z' });
  googleCalendarTest.upsertGoogleEvents([master], f.calendarRefId);
  googleCalendarTest.upsertGoogleEvents([master], f.calendarRefId);
  let instancePatches = 0;
  const provider = writableCalendar({ calendarId: f.calendarId, instances: [
    { item: { id: 'original-instance', etag: '"instance-v1"', originalStartTime: { dateTime: '2035-04-26T09:00:00+02:00' } } },
  ], onPatch: (params) => {
    if (params.eventId === 'followup-master') {
      assert.equal(params.headers['If-Match'], '"fresh-v9"');
      assert.equal(params.requestBody.summary, 'Remote master');
      return { data: { id: params.eventId, etag: '"master-v10"' } };
    }
    assert.equal(params.eventId, 'original-instance');
    assert.equal(params.headers['If-Match'], instancePatches++ ? '"patched"' : '"instance-v1"');
    return { data: { id: params.eventId, etag: '"patched"' } };
  } });
  assert.equal(claimCalendarEditOperation(newer.body.edit.operation_ids[0],db),null);
  assert.equal((await googleCalendarTest.processScopedOperations(provider, new Map())).completed,1);
  assert.equal((await googleCalendarTest.processScopedOperations(provider, new Map())).completed,1);
  const continuation = { ...provider.calls.inserts[0].requestBody, id: 'inserted-continuation', etag: '"inserted-v1"' };
  const exception = occurrenceItem(row(f.exceptionId).external_calendar_id,continuation.id,'2035-04-26T07:00:00Z',{title:'Newer exception intent',etag:'"patched"'});
  googleCalendarTest.upsertGoogleEvents([continuation,exception],f.calendarRefId);
  googleCalendarTest.upsertGoogleEvents([continuation,exception],f.calendarRefId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,3);
  assert.equal(row(f.exceptionId).exception_of_event_id,f.continuationId);
  assert.equal(db.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').get(f.exceptionId).user_id,userId);
  assert.equal(db.prepare('SELECT entity_id FROM reminders WHERE id=?').get(reminder).entity_id,f.exceptionId);
  assert.equal(operation(newer.body.edit.operation_ids[0]).status, 'completed', 'Newer occurrence must reach provider completion after authoritative readback');
  assert.equal(row(f.exceptionId).title, 'Newer exception intent');
  assert.equal(instancePatches, 2);
});

test('supplemental nested following recovery must not restore rejected time shift', async () => {
  reset(); const f = await followingGoogle();
  const rejected = writableCalendar({ calendarId: f.calendarId, onPatch: () => { throw Object.assign(new Error('Original master changed'), { code: 412 }); } });
  assert.equal((await googleCalendarTest.processScopedOperations(rejected, new Map())).conflict, 1);
  const newer = await call('PUT', '/' + f.continuationId, { edit_scope: 'following', occurrence_start: '2035-04-26T11:00',
    title: 'Newer later-tail intent', expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
  assert.equal(newer.status, 200, JSON.stringify(newer.body));
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  googleCalendarTest.upsertGoogleEvents([masterItem('followup-master', { etag: '"fresh-v9"',
    start: '2035-04-05T07:00:00Z', end: '2035-04-05T08:00:00Z' })], f.calendarRefId);
  await resolveFieldConflicts(newer.body.data.id);
  let inserted = 0;
  const accepted = [];
  const provider = writableCalendar({ calendarId: f.calendarId, onInsert: params => {
    const id = ++inserted === 1 ? 'supp-recovery-child' : 'supp-later-child';
    const item = { ...params.requestBody, id, etag: '"' + id + '-v1"' };
    accepted.push(item);
    return { data: item };
  } });
  await googleCalendarTest.processScopedOperations(provider, new Map());
  await googleCalendarTest.processScopedOperations(provider, new Map());
  const previousSegment = provider.calls.patches.find(params => params.eventId === 'supp-recovery-child');
  assert.ok(previousSegment, 'The later split must have an actionable provider identity');
  assert.equal(Date.parse(previousSegment.requestBody.start.dateTime), Date.parse('2035-04-12T07:00:00Z'),
    'The preceding segment must preserve authoritative 09:00 Berlin, rather than restore the discarded 11:00 gesture');
  assert.equal(previousSegment.headers['If-Match'],'"supp-recovery-child-v1"');
  assert.equal(previousSegment.requestBody.summary,'Remote master');
  assert.match(previousSegment.requestBody.recurrence[0],/UNTIL=20350425/);
  assert.equal(provider.calls.inserts.length,2);
  assert.equal(Date.parse(accepted[1].start.dateTime),Date.parse('2035-04-26T07:00:00Z'));
  assert.equal(row(newer.body.data.id).title, 'Newer later-tail intent');
  googleCalendarTest.upsertGoogleEvents([{...accepted[0],...previousSegment.requestBody,etag:'"segment-v2"'},accepted[1]],f.calendarRefId);
  googleCalendarTest.upsertGoogleEvents([{...accepted[0],...previousSegment.requestBody,etag:'"segment-v2"'},accepted[1]],f.calendarRefId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,3);
  const earlier = expandRecurringEvents([row(f.continuationId)],'2035-04-12','2035-04-25',null);
  assert.equal(earlier.length,2);
  assert.ok(earlier.every((event)=>event.title==='Remote master'));
  assert.ok(earlier.every((event)=>new Date(event.start_datetime).getUTCHours()===7));
  assert.equal(operation(newer.body.edit.operation_ids[0]).status, 'completed');
});

test('supplemental uncertain CalDAV continuation Reload preserves detached row metadata', async () => {
  reset(); const f = await followingCalDAV({ withException: true });
  db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(f.exceptionId, userId);
  const reminder = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-26T10:00',?)").run(f.exceptionId, userId).lastInsertRowid);
  let createdUid;
  const first = await pushCalDAV({
    updateCalendarObject: async ({ calendarObject }) => {
      assert.equal(calendarObject.etag, '"dav-detached-v2"');
      f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"old-v3"' });
      return { etag: '"old-v3"' };
    },
    createCalendarObject: async ({ filename, iCalString }) => {
      createdUid = parseICS(iCalString)[0].uid;
      assert.equal((iCalString.match(/BEGIN:VEVENT/g) || []).length, 2);
      f.objects.set(createdUid, { url: f.calendarUrl + filename, data: iCalString, etag: '"new-v1"', calendarUrl: f.calendarUrl });
      throw Object.assign(new Error('Create accepted, response lost'), { code: 503 });
    },
  }, f);
  assert.equal(first.retry, 1);
  const remote = f.objects.get(createdUid);
  f.objects.set(createdUid, { ...remote, data: remote.data.replace('SUMMARY:Continuation', 'SUMMARY:External'), etag: '"new-v2"' });
  assert.equal((await pushCalDAV({}, f)).conflict, 1);
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  assert.equal(operation(f.operationId).payload.reload_readback_pending,true);
  assert.equal(row(f.continuationId).external_calendar_id,null);
  assert.notEqual(JSON.parse(operation(f.operationId).progress_json).continuation_master.accepted,true);
  db.exec(`CREATE TRIGGER fail_uncertain_adoption BEFORE UPDATE OF external_calendar_id ON calendar_events
    WHEN OLD.id = ${f.exceptionId}
    BEGIN SELECT RAISE(ABORT, 'uncertain identity adoption fault'); END;`);
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(operation(f.operationId).payload.reload_readback_pending,true);
  assert.equal(row(f.continuationId).external_calendar_id,null);
  assert.equal(row(f.exceptionId).external_calendar_id,f.uid + '::2035-04-26');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,3);
  assert.equal(db.prepare('SELECT entity_id FROM reminders WHERE id=?').get(reminder).entity_id,f.exceptionId);
  db.exec('DROP TRIGGER fail_uncertain_adoption');
  await inboundCalDAV(f, { beforeRetry: false });
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(operation(f.operationId).payload.reload_readback_pending,false);
  assert.notEqual(JSON.parse(operation(f.operationId).progress_json).continuation_master.accepted,true);
  assert.equal(operation(f.operationId).payload.provider_readback_result.providerEtag,'"new-v2"');
  assert.equal(row(f.continuationId).title,'External');
  assert.ok(row(f.exceptionId), 'Authoritative readback must preserve the original detached local row');
  assert.equal(row(f.exceptionId).external_calendar_id, createdUid + '::2035-04-26');
  assert.equal(db.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').get(f.exceptionId)?.user_id, userId);
  assert.equal(db.prepare('SELECT entity_id FROM reminders WHERE id=?').get(reminder)?.entity_id, f.exceptionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 3);
});

test('supplemental shortened authoritative parent survives first-occurrence recovery', async () => {
  reset(); const f = await followingGoogle();
  const rejected = writableCalendar({ calendarId: f.calendarId, onPatch: () => { throw Object.assign(new Error('Original master changed'), { code: 412 }); } });
  assert.equal((await googleCalendarTest.processScopedOperations(rejected, new Map())).conflict, 1);
  db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(f.masterId, userId);
  const reminder = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-12T08:00',?)").run(f.masterId, userId).lastInsertRowid);
  const newer = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', occurrence_start: '2035-04-12T11:00',
    title: 'Newer child intent', expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
  assert.equal(newer.status, 200);
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  googleCalendarTest.upsertGoogleEvents([masterItem('followup-master', { etag: '"fresh-v9"',
    start: '2035-04-12T09:00:00Z', end: '2035-04-12T10:00:00Z', rule: 'FREQ=WEEKLY;COUNT=5' })], f.calendarRefId);
  await resolveFieldConflicts(f.continuationId);
  assert.ok(row(f.masterId), 'Recovery must not delete the authoritative provider parent');
  assert.equal(db.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').get(f.masterId)?.user_id, userId);
  assert.equal(db.prepare('SELECT entity_id FROM reminders WHERE id=?').get(reminder)?.entity_id, f.masterId);
  const provider = writableCalendar({calendarId:f.calendarId,onPatch:(params)=>{
    assert.equal(params.eventId,'followup-master');
    assert.equal(params.headers['If-Match'],'"fresh-v9"');
    assert.equal(params.requestBody.summary,'Newer child intent');
    return {data:{...params.requestBody,id:params.eventId,etag:'"accepted-v10"'}};
  },onInsert:()=>{throw new Error('An existing first-occurrence master cannot be inserted again');}});
  assert.equal((await googleCalendarTest.processScopedOperations(provider,new Map())).completed,1);
  const authoritative = {...provider.calls.patches[0].requestBody,id:'followup-master',etag:'"accepted-v10"'};
  googleCalendarTest.upsertGoogleEvents([authoritative],f.calendarRefId);
  googleCalendarTest.upsertGoogleEvents([authoritative],f.calendarRefId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,1);
  assert.ok(row(f.masterId));
  assert.equal(operation(newer.body.edit.operation_ids[0]).event_id,f.masterId);
  assert.equal(operation(f.operationId).event_id,f.masterId);
  assert.equal(db.prepare('SELECT remind_at FROM reminders WHERE id=?').get(reminder).remind_at,'2035-04-12T08:00');
});

test('supplemental late all-day conversion must not add an extra canceled day', async () => {
  reset(); const f = await followingCalDAV({ allDay: true, exdate: true, convertTimed: true, lateDaily: true });
  let resource;
  assert.equal((await pushCalDAV({ updateCalendarObject: async () => ({ etag: '"old-v2"' }),
    createCalendarObject: async ({ iCalString }) => { resource = iCalString; return { etag: '"child-v1"' }; } }, f)).completed, 1);
  assert.match(resource, /EXDATE;TZID=Europe\/Berlin:20350427T150000/);
  assert.doesNotMatch(resource, /EXDATE[^\r\n]*20350428T150000/, 'One original canceled occurrence must not become two canceled days');
});

for (const hour of [8,15]) {
  test('DAILY all-day conversion preserves exactly one canceled civil occurrence at ' + hour + ':00',async()=>{
    reset();const f=await followingCalDAV({allDay:true,exdate:true,convertTimed:true,lateDaily:true,conversionHour:hour});
    let resource;
    assert.equal((await pushCalDAV({
      updateCalendarObject:async({calendarObject})=>{
        f.objects.set(f.uid,{...f.objects.get(f.uid),data:calendarObject.data,etag:'"old-v2"'});
        return {etag:'"old-v2"'};
      },
      createCalendarObject:async({filename,iCalString})=>{
        resource=iCalString;const uid=parseICS(iCalString)[0].uid;
        f.objects.set(uid,{url:f.calendarUrl+filename,data:iCalString,etag:'"child-v1"',calendarUrl:f.calendarUrl});
        return {etag:'"child-v1"'};
      },
    },f)).completed,1);
    const exclusions=resource.split(/\r?\n/).filter((line)=>line.startsWith('EXDATE'));
    assert.equal(exclusions.length,1);
    assert.equal(exclusions[0],'EXDATE;TZID=Europe/Berlin:20350427T'+String(hour).padStart(2,'0')+'0000');
    assert.deepEqual(operation(f.operationId).payload.split.exception_operations.map((item)=>item.continuation_start),['2035-04-27']);
    await inboundCalDAV(f,{beforeRetry:false});await inboundCalDAV(f,{beforeRetry:false});
    const dates=db.prepare('SELECT exception_date FROM calendar_event_exceptions WHERE event_id=?').all(f.continuationId).map((item)=>item.exception_date);
    assert.deepEqual(dates,['2035-04-27']);
    const events=expandRecurringEvents([row(f.continuationId)],'2035-04-26','2035-04-28',loadEventExceptions(db,[f.continuationId]));
    assert.deepEqual(events.map((event)=>event.start_datetime.slice(0,10)),['2035-04-26','2035-04-28']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,2);
  });
}

for(const source of ['google','caldav']) {
  test(source+' recovery exposes an actionable error when the selected occurrence no longer exists',async()=>{
    reset();const f=source==='google'?await followingGoogle():await followingCalDAV();
    if(source==='google')assert.equal((await googleCalendarTest.processScopedOperations(writableCalendar({calendarId:f.calendarId,onPatch:()=>{throw Object.assign(new Error('First master conflict'),{code:412});}}),new Map())).conflict,1);
    else assert.equal((await pushCalDAV({updateCalendarObject:async()=>{throw Object.assign(new Error('First master conflict'),{code:412});}},f)).conflict,1);
    const slot=expandRecurringEvents([row(f.continuationId)],'2035-04-12','2035-04-12',null)[0].start_datetime;
    const newer=await call('PUT','/'+f.continuationId,{edit_scope:'series',occurrence_start:slot,title:'Retained latest intent',expected_revision:(await call('GET','/'+f.continuationId)).body.data.revision});
    assert.equal(newer.status,200);
    assert.equal((await call('POST','/'+f.continuationId+'/reload-sync',{operation_id:f.operationId})).status,200);
    if(source==='google'){
      const master=masterItem('followup-master',{etag:'"fresh-v9"',rule:'FREQ=WEEKLY;COUNT=1',start:'2035-04-05T07:00:00Z',end:'2035-04-05T08:00:00Z'});
      googleCalendarTest.upsertGoogleEvents([master],f.calendarRefId);googleCalendarTest.upsertGoogleEvents([master],f.calendarRefId);
    }else{
      f.objects.set(f.uid,{...f.objects.get(f.uid),data:f.objects.get(f.uid).data.replace('COUNT=6','COUNT=1'),etag:'"fresh-v9"'});
      await inboundCalDAV(f,{beforeRetry:false});await inboundCalDAV(f,{beforeRetry:false});
    }
    const current=await call('GET','/'+f.continuationId);
    assert.equal(current.body.data.sync.state,'error');assert.equal(current.body.data.sync.retryable,false);
    assert.match(current.body.data.sync.error,/occurrence no longer exists.*choose an existing occurrence.*discard/i);
    assert.equal(operation(newer.body.edit.operation_ids[0]).failure_kind,'recovery_occurrence_missing');
    assert.equal(row(f.continuationId).title,'Retained latest intent');
    assert.equal(supplementalPending(source,db).length,0);
  });
}


test('CalDAV dependent detached intent completes after authoritative parent refresh', async () => {
  reset();
  const f = await followingCalDAV({ withException: true });
  assert.equal((await pushCalDAV({ updateCalendarObject: async () => {
    throw Object.assign(new Error('Original master changed'), { code: 412 });
  } }, f)).conflict, 1);
  const newer = await call('PUT', '/' + f.exceptionId, {
    edit_scope: 'this', occurrence_start: row(f.exceptionId).exception_original_start,
    expected_revision: (await call('GET', '/' + f.exceptionId)).body.data.revision,
    title: 'Latest detached CalDAV intent',
  });
  assert.equal(newer.status, 200, JSON.stringify(newer.body));
  const newerId = newer.body.edit.operation_ids[0];
  const staleClaim = claimCalendarEditOperation(newerId, db);
  assert.ok(staleClaim);
  db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(f.exceptionId,userId);
  const reminder = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-26T10:00',?)").run(f.exceptionId,userId).lastInsertRowid);
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status,200);
  assert.equal(completeCalendarEditOperation(staleClaim.id, { providerUid: 'stale' }, db, staleClaim),false);
  f.objects.set(f.uid,{...f.objects.get(f.uid),etag:'"fresh-v9"'});
  const originalIdentity = f.objects.get(f.uid).data.match(/^RECURRENCE-ID[^\r\n]*$/m)[0];
  let inserts = 0;
  let updates = 0;
  let continuationUid;
  const client = {
    fetchCalendars: async () => [...f.calendars.values()],
    fetchCalendarObjects: async () => [...f.objects.values()],
    updateCalendarObject: async ({calendarObject}) => {
      updates++;
      const uid = parseICS(calendarObject.data)[0].uid;
      if (uid === f.uid) {
        assert.equal(calendarObject.etag,'"fresh-v9"');
        assert.match(calendarObject.data,/SUMMARY:Original/);
        assert.match(calendarObject.data,/DTSTART;TZID=Europe\/Berlin:20350405T090000/);
        assert.match(calendarObject.data,/UNTIL=20350411/);
      } else {
        assert.equal(uid,continuationUid);
        assert.equal(calendarObject.etag,'"child-v1"');
        assert.ok(calendarObject.data.includes(originalIdentity));
        assert.match(calendarObject.data,/SUMMARY:Latest detached CalDAV intent/);
      }
      const etag = uid === f.uid ? '"old-v10"' : '"child-v2"';
      f.objects.set(uid,{...f.objects.get(uid),data:calendarObject.data,etag});
      return {etag};
    },
    createCalendarObject: async ({filename,iCalString}) => {
      inserts++;
      continuationUid = parseICS(iCalString)[0].uid;
      assert.match(iCalString,/DTSTART;TZID=Europe\/Berlin:20350412T090000/);
      assert.ok(iCalString.includes(originalIdentity));
      f.objects.set(continuationUid,{url:f.calendarUrl+filename,data:iCalString,etag:'"child-v1"',calendarUrl:f.calendarUrl});
      return {etag:'"child-v1"'};
    },
  };
  assert.equal((await caldavSync.sync({createClient:async () => client})).success,true);
  assert.equal((await pushCalDAV(client,f)).completed,1);
  assert.equal(inserts,1);
  assert.equal(updates,2);
  assert.equal(operation(newerId).status,'completed');
  assert.equal(row(f.exceptionId).external_calendar_id,continuationUid+'::2035-04-26');
  await inboundCalDAV(f,{beforeRetry:false});
  await inboundCalDAV(f,{beforeRetry:false});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,3);
  assert.equal(row(f.exceptionId).exception_of_event_id,f.continuationId);
  assert.equal(row(f.exceptionId).title,'Latest detached CalDAV intent');
  assert.equal(db.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').get(f.exceptionId).user_id,userId);
  assert.equal(db.prepare('SELECT entity_id FROM reminders WHERE id=?').get(reminder).entity_id,f.exceptionId);
  const earlier = expandRecurringEvents([row(f.masterId)],'2035-04-05','2035-04-11',null);
  assert.equal(earlier.length,1);
  assert.equal(Date.parse(earlier[0].start_datetime),Date.parse('2035-04-05T07:00:00Z'));
});
test('final review supplemental full editor form preserves refreshed fields and count', async () => {
  reset(); const f = await followingGoogle();
  const rejected = writableCalendar({ calendarId: f.calendarId, onPatch: () => { throw Object.assign(new Error('Original master changed'), { code: 412 }); } });
  assert.equal((await googleCalendarTest.processScopedOperations(rejected, new Map())).conflict, 1);
  const child = row(f.continuationId);
  const slot = expandRecurringEvents([child], '2035-04-26', '2035-04-26', null)[0];
  const newer = await call('PUT', '/' + f.continuationId, {
    edit_scope: 'following', occurrence_start: slot.start_datetime,
    title: 'Newer later-tail intent', description: child.description ?? '', location: child.location ?? '',
    start_datetime: slot.start_datetime, end_datetime: slot.end_datetime, all_day: child.all_day,
    recurrence_rule: child.recurrence_rule, color: child.color ?? null, icon: child.icon ?? null,
    visibility: child.visibility || 'all', countdown: child.countdown || 0, assigned_to: [],
    target_google_calendar_id: child.target_google_calendar_id ?? null,
    target_caldav_account_id: child.target_caldav_account_id ?? null,
    target_caldav_calendar_url: child.target_caldav_calendar_url ?? null,
    target_outlook_account_id: child.target_outlook_account_id ?? null,
    target_outlook_calendar_id: child.target_outlook_calendar_id ?? null,
    expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision,
  });
  assert.equal(newer.status, 200, JSON.stringify(newer.body));
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  googleCalendarTest.upsertGoogleEvents([{ ...masterItem('followup-master', { etag: '"fresh-v9"',
    start: '2035-04-05T07:00:00Z', end: '2035-04-05T08:00:00Z', rule: 'FREQ=WEEKLY;COUNT=4' }),
    description: 'Remote description', location: 'Remote location' }], f.calendarRefId);
  await resolveFieldConflicts(newer.body.data.id);
  let inserted = 0;
  const accepted = [];
  const provider = writableCalendar({ calendarId: f.calendarId, onInsert: params => {
    const id = ++inserted === 1 ? 'supp-recovery-child' : 'supp-later-child';
    const item = { ...params.requestBody, id, etag: '"' + id + '-v1"' };
    accepted.push(item);
    return { data: item };
  } });
  await googleCalendarTest.processScopedOperations(provider, new Map());
  await googleCalendarTest.processScopedOperations(provider, new Map());
  const previousSegment = provider.calls.patches.find(params => params.eventId === 'supp-recovery-child');
  console.log('FULL_FORM_DIAGNOSTIC', JSON.stringify({
    editorRule: child.recurrence_rule, selectedStart: slot.start_datetime,
    preceding: previousSegment?.requestBody,
    inserted: accepted.map(item => ({ title: item.summary, description: item.description, location: item.location,
      recurrence: item.recurrence, start: item.start, end: item.end })),
  }));
  assert.ok(previousSegment, 'The later split must have an actionable provider identity');
  assert.equal(Date.parse(previousSegment.requestBody.start.dateTime), Date.parse('2035-04-12T07:00:00Z'),
    'The preceding segment must preserve authoritative 09:00 Berlin, rather than restore the discarded 11:00 gesture');
  assert.equal(previousSegment.headers['If-Match'],'"supp-recovery-child-v1"');
  assert.equal(previousSegment.requestBody.summary,'Remote master');
  assert.match(previousSegment.requestBody.recurrence[0],/UNTIL=20350425/);
  assert.equal(provider.calls.inserts.length,2);
  assert.equal(Date.parse(accepted[1].start.dateTime),Date.parse('2035-04-26T07:00:00Z'));
  assert.equal(row(newer.body.data.id).title, 'Newer later-tail intent');
  assert.equal(accepted[1].description, 'Remote description', 'Unchanged editor fields must not overwrite remote description');
  assert.equal(accepted[1].location, 'Remote location', 'Unchanged editor fields must not overwrite remote location');
  assert.match(accepted[1].recurrence[0], /COUNT=1(?:;|$)/, 'Only the final authoritative occurrence remains');
  googleCalendarTest.upsertGoogleEvents([{...accepted[0],...previousSegment.requestBody,etag:'"segment-v2"'},accepted[1]],f.calendarRefId);
  googleCalendarTest.upsertGoogleEvents([{...accepted[0],...previousSegment.requestBody,etag:'"segment-v2"'},accepted[1]],f.calendarRefId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,3);
  const earlier = expandRecurringEvents([row(f.continuationId)],'2035-04-12','2035-04-25',null);
  assert.equal(earlier.length,2);
  assert.ok(earlier.every((event)=>event.title==='Remote master'));
  assert.ok(earlier.every((event)=>new Date(event.start_datetime).getUTCHours()===7));
  assert.equal(operation(newer.body.edit.operation_ids[0]).status, 'completed');
});


for (const source of ['google', 'caldav']) {
  test('final review supplemental ' + source + ' nonrecurring parent produces actionable recovery', async () => {
    reset(); const f = source === 'google' ? await followingGoogle() : await followingCalDAV();
    if (source === 'google') {
      assert.equal((await googleCalendarTest.processScopedOperations(writableCalendar({ calendarId: f.calendarId,
        onPatch: () => { throw Object.assign(new Error('First master conflict'), { code: 412 }); } }), new Map())).conflict, 1);
    } else {
      assert.equal((await pushCalDAV({ updateCalendarObject: async () => {
        throw Object.assign(new Error('First master conflict'), { code: 412 });
      } }, f)).conflict, 1);
    }
    const slot = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0].start_datetime;
    const newer = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', occurrence_start: slot,
      title: 'Retained latest intent', expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
    assert.equal(newer.status, 200);
    assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
    if (source === 'google') {
      const master = masterItem('followup-master', { etag: '"fresh-v9"', start: '2035-04-05T07:00:00Z', end: '2035-04-05T08:00:00Z' });
      delete master.recurrence;
      googleCalendarTest.upsertGoogleEvents([master], f.calendarRefId);
      googleCalendarTest.upsertGoogleEvents([master], f.calendarRefId);
    } else {
      const remote = f.objects.get(f.uid);
      f.objects.set(f.uid, { ...remote, data: remote.data.replace(/^RRULE:.*(?:\r?\n|$)/m, ''), etag: '"fresh-v9"' });
      // String.raw keeps the regex backslashes above; use the actual line form.
      const object = f.objects.get(f.uid);
      f.objects.set(f.uid, { ...object, data: object.data.split(/\r?\n/).filter(line => !line.startsWith('RRULE:')).join('\r\n') });
      await inboundCalDAV(f, { beforeRetry: false });
      await inboundCalDAV(f, { beforeRetry: false });
    }
    const current = await call('GET', '/' + f.continuationId);
    console.log('NONRECURRING_DIAGNOSTIC', JSON.stringify({ source, parentRule: row(f.masterId)?.recurrence_rule,
      sync: current.body.data.sync, newerStatus: operation(newer.body.edit.operation_ids[0]).status,
      eligible: supplementalPending(source, db).length }));
    assert.equal(row(f.masterId).recurrence_rule, null, 'Provider readback must really remove recurrence');
    assert.equal(current.body.data.sync.state, 'error');
    assert.equal(current.body.data.sync.retryable, false);
    assert.match(current.body.data.sync.error, /occurrence no longer exists.*choose an existing occurrence.*discard/i);
    assert.equal(operation(newer.body.edit.operation_ids[0]).failure_kind, 'recovery_occurrence_missing');
    assert.equal(supplementalPending(source, db).length, 0);
  });
}

test('final review supplemental absent uncertain CalDAV continuation must not wait forever', async () => {
  reset(); const f = await followingCalDAV({ withException: true });
  let createdUid;
  const first = await pushCalDAV({
    updateCalendarObject: async ({ calendarObject }) => {
      f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"old-v3"' });
      return { etag: '"old-v3"' };
    },
    createCalendarObject: async ({ filename, iCalString }) => {
      createdUid = parseICS(iCalString)[0].uid;
      f.objects.set(createdUid, { url: f.calendarUrl + filename, data: iCalString, etag: '"new-v1"', calendarUrl: f.calendarUrl });
      throw Object.assign(new Error('Create accepted, response lost'), { code: 503 });
    },
  }, f);
  assert.equal(first.retry, 1);
  const remote = f.objects.get(createdUid);
  f.objects.set(createdUid, { ...remote, data: remote.data.replace('SUMMARY:Continuation', 'SUMMARY:External'), etag: '"new-v2"' });
  assert.equal((await pushCalDAV({}, f)).conflict, 1);
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  f.objects.delete(createdUid);
  await inboundCalDAV(f, { beforeRetry: false });
  await inboundCalDAV(f, { beforeRetry: false });
  const current = await call('GET', '/' + f.continuationId);
  console.log('ABSENT_RESOURCE_DIAGNOSTIC', JSON.stringify({ status: current.status,
    sync: current.body.data?.sync, readbackPending: operation(f.operationId).payload.reload_readback_pending,
    rows: db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n }));
  assert.equal(current.status, 404, 'No newer intent remains, so authoritative absence removes the optimistic copy');
  assert.equal(operation(f.operationId).payload.reload_readback_pending, false);
  assert.ok(row(f.masterId));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 1);
});

async function rejectedRecovery(source, options = {}) {
  const f = source === 'google' ? await followingGoogle(options) : await followingCalDAV(options);
  const reject = () => { throw Object.assign(new Error('First master conflict'), { code: 412 }); };
  const result = source === 'google'
    ? await googleCalendarTest.processScopedOperations(writableCalendar({ calendarId: f.calendarId, onPatch: reject }), new Map())
    : await pushCalDAV({ updateCalendarObject: reject }, f);
  assert.equal(result.conflict, 1);
  return f;
}

async function uncertainDeletedResource({ newer = false } = {}) {
  const f = await followingCalDAV({ withException: true });
  let uid; let stale;
  const first = await pushCalDAV({ updateCalendarObject: async ({ calendarObject }) => {
    f.objects.set(f.uid, { ...f.objects.get(f.uid), data: calendarObject.data, etag: '"accepted-old"' });
    return { etag: '"accepted-old"' };
  }, createCalendarObject: async ({ filename, iCalString }) => {
    uid = parseICS(iCalString)[0].uid;
    stale = operation(f.operationId);
    f.objects.set(uid, { url: f.calendarUrl + filename, data: iCalString, etag: '"accepted-new"', calendarUrl: f.calendarUrl });
    throw Object.assign(new Error('Create accepted but response lost'), { code: 503 });
  } }, f);
  assert.equal(first.retry, 1);
  const object = f.objects.get(uid);
  f.objects.set(uid, { ...object, data: object.data.replace('SUMMARY:Continuation', 'SUMMARY:Actual provider change'), etag: '"changed"' });
  assert.equal((await pushCalDAV({}, f)).conflict, 1);
  let newerId = null;
  if (newer) {
    const selected = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0];
    const edit = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', occurrence_start: selected.start_datetime,
      title: 'Retained after resource removal', expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
    assert.equal(edit.status, 200, JSON.stringify(edit.body)); newerId = edit.body.edit.operation_ids[0];
  }
  assert.equal((await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId })).status, 200);
  f.objects.delete(uid);
  return { ...f, newerId, stale, absentUid: uid, absentObject: f.objects.get(uid) || object };
}

test('REC06/07/08 CalDAV absent uncertain resource with newer intent retains actionable error and safe discard', async () => {
  reset(); const f = await uncertainDeletedResource({ newer: true });
  db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(f.continuationId, userId);
  const reminderId = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-12T10:30',?)").run(f.continuationId, userId).lastInsertRowid);
  await inboundCalDAV(f, { beforeRetry: false }); await inboundCalDAV(f, { beforeRetry: false });
  const retained = (await call('GET', '/' + f.continuationId)).body.data;
  assert.equal(retained.title, 'Retained after resource removal');
  assert.equal(retained.sync.state, 'error'); assert.equal(retained.sync.retryable, false);
  assert.equal(retained.sync.failure_kind, 'recovery_occurrence_missing');
  assert.equal(operation(f.operationId).payload.reload_readback_pending, false);
  assert.equal(supplementalPending('caldav', db).length, 0);
  assert.equal(db.prepare('SELECT entity_id FROM reminders WHERE id=?').get(reminderId).entity_id, f.continuationId);
  assert.equal((await call('DELETE', '/' + f.continuationId)).status, 409);
  assert.equal((await call('POST', '/' + f.continuationId + '/discard-recovery', {})).status, 200);
  assert.equal(operation(f.newerId).resolution, 'discard_unsaved');
  assert.equal(completeCalendarEditOperation(f.operationId, { providerUid: 'stale-resurrected' }, db, f.stale), false);
  assert.equal(updateCalendarEditOperationProgress(f.operationId, { continuation_master: { id: 'stale' } }, db, f.stale), false);
  assert.equal(failCalendarEditOperation(f.operationId, new Error('stale'), {}, db, f.stale), false);
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(row(f.continuationId), undefined); assert.ok(row(f.masterId));
  assert.equal(f.objects.size, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n, 0);
});

test('REC07 CalDAV failed and explicitly partial fetches cannot prove uncertain resource absent', async () => {
  reset(); const f = await uncertainDeletedResource();
  const client = { fetchCalendars: async () => [...f.calendars.values()],
    fetchCalendarObjects: async () => { throw new Error('Incomplete collection fetch'); } };
  await caldavSync.sync({ createClient: async () => client });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, true); assert.ok(row(f.continuationId));
  client.fetchCalendarObjects = async () => Object.assign([...f.objects.values()], { partial: true });
  await caldavSync.sync({ createClient: async () => client });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, true); assert.ok(row(f.continuationId));
  client.fetchCalendarObjects = async () => Object.assign([...f.objects.values()], { incremental: true });
  await caldavSync.sync({ createClient: async () => client });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, true); assert.ok(row(f.continuationId));
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, false); assert.equal(row(f.continuationId), undefined);
});

const davListing = (responses = '') => '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' + responses + '</d:multistatus>';
const davObjectResponse = (url, data = null, status = 200) => '<d:response><d:href>' + new URL(url).pathname
  + '</d:href><d:propstat><d:prop><d:getetag>"protocol-v1"</d:getetag>'
  + (data === null ? '' : '<c:calendar-data><![CDATA[' + data + ']]></c:calendar-data>')
  + '</d:prop><d:status>HTTP/1.1 ' + status + ' Response</d:status></d:propstat></d:response>';

for (const newer of [false, true]) {
  for (const kind of ['html', 'malformed', 'truncated-root', 'truncated-response', 'invalid-child', 'query-error', 'collection-query-error', 'collection-href-only', 'multiget-incomplete']) {
    test('REC-SPEC-01 real tsdav ' + kind + ' preserves uncertain readback with newer=' + newer, async () => {
      reset(); const f = await uncertainDeletedResource({ newer });
      // Keep outbound work claimed elsewhere while this authoritative read is
      // evaluated, so ordinary retry bookkeeping does not obscure data safety.
      if (newer) assert.ok(claimCalendarEditOperation(f.newerId, db));
      const reminderId = Number(db.prepare("INSERT INTO reminders (entity_type,entity_id,remind_at,created_by) VALUES ('event',?,'2035-04-12T10:30',?)").run(f.continuationId, userId).lastInsertRowid);
      const before = { child: row(f.continuationId), exception: row(f.exceptionId),
        reminder: db.prepare('SELECT * FROM reminders WHERE id=?').get(reminderId), payload: operation(f.operationId).payload };
      const parentObject = [...f.objects.values()][0];
      const query = davListing(davObjectResponse(parentObject.url) + davObjectResponse(f.absentObject.url));
      const replies = {
        html: [{ text: '<html>Temporary gateway page</html>', contentType: 'text/html', status: 200 }],
        malformed: [{ text: '<broken', status: 207 }],
        'truncated-root': [{ text: '<d:multistatus xmlns:d="DAV:">', status: 207 }],
        'truncated-response': [{ text: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/collection/</d:href>', status: 207 }],
        'invalid-child': [{ text: davListing('<invalid/>'), status: 207 }],
        'query-error': [{ text: davListing(davObjectResponse(f.absentObject.url, null, 404)), status: 207 }, { text: davListing(), status: 207 }],
        'collection-query-error': [{ text: davListing(davObjectResponse(f.calendarUrl, null, 404)), status: 207 }],
        'collection-href-only': [{ text: davListing('<d:response><d:href>' + new URL(f.calendarUrl).pathname + '</d:href></d:response>'), status: 207 }],
        'multiget-incomplete': [{ text: query, status: 207 }, { text: davListing(davObjectResponse(parentObject.url, parentObject.data)), status: 207 }],
      }[kind];
      let requests = 0;
      const transport = async () => {
        const reply = replies[Math.min(requests++, replies.length - 1)];
        return new Response(reply.text, { status: reply.status, headers: { 'Content-Type': reply.contentType || 'application/xml' } });
      };
      const wrapped = withCalendarObjectUrlFilter({ fetchCalendarObjects: installedCalendarObjects });
      const client = { fetchCalendars: async () => [...f.calendars.values()],
        fetchCalendarObjects: (params) => wrapped.fetchCalendarObjects({ ...params, fetch: transport }) };
      await caldavSync.sync({ createClient: async () => client });
      assert.ok(requests > 0, 'The installed tsdav response path must run');
      assert.deepEqual(row(f.continuationId), before.child);
      assert.deepEqual(row(f.exceptionId), before.exception);
      assert.deepEqual(db.prepare('SELECT * FROM reminders WHERE id=?').get(reminderId), before.reminder);
      assert.equal(operation(f.operationId).payload.reload_readback_pending, true);
      assert.deepEqual(operation(f.operationId).payload, before.payload);
      if (newer) assert.equal(operation(f.newerId).failure_kind, null);
    });
  }
  test('REC-SPEC-01 real tsdav valid empty listing converges with newer=' + newer, async () => {
    reset(); const f = await uncertainDeletedResource({ newer });
    let requests = 0;
    const wrapped = withCalendarObjectUrlFilter({ fetchCalendarObjects: installedCalendarObjects });
    const client = { fetchCalendars: async () => [...f.calendars.values()], fetchCalendarObjects: (params) => wrapped.fetchCalendarObjects({
      ...params, fetch: async () => { requests++; return new Response(davListing(), { status: 207, headers: { 'Content-Type': 'application/xml' } }); },
    }) };
    await caldavSync.sync({ createClient: async () => client });
    assert.equal(requests, 1);
    assert.equal(operation(f.operationId).payload.reload_readback_pending, false);
    if (newer) {
      const retained = (await call('GET', '/' + f.continuationId)).body.data;
      assert.equal(retained.sync.failure_kind, 'recovery_occurrence_missing');
      assert.equal(retained.sync.retryable, false);
      assert.equal(retained.title, 'Retained after resource removal');
    } else assert.equal(row(f.continuationId), undefined);
  });
}

test('REC07 mixed valid and skipped VEVENT cannot prove uncertain resource absent', async () => {
  reset(); const f = await uncertainDeletedResource();
  const objects = [...f.objects.values()];
  const mixed = { ...objects[0], data: objects[0].data.replace('END:VCALENDAR',
    'BEGIN:VEVENT\r\nUID:' + f.absentUid + '\r\nSUMMARY:Unavailable invalid continuation\r\nEND:VEVENT\r\nEND:VCALENDAR') };
  const skipped = [];
  assert.ok(parseICS(mixed.data, { onSkip: (item) => skipped.push(item) }).length > 0);
  assert.ok(skipped.some((item) => item.uid === f.absentUid));
  await caldavSync.sync({ createClient: async () => ({ fetchCalendars: async () => [...f.calendars.values()],
    fetchCalendarObjects: async () => Object.assign([mixed], { complete: true }) }) });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, true);
  assert.ok(row(f.continuationId));
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, false);
  assert.equal(row(f.continuationId), undefined);
});

test('REC07 incomplete continuation components preserve pending identity adoption and local exceptions', async () => {
  reset(); const f = await uncertainDeletedResource();
  // The accepted resource has a valid master but its detached occurrence now
  // lacks DTSTART. This parser omission must not become remote deletion.
  const resource = f.absentObject;
  const components = resource.data.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g);
  assert.ok(components.length > 1);
  const detached = components.find((item) => item.includes('RECURRENCE-ID'));
  assert.ok(detached);
  const partial = { ...resource, data: resource.data.replace(detached, detached.replace(/^DTSTART[^\r\n]*\r?\n/m, '')) };
  const skipped = [];
  assert.ok(parseICS(partial.data, { onSkip: (item) => skipped.push(item) }).some((item) => item.uid === f.absentUid));
  assert.equal(skipped.length, 1);
  const before = row(f.exceptionId);
  const client = { fetchCalendars: async () => [...f.calendars.values()],
    fetchCalendarObjects: async () => Object.assign([...f.objects.values(), partial], { complete: true }) };
  await caldavSync.sync({ createClient: async () => client });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, true);
  assert.deepEqual(row(f.exceptionId), before);
  assert.ok(row(f.continuationId));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE external_calendar_id=?').get(f.absentUid).n, 0);
  f.objects.set(f.absentUid, resource);
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, false);
  assert.equal(row(f.continuationId).external_calendar_id, f.absentUid);
  assert.ok(row(f.exceptionId).external_calendar_id.startsWith(f.absentUid + '::'));
});

test('REC07/08 absence and local discard roll back faults and stay retired after disposable reopen', async () => {
  reset(); const f = await uncertainDeletedResource({ newer: true });
  await inboundCalDAV(f, { beforeRetry: false });
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const directory = await mkdtemp(join(tmpdir(), 'yuvomi-recovery-discard-'));
  const path = join(directory, 'disposable.sqlite'); const originalDb = db;
  await db.backup(path); let reopened = new Database(path);
  try {
    db = reopened; dbmod._setTestDatabase(db);
    db.exec(`CREATE TRIGGER discard_fault BEFORE DELETE ON calendar_events WHEN OLD.id = ${f.continuationId}
      BEGIN SELECT RAISE(ABORT, 'discard fault'); END;`);
    assert.equal((await call('POST', '/' + f.continuationId + '/discard-recovery', {})).status, 500);
    assert.equal(operation(f.newerId).resolution, null); assert.ok(row(f.continuationId));
    db.exec('DROP TRIGGER discard_fault');
    assert.equal((await call('POST', '/' + f.continuationId + '/discard-recovery', {})).status, 200);
    reopened.close(); reopened = new Database(path); db = reopened; dbmod._setTestDatabase(db);
    assert.equal(row(f.continuationId), undefined); assert.equal(operation(f.newerId).resolution, 'discard_unsaved');
    assert.equal((await call('POST', '/' + f.continuationId + '/discard-recovery', {})).status, 200);
    assert.equal(supplementalPending('caldav', db).length, 0);
    assert.equal(completeCalendarEditOperation(f.operationId, { providerUid: 'replayed' }, db, f.stale), false);
    await inboundCalDAV(f, { beforeRetry: false }); assert.ok(row(f.masterId));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n, 0);
  } finally {
    dbmod._resetTestDatabase(); db = originalDb; reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('REC07 absent uncertain resource cleanup fault leaves identities and audit readback atomic', async () => {
  reset(); const f = await uncertainDeletedResource();
  db.exec(`CREATE TRIGGER absent_readback_fault BEFORE DELETE ON calendar_events WHEN OLD.id = ${f.continuationId}
    BEGIN SELECT RAISE(ABORT, 'absent cleanup fault'); END;`);
  await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, true);
  assert.ok(row(f.continuationId)); assert.ok(row(f.exceptionId)); assert.ok(row(f.masterId));
  db.exec('DROP TRIGGER absent_readback_fault');
  await inboundCalDAV(f, { beforeRetry: false }); await inboundCalDAV(f, { beforeRetry: false });
  assert.equal(operation(f.operationId).payload.reload_readback_pending, false);
  assert.equal(row(f.continuationId), undefined); assert.equal(row(f.exceptionId), undefined); assert.ok(row(f.masterId));
});

test('REC06/08 CalDAV present continuation missing a newer edited component offers local discard without resource DELETE', async () => {
  reset(); const f = await uncertainDeletedResource();
  // Restore the fetched resource as a master only. The provider removed the
  // detached component while its local row acquired a newer explicit edit.
  const progress = JSON.parse(operation(f.operationId).progress_json).continuation_master;
  const data = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:' + f.absentUid,
    'SUMMARY:Present authoritative continuation', 'DTSTART;TZID=Europe/Berlin:20350412T110000',
    'DTEND;TZID=Europe/Berlin:20350412T120000', 'RRULE:FREQ=WEEKLY;COUNT=5', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  f.objects.set(f.absentUid, { url: progress.url, data, etag: '"present-only-master"', calendarUrl: f.calendarUrl });
  const edited = await call('PUT', '/' + f.exceptionId, { edit_scope: 'this',
    occurrence_start: row(f.exceptionId).exception_original_start, title: 'Retained missing component',
    expected_revision: (await call('GET', '/' + f.exceptionId)).body.data.revision });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  await inboundCalDAV(f, { beforeRetry: false }); await inboundCalDAV(f, { beforeRetry: false });
  const retained = (await call('GET', '/' + f.exceptionId)).body.data;
  assert.equal(retained.sync.failure_kind, 'recovery_occurrence_missing'); assert.equal(retained.sync.retryable, false);
  assert.equal(retained.title, 'Retained missing component');
  assert.equal(operation(f.operationId).payload.reload_readback_pending, false);
  assert.equal(row(f.continuationId).external_calendar_id, f.absentUid);
  assert.equal((await call('DELETE', '/' + f.exceptionId)).status, 409);
  assert.equal((await call('POST', '/' + f.exceptionId + '/discard-recovery', {})).status, 200);
  assert.equal(row(f.exceptionId), undefined); assert.ok(row(f.continuationId)); assert.ok(row(f.masterId));
  assert.equal(f.objects.get(f.absentUid).data, data);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n, 0);
  await inboundCalDAV(f, { beforeRetry: false }); assert.ok(row(f.continuationId));
});

for (const source of ['google', 'caldav']) {
  for (const scope of ['series', 'following']) {
    test('REC03/05 ' + source + ' ' + scope + ' later-occurrence absolute date keeps original tail cutoff', async () => {
      reset(); const f = await rejectedRecovery(source);
      const child = row(f.continuationId);
      const selected = expandRecurringEvents([child], '2035-04-26', '2035-04-26', null)[0];
      const edit = await call('PUT', '/' + child.id, { ...editorRecoveryBody(child, selected), edit_scope: scope,
        occurrence_start: selected.start_datetime, start_datetime: '2035-04-27T12:00', end_datetime: '2035-04-27T13:00',
        expected_revision: (await call('GET', '/' + child.id)).body.data.revision });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      await call('POST', '/' + child.id + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f);
      const sent = await completeRecovery(source, f);
      assert.equal(sent.length, scope === 'series' ? 1 : 2);
      const last = sent.at(-1);
      const start = source === 'google' ? last.start.dateTime : last.dtstart;
      assert.equal(Date.parse(start), Date.parse((scope === 'series' ? '2035-04-13' : '2035-04-27') + 'T10:00:00Z'));
      const original = expandRecurringEvents([row(f.masterId)], '2035-04-05', '2035-04-11', null);
      assert.equal(original.length, 1);
      assert.equal(original[0].title, source === 'google' ? 'Imported series' : 'Original');
      assert.equal(row(edit.body.data.id).recurrence_rule.includes('COUNT='), true);
    });
  }
  test('REC04 ' + source + ' recovery retains subminimum time instead of clamping', async () => {
    reset(); const f = await rejectedRecovery(source, { newStart: '2035-04-12T08:00', newEnd: '2035-04-12T09:00' });
    const selected = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0];
    const edit = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', edit_action: 'resize',
      occurrence_start: selected.start_datetime, end_datetime: '2035-04-12T09:05',
      expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
    await authoritativeRecovery(source, f);
    const current = (await call('GET', '/' + f.continuationId)).body.data;
    assert.equal(current.sync.failure_kind, 'recovery_invalid_range');
    assert.equal(current.sync.retryable, false);
    assert.equal(current.sync.recovery.retained_changes.end_datetime, '2035-04-12T09:05');
    assert.equal((await completeRecovery(source, f)).length, 0);
  });
}

for (const source of ['google', 'caldav']) {
  test('REC01/05/06 ' + source + ' assignment-only recovery exposes deliberate retained assignments', async () => {
    reset(); const f = await rejectedRecovery(source);
    const slot = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0];
    const edit = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', occurrence_start: slot.start_datetime,
      assigned_to: [userId], expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
    assert.equal(edit.status, 200);
    assert.deepEqual(operation(edit.body.edit.operation_ids[0]).payload.edit_intent.fields, {});
    await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
    assert.deepEqual((await call('GET', '/' + f.continuationId)).body.data.sync.recovery.retained_changes, { assigned_to: [userId] });
    await authoritativeRecovery(source, f, { count: 1 });
    const retained = (await call('GET', '/' + f.continuationId)).body.data;
    assert.equal(retained.sync.failure_kind, 'recovery_occurrence_missing');
    assert.deepEqual(retained.sync.recovery.retained_changes, { assigned_to: [userId] });
    assert.equal((await call('PUT', '/' + f.continuationId, { title: 'Legacy must not overwrite retained intent' })).status, 409);
    assert.equal((await call('POST', '/' + f.continuationId + '/discard-recovery', {})).status, 200);
    assert.ok(row(f.masterId)); assert.equal((await completeRecovery(source, f)).length, 0);
  });
}

test('REC04/05 CalDAV all-day rollback keeps absolute resized date and rejects inverted authoritative range', async () => {
  reset(); const f = await rejectedRecovery('caldav', { allDay: true, newStart: '2035-04-13', newEnd: '2035-04-15' });
  const selected = expandRecurringEvents([row(f.continuationId)], '2035-04-13', '2035-04-13', null)[0];
  const edit = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', edit_action: 'resize',
    occurrence_start: selected.start_datetime, start_datetime: '2035-04-14', end_datetime: '2035-04-15',
    expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
  await authoritativeRecovery('caldav', f);
  const current = (await call('GET', '/' + f.continuationId)).body.data;
  assert.equal(current.sync.failure_kind, 'recovery_invalid_range');
  assert.equal(current.sync.recovery.retained_changes.start_datetime, '2035-04-14');
  assert.equal(current.sync.retryable, false); assert.equal((await completeRecovery('caldav', f)).length, 0);
});

function editorRecoveryBody(child, selected) {
  return { title: child.title, description: child.description ?? '', location: child.location ?? '',
    start_datetime: selected.start_datetime, end_datetime: selected.end_datetime, all_day: child.all_day,
    recurrence_rule: child.recurrence_rule, color: child.color ?? null, icon: child.icon,
    visibility: child.visibility || 'all', countdown: child.countdown || 0, assigned_to: [],
    target_google_calendar_id: child.target_google_calendar_id ?? null,
    target_caldav_account_id: child.target_caldav_account_id ?? null, target_caldav_calendar_url: child.target_caldav_calendar_url ?? null,
    target_outlook_account_id: child.target_outlook_account_id ?? null, target_outlook_calendar_id: child.target_outlook_calendar_id ?? null };
}

async function authoritativeRecovery(source, f, { title = null, description = null, location = null, count = 6, startHour = 9, endHour = 10 } = {}) {
  if (source === 'google') {
    googleCalendarTest.upsertGoogleEvents([{ ...masterItem('followup-master', {
      title: title || 'Imported series', etag: '"recovery-current"', rule: 'FREQ=WEEKLY;COUNT=' + count,
      start: '2035-04-05T' + String(startHour - 2).padStart(2, '0') + ':00:00Z',
      end: '2035-04-05T' + String(endHour - 2).padStart(2, '0') + ':00:00Z' }), description, location }], f.calendarRefId);
  } else {
    const current = f.objects.get(f.uid);
    const data = current.data.replace(/^SUMMARY:[^\r\n]*/m, 'SUMMARY:' + (title || 'Original'))
      .replace('COUNT=6', 'COUNT=' + count)
      .replace('20350405T090000', '20350405T' + String(startHour).padStart(2, '0') + '0000')
      .replace('20350405T100000', '20350405T' + String(endHour).padStart(2, '0') + '0000')
      .replace('END:VEVENT', (description ? 'DESCRIPTION:' + description + '\r\n' : '')
        + (location ? 'LOCATION:' + location + '\r\n' : '') + 'END:VEVENT');
    f.objects.set(f.uid, { ...current, data, etag: '"recovery-current"' });
    await inboundCalDAV(f, { beforeRetry: false });
  }
}

async function completeRecovery(source, f) {
  const sent = [];
  if (source === 'google') {
    let inserted = 0;
    const provider = writableCalendar({ calendarId: f.calendarId, onInsert: (params) => {
      sent.push(params.requestBody);
      return { data: { ...params.requestBody, id: 'recovery-' + (++inserted), etag: '"accepted"' } };
    } });
    await googleCalendarTest.processScopedOperations(provider, new Map());
    await googleCalendarTest.processScopedOperations(provider, new Map());
  } else {
    const provider = { updateCalendarObject: async ({ calendarObject }) => {
      const uid = parseICS(calendarObject.data)[0].uid;
      f.objects.set(uid, { ...f.objects.get(uid), ...calendarObject, etag: '"accepted"' });
      return { etag: '"accepted"' };
    }, createCalendarObject: async ({ filename, iCalString }) => {
      sent.push(parseICS(iCalString)[0]);
      const uid = parseICS(iCalString)[0].uid;
      f.objects.set(uid, { url: f.calendarUrl + filename, data: iCalString, etag: '"accepted"', calendarUrl: f.calendarUrl });
      return { etag: '"accepted"' };
    } };
    await pushCalDAV(provider, f); await pushCalDAV(provider, f);
  }
  return sent;
}

for (const source of ['google', 'caldav']) {
  for (const form of ['minimal', 'editor']) {
    test('REC01/05 ' + source + ' ' + form + ' later-tail title preserves independent fields and shortened count', async () => {
      reset(); const f = await rejectedRecovery(source);
      const child = row(f.continuationId);
      const selected = expandRecurringEvents([child], '2035-04-26', '2035-04-26', null)[0];
      const newer = await call('PUT', '/' + child.id, { ...(form === 'editor' ? editorRecoveryBody(child, selected) : {}),
        edit_scope: 'following', occurrence_start: selected.start_datetime, title: 'Latest title only',
        expected_revision: (await call('GET', '/' + child.id)).body.data.revision });
      assert.equal(newer.status, 200, JSON.stringify(newer.body));
      const newerId = newer.body.edit.operation_ids[0];
      assert.deepEqual(operation(newerId).payload.edit_intent.fields, { title: 'Latest title only' });
      await call('POST', '/' + child.id + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f, { description: 'Remote description', location: 'Remote location', count: 4 });
      const sent = await completeRecovery(source, f);
      assert.equal(sent.length, 2);
      const final = row(newer.body.data.id);
      assert.equal(final.title, 'Latest title only');
      assert.equal(final.description, 'Remote description'); assert.equal(final.location, 'Remote location');
      assert.match(final.recurrence_rule, /COUNT=1(?:;|$)/);
      const last = sent.at(-1);
      if (source === 'google') assert.equal(Date.parse(last.start.dateTime), Date.parse('2035-04-26T07:00:00Z'));
      else assert.equal(last.dtstart, '2035-04-26T07:00:00Z');
      assert.equal(operation(newerId).status, 'completed');
    });
  }
  for (const scenario of [
    { name: 'body move', action: 'move', start: '12:00', end: '13:00', expectedStart: '12:00', expectedEnd: '13:00' },
    { name: 'manual editor move', full: true, start: '12:00', end: '13:00', expectedStart: '12:00', expectedEnd: '13:00' },
    { name: 'resize end', action: 'resize', end: '13:00', expectedStart: '09:00', expectedEnd: '13:00' },
    { name: 'resize start', action: 'resize', start: '09:30', expectedStart: '09:30', expectedEnd: '10:00' },
    { name: 'drag after failed duration resize', action: 'move', firstStart: '09:00', firstEnd: '11:00', start: '12:00', end: '14:00', expectedStart: '12:00', expectedEnd: '14:00' },
  ]) {
    test('REC02/03/04 ' + source + ' ' + scenario.name + ' keeps absolute targets after rollback', async () => {
      reset(); const f = await rejectedRecovery(source, scenario.firstStart ? {
        newStart: '2035-04-12T' + scenario.firstStart, newEnd: '2035-04-12T' + scenario.firstEnd } : {});
      const child = row(f.continuationId);
      const selected = expandRecurringEvents([child], '2035-04-12', '2035-04-12', null)[0];
      const newer = await call('PUT', '/' + child.id, { ...(scenario.full ? editorRecoveryBody(child, selected) : {}),
        edit_scope: 'series', occurrence_start: selected.start_datetime,
        ...(scenario.action ? { edit_action: scenario.action } : {}),
        ...(scenario.start ? { start_datetime: '2035-04-12T' + scenario.start } : {}),
        ...(scenario.end ? { end_datetime: '2035-04-12T' + scenario.end } : {}),
        expected_revision: (await call('GET', '/' + child.id)).body.data.revision });
      assert.equal(newer.status, 200, JSON.stringify(newer.body));
      await call('POST', '/' + child.id + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f);
      assert.notEqual((await call('GET', '/' + child.id)).body.data.sync.failure_kind, 'recovery_field_conflict', 'Rollback is not an external conflict');
      const sent = await completeRecovery(source, f);
      assert.equal(sent.length, 1);
      const start = source === 'google' ? sent[0].start.dateTime : sent[0].dtstart;
      const end = source === 'google' ? sent[0].end.dateTime : sent[0].dtend;
      assert.equal(Date.parse(start), Date.parse('2035-04-12T' + String(Number(scenario.expectedStart.slice(0, 2)) - 2).padStart(2, '0') + scenario.expectedStart.slice(2) + ':00Z'));
      assert.equal(Date.parse(end), Date.parse('2035-04-12T' + String(Number(scenario.expectedEnd.slice(0, 2)) - 2).padStart(2, '0') + scenario.expectedEnd.slice(2) + ':00Z'));
    });
  }
}

async function newerRecoveryFields(f, fields) {
  const selected = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0];
  const result = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', occurrence_start: selected.start_datetime,
    ...fields, expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.edit.operation_ids[0];
}

async function captureRecoveryDisplay(name, event) {
  if (!process.env.RECOVERY_TIME_METADATA) return;
  const { readFileSync, existsSync, writeFileSync } = await import('node:fs');
  const path = process.env.RECOVERY_TIME_METADATA;
  const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  recorded[name] = event;
  writeFileSync(path, JSON.stringify(recorded, null, 2));
}

test('REC-STD-01 all-day conflict exposes exact DATE boundaries for recovery presentation', async () => {
  reset(); const f = await rejectedRecovery('caldav', { allDay: true, newStart: '2035-04-13', newEnd: '2035-04-15' });
  const selected = expandRecurringEvents([row(f.continuationId)], '2035-04-13', '2035-04-13', null)[0];
  const edit = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', edit_action: 'move', occurrence_start: selected.start_datetime,
    start_datetime: '2035-04-20', end_datetime: '2035-04-22',
    expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
  const object = f.objects.get(f.uid);
  f.objects.set(f.uid, { ...object, data: object.data.replace('DTEND;VALUE=DATE:20350406', 'DTEND;VALUE=DATE:20350407'), etag: '"all-day-provider-change"' });
  await inboundCalDAV(f, { beforeRetry: false });
  const retained = (await call('GET', '/' + f.continuationId)).body.data;
  assert.equal(retained.sync.failure_kind, 'recovery_field_conflict');
  assert.equal(retained.all_day, 1);
  assert.deepEqual(retained.sync.recovery.retained_changes, { start_datetime: '2035-04-20', end_datetime: '2035-04-22' });
  assert.deepEqual(retained.sync.recovery.conflicts.map((item) => item.field), ['end_datetime']);
  await captureRecoveryDisplay('allDay', retained);
  await resolveFieldConflicts(f.continuationId, 'local');
  assert.equal((await completeRecovery('caldav', f)).length, 1);
  assert.equal(row(f.continuationId).start_datetime, '2035-04-20');
  assert.equal(row(f.continuationId).end_datetime, '2035-04-22');
});

for (const source of ['google', 'caldav']) {
  for (const choice of ['local', 'provider']) {
    test('REC-SPEC-02 ' + source + ' title then independent location keeps actionable ' + choice + ' choice', async () => {
      reset(); const f = await rejectedRecovery(source);
      const titleId = await newerRecoveryFields(f, { title: 'Newer title C' });
      const locationId = await newerRecoveryFields(f, { location: 'Independent location X' });
      await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f, { title: 'Provider title D' });
      const retained = (await call('GET', '/' + f.continuationId)).body.data;
      assert.equal(retained.sync.failure_kind, 'recovery_field_conflict');
      assert.equal(retained.sync.operation_id, titleId);
      assert.deepEqual(retained.sync.recovery.retained_changes, { title: 'Newer title C', location: 'Independent location X' });
      assert.deepEqual(retained.sync.recovery.conflicts.map((item) => item.field), ['title']);
      const intents = [titleId, locationId].map((id) => operation(id).payload.edit_intent);
      await authoritativeRecovery(source, f, { title: 'Provider title D' });
      assert.deepEqual([titleId, locationId].map((id) => operation(id).payload.edit_intent), intents);
      assert.deepEqual((await call('GET', '/' + f.continuationId)).body.data.sync.recovery.retained_changes,
        retained.sync.recovery.retained_changes, 'Inspection/cancel must preserve both edits');
      await resolveFieldConflicts(f.continuationId, choice);
      assert.equal((await completeRecovery(source, f)).length, 1);
      assert.equal(row(f.continuationId).title, choice === 'local' ? 'Newer title C' : 'Provider title D');
      assert.equal(row(f.continuationId).location, 'Independent location X');
      for (const id of [titleId, locationId]) assert.equal(operation(id).resolution, 'replaced_after_reload');
    });
    test('REC-SPEC-02 ' + source + ' superseded title uses latest ' + choice + ' value without replay', async () => {
      reset(); const f = await rejectedRecovery(source);
      const oldTitleId = await newerRecoveryFields(f, { title: 'Superseded title C' });
      const latestTitleId = await newerRecoveryFields(f, { title: 'Latest title E' });
      await newerRecoveryFields(f, { location: 'Independent location X' });
      await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f, { title: 'Provider title D' });
      const retained = (await call('GET', '/' + f.continuationId)).body.data;
      assert.equal(retained.sync.operation_id, latestTitleId);
      assert.equal(retained.sync.recovery.conflicts.length, 1);
      assert.equal(retained.sync.recovery.conflicts[0].local, 'Latest title E');
      assert.equal(retained.sync.recovery.retained_changes.title, 'Latest title E');
      assert.notEqual(operation(oldTitleId).failure_kind, 'recovery_field_conflict');
      await resolveFieldConflicts(f.continuationId, choice);
      assert.equal((await completeRecovery(source, f)).length, 1);
      assert.equal(row(f.continuationId).title, choice === 'local' ? 'Latest title E' : 'Provider title D');
      assert.equal(row(f.continuationId).location, 'Independent location X');
    });
  }
  test('REC-SPEC-02 ' + source + ' partial choice leaves another operation conflict actionable', async () => {
    reset(); const f = await rejectedRecovery(source);
    const titleId = await newerRecoveryFields(f, { title: 'Newer title C' });
    const locationId = await newerRecoveryFields(f, { location: 'Newer location X' });
    await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
    await authoritativeRecovery(source, f, { title: 'Provider title D', location: 'Provider location Y', description: 'Independent provider description' });
    const initial = (await call('GET', '/' + f.continuationId)).body.data;
    assert.equal(initial.sync.failure_kind, 'recovery_field_conflict');
    assert.deepEqual(initial.sync.recovery.conflicts.map((item) => item.field).sort(), ['location', 'title']);
    assert.deepEqual(initial.sync.recovery.retained_changes, { title: 'Newer title C', location: 'Newer location X' });
    assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', { operation_id: initial.sync.operation_id,
      choices: { title: 'local' }, expected_revision: initial.sync.recovery.authoritative_revision })).status, 200);
    const remaining = (await call('GET', '/' + f.continuationId)).body.data;
    assert.equal(remaining.sync.operation_id, locationId);
    assert.equal(remaining.sync.failure_kind, 'recovery_field_conflict');
    assert.deepEqual(remaining.sync.recovery.conflicts.map((item) => item.field), ['location']);
    assert.equal(operation(titleId).payload.recovery_choices.title, 'local');
    assert.equal(operation(titleId).resolution, null);
    assert.deepEqual((await call('GET', '/' + f.continuationId)).body.data.sync.recovery, remaining.sync.recovery);
    await resolveFieldConflicts(f.continuationId, 'provider');
    assert.equal((await completeRecovery(source, f)).length, 1);
    assert.equal(row(f.continuationId).title, 'Newer title C');
    assert.equal(row(f.continuationId).location, 'Provider location Y');
    assert.equal(row(f.continuationId).description, 'Independent provider description');
    if (source === 'caldav' && process.env.RECOVERY_MULTI_METADATA) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.RECOVERY_MULTI_METADATA, JSON.stringify({ initial, remaining }, null, 2));
    }
  });
  for (const refreshedTitle of ['local', 'base']) for (const choice of ['local', 'provider']) {
    test('REC-SPEC-03 ' + source + ' refreshed title matching ' + refreshedTitle + ' leaves only location for ' + choice, async () => {
      reset(); const f = await rejectedRecovery(source);
      const originalTitle = row(f.masterId).title;
      const titleId = await newerRecoveryFields(f, { title: 'Newer title C' });
      const locationId = await newerRecoveryFields(f, { location: 'Newer location X' });
      await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f, { title: 'Provider title D', location: 'Provider location Y', description: 'Independent provider description' });
      const initial = (await call('GET', '/' + f.continuationId)).body.data;
      assert.deepEqual(initial.sync.recovery.conflicts.map((item) => item.field).sort(), ['location', 'title']);
      const nextTitle = refreshedTitle === 'local' ? 'Newer title C' : originalTitle;
      await authoritativeRecovery(source, f, { title: nextTitle, location: 'Provider location Y', description: 'Independent provider description' });
      const authoritative = (await call('GET', '/' + f.masterId)).body.data;
      assert.equal(authoritative.title, nextTitle);
      assert.notEqual(authoritative.revision, initial.sync.recovery.authoritative_revision);
      let remaining = (await call('GET', '/' + f.continuationId)).body.data;
      assert.equal(remaining.sync.operation_id, locationId);
      assert.deepEqual(remaining.sync.recovery.conflicts.map((item) => item.field), ['location']);
      assert.equal(remaining.sync.recovery.authoritative_revision, authoritative.revision);
      assert.deepEqual(remaining.sync.recovery.retained_changes, { title: 'Newer title C', location: 'Newer location X' });
      assert.equal(operation(titleId).payload.recovery, null);
      assert.equal(operation(titleId).failure_kind, null);
      assert.equal(operation(titleId).resolution, null);
      const beforeStale = [operation(titleId), operation(locationId), row(f.continuationId)];
      assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', { operation_id: initial.sync.operation_id,
        choices: { title: 'provider', location: choice }, expected_revision: initial.sync.recovery.authoritative_revision })).status, 409);
      assert.deepEqual([operation(titleId), operation(locationId), row(f.continuationId)], beforeStale);
      await authoritativeRecovery(source, f, { title: nextTitle, location: 'Provider location Y', description: 'Independent provider description' });
      const repeated = (await call('GET', '/' + f.continuationId)).body.data;
      assert.deepEqual({ ...repeated.sync.recovery, authoritative_revision: null },
        { ...remaining.sync.recovery, authoritative_revision: null });
      const repeatedAuthoritative = (await call('GET', '/' + f.masterId)).body.data;
      assert.equal(repeated.sync.recovery.authoritative_revision, repeatedAuthoritative.revision);
      const beforeRepeatedStale = [operation(titleId), operation(locationId), row(f.continuationId)];
      assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', { operation_id: initial.sync.operation_id,
        choices: { title: 'provider' }, expected_revision: initial.sync.recovery.authoritative_revision })).status, 409);
      assert.deepEqual([operation(titleId), operation(locationId), row(f.continuationId)], beforeRepeatedStale);
      remaining = repeated;
      assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', { operation_id: remaining.sync.operation_id,
        choices: { location: choice }, expected_revision: remaining.sync.recovery.authoritative_revision })).status, 200);
      const sent = await completeRecovery(source, f);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].summary, 'Newer title C');
      assert.equal(supplementalPending(source, db).length, 0);
      assert.equal(row(f.continuationId).title, 'Newer title C');
      assert.equal(row(f.continuationId).location, choice === 'local' ? 'Newer location X' : 'Provider location Y');
      assert.equal(row(f.continuationId).description, 'Independent provider description');
      assert.equal(operation(titleId).resolution, 'replaced_after_reload');
      assert.equal(operation(locationId).resolution, 'replaced_after_reload');
      if (source === 'caldav' && refreshedTitle === 'local' && choice === 'provider' && process.env.RECOVERY_REFRESH_METADATA) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(process.env.RECOVERY_REFRESH_METADATA, JSON.stringify({ initial, remaining,
          authoritative: repeatedAuthoritative }, null, 2));
      }
    });
  }
  test('REC-SPEC-02 ' + source + ' latest title matching provider suppresses superseded conflict', async () => {
    reset(); const f = await rejectedRecovery(source);
    await newerRecoveryFields(f, { title: 'Superseded title C' });
    await newerRecoveryFields(f, { title: 'Matching latest title E' });
    await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
    await authoritativeRecovery(source, f, { title: 'Matching latest title E' });
    assert.notEqual((await call('GET', '/' + f.continuationId)).body.data.sync.failure_kind, 'recovery_field_conflict');
    assert.equal((await completeRecovery(source, f)).length, 1);
    assert.equal(row(f.continuationId).title, 'Matching latest title E');
  });
  for (const scenario of [
    { first: 'local', changed: true, again: 'local' },
    { first: 'local', changed: true, again: 'provider' },
    { first: 'local', changed: false },
    { first: 'provider', changed: true },
  ]) {
    test('REC-SPEC-02 ' + source + ' partial ' + scenario.first + ' choice follows fresh provider title changed=' + scenario.changed + ' again=' + (scenario.again || 'none'), async () => {
      reset(); const f = await rejectedRecovery(source);
      const titleId = await newerRecoveryFields(f, { title: 'Local title C' });
      await newerRecoveryFields(f, { location: 'Local location X' });
      await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f, { title: 'Provider title D', location: 'Provider location Y' });
      const first = (await call('GET', '/' + f.continuationId)).body.data.sync;
      assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', { operation_id: first.operation_id,
        choices: { title: scenario.first }, expected_revision: first.recovery.authoritative_revision })).status, 200);
      const nextTitle = scenario.changed ? 'New provider title F' : 'Provider title D';
      await authoritativeRecovery(source, f, { title: nextTitle, location: 'Provider location Y' });
      assert.equal(row(f.masterId).title, nextTitle);
      const fresh = (await call('GET', '/' + f.continuationId)).body.data.sync;
      assert.equal(fresh.failure_kind, 'recovery_field_conflict');
      assert.deepEqual(fresh.recovery.conflicts.map((item) => item.field).sort(), scenario.again ? ['location', 'title'] : ['location']);
      if (scenario.again) {
        const title = fresh.recovery.conflicts.find((item) => item.field === 'title');
        assert.equal(title.local, 'Local title C'); assert.equal(title.provider, nextTitle);
        assert.equal(operation(titleId).resolution, null);
      }
      const choices = { location: 'local', ...(scenario.again ? { title: scenario.again } : {}) };
      assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', { operation_id: fresh.operation_id,
        choices, expected_revision: fresh.recovery.authoritative_revision })).status, 200);
      assert.equal((await completeRecovery(source, f)).length, 1);
      assert.equal(row(f.continuationId).title, scenario.first === 'provider' || scenario.again === 'provider' ? nextTitle : 'Local title C');
      assert.equal(row(f.continuationId).location, 'Local location X');
    });
  }
}

for (const source of ['google', 'caldav']) {
  for (const choice of ['local', 'provider']) {
    test('REC02 ' + source + ' genuine title conflict cancels safely then keeps ' + choice, async () => {
      reset(); const f = await rejectedRecovery(source);
      const selected = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0];
      const newer = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', occurrence_start: selected.start_datetime,
        title: 'Latest deliberate title', expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
      assert.equal(newer.status, 200);
      await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
      await authoritativeRecovery(source, f, { title: 'Genuine remote title', description: 'Independent remote description' });
      const retained = (await call('GET', '/' + f.continuationId)).body.data;
      assert.equal(retained.sync.failure_kind, 'recovery_field_conflict');
      assert.deepEqual(retained.sync.recovery.conflicts.map((item) => item.field), ['title']);
      assert.equal(retained.sync.recovery.conflicts[0].local, 'Latest deliberate title');
      assert.equal(retained.sync.recovery.conflicts[0].provider, 'Genuine remote title');
      const before = operation(newer.body.edit.operation_ids[0]).payload.edit_intent;
      // Cancellation makes no request; provider passes and repeated inbound
      // leave the durable conflict and retained local data untouched.
      await completeRecovery(source, f);
      await authoritativeRecovery(source, f, { title: 'Genuine remote title', description: 'Independent remote description' });
      assert.equal(row(f.continuationId).title, 'Latest deliberate title');
      assert.deepEqual(operation(newer.body.edit.operation_ids[0]).payload.edit_intent, before);
      assert.equal(operation(newer.body.edit.operation_ids[0]).resolution, null);
      const parent = (await call('GET', '/' + f.masterId)).body.data;
      assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', {
        operation_id: retained.sync.operation_id, choices: {}, expected_revision: parent.revision })).status, 400);
      assert.equal((await call('POST', '/' + f.continuationId + '/resolve-recovery', {
        operation_id: retained.sync.operation_id, choices: { title: choice }, expected_revision: 'stale' })).status, 409);
      await resolveFieldConflicts(f.continuationId, choice);
      const sent = await completeRecovery(source, f);
      assert.equal(sent.length, 1);
      assert.equal(row(f.continuationId).title, choice === 'local' ? 'Latest deliberate title' : 'Genuine remote title');
      assert.equal(row(f.continuationId).description, 'Independent remote description');
    });
  }
  test('REC02/03 ' + source + ' genuine external duration asks before retaining full drag interval', async () => {
    reset(); const f = await rejectedRecovery(source, { newStart: '2035-04-12T09:00', newEnd: '2035-04-12T11:00' });
    const slot = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0];
    const newer = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', edit_action: 'move', occurrence_start: slot.start_datetime,
      start_datetime: '2035-04-12T12:00', end_datetime: '2035-04-12T14:00',
      expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
    assert.equal(newer.status, 200);
    await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
    await authoritativeRecovery(source, f, { endHour: 11 });
    const sync = (await call('GET', '/' + f.continuationId)).body.data.sync;
    assert.equal(sync.failure_kind, 'recovery_field_conflict');
    assert.deepEqual(sync.recovery.conflicts.map((item) => item.field), ['end_datetime']);
    if (source === 'caldav') await captureRecoveryDisplay('timed', (await call('GET', '/' + f.continuationId)).body.data);
    await resolveFieldConflicts(f.continuationId);
    const sent = await completeRecovery(source, f);
    assert.equal(sent.length, 1);
    assert.equal(Date.parse(source === 'google' ? sent[0].start.dateTime : sent[0].dtstart), Date.parse('2035-04-12T10:00:00Z'));
    assert.equal(Date.parse(source === 'google' ? sent[0].end.dateTime : sent[0].dtend), Date.parse('2035-04-12T12:00:00Z'));
  });
  test('REC04/08 ' + source + ' invalid recovered resize remains actionable and discard never deletes provider parent', async () => {
    reset(); const f = await rejectedRecovery(source, { newStart: '2035-04-12T11:00', newEnd: '2035-04-12T14:00' });
    const selected = expandRecurringEvents([row(f.continuationId)], '2035-04-12', '2035-04-12', null)[0];
    const resized = await call('PUT', '/' + f.continuationId, { edit_scope: 'series', edit_action: 'resize', occurrence_start: selected.start_datetime,
      start_datetime: '2035-04-12T13:00',
      expected_revision: (await call('GET', '/' + f.continuationId)).body.data.revision });
    assert.equal(resized.status, 200);
    await call('POST', '/' + f.continuationId + '/reload-sync', { operation_id: f.operationId });
    await authoritativeRecovery(source, f);
    const current = (await call('GET', '/' + f.continuationId)).body.data;
    assert.equal(current.sync.failure_kind, 'recovery_invalid_range');
    assert.equal(current.sync.retryable, false);
    assert.deepEqual(current.sync.recovery.retained_changes, { start_datetime: '2035-04-12T13:00' });
    assert.equal((await call('DELETE', '/' + f.continuationId)).status, 409);
    assert.equal((await call('POST', '/' + f.continuationId + '/discard-recovery', {})).status, 200);
    assert.ok(row(f.masterId)); assert.equal(row(f.continuationId), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n, 0);
    assert.equal(operation(resized.body.edit.operation_ids[0]).resolution, 'discard_unsaved');
    assert.equal((await call('POST', '/' + f.continuationId + '/discard-recovery', {})).status, 200);
    assert.equal((await completeRecovery(source, f)).length, 0);
  });
}
