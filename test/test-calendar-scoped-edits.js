/** Server-authoritative recurring calendar scope and revision routes. */

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { expandRecurringEvents, loadEventExceptions } = await import('../server/services/calendar-events.js');
const {
  activeCalendarEditOperations,
  claimCalendarEditOperation,
  completeCalendarEditOperation,
  failCalendarEditOperation,
} = await import('../server/services/calendar-edit-operations.js');
const { __test: googleCalendarTest } = await import('../server/services/google-calendar.js');
const caldavSync = await import('../server/services/caldav-sync.js');
const { __test: caldavCalendarTest } = caldavSync;
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const db = dbmod.get();

const user = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('scope', 'Scope', 'x', 'admin')"
).run().lastInsertRowid);
const otherUser = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('scope-other', 'Scope Other', 'x', 'member')"
).run().lastInsertRowid);

const app = express();
app.use((req, _res, next) => {
  req.authUserId = user;
  req.authRole = 'admin';
  req.session = { userId: user, role: 'admin' };
  next();
});
app.use(express.json());
app.use('/', calendarRouter);
const server = app.listen(0);
const base = await new Promise((resolve) => server.on('listening', () =>
  resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.headers.get('content-type')?.includes('json')
    ? await response.json() : null;
  return { status: response.status, body: json };
}

function series(title, rule = 'FREQ=WEEKLY;COUNT=4') {
  return Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, recurrence_rule, created_by, visibility)
    VALUES (?, '2030-01-07T09:00', '2030-01-07T10:00', 0, ?, ?, 'all')
  `).run(title, rule, user).lastInsertRowid);
}

test('scoped this creates a detached occurrence and reports metadata', async () => {
  const id = series('scope-this');
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: '2030-01-14T09:00',
    expected_revision: before.revision,
    start_datetime: '2030-01-14T11:00', end_datetime: '2030-01-14T12:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.edit.operation_ids, []);
  assert.equal(response.body.data.start_datetime, '2030-01-14T11:00');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE exception_of_event_id = ?').get(id).n, 1);
});

test('following keeps a finite COUNT and rejects an unknown occurrence', async () => {
  const id = series('scope-following');
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'following', occurrence_start: '2030-01-14T09:00',
    expected_revision: before.revision,
    start_datetime: '2030-01-14T11:00', end_datetime: '2030-01-14T12:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const rows = db.prepare('SELECT recurrence_rule FROM calendar_events WHERE title = ? ORDER BY id').all('scope-following');
  assert.equal(rows.length, 2);
  assert.match(rows[0].recurrence_rule, /UNTIL=20300113/);
  assert.equal(rows[1].recurrence_rule, 'FREQ=WEEKLY;COUNT=3');
  const expanded = expandRecurringEvents(
    db.prepare('SELECT * FROM calendar_events WHERE title = ? ORDER BY id').all('scope-following'),
    '2030-01-01',
    '2030-02-28',
    loadEventExceptions(db, db.prepare('SELECT id FROM calendar_events WHERE title = ?').all('scope-following').map((row) => row.id)),
  );
  assert.equal(expanded.length, 4, 'finite COUNT must not be extended by the split');

  const stale = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: '2030-01-21T09:00',
    expected_revision: before.revision, start_datetime: '2030-01-21T10:00',
  });
  assert.equal(stale.status, 409);

  const unknown = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: '2030-03-18T09:00',
    expected_revision: (await call('GET', `/${id}`)).body.data.revision,
    start_datetime: '2030-03-18T10:00',
  });
  assert.equal(unknown.status, 400);
});

test('following at the first occurrence keeps the complete finite series', async () => {
  const id = series('scope-following-first');
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'following', occurrence_start: '2030-01-07T09:00',
    expected_revision: before.revision,
    start_datetime: '2030-01-07T11:00', end_datetime: '2030-01-07T12:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.id, id);

  const rows = db.prepare(`
    SELECT id, recurrence_rule, exception_of_event_id
    FROM calendar_events WHERE title = ? ORDER BY id
  `).all('scope-following-first');
  assert.deepEqual(rows, [{
    id,
    recurrence_rule: 'FREQ=WEEKLY;COUNT=4',
    exception_of_event_id: null,
  }]);

  const expanded = expandRecurringEvents(
    db.prepare('SELECT * FROM calendar_events WHERE id = ?').all(id),
    '2030-01-01',
    '2030-02-28',
    loadEventExceptions(db, [id]),
  );
  assert.equal(expanded.length, 4, 'first-occurrence following edit must not lose or duplicate occurrences');
});

test('series moves shift explicit weekly weekdays with the civil gesture', async () => {
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, recurrence_rule, created_by, visibility)
    VALUES ('scope-weekday-selector', '2026-09-22T09:00', '2026-09-22T10:00', 0,
            'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4', ?, 'all')
  `).run(user).lastInsertRowid);
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: before.start_datetime,
    expected_revision: before.revision,
    start_datetime: '2026-09-23T09:00', end_datetime: '2026-09-23T10:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.recurrence_rule, 'FREQ=WEEKLY;BYDAY=WE,FR;COUNT=4');
  const occurrences = expandRecurringEvents(
    [db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id)],
    '2026-09-01', '2026-10-10', loadEventExceptions(db, [id]),
  );
  assert.deepEqual(
    occurrences.map((row) => row.start_datetime.slice(0, 16)),
    ['2026-09-23T09:00', '2026-09-25T09:00', '2026-09-30T09:00', '2026-10-02T09:00'],
  );
});

test('following transfers later detached exceptions to the continuation master', async () => {
  const id = series('scope-following-exception');
  let current = (await call('GET', `/${id}`)).body.data;
  const detached = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: '2030-01-21T09:00',
    expected_revision: current.revision,
    start_datetime: '2030-01-21T13:00', end_datetime: '2030-01-21T14:00',
  });
  assert.equal(detached.status, 200, JSON.stringify(detached.body));
  const detachedId = detached.body.data.id;

  current = (await call('GET', `/${id}`)).body.data;
  const split = await call('PUT', `/${id}`, {
    edit_scope: 'following', occurrence_start: '2030-01-14T09:00',
    expected_revision: current.revision,
    start_datetime: '2030-01-14T11:00', end_datetime: '2030-01-14T12:00',
  });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const continuationId = split.body.data.id;
  assert.equal(
    db.prepare('SELECT exception_of_event_id FROM calendar_events WHERE id = ?').get(detachedId).exception_of_event_id,
    continuationId,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE exception_of_event_id = ?').get(id).n, 0);
});

test('normal PUT rejects a stale opaque revision without changing the row', async () => {
  const id = Number(db.prepare(
    "INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('scope-conflict', '2030-02-01T09:00', ?)"
  ).run(user).lastInsertRowid);
  const before = (await call('GET', `/${id}`)).body.data;
  assert.equal((await call('PUT', `/${id}`, {
    title: 'newer', expected_revision: before.revision,
  })).status, 200);
  const stale = await call('PUT', `/${id}`, {
    title: 'stale', expected_revision: before.revision,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.conflict.expected_revision, before.revision);
  assert.equal((await call('GET', `/${id}`)).body.data.title, 'newer');
});

test('read-only ICS event is rejected before local scoped mutation', async () => {
  const subscription = Number(db.prepare(
    "INSERT INTO ics_subscriptions (name, url, created_by) VALUES ('read-only', 'https://example.invalid/feed.ics', ?)"
  ).run(user).lastInsertRowid);
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, recurrence_rule, external_source, external_calendar_id, subscription_id, created_by)
    VALUES ('scope-ics', '2030-03-04T09:00', 'FREQ=WEEKLY;COUNT=2', 'ics', 'ics-id', ?, ?)
  `).run(subscription, user).lastInsertRowid);
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: '2030-03-04T09:00',
    expected_revision: before.revision, start_datetime: '2030-03-04T10:00',
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'ics_subscription');
  assert.equal(db.prepare('SELECT start_datetime FROM calendar_events WHERE id = ?').get(id).start_datetime, '2030-03-04T09:00');
});

test('remote exception context stays explicitly unknown until a provider baseline exists', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token', 'test-token')").run();
  const calendar = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('google', 'scope-google', 'Scope Google')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, enabled, access_role)
    VALUES ('scope-google', 'Scope Google', 1, 'writer')
  `).run();
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, target_google_calendar_id, created_by)
    VALUES ('scope-remote', '2030-03-11T09:00', '2030-03-11T10:00',
            'FREQ=WEEKLY;COUNT=2', 'google', 'scope-google-event', ?,
            'scope-google', ?)
  `).run(calendar, user).lastInsertRowid);

  let context = (await call('GET', `/${id}/edit-context`)).body.data;
  assert.equal(context.exception_summary.known, false);
  db.prepare('UPDATE calendar_events SET provider_revision = ? WHERE id = ?').run('"v1"', id);
  context = (await call('GET', `/${id}/edit-context`)).body.data;
  assert.equal(context.exception_summary.known, true);
});

test('Apple keeps ordinary editor saves reachable while scoped recurrence is blocked', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('apple_caldav_url', 'https://apple.example/')").run();
  const calendarRef = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('apple', 'https://apple.example/calendar/', 'Apple legacy')
  `).run().lastInsertRowid);
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, provider_revision, created_by)
    VALUES ('Apple ordinary', '2030-03-18T09:00', '2030-03-18T10:00',
            'FREQ=WEEKLY;COUNT=3', 'apple', 'apple-series', ?, '"apple-v1"', ?)
  `).run(calendarRef, user).lastInsertRowid);

  const before = (await call('GET', `/${id}`)).body.data;
  const ordinary = await call('PUT', `/${id}`, {
    title: 'Apple ordinary renamed', expected_revision: before.revision,
  });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.equal(ordinary.body.data.title, 'Apple ordinary renamed');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM calendar_edit_operations WHERE event_id = ?').get(id).count,
    0,
  );

  const scoped = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: before.start_datetime,
    expected_revision: ordinary.body.data.revision, title: 'Should stay blocked',
  });
  assert.equal(scoped.status, 409, JSON.stringify(scoped.body));
  assert.equal(scoped.body.reason, 'provider_scope_unsupported');
  assert.equal(db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(id).title, 'Apple ordinary renamed');

  const recurrenceChange = await call('PUT', `/${id}`, {
    recurrence_rule: 'FREQ=DAILY;COUNT=2',
    expected_revision: (await call('GET', `/${id}`)).body.data.revision,
  });
  assert.equal(recurrenceChange.status, 409, JSON.stringify(recurrenceChange.body));
  assert.equal(recurrenceChange.body.reason, 'provider_scope_unsupported');

  const oneOffId = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, external_source, external_calendar_id,
       calendar_ref_id, provider_revision, created_by)
    VALUES ('Apple one-off', '2030-03-19T09:00', '2030-03-19T10:00', 'apple',
            'apple-one-off', ?, '"apple-one-off-v1"', ?)
  `).run(calendarRef, user).lastInsertRowid);
  const oneOffBefore = (await call('GET', `/${oneOffId}`)).body.data;
  const oneOffAdd = await call('PUT', `/${oneOffId}`, {
    recurrence_rule: 'FREQ=DAILY;COUNT=2', expected_revision: oneOffBefore.revision,
  });
  assert.equal(oneOffAdd.status, 200, JSON.stringify(oneOffAdd.body));
  assert.equal(oneOffAdd.body.data.recurrence_rule, 'FREQ=DAILY;COUNT=2');

  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(oneOffId);
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  db.prepare('DELETE FROM external_calendars WHERE id = ?').run(calendarRef);
  db.prepare("DELETE FROM sync_config WHERE key = 'apple_caldav_url'").run();
});

test('non-recurring this edits and full editor fields stay on the scoped path', async () => {
  const id = Number(db.prepare(
    "INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by, visibility) VALUES ('scope-full', '2030-04-01T09:00', '2030-04-01T10:00', ?, 'all')"
  ).run(user).lastInsertRowid);
  const revision = (await call('GET', `/${id}`)).body.data.revision;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: '2030-04-01T09:00', expected_revision: revision,
    title: 'scope-full-updated', description: 'full form', start_datetime: '2030-04-01T11:00',
    end_datetime: '2030-04-01T12:00', all_day: 0, location: 'Kitchen', color: null,
    icon: 'calendar', visibility: 'all', countdown: 1, recurrence_rule: null,
    assigned_to: [otherUser], target_google_calendar_id: null,
    target_caldav_account_id: null, target_caldav_calendar_url: null,
    target_outlook_account_id: null, target_outlook_calendar_id: null,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.edit.scope, 'this');
  assert.equal(response.body.data.title, 'scope-full-updated');
  assert.equal(response.body.data.countdown, 1);
  assert.deepEqual(
    db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?').all(response.body.data.id),
    [{ user_id: otherUser }],
  );
});

test('scoped edits of a local provider target retain the ordinary outbound marker', async () => {
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, target_google_calendar_id, created_by)
    VALUES ('scope-local-target', '2030-04-15T09:00', '2030-04-15T10:00', 'target-calendar', ?)
  `).run(user).lastInsertRowid);
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: before.start_datetime,
    expected_revision: before.revision,
    start_datetime: '2030-04-15T11:00', end_datetime: '2030-04-15T12:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const row = db.prepare(
    'SELECT external_source, outbound_dirty FROM calendar_events WHERE id = ?'
  ).get(id);
  assert.deepEqual(row, { external_source: 'local', outbound_dirty: 1 });
  assert.equal(response.body.edit.sync.state, 'pending');
});

test('scoped timed and all-day conversion accepts an inclusive one-day range', async () => {
  const id = Number(db.prepare(
    "INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by) VALUES ('scope-convert', '2030-05-01T09:00', '2030-05-01T10:00', 0, ?)"
  ).run(user).lastInsertRowid);
  let current = (await call('GET', `/${id}`)).body.data;
  let response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: current.start_datetime, expected_revision: current.revision,
    start_datetime: '2030-05-02', end_datetime: '2030-05-02', all_day: 1,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.all_day, 1);
  assert.equal(response.body.data.start_datetime, '2030-05-02');
  assert.equal(response.body.data.end_datetime, '2030-05-02');
  current = (await call('GET', `/${id}`)).body.data;
  response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: current.start_datetime, expected_revision: current.revision,
    start_datetime: '2030-05-02T09:00', end_datetime: '2030-05-02T10:00', all_day: 0,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.all_day, 0);
  assert.equal(response.body.data.start_datetime, '2030-05-02T09:00');
});

test('series move from a later occurrence preserves the master duration and exception summary', async () => {
  const id = series('scope-series-move');
  let current = (await call('GET', `/${id}`)).body.data;
  let response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: '2030-01-14T09:00', expected_revision: current.revision,
    start_datetime: '2030-01-14T11:00', end_datetime: '2030-01-14T12:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  current = (await call('GET', `/${id}`)).body.data;
  response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: '2030-01-07T09:00', expected_revision: current.revision,
    start_datetime: '2030-01-07T10:00', end_datetime: '2030-01-07T11:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.start_datetime, '2030-01-07T10:00');
  assert.equal(response.body.data.end_datetime, '2030-01-07T11:00');
  const context = (await call('GET', `/${id}/edit-context`)).body.data;
  assert.equal(context.exception_summary.count, 1);
});

test('scoped editor attachment replacement and removal are transactional', async () => {
  const id = Number(db.prepare(
    "INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('scope-attachment', '2030-06-01T09:00', ?)"
  ).run(user).lastInsertRowid);
  const dataUrl = `data:text/plain;base64,${Buffer.from('scoped attachment').toString('base64')}`;
  let current = (await call('GET', `/${id}`)).body.data;
  let response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: current.start_datetime, expected_revision: current.revision,
    attachment_data: dataUrl, attachment_name: 'scoped.txt', title: 'scope-attachment',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const documentId = response.body.data.attachment_document_id;
  assert.ok(documentId);
  current = (await call('GET', `/${id}`)).body.data;
  response = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: current.start_datetime, expected_revision: current.revision,
    remove_attachment: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.attachment_document_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_documents WHERE id = ?').get(documentId).n, 1);
});

test('scoped full editor can add, change, and remove a recurrence rule', async () => {
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, visibility)
    VALUES ('scope-recurrence-editor', '2030-07-01T09:00', '2030-07-01T10:00', 0, ?, 'all')
  `).run(user).lastInsertRowid);

  let current = (await call('GET', `/${id}`)).body.data;
  let response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: current.start_datetime,
    expected_revision: current.revision,
    recurrence_rule: 'FREQ=WEEKLY;COUNT=3',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.recurrence_rule, 'FREQ=WEEKLY;COUNT=3');

  current = (await call('GET', `/${id}`)).body.data;
  response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: current.start_datetime,
    expected_revision: current.revision,
    recurrence_rule: 'FREQ=DAILY;COUNT=2',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.recurrence_rule, 'FREQ=DAILY;COUNT=2');

  current = (await call('GET', `/${id}`)).body.data;
  response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: current.start_datetime,
    expected_revision: current.revision,
    recurrence_rule: null,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.recurrence_rule, null);
});

test('detached editor metadata resolves this and parent scopes by explicit revisions', async () => {
  const id = series('scope-detached-parent');
  let current = (await call('GET', `/${id}`)).body.data;
  const detachedResponse = await call('PUT', `/${id}`, {
    edit_scope: 'this', occurrence_start: '2030-01-14T09:00',
    expected_revision: current.revision,
    start_datetime: '2030-01-14T11:00', end_datetime: '2030-01-14T12:00',
  });
  assert.equal(detachedResponse.status, 200, JSON.stringify(detachedResponse.body));
  const detachedId = detachedResponse.body.data.id;
  const detached = (await call('GET', `/${detachedId}`)).body.data;
  assert.equal(detached.original_occurrence_start, '2030-01-14T09:00');
  assert.equal(detached.recurrence_parent.id, id);
  assert.equal(detached.recurrence_parent.recurrence_rule, 'FREQ=WEEKLY;COUNT=4');
  assert.deepEqual(detached.edit_capabilities.scopes, { this: true, following: true, series: true });

  const thisEdit = await call('PUT', `/${detachedId}`, {
    edit_scope: 'this', occurrence_start: detached.original_occurrence_start,
    expected_revision: detached.revision, title: 'scope-detached-parent-edited',
  });
  assert.equal(thisEdit.status, 200, JSON.stringify(thisEdit.body));
  assert.equal(thisEdit.body.data.id, detachedId);
  assert.equal(thisEdit.body.data.title, 'scope-detached-parent-edited');

  const parent = (await call('GET', `/${id}`)).body.data;
  const seriesEdit = await call('PUT', `/${detachedId}`, {
    edit_scope: 'series', occurrence_start: detached.original_occurrence_start,
    expected_parent_revision: parent.revision,
    // Match the full editor payload: detached rows expose an empty local
    // recurrence field even though the parent still owns the series rule.
    title: 'scope-detached-parent-series', recurrence_rule: null,
  });
  assert.equal(seriesEdit.status, 200, JSON.stringify(seriesEdit.body));
  assert.equal(seriesEdit.body.data.id, id);
  assert.equal(seriesEdit.body.data.title, 'scope-detached-parent-series');
  assert.equal(seriesEdit.body.data.recurrence_rule, 'FREQ=WEEKLY;COUNT=4');

  const explicitRemovalParent = (await call('GET', `/${id}`)).body.data;
  const explicitRemoval = await call('PUT', `/${detachedId}`, {
    edit_scope: 'series', occurrence_start: detached.original_occurrence_start,
    expected_parent_revision: explicitRemovalParent.revision,
    title: 'scope-detached-parent-series', recurrence_rule: null,
    recurrence_rule_explicit: true,
  });
  assert.equal(explicitRemoval.status, 200, JSON.stringify(explicitRemoval.body));
  assert.equal(explicitRemoval.body.data.recurrence_rule, null);

  const followingId = series('scope-detached-following');
  const followingBefore = (await call('GET', `/${followingId}`)).body.data;
  const detachedFollowing = await call('PUT', `/${followingId}`, {
    edit_scope: 'this', occurrence_start: '2030-01-14T09:00',
    expected_revision: followingBefore.revision,
    start_datetime: '2030-01-14T11:00', end_datetime: '2030-01-14T12:00',
  });
  assert.equal(detachedFollowing.status, 200, JSON.stringify(detachedFollowing.body));
  const followingDetachedId = detachedFollowing.body.data.id;
  const followingParent = (await call('GET', `/${followingId}`)).body.data;
  const following = await call('PUT', `/${followingDetachedId}`, {
    edit_scope: 'following', occurrence_start: '2030-01-14T09:00',
    expected_parent_revision: followingParent.revision,
    start_datetime: '2030-01-14T13:00', end_datetime: '2030-01-14T14:00',
  });
  assert.equal(following.status, 200, JSON.stringify(following.body));
  assert.notEqual(following.body.data.id, followingId);
  assert.equal(following.body.edit.scope, 'following');
});

test('expired scoped provider leases recover and expose an explicit retry path', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token', 'queue-test-token')").run();
  const calendar = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('google', 'scope-google-queue', 'Scope Google Queue')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, enabled, access_role)
    VALUES ('scope-google-queue', 'Scope Google Queue', 1, 'writer')
  `).run();
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, created_by)
    VALUES ('scope-queue', '2030-08-05T09:00', '2030-08-05T10:00',
            'FREQ=WEEKLY;COUNT=2', 'google', 'scope-google-queue-event', ?,
            ?)
  `).run(calendar, user).lastInsertRowid);
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: before.start_datetime,
    expected_revision: before.revision, start_datetime: '2030-08-05T10:00',
    end_datetime: '2030-08-05T11:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const operationId = response.body.edit.operation_ids[0];
  assert.ok(operationId);

  const claimed = claimCalendarEditOperation(operationId, db);
  assert.equal(claimed.status, 'processing');
  db.prepare(`
    UPDATE calendar_edit_operations
    SET claim_expires_at = '2000-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(operationId);
  const active = activeCalendarEditOperations('google', db);
  assert.equal(active.length, 1);
  assert.equal(active[0].status, 'retry');
  assert.equal(active[0].identity.event_id, id);
  assert.equal(active[0].identity.master_external_id, 'scope-google-queue-event');
  assert.equal(active[0].identity.provider_uid, 'scope-google-queue-event');
  assert.equal(active[0].identity.target_calendar_id, 'scope-google-queue');

  const recoveredClaim = claimCalendarEditOperation(operationId, db);
  assert.equal(recoveredClaim.status, 'processing');
  assert.equal(failCalendarEditOperation(
    operationId, new Error('temporary provider outage'), { retryable: true }, db, recoveredClaim,
  ), true);
  const failedContext = (await call('GET', `/${id}/edit-context`)).body.data;
  assert.equal(failedContext.sync.state, 'error');
  assert.equal(failedContext.sync.retryable, true);
  const retried = await call('POST', `/${id}/retry-sync`);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(db.prepare('SELECT status FROM calendar_edit_operations WHERE id = ?').get(operationId).status, 'pending');
  const finalClaim = claimCalendarEditOperation(operationId, db);
  assert.equal(finalClaim.status, 'processing');
  assert.equal(completeCalendarEditOperation(operationId, {
    providerUid: 'scope-google-queue-result',
    providerEtag: '"queue-v2"',
    providerObjectUrl: 'https://google.invalid/events/scope-google-queue-result',
    providerCalendarId: 'scope-google-queue',
    providerCalendarRefId: calendar,
  }, db, finalClaim), true);
  const reconciled = db.prepare(`
    SELECT external_calendar_id, external_source, calendar_ref_id,
           target_google_calendar_id, external_object_url, provider_revision
    FROM calendar_events WHERE id = ?
  `).get(id);
  assert.deepEqual(reconciled, {
    external_calendar_id: 'scope-google-queue-result',
    external_source: 'google',
    calendar_ref_id: calendar,
    target_google_calendar_id: 'scope-google-queue',
    external_object_url: 'https://google.invalid/events/scope-google-queue-result',
    provider_revision: '"queue-v2"',
  });
});

test('a recovered worker cannot complete or fail after a newer claim', async () => {
  db.prepare("DELETE FROM calendar_edit_operations WHERE status <> 'completed'").run();
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token', 'fence-test-token')").run();
  const calendar = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('google', 'scope-google-fence', 'Scope Google Fence')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, enabled, access_role)
    VALUES ('scope-google-fence', 'Scope Google Fence', 1, 'writer')
  `).run();
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, created_by)
    VALUES ('scope-fence', '2030-09-02T09:00', '2030-09-02T10:00',
            'FREQ=WEEKLY;COUNT=2', 'google', 'scope-google-fence-event', ?, ?)
  `).run(calendar, user).lastInsertRowid);
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: before.start_datetime,
    expected_revision: before.revision, start_datetime: '2030-09-02T10:00',
    end_datetime: '2030-09-02T11:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const operationId = response.body.edit.operation_ids[0];
  const workerA = claimCalendarEditOperation(operationId, db);
  assert.ok(workerA?.claim_token);
  db.prepare(`
    UPDATE calendar_edit_operations
    SET claim_expires_at = '2000-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(operationId);
  const workerB = claimCalendarEditOperation(operationId, db);
  assert.equal(workerB.status, 'processing');
  assert.ok(workerB.claim_generation > workerA.claim_generation);
  assert.notEqual(workerB.claim_token, workerA.claim_token);

  assert.equal(completeCalendarEditOperation(operationId, {
    providerUid: 'late-worker-a', providerEtag: 'late-a',
  }, db, workerA), false);
  assert.equal(failCalendarEditOperation(
    operationId, Object.assign(new Error('late worker failure'), { code: 409 }),
    { retryable: false, conflict: true }, db, workerA,
  ), false);
  assert.equal(db.prepare('SELECT status FROM calendar_edit_operations WHERE id = ?').get(operationId).status, 'processing');
  assert.equal(completeCalendarEditOperation(operationId, {
    providerUid: 'worker-b', providerEtag: 'worker-b-etag',
  }, db, workerB), true);
  assert.equal(db.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(id).external_calendar_id, 'worker-b');
});

test('provider conflict reload releases inbound protection without retrying the stale edit', async () => {
  db.prepare("DELETE FROM calendar_edit_operations WHERE status <> 'completed'").run();
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token', 'conflict-test-token')").run();
  const calendar = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('google', 'scope-google-conflict', 'Scope Google Conflict')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, enabled, access_role)
    VALUES ('scope-google-conflict', 'Scope Google Conflict', 1, 'writer')
  `).run();
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, created_by)
    VALUES ('scope-conflict', '2030-10-07T09:00', '2030-10-07T10:00',
            'FREQ=WEEKLY;COUNT=2', 'google', 'scope-google-conflict-event', ?, ?)
  `).run(calendar, user).lastInsertRowid);
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'series', occurrence_start: before.start_datetime,
    expected_revision: before.revision, title: 'Local before conflict',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const operationId = response.body.edit.operation_ids[0];
  const claim = claimCalendarEditOperation(operationId, db);
  const conflict = Object.assign(new Error('provider precondition failed'), { status: 412 });
  assert.equal(failCalendarEditOperation(
    operationId, conflict, { retryable: false }, db, claim,
  ), true);
  assert.equal(activeCalendarEditOperations('google', db).length, 1);
  const context = (await call('GET', `/${id}/edit-context`)).body.data;
  assert.equal(context.sync.conflict, true);
  assert.equal(context.sync.retryable, false);

  const reload = await call('POST', `/${id}/reload-sync`, { operation_id: operationId });
  assert.equal(reload.status, 200, JSON.stringify(reload.body));
  assert.equal(reload.body.reload.resolved_operations, 1);
  assert.equal(activeCalendarEditOperations('google', db).length, 0);
  assert.equal(db.prepare('SELECT resolution FROM calendar_edit_operations WHERE id = ?').get(operationId).resolution, 'reload');
  const reloaded = (await call('GET', `/${id}/edit-context`)).body.data;
  assert.equal(reloaded.sync.state, 'pending');
  assert.equal(reloaded.sync.conflict, false);

  // The explicit reload only releases the protection.  The first matching
  // provider row must supply the authoritative values and clear the pending
  // marker; a background sync that did not contain this event must not do so.
  googleCalendarTest.upsertGoogleEvents([{
    id: 'scope-google-conflict-event',
    summary: 'Authoritative provider title',
    etag: '"remote-v3"',
    start: { dateTime: '2030-10-07T09:00:00Z', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2030-10-07T10:00:00Z', timeZone: 'Europe/Berlin' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'],
  }], calendar);
  const afterReadback = (await call('GET', `/${id}/edit-context`)).body.data;
  assert.equal(afterReadback.sync.state, 'clean');
  assert.equal((await call('GET', `/${id}`)).body.data.title, 'Authoritative provider title');
});

test('imported Google scoped route keeps its calendar identity through inbound and a second edit', async () => {
  db.prepare("DELETE FROM calendar_edit_operations WHERE status <> 'completed'").run();
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token', 'route-google-token')").run();
  const calendarId = 'route-imported-google';
  const calendarRefId = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('google', ?, 'Imported Google')
  `).run(calendarId).lastInsertRowid);
  db.prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, enabled, access_role)
    VALUES (?, 'Imported Google', 1, 'writer')
  `).run(calendarId);
  const eventId = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, provider_revision, created_by)
    VALUES ('Imported route series', '2035-04-05T09:00', '2035-04-05T10:00',
            'FREQ=WEEKLY;COUNT=4', 'google', 'route-master', ?, '"master-v1"', ?)
  `).run(calendarRefId, user).lastInsertRowid);

  const firstBefore = (await call('GET', `/${eventId}`)).body.data;
  const firstEdit = await call('PUT', `/${eventId}`, {
    edit_scope: 'series', occurrence_start: firstBefore.start_datetime,
    expected_revision: firstBefore.revision, title: 'Route first edit',
  });
  assert.equal(firstEdit.status, 200, JSON.stringify(firstEdit.body));
  const firstOperationId = firstEdit.body.edit.operation_ids[0];
  const firstOperation = db.prepare(
    'SELECT * FROM calendar_edit_operations WHERE id = ?'
  ).get(firstOperationId);
  const firstPayload = JSON.parse(firstOperation.payload_json);
  assert.equal(firstPayload.target_calendar_id, calendarId);
  assert.equal(firstPayload.provider.calendarId, calendarId);
  assert.equal(firstPayload.provider.etag, '"master-v1"');

  // A full inbound pass observes a newer remote baseline, but the queued write
  // must retain its original conditional ETag and local fields.
  googleCalendarTest.upsertGoogleEvents([{
    id: 'route-master', summary: 'stale remote title', etag: '"remote-v2"',
    start: { dateTime: '2035-04-05T09:00:00Z', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2035-04-05T10:00:00Z', timeZone: 'Europe/Berlin' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
  }], calendarRefId);
  assert.equal(db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(eventId).title, 'Route first edit');
  assert.equal(db.prepare('SELECT provider_revision FROM calendar_events WHERE id = ?').get(eventId).provider_revision, '"remote-v2"');

  const patches = [];
  const calendar = {
    colors: { get: async () => ({ data: { event: {} } }) },
    calendarList: { get: async () => ({ data: { accessRole: 'writer', timeZone: 'Europe/Berlin' } }) },
    events: {
      patch: async (params) => {
        patches.push(params);
        return { data: { id: params.eventId, etag: '"remote-v3"' } };
      },
    },
  };
  const pushed = await googleCalendarTest.processScopedOperations(calendar, new Map());
  assert.equal(pushed.completed, 1);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].calendarId, calendarId);
  assert.equal(patches[0].eventId, 'route-master');
  assert.equal(patches[0].headers['If-Match'], '"master-v1"');
  assert.equal(db.prepare('SELECT status FROM calendar_edit_operations WHERE id = ?').get(firstOperationId).status, 'completed');

  const secondBefore = (await call('GET', `/${eventId}`)).body.data;
  const secondEdit = await call('PUT', `/${eventId}`, {
    edit_scope: 'series', occurrence_start: secondBefore.start_datetime,
    expected_revision: secondBefore.revision, title: 'Route second edit',
  });
  assert.equal(secondEdit.status, 200, JSON.stringify(secondEdit.body));
  const secondOperationId = secondEdit.body.edit.operation_ids[0];
  const secondPayload = JSON.parse(db.prepare(
    'SELECT payload_json FROM calendar_edit_operations WHERE id = ?'
  ).get(secondOperationId).payload_json);
  assert.equal(secondPayload.provider.masterId, 'route-master');
  assert.equal(secondPayload.provider.calendarId, calendarId);
  const secondPushed = await googleCalendarTest.processScopedOperations(calendar, new Map());
  assert.equal(secondPushed.completed, 1);
  assert.equal(patches.length, 2);
  assert.equal(patches[1].eventId, 'route-master');
  assert.equal(patches[1].headers['If-Match'], '"remote-v3"');
  assert.equal(db.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(eventId).external_calendar_id, 'route-master');
});

test('route following Google transfer resolves shifted later exceptions on the continuation', async () => {
  db.prepare("DELETE FROM calendar_edit_operations WHERE status <> 'completed'").run();
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token', 'route-following-token')").run();
  const calendarId = 'route-following-google';
  const calendarRefId = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('google', ?, 'Following Google')
  `).run(calendarId).lastInsertRowid);
  db.prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, enabled, access_role)
    VALUES (?, 'Following Google', 1, 'writer')
  `).run(calendarId);
  const masterId = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, provider_revision, created_by)
    VALUES ('Following route series', '2035-04-05T09:00', '2035-04-05T10:00',
            'FREQ=WEEKLY;COUNT=6', 'google', 'route-following-master', ?, '"follow-master-v1"', ?)
  `).run(calendarRefId, user).lastInsertRowid);

  // Create the later exception through the actual route first. Its remote
  // operation is completed before the following split, leaving a real local
  // detached row for the backend to transfer.
  const beforeThis = (await call('GET', `/${masterId}`)).body.data;
  const thisEdit = await call('PUT', `/${masterId}`, {
    edit_scope: 'this', occurrence_start: '2035-04-26T09:00',
    expected_revision: beforeThis.revision,
    title: 'Moved exception', start_datetime: '2035-04-26T12:00', end_datetime: '2035-04-26T13:00',
  });
  assert.equal(thisEdit.status, 200, JSON.stringify(thisEdit.body));
  const thisOccurrenceId = thisEdit.body.data.id;
  const thisInstances = [];
  const thisCalendar = {
    colors: { get: async () => ({ data: { event: {} } }) },
    calendarList: { get: async () => ({ data: { accessRole: 'writer', timeZone: 'Europe/Berlin' } }) },
    events: {
      instances: async () => ({ data: { items: [{
        id: 'route-following-master_20350426T090000Z', etag: '"exception-v1"',
        originalStartTime: { dateTime: '2035-04-26T09:00:00Z' },
      }] } }),
      patch: async (params) => {
        thisInstances.push(params);
        return { data: { id: params.eventId, etag: '"exception-v2"' } };
      },
    },
  };
  assert.equal((await googleCalendarTest.processScopedOperations(thisCalendar, new Map())).completed, 1);
  assert.equal(
    db.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(thisOccurrenceId).external_calendar_id,
    'route-following-master_20350426T090000Z',
  );

  const beforeFollowing = (await call('GET', `/${masterId}`)).body.data;
  const followingEdit = await call('PUT', `/${masterId}`, {
    edit_scope: 'following', occurrence_start: '2035-04-12T09:00',
    expected_revision: beforeFollowing.revision,
    title: 'Following continuation', start_datetime: '2035-04-12T11:00', end_datetime: '2035-04-12T12:00',
  });
  assert.equal(followingEdit.status, 200, JSON.stringify(followingEdit.body));
  const followingOperationId = followingEdit.body.edit.operation_ids[0];
  const followingPayload = JSON.parse(db.prepare(
    'SELECT payload_json FROM calendar_edit_operations WHERE id = ?'
  ).get(followingOperationId).payload_json);
  const exceptionOperations = followingPayload.split?.exception_operations || [];
  assert.equal(exceptionOperations.length, 1);
  assert.equal(exceptionOperations[0].original_start, '2035-04-26T09:00');
  assert.equal(exceptionOperations[0].continuation_start, '2035-04-26T11:00');
  assert.equal(exceptionOperations[0].event.start_datetime, '2035-04-26T12:00');

  const masterPatches = [];
  const exceptionPatches = [];
  const inserts = [];
  const followingCalendar = {
    colors: { get: async () => ({ data: { event: {} } }) },
    calendarList: { get: async () => ({ data: { accessRole: 'writer', timeZone: 'Europe/Berlin' } }) },
    events: {
      patch: async (params) => {
        if (params.eventId === 'route-following-master') masterPatches.push(params);
        else exceptionPatches.push(params);
        return { data: { id: params.eventId, etag: params.eventId === 'route-following-master' ? '"follow-master-v2"' : '"exception-v3"' } };
      },
      insert: async () => {
        inserts.push(true);
        return { data: { id: 'route-following-continuation', etag: '"continuation-v1"' } };
      },
      // Following writes use the durable private marker before inserting the
      // continuation.  An empty result is authoritative: it proves this test
      // exercised the lookup seam and that the insert was actually needed.
      list: async () => ({ data: { items: [] } }),
      instances: async ({ eventId }) => {
        assert.equal(eventId, 'route-following-continuation');
        return { data: { items: [{
          id: 'route-following-continuation_20350426T110000Z', etag: '"continuation-exception-v1"',
          originalStartTime: { dateTime: '2035-04-26T11:00:00Z' },
        }] } };
      },
    },
  };
  const followingPushed = await googleCalendarTest.processScopedOperations(followingCalendar, new Map());
  assert.equal(followingPushed.completed, 1);
  assert.equal(masterPatches.length, 1);
  assert.equal(inserts.length, 1);
  assert.equal(exceptionPatches.length, 1);
  assert.equal(exceptionPatches[0].eventId, 'route-following-continuation_20350426T110000Z');
  assert.equal(exceptionPatches[0].headers['If-Match'], '"continuation-exception-v1"');
  assert.equal(exceptionPatches[0].requestBody.start.dateTime, '2035-04-26T12:00:00');
  const continuationId = followingEdit.body.data.id;
  assert.equal(
    db.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(continuationId).external_calendar_id,
    'route-following-continuation',
  );
});

test('CalDAV route scope uses the imported object identity through inbound and a second edit', async () => {
  db.prepare("DELETE FROM calendar_edit_operations WHERE status <> 'completed'").run();
  const calendarUrl = 'https://dav.example/route-family/';
  const accountId = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('Route Mailbox', 'https://dav.example/', 'route', 'secret')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO caldav_calendar_selection
      (account_id, calendar_url, calendar_name, enabled, write_capability)
    VALUES (?, ?, 'Route Family', 1, 'write')
  `).run(accountId, calendarUrl);
  const calendarRefId = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name)
    VALUES ('caldav', ?, 'Route Family')
  `).run(calendarUrl).lastInsertRowid);
  const uid = 'route-caldav-series@example.test';
  const eventId = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, external_source,
       external_calendar_id, calendar_ref_id, provider_revision, created_by)
    VALUES ('Imported CalDAV series', '2035-06-05T09:00:00Z', '2035-06-05T10:00:00Z',
            'FREQ=WEEKLY;COUNT=4', 'caldav', ?, ?, '"cal-v1"', ?)
  `).run(uid, calendarRefId, user).lastInsertRowid);
  const objectUrl = `${calendarUrl}route-series.ics`;
  const originalICS = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Imported',
    'DTSTART:20350605T090000Z', 'DTEND:20350605T100000Z',
    'RRULE:FREQ=WEEKLY;COUNT=4', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const before = (await call('GET', `/${eventId}`)).body.data;
  const firstEdit = await call('PUT', `/${eventId}`, {
    edit_scope: 'this', occurrence_start: '2035-06-12T09:00:00Z',
    expected_revision: before.revision,
    title: 'CalDAV first edit', start_datetime: '2035-06-12T11:00:00Z', end_datetime: '2035-06-12T12:00:00Z',
  });
  assert.equal(firstEdit.status, 200, JSON.stringify(firstEdit.body));
  const detachedId = firstEdit.body.data.id;
  const firstOperationId = firstEdit.body.edit.operation_ids[0];
  const updates = [];
  const firstClient = {
    updateCalendarObject: async (params) => { updates.push(params); },
  };
  const objectIndex = new Map([[uid, {
    url: objectUrl, etag: '"cal-v1"', data: originalICS, calendarUrl,
  }]]);
  const calendars = new Map([[calendarUrl, { url: calendarUrl, writable: true }]]);
  const firstPushed = await caldavCalendarTest.processScopedOperations(
    firstClient, objectIndex, calendars, new Set([calendarUrl]),
  );
  assert.equal(firstPushed.completed, 1);
  assert.equal(db.prepare('SELECT status FROM calendar_edit_operations WHERE id = ?').get(firstOperationId).status, 'completed');
  assert.equal(
    db.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(detachedId).external_calendar_id,
    `${uid}::2035-06-12`,
  );
  const firstICS = updates[0].calendarObject.data;
  assert.match(firstICS, /SUMMARY:CalDAV first edit/);
  objectIndex.set(uid, { url: objectUrl, etag: '"cal-v2"', data: firstICS, calendarUrl });
  objectIndex.set(`${uid}::2035-06-12`, { url: objectUrl, etag: '"cal-v2"', data: firstICS, calendarUrl });

  // A subsequent inbound pass captures the new object ETag before the second
  // gesture. The second queue payload must use this fresh baseline rather than
  // silently rebasing the first operation's conditional token.
  const baselineClient = {
    fetchCalendars: async () => [{ url: calendarUrl, displayName: 'Route Family', components: ['VEVENT'], writable: true }],
    fetchCalendarObjects: async () => [{ url: objectUrl, etag: '"cal-v2"', data: firstICS }],
  };
  const baselineResult = await caldavSync.sync({ createClient: async () => baselineClient });
  assert.equal(baselineResult.success, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM calendar_events WHERE external_source = 'caldav'").get().count,
    2,
    'the inbound refresh must reconcile the existing detached row instead of duplicating it',
  );

  const detachedBefore = (await call('GET', `/${detachedId}`)).body.data;
  const secondEdit = await call('PUT', `/${detachedId}`, {
    edit_scope: 'this', occurrence_start: detachedBefore.original_occurrence_start,
    expected_revision: detachedBefore.revision,
    title: 'CalDAV second edit', start_datetime: '2035-06-12T12:00:00Z', end_datetime: '2035-06-12T13:00:00Z',
  });
  assert.equal(secondEdit.status, 200, JSON.stringify(secondEdit.body));
  const secondOperationId = secondEdit.body.edit.operation_ids[0];
  const inboundWrites = [];
  const syncClient = {
    fetchCalendars: async () => [{ url: calendarUrl, displayName: 'Route Family', components: ['VEVENT'], writable: true }],
    fetchCalendarObjects: async () => [{ url: objectUrl, etag: '"cal-v2"', data: firstICS }],
    updateCalendarObject: async (params) => {
      inboundWrites.push(params);
      return {};
    },
  };
  const syncResult = await caldavSync.sync({ createClient: async () => syncClient });
  assert.equal(syncResult.success, true);
  assert.equal(db.prepare('SELECT status FROM calendar_edit_operations WHERE id = ?').get(secondOperationId).status, 'completed');
  assert.equal(inboundWrites.length, 1);
  const secondICS = inboundWrites[0].calendarObject.data;
  // CalDAV keeps the master UID on the VEVENT override.  The detached local
  // identity is UID::date and is reconciled in the database, while the object
  // itself carries the original UID plus RECURRENCE-ID.
  assert.equal((secondICS.match(/UID:route-caldav-series@example\.test/g) || []).length, 2,
    'the second scoped edit updates the existing detached identity');
  assert.match(secondICS, /RECURRENCE-ID(?:;[^:]+)?:20350612T090000/);
  assert.match(secondICS, /SUMMARY:CalDAV second edit/);
  assert.equal(
    db.prepare('SELECT external_calendar_id FROM calendar_events WHERE id = ?').get(detachedId).external_calendar_id,
    `${uid}::2035-06-12`,
  );
});

test('following reminder copies from the master-to-continuation anchor', async () => {
  const id = series('scope-reminder-anchor');
  db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, '2030-01-06T09:00', ?)
  `).run(id, user);
  const before = (await call('GET', `/${id}`)).body.data;
  const response = await call('PUT', `/${id}`, {
    edit_scope: 'following', occurrence_start: '2030-01-21T09:00',
    expected_revision: before.revision,
    start_datetime: '2030-01-21T11:00', end_datetime: '2030-01-21T12:00',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const continuationId = response.body.data.id;
  assert.equal(
    db.prepare(`
      SELECT remind_at FROM reminders
      WHERE entity_type = 'event' AND entity_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(continuationId).remind_at,
    '2030-01-20T11:00',
  );
});

test('recurring series moves preserve civil time across both Berlin DST transitions', async () => {
  const previous = db.prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get()?.value ?? null;
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
  try {
    const spring = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, created_by, visibility)
      VALUES ('scope-dst-spring', '2030-03-24T09:00:00+01:00', '2030-03-24T10:00:00+01:00',
              0, 'FREQ=WEEKLY;COUNT=3', 'Europe/Berlin', ?, 'all')
    `).run(user).lastInsertRowid);
    const springBefore = (await call('GET', `/${spring}`)).body.data;
    const springResponse = await call('PUT', `/${spring}`, {
      edit_scope: 'series', occurrence_start: '2030-03-31T07:00:00Z',
      expected_revision: springBefore.revision,
      start_datetime: '2030-03-31T10:00:00+02:00',
      end_datetime: '2030-03-31T11:00:00+02:00',
    });
    assert.equal(springResponse.status, 200, JSON.stringify(springResponse.body));
    const springRow = db.prepare('SELECT start_datetime, end_datetime FROM calendar_events WHERE id = ?').get(spring);
    assert.equal(springRow.start_datetime, '2030-03-24T09:00:00Z');
    assert.equal(springRow.end_datetime, '2030-03-24T10:00:00Z');

    const autumn = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, created_by, visibility)
      VALUES ('scope-dst-autumn', '2030-10-20T09:00:00+02:00', '2030-10-20T10:00:00+02:00',
              0, 'FREQ=WEEKLY;COUNT=3', 'Europe/Berlin', ?, 'all')
    `).run(user).lastInsertRowid);
    const autumnBefore = (await call('GET', `/${autumn}`)).body.data;
    const autumnResponse = await call('PUT', `/${autumn}`, {
      edit_scope: 'series', occurrence_start: '2030-10-27T08:00:00Z',
      expected_revision: autumnBefore.revision,
      start_datetime: '2030-10-27T10:00:00+01:00',
      end_datetime: '2030-10-27T11:00:00+01:00',
    });
    assert.equal(autumnResponse.status, 200, JSON.stringify(autumnResponse.body));
    const autumnRow = db.prepare('SELECT start_datetime, end_datetime FROM calendar_events WHERE id = ?').get(autumn);
    assert.equal(autumnRow.start_datetime, '2030-10-20T08:00:00Z');
    assert.equal(autumnRow.end_datetime, '2030-10-20T09:00:00Z');
  } finally {
    if (previous === null) db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
    else db.prepare("UPDATE sync_config SET value = ? WHERE key = 'household_timezone'").run(previous);
  }
});
