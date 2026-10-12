/** Public task scheduling and calendar reads against a migrated isolated DB.
 * The user-approved spec's application-request seam explicitly reuses this
 * real router/HTTP integration pattern, overriding CONTRIBUTING's older direct
 * handler guideline (.scratch/meal-calendar-task-planning/spec.md, Testing).
 */
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'session-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
const db = (await import('../server/db.js')).get();
const tasks = (await import('../server/routes/tasks.js')).default;
const calendar = (await import('../server/routes/calendar.js')).default;
const users = ['owner', 'other', 'viewer'].map(name => Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')").run(name, name).lastInsertRowid));
const providerFixtures = {};
let actor = users[0];
let scopes = null;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.authUserId = actor; req.authRole = 'member'; req.authScopes = scopes; req.session = { userId: actor }; next(); });
app.use('/rewards', (await import('../server/routes/rewards.js')).default);
app.use('/tasks', tasks); app.use('/calendar', calendar);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
test.after(() => new Promise(resolve => server.close(resolve)));
async function call(method, path, body, user = users[0]) {
  actor = user;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, ...(res.status === 204 ? {} : await res.json()) };
}
async function task(body = {}) {
  const res = await call('POST', '/tasks', { title: 'Session task', due_date: '2090-04-01', start_date: '2000-01-01', ...body });
  assert.equal(res.status, 201, JSON.stringify(res)); return res.data;
}
const interval = { publication_target: 'local', start_datetime: '2090-03-31T10:00', tzid: 'Europe/Berlin' };
test('schedule multiple durable shared allocations without moving deadline or spawning recurrence', async () => {
  const parent = await task({ assigned_to: [users[1], users[0]], is_recurring: true, recurrence_rule: 'FREQ=DAILY' });
  const first = await call('POST', `/tasks/${parent.id}/sessions`, interval);
  assert.equal(first.status, 201, JSON.stringify(first));
  const second = await call('POST', `/tasks/${parent.id}/sessions`, interval);
  assert.equal(second.status, 201); assert.notEqual(first.data.id, second.data.id);
  const sessions = await call('GET', `/tasks/${parent.id}/sessions`);
  assert.equal(sessions.data.length, 2);
  assert.equal(first.data.assigned_to, users[1]);
  assert.deepEqual(first.data.assigned_users.map(u => u.id).sort(), users.slice(0, 2).sort());
  assert.equal(first.data.session_status, 'unfinished');
  assert.equal(first.data.recurrence_rule, null);
  assert.equal(Date.parse(first.data.end_datetime) - Date.parse(first.data.start_datetime), 30 * 60_000);
  assert.equal(first.data.tzid, 'Europe/Berlin');
  const updated = (await call('GET', `/tasks/${parent.id}`)).data;
  assert.equal(updated.due_date, parent.due_date); assert.equal(updated.start_date, parent.start_date);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE recurrence_origin_id = ?').get(parent.id).n, 0);
  const plannable = await call('GET', '/tasks/plannable');
  assert.ok(plannable.data.some(t => t.id === parent.id));
  const rows = (await call('GET', '/calendar?from=2090-03-30&to=2090-04-02')).data;
  assert.equal(rows.filter(e => e.task_id === parent.id).length, 2);
});

test('unassigned scheduling assigns atomically; rejected inputs and ineligible tasks do not assign', async () => {
  const parent = await task();
  for (const body of [ { ...interval, end_datetime: interval.start_datetime }, { ...interval, tzid: 'invalid/zone' }, { ...interval, start_datetime: '2090-02-31T10:00' }, { ...interval, assigned_to: [users[1]] } ]) {
    assert.equal((await call('POST', `/tasks/${parent.id}/sessions`, body)).status, 400);
    assert.equal((await call('GET', `/tasks/${parent.id}`)).data.assigned_to, null);
    assert.deepEqual((await call('GET', `/tasks/${parent.id}/sessions`)).data, []);
  }
  scopes = ['tasks:write'];
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions`, interval)).status, 403);
  scopes = null;
  const session = await call('POST', `/tasks/${parent.id}/sessions`, interval);
  assert.equal(session.status, 201);
  assert.equal(session.data.assigned_to, users[0]);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.assigned_to, users[0]);
  for (const fields of [ { start_date: '2099-01-01' }, { status: 'done' }, { status: 'archived' }, { parent_task_id: parent.id } ]) {
    const ineligible = await task(fields);
    if (fields.status) await call('PATCH', `/tasks/${ineligible.id}/status`, { status: fields.status });
    assert.equal((await call('POST', `/tasks/${ineligible.id}/sessions`, interval)).status, 409);
    assert.ok(!(await call('GET', '/tasks/plannable')).data.some(t => t.id === ineligible.id));
  }
});

test('calendar/details/feeds enforce current parent visibility and prohibit ordinary event edits', async () => {
  const parent = await task({ visibility: 'assignees', assigned_to: [users[1], users[0]] });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  assert.equal((await call('GET', `/calendar/${session.id}`, null, users[1])).status, 200);
  assert.equal((await call('GET', `/calendar/${session.id}`, null, users[2])).status, 404);
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`, null, users[2])).status, 404);
  assert.ok(!(await call('GET', '/calendar?from=2090-03-30&to=2090-04-02', null, users[2])).data.some(e => e.id === session.id));
  assert.ok(!(await call('GET', '/calendar/search?q=Session', null, users[2])).data.some(e => e.id === session.id));
  assert.equal((await call('PUT', `/calendar/${session.id}`, { title: 'Leaked', target_google_calendar_id: 'external' })).status, 409);
  assert.equal((await call('DELETE', `/calendar/${session.id}`)).status, 409);
  const { buildFeed } = await import('../server/services/ics-export.js');
  assert.ok(buildFeed(db, users[1]).includes(`UID:event-${session.id}@yuvomi`));
  assert.ok(!buildFeed(db, users[2]).includes(`UID:event-${session.id}@yuvomi`));
  const ordinary = (await call('POST', '/calendar', { title: 'Ordinary private feed', start_datetime: '2090-04-01T11:00', visibility: 'private' })).data;
  assert.ok(buildFeed(db, users[2]).includes('Ordinary private feed'));
  await call('PUT', `/tasks/${parent.id}`, { visibility: 'private' });
  assert.equal((await call('GET', `/calendar/${session.id}`, null, users[1])).status, 404);
  assert.ok(!buildFeed(db, null).includes(`UID:event-${session.id}@yuvomi`));
  assert.ok(ordinary.id);
});

test('completion/archive remove future unfinished allocations, retain past history; parent deletion removes all', async () => {
  for (const action of ['done', 'archived']) {
    const parent = await task();
    const past = (await call('POST', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: '2001-01-01T10:00', tzid: 'UTC' })).data;
    const future = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
    assert.equal((await call('PATCH', `/tasks/${parent.id}/status`, { status: action })).status, 200);
    const rows = (await call('GET', `/tasks/${parent.id}/sessions`)).data;
    assert.deepEqual(rows.map(e => e.id), [past.id]);
    assert.equal((await call('GET', `/calendar/${future.id}`)).status, 404);
    assert.equal((await call('DELETE', `/tasks/${parent.id}`)).status, 200);
    assert.equal((await call('GET', `/calendar/${past.id}`)).status, 404);
  }
});

test('participant eligibility and scheduling somebody else preserve assignment and reject atomically', async () => {
  const parent = await task({ assigned_to: [users[1]] });
  const session = await call('POST', `/tasks/${parent.id}/sessions`, interval);
  assert.equal(session.status, 201); assert.equal(session.data.assigned_to, users[1]);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.assigned_to, users[1]);
  assert.ok(!(await call('GET', '/tasks/plannable')).data.some(t => t.id === parent.id));
  const restricted = await task({ assigned_to: [users[2]] });
  db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'module', 'calendar', 'none')").run(String(users[2]));
  try {
    assert.equal((await call('POST', `/tasks/${restricted.id}/sessions`, interval)).status, 400);
    assert.equal((await call('GET', `/tasks/${restricted.id}/sessions`)).data.length, 0);
    assert.equal((await call('GET', `/tasks/${restricted.id}`)).data.assigned_to, users[2]);
  } finally { db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(users[2])); }
});

test('reopening a recurring origin retains a successor with allocated work', async () => {
  const { todayKey } = await import('../server/utils/timezone.js');
  const parent = await task({ assigned_to: [users[0]], due_date: todayKey(db), is_recurring: true, recurrence_rule: 'FREQ=DAILY', recurrence_from_completion: true });
  await call('PATCH', `/tasks/${parent.id}/status`, { status: 'done' });
  const successor = (await call('GET', '/tasks?include_future=1')).data.find(t => t.recurrence_origin_id === parent.id);
  assert.ok(successor);
  // Fixture represents a successor created before snapshot migration 197.
  db.prepare('DELETE FROM task_recurrence_snapshots WHERE task_id = ?').run(successor.id);
  assert.equal((await call('POST', `/tasks/${successor.id}/sessions`, interval)).status, 201);
  await call('PATCH', `/tasks/${parent.id}/status`, { status: 'open' });
  assert.equal((await call('GET', `/tasks/${successor.id}`)).status, 200);
  assert.equal((await call('GET', `/tasks/${successor.id}/sessions`)).data.length, 1);
});


test('planning filters retain visibility and count allocations outside the calendar range', async () => {
  const visible = await task({ title: 'Other member planning', assigned_to: [users[1]], visibility: 'household' });
  const hidden = (await call('POST', '/tasks', { title: 'Private planning', start_date: '2000-01-01', assigned_to: [users[1]], visibility: 'private' }, users[1])).data;
  let rows = (await call('GET', `/tasks/plannable?assigned_to=${users[1]}`)).data;
  assert.ok(rows.some(t => t.id === visible.id));
  assert.ok(!rows.some(t => t.id === hidden.id));
  assert.ok(!(await call('GET', '/tasks/plannable')).data.some(t => t.id === visible.id));
  await call('POST', `/tasks/${visible.id}/sessions`, interval);
  rows = (await call('GET', `/tasks/plannable?assigned_to=${users[1]}`)).data;
  assert.equal(rows.find(t => t.id === visible.id).session_count, 1);
});


test('move and resize a session without changing its identity, participants or parent deadline', async () => {
  const parent = await task({ assigned_to: [users[1], users[0]] });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  const moved = await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, {
    start_datetime: '2090-03-31T23:45', end_datetime: '2090-04-01T00:15', tzid: 'Europe/Berlin',
  });
  assert.equal(moved.status, 200, JSON.stringify(moved));
  assert.equal(moved.data.id, session.id);
  assert.equal(moved.data.task_id, parent.id);
  assert.equal(moved.data.start_datetime, '2090-03-31T21:45:00.000Z');
  assert.equal(moved.data.end_datetime, '2090-03-31T22:15:00.000Z');
  assert.deepEqual(moved.data.assigned_users, session.assigned_users);
  const resized = await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, {
    start_datetime: moved.data.start_datetime, end_datetime: '2090-03-31T23:15:00Z', tzid: 'Europe/Berlin',
  });
  assert.equal(resized.status, 200);
  assert.equal(resized.data.end_datetime, '2090-03-31T23:15:00.000Z');
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`)).data.length, 1);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.due_date, parent.due_date);
});


test('unschedule only the selected allocation and keep the parent and other sessions', async () => {
  const parent = await task();
  const first = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  const second = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  assert.equal((await call('DELETE', `/tasks/${parent.id}/sessions/${first.id}`)).status, 204);
  assert.deepEqual((await call('GET', `/tasks/${parent.id}/sessions`)).data.map(e => e.id), [second.id]);
  assert.equal((await call('GET', `/calendar/${first.id}`)).status, 404);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.due_date, parent.due_date);
  assert.equal((await call('GET', '/tasks/plannable')).data.find(t => t.id === parent.id).session_count, 1);
});

test('duration preferences and start-only moves use elapsed time across DST; rejected edits retain allocations', async () => {
  const parent = await task({ visibility: 'private', assigned_to: [users[0]] });
  const made = await call('POST', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: '2026-03-29T01:45', tzid: 'Europe/Berlin', duration_minutes: 45 });
  assert.equal(made.status, 201);
  assert.equal(made.data.end_datetime, '2026-03-29T01:30:00.000Z');
  const preciseParent = await task();
  const precise = await call('POST', `/tasks/${preciseParent.id}/sessions`, { publication_target: 'local', start_datetime: '2026-03-29T01:45:00.333', tzid: 'Europe/Berlin', duration_minutes: 15 });
  assert.equal(precise.status, 201);
  assert.equal(precise.data.start_datetime, '2026-03-29T00:45:00.333Z');
  assert.equal(precise.data.end_datetime, '2026-03-29T01:00:00.333Z');
  const path = `/tasks/${parent.id}/sessions/${made.data.id}`;
  const moved = await call('PUT', path, { start_datetime: '2026-10-25T01:45', expected_revision: made.data.edit_revision });
  assert.equal(moved.status, 200);
  assert.equal(Date.parse(moved.data.end_datetime) - Date.parse(moved.data.start_datetime), 45 * 60_000);
  for (const body of [{ duration_minutes: 0 }, { duration_minutes: -15 }, { duration_minutes: '45' }, { publication_target: 'local', start_datetime: '2026-03-29T02:15' }, { assigned_to: users[1] }]) {
    assert.equal((await call('PUT', path, body)).status, 400);
  }
  assert.equal((await call('PUT', path, { duration_minutes: 60, expected_revision: made.data.edit_revision })).status, 409);
  assert.equal((await call('PUT', path, { duration_minutes: 60 }, users[1])).status, 404);
  assert.equal((await call('DELETE', path, null, users[1])).status, 404);
  scopes = ['tasks:write'];
  assert.equal((await call('PUT', path, { duration_minutes: 60 })).status, 403);
  assert.equal((await call('DELETE', path)).status, 403);
  scopes = null;
  assert.deepEqual((await call('GET', `/tasks/${parent.id}/sessions`)).data, [moved.data]);
});

test('unscheduling retains the existing provider deletion identity and invalid cross-task edits do nothing', async () => {
  const parent = await task();
  const other = await task();
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token', 'fixture')").run();
  db.prepare("UPDATE calendar_events SET external_source = 'google', external_calendar_id = 'remote-session-07', target_google_calendar_id = 'remote-calendar' WHERE id = ?").run(session.id);
  const path = `/tasks/${parent.id}/sessions/${session.id}`;
  assert.equal((await call('PUT', `/tasks/${other.id}/sessions/${session.id}`, { duration_minutes: 60 })).status, 404);
  assert.equal((await call('DELETE', `/tasks/${other.id}/sessions/${session.id}`)).status, 404);
  assert.equal((await call('PUT', '/tasks/no/sessions/no', {})).status, 400);
  const read = (await call('GET', `/tasks/${parent.id}/sessions`)).data[0];
  const moved = await call('PUT', path, { duration_minutes: 60, expected_revision: read.revision });
  assert.equal(moved.status, 200, JSON.stringify(moved));
  assert.equal(moved.data.external_calendar_id, 'remote-session-07');
  assert.equal(moved.data.target_google_calendar_id, 'remote-calendar');
  assert.equal((await call('DELETE', path)).status, 204);
  assert.deepEqual(db.prepare("SELECT source, calendar_external_id, event_external_id FROM calendar_pending_deletions WHERE event_external_id = 'remote-session-07'").get(), {
    source: 'google', calendar_external_id: 'remote-calendar', event_external_id: 'remote-session-07',
  });
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.due_date, parent.due_date);
});

test('shared session completion weights retained durations and explicitly finishes the parent once', async () => {
  const parent = await task({ assigned_to: [users[0], users[1]] });
  const a = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, duration_minutes: 30 })).data;
  const b = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, duration_minutes: 90 })).data;
  const complete = await call('POST', `/tasks/${parent.id}/sessions/${a.id}/complete`, {}, users[1]);
  assert.equal(complete.status, 200);
  assert.equal(complete.data.session_completed_by, users[1]);
  assert.ok(complete.data.session_completed_at);
  let updated = (await call('GET', `/tasks/${parent.id}`)).data;
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.scheduled_work.percentage, 25);
  const c = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, duration_minutes: 60 })).data;
  updated = (await call('GET', `/tasks/${parent.id}`)).data;
  assert.equal(Math.round(updated.scheduled_work.percentage), 17);
  assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${a.id}`, { duration_minutes: 60 })).status, 409);
  await call('DELETE', `/tasks/${parent.id}/sessions/${c.id}`);
  await call('POST', `/tasks/${parent.id}/sessions/${b.id}/complete`, {});
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.status, 'done');
  const repeated = await call('POST', `/tasks/${parent.id}/sessions/${a.id}/complete`, {});
  assert.equal(repeated.data.session_completed_by, users[1]);
});

test('publication defaults belong to the primary assignee; restricted and read-only targets require choices', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key,value) VALUES ('google_refresh_token','fixture')").run();
  db.prepare("INSERT INTO google_calendar_selection (calendar_id,name,enabled,access_role) VALUES ('primary-cal','Primary calendar',1,'writer'), ('reader-cal','Reader',1,'reader')").run();
  db.prepare("INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)").run(`calendar_default_target:user:${users[1]}`, 'google:primary-cal');
  const parent = await task({ assigned_to: [users[1], users[0]] });
  const session = await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: undefined });
  assert.equal(session.status, 201);
  assert.equal(session.data.target_google_calendar_id, 'primary-cal');
  assert.equal(session.data.outbound_dirty, 1);
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: 'google:reader-cal' })).status, 400);
  const restricted = await task({ visibility: 'assignees', assigned_to: [users[1], users[0]] });
  assert.equal((await call('POST', `/tasks/${restricted.id}/sessions`, { ...interval, publication_target: undefined })).status, 409);
  assert.equal((await call('POST', `/tasks/${restricted.id}/sessions`, { ...interval, publication_target: 'google:primary-cal' })).status, 201);
});

test('real Google transport lifecycle preserves one session identity through ambiguous create, retry, resize and task cleanup', async () => {
  const google = await import('../server/services/google-calendar.js');
  const remote = new Map(); let uncertain = true, uncertainId, resizeDuringCreate, creates = 0;
  const client = {
    colors: { get: async () => ({ data: { event: {} } }) },
    calendarList: { get: async ({ calendarId }) => ({ data: { id: calendarId, summary: calendarId, accessRole: calendarId === 'reader-cal' ? 'reader' : 'writer', timeZone: 'UTC' } }) },
    events: {
      list: async ({ calendarId }) => ({ data: { items: [...remote.values()].filter(event => event.calendarId === calendarId), nextSyncToken: 'fixture' } }),
      insert: async ({ calendarId, requestBody }) => {
        if (remote.has(requestBody.id)) throw Object.assign(new Error('Already exists'), { code: 409 });
        creates++; remote.set(requestBody.id, { ...requestBody, calendarId });
        if (resizeDuringCreate && requestBody.id === resizeDuringCreate.uid) {
          await call('PUT', `/tasks/${resizeDuringCreate.taskId}/sessions/${resizeDuringCreate.sessionId}`, { duration_minutes: 120 });
          resizeDuringCreate = null;
        }
        if (uncertain && requestBody.id === uncertainId) { uncertain = false; throw new Error('Response lost after remote creation'); }
        return { data: remote.get(requestBody.id) };
      },
      get: async ({ eventId }) => ({ data: remote.get(eventId) }),
      patch: async ({ eventId, requestBody }) => { remote.set(eventId, { ...remote.get(eventId), ...requestBody }); return { data: remote.get(eventId) }; },
      delete: async ({ eventId }) => { remote.delete(eventId); return {}; },
    },
  };
  providerFixtures.google = { client, remote };
  const parent = await task();
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: 'google:primary-cal' })).data;
  uncertainId = session.session_publication_uid.replaceAll('-', '');
  await google.sync({ calendarClient: client });
  assert.equal((await call('GET', `/calendar/${session.id}`)).data.sync.state, 'error');
  await google.sync({ calendarClient: client });
  const published = (await call('GET', `/tasks/${parent.id}/sessions`)).data;
  assert.equal(published.length, 1); assert.equal(published[0].id, session.id);
  assert.equal(published[0].external_source, 'google');
  assert.equal(creates, remote.size);
  await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 90 });
  await google.sync({ calendarClient: client });
  const external = remote.get(published[0].external_calendar_id);
  assert.equal(Date.parse(external.end.dateTime) - Date.parse(external.start.dateTime), 90 * 60000);
  await call('PATCH', `/tasks/${parent.id}/status`, { status: 'done' });
  await google.sync({ calendarClient: client });
  assert.ok(!remote.has(published[0].external_calendar_id));
  const racingParent = await task();
  const racing = (await call('POST', `/tasks/${racingParent.id}/sessions`, { ...interval, publication_target: 'google:primary-cal' })).data;
  resizeDuringCreate = { uid: racing.session_publication_uid.replaceAll('-', ''), taskId: racingParent.id, sessionId: racing.id };
  await google.sync({ calendarClient: client });
  assert.equal((await call('GET', `/tasks/${racingParent.id}/sessions`)).data[0].outbound_dirty, 1);
  await google.sync({ calendarClient: client });
  const latest = remote.get(racing.session_publication_uid.replaceAll('-', ''));
  assert.equal(Date.parse(latest.end.dateTime) - Date.parse(latest.start.dateTime), 120 * 60000);
});

test('only final explicit completion awards shared rewards, records history and generates one recurring successor', async () => {
  for (const user of users.slice(0, 2)) db.prepare('INSERT OR REPLACE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(user);
  const parent = await task({ assigned_to: users.slice(0, 2), points: 7, is_recurring: true, recurrence_rule: 'FREQ=DAILY' });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  await Promise.all([call('POST', `/tasks/${parent.id}/sessions/${session.id}/complete`, {}), call('POST', `/tasks/${parent.id}/sessions/${session.id}/complete`, {})]);
  assert.equal((await call('GET', `/tasks/${parent.id}/completions`)).data.length, 1);
  const ledger = (await call('GET', '/rewards/ledger')).data.filter(entry => entry.task_id === parent.id);
  assert.equal(ledger.length, 2); assert.ok(ledger.every(entry => entry.delta === 7));
  const successors = (await call('GET', '/tasks?include_future=1')).data.filter(row => row.recurrence_origin_id === parent.id);
  assert.equal(successors.length, 1);
});

test('empty lists, elapsed time, rounded 100 percent and removing unfinished work cannot finish a parent', async () => {
  const parent = await task();
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.status, 'open');
  const a = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, start_datetime: '2001-01-01T10:00', duration_minutes: 9999 })).data;
  const b = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, duration_minutes: 1 })).data;
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.status, 'open');
  await call('POST', `/tasks/${parent.id}/sessions/${a.id}/complete`, {});
  let updated = (await call('GET', `/tasks/${parent.id}`)).data;
  assert.equal(Math.round(updated.scheduled_work.percentage), 100); assert.equal(updated.status, 'in_progress');
  await call('DELETE', `/tasks/${parent.id}/sessions/${b.id}`);
  updated = (await call('GET', `/tasks/${parent.id}`)).data;
  assert.equal(updated.scheduled_work.percentage, 100); assert.equal(updated.status, 'in_progress');
  assert.equal((await call('GET', `/tasks/${parent.id}/completions`)).data.length, 0);
});

test('CalDAV transport reuses a stable resource, updates it, and deletes it on parent removal', async () => {
  const caldav = await import('../server/services/caldav-sync.js');
  const account = Number(db.prepare("INSERT INTO caldav_accounts (name,caldav_url,username,password) VALUES ('DAV','https://dav.example','fixture','fixture')").run().lastInsertRowid);
  const url = 'https://dav.example/calendar/';
  db.prepare("INSERT INTO caldav_calendar_selection (account_id,calendar_url,calendar_name,enabled,write_capability) VALUES (?,?,'Work',1,'write')").run(account, url);
  const objects = new Map(); let fail = true;
  const client = {
    fetchCalendars: async () => [{ url, displayName: 'Work', writable: true, components: ['VEVENT'] }],
    fetchCalendarObjects: async () => [...objects.values()],
    createCalendarObject: async ({ filename, iCalString }) => { if (objects.has(url + filename)) return { ok: false, status: 412 }; objects.set(url + filename, { url: url + filename, data: iCalString, etag: 'fixture' }); if (fail) { fail = false; throw new Error('Lost DAV response'); } return { ok: true }; },
    updateCalendarObject: async ({ calendarObject }) => { objects.set(calendarObject.url, calendarObject); return { ok: true }; },
    deleteCalendarObject: async ({ calendarObject }) => { objects.delete(calendarObject.url); return { ok: true }; },
  };
  const parent = await task();
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: `caldav:${account}|${url}` })).data;
  await caldav.sync({ createClient: async () => client });
  assert.equal((await call('GET', `/calendar/${session.id}`)).data.sync.state, 'error');
  await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 45 });
  await caldav.sync({ createClient: async () => client });
  assert.ok([...objects.values()][0].data.includes('DTEND:20900331T084500Z'));
  const published = (await call('GET', `/tasks/${parent.id}/sessions`)).data;
  assert.equal(published.length, 1); assert.equal(published[0].id, session.id); assert.equal(objects.size, 1);
  assert.equal(published[0].external_source, 'caldav');
  await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 60 });
  await caldav.sync({ createClient: async () => client });
  assert.ok([...objects.values()][0].data.includes('DTEND:20900331T090000Z'));
  const google = await import('../server/services/google-calendar.js');
  const transferParent = await task();
  const transfer = (await call('POST', `/tasks/${transferParent.id}/sessions`, { ...interval, publication_target: 'google:primary-cal' })).data;
  await google.sync({ calendarClient: providerFixtures.google.client });
  const old = (await call('GET', `/tasks/${transferParent.id}/sessions`)).data[0];
  await call('PUT', `/tasks/${transferParent.id}/sessions/${transfer.id}`, { publication_target: `caldav:${account}|${url}` });
  fail = true;
  await caldav.sync({ createClient: async () => client });
  assert.ok(providerFixtures.google.remote.has(old.external_calendar_id), 'successful prior publication survives failed transfer');
  const pending = (await call('GET', `/tasks/${transferParent.id}/sessions`)).data[0];
  assert.equal(pending.external_source, 'google'); assert.ok(pending.session_pending_target);
  await call('PUT', `/tasks/${transferParent.id}/sessions/${transfer.id}`, { publication_target: 'google:primary-cal' });
  await caldav.sync({ createClient: async () => client });
  assert.equal(objects.size, 1, 'cancelled uncertain replacement is removed');
  assert.ok(providerFixtures.google.remote.has(old.external_calendar_id));
  await call('PUT', `/tasks/${transferParent.id}/sessions/${transfer.id}`, { publication_target: `caldav:${account}|${url}` });
  await caldav.sync({ createClient: async () => client });
  await google.sync({ calendarClient: providerFixtures.google.client });
  assert.ok(!providerFixtures.google.remote.has(old.external_calendar_id));
  assert.equal((await call('GET', `/tasks/${transferParent.id}/sessions`)).data[0].external_source, 'caldav');
  await call('DELETE', `/tasks/${transferParent.id}`);
  await call('DELETE', `/tasks/${parent.id}`);
  await caldav.sync({ createClient: async () => client });
  assert.equal(objects.size, 0);
});

test('Outlook session publishes only to its explicit account, retries once and retains a deletion link', async () => {
  process.env.MS_CLIENT_ID = 'fixture'; process.env.MS_CLIENT_SECRET = 'fixture'; process.env.MS_REDIRECT_URI = 'http://fixture';
  const outlook = await import('../server/services/outlook-calendar.js');
  const account = Number(db.prepare("INSERT INTO outlook_accounts (name,access_token,refresh_token,token_expiry,auto_sync_calendar_id,owner_user_id) VALUES ('Graph','fixture','fixture','2099-01-01T00:00:00Z','work',?)").run(users[0]).lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO outlook_accounts (name,access_token,refresh_token,token_expiry,auto_sync_calendar_id,owner_user_id) VALUES ('Other','fixture','fixture','2099-01-01T00:00:00Z','other',?)").run(users[0]).lastInsertRowid);
  for (const [id, calendar] of [[account, 'work'], [other, 'other']]) db.prepare("INSERT INTO outlook_calendar_selection (account_id,calendar_id,calendar_name,enabled,can_edit) VALUES (?,?,?,1,1)").run(id, calendar, calendar);
  const remote = new Map(); let fail = true, cancelDuringCreate = false, posts = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET'; const body = options.body ? JSON.parse(options.body) : null;
    if (method === 'POST') {
      if (!body.transactionId) return Response.json({ id: 'ordinary-' + url.split('/calendars/')[1].split('/')[0], changeKey: 'fixture' }, { status: 201 });
      posts++; assert.ok(url.includes('/calendars/work/') || url.includes('/calendars/alt/'));
      const id = body.transactionId; remote.set(id, { ...body, id, changeKey: 'fixture' });
      if (cancelDuringCreate) { cancelDuringCreate = false; await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { publication_target: `outlook:${account}|work` }); }
      if (fail) { fail = false; throw new Error('Graph response lost'); }
      return Response.json(remote.get(id), { status: 201 });
    }
    if (method === 'PATCH') { const id = decodeURIComponent(url.split('/').at(-1)); remote.set(id, { ...remote.get(id), ...body }); return Response.json(remote.get(id)); }
    if (method === 'DELETE') { remote.delete(decodeURIComponent(url.split('/').at(-1))); return new Response(null, { status: 204 }); }
    return Response.json({ value: [...remote.values()] });
  };
  const parent = await task({ assigned_to: users.slice(0, 2) });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: `outlook:${account}|work` })).data;
  await outlook.sync({ fetchImpl });
  assert.equal((await call('GET', `/calendar/${session.id}`)).data.sync.state, 'error');
  await outlook.sync({ fetchImpl });
  assert.equal(remote.size, 1); assert.equal(posts, 2);
  db.prepare("INSERT INTO outlook_calendar_selection (account_id,calendar_id,calendar_name,enabled,can_edit) VALUES (?,'alt','Alternative',1,1)").run(account);
  await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { publication_target: `outlook:${account}|alt` });
  fail = true; cancelDuringCreate = true;
  await outlook.sync({ fetchImpl });
  await outlook.sync({ fetchImpl });
  assert.equal(remote.size, 1, 'cancelled uncertain Outlook replacement cannot delete the retained block');
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`)).data[0].target_outlook_calendar_id, 'work');
  await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { publication_target: `outlook:${account}|alt` });
  await outlook.sync({ fetchImpl });
  await outlook.sync({ fetchImpl });
  assert.equal(remote.size, 1, 'successful same-account transfer removes only the old block');
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`)).data[0].target_outlook_calendar_id, 'alt');
  await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 60 });
  await outlook.sync({ fetchImpl });
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`)).data[0].id, session.id);
  await call('DELETE', `/tasks/${parent.id}`);
  await outlook.sync({ fetchImpl });
  assert.equal(remote.size, 0);
});


test('session overrides select effective participants without changing parent access or assignments', async () => {
  const parent = await task({ assigned_to: [users[1], users[0]], visibility: 'assignees' });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  const changed = await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, {
    session_assignment_mode: 'override', assigned_to: users[2], assigned_users: [users[2], users[0]],
  });
  assert.equal(changed.status, 200, JSON.stringify(changed));
  assert.equal(changed.data.session_assignment_mode, 'override');
  assert.equal(changed.data.assigned_to, users[2]);
  assert.deepEqual(changed.data.assigned_users.map(u => u.id).sort(), [users[0], users[2]].sort());
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.assigned_to, users[1]);
  assert.equal((await call('GET', `/calendar/${session.id}`, null, users[2])).status, 404);
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`, null, users[2])).status, 404);
  assert.equal(changed.data.start_datetime, session.start_datetime);
  assert.equal(changed.data.target_google_calendar_id, session.target_google_calendar_id);
});


test('task reassignment follows only future unfinished inherited sessions and retains primary identity on unrelated edits', async () => {
  const parent = await task({ assigned_to: [users[1], users[0]] });
  const future = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  const past = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, start_datetime: '2001-01-01T10:00' })).data;
  const completed = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  await call('POST', `/tasks/${parent.id}/sessions/${completed.id}/complete`, {});
  const exception = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval,
    session_assignment_mode: 'override', assigned_to: users[0], assigned_users: [users[0]] })).data;
  assert.equal((await call('PUT', `/tasks/${parent.id}`, { title: 'Keep primary' })).data.assigned_to, users[1]);
  assert.equal((await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[2], users[0]] })).status, 200);
  let sessions = (await call('GET', `/tasks/${parent.id}/sessions`)).data;
  assert.equal(sessions.find(s => s.id === future.id).assigned_to, users[2]);
  for (const id of [past.id, completed.id]) {
    assert.equal(sessions.find(s => s.id === id).assigned_to, users[1]);
    assert.deepEqual(sessions.find(s => s.id === id).assigned_users.map(u => u.id).sort(), [users[0], users[1]].sort());
  }
  assert.equal(sessions.find(s => s.id === exception.id).assigned_to, users[0]);
  const reset = await call('PUT', `/tasks/${parent.id}/sessions/${exception.id}`, { session_assignment_mode: 'inherited' });
  assert.equal(reset.status, 200); assert.equal(reset.data.assigned_to, users[2]);
  assert.equal(reset.data.session_assignment_mode, 'inherited');
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.scheduled_work.percentage, 25);
  assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${completed.id}`, { session_assignment_mode: 'override', assigned_to: users[2] })).status, 409);
});


test('assignment overrides resolve the effective primary default and approved task moves are atomic', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key,value) VALUES ('google_refresh_token','fixture')").run();
  for (const id of ['assignment-a','assignment-b']) db.prepare("INSERT OR IGNORE INTO google_calendar_selection (calendar_id,name,enabled,access_role) VALUES (?,?,1,'writer')").run(id,id);
  for (const [user, cal] of [[users[1], 'assignment-a'],[users[2], 'assignment-b']]) db.prepare('INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)').run(`calendar_default_target:user:${user}`, `google:${cal}`);
  const parent = await task({ assigned_to: [users[1], users[0]] });
  const inherited = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: undefined })).data;
  const exception = await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: undefined,
    session_assignment_mode: 'override', assigned_to: users[2], assigned_users: [users[2], users[0]] });
  assert.equal(exception.status, 201, JSON.stringify(exception));
  assert.equal(exception.data.target_google_calendar_id, 'assignment-b');
  assert.equal((await call('GET', `/tasks/${parent.id}/session-targets?session_id=${exception.data.id}`)).data.default_target, 'google:assignment-b');
  assert.equal((await call('GET', `/tasks/${parent.id}/session-targets?assigned_to=${users[2]}`)).data.default_target, 'google:assignment-b');
  const rejected = await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[2], users[0]],
    session_calendar_moves: [{ session_id: inherited.id, publication_target: 'google:missing-calendar' }] });
  assert.equal(rejected.status, 400);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.assigned_to, users[1]);
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`)).data.find(s => s.id === inherited.id).assigned_to, users[1]);
  const retained = await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[2], users[0]] });
  assert.equal(retained.status, 200);
  let sessions = (await call('GET', `/tasks/${parent.id}/sessions`)).data;
  assert.equal(sessions.find(s => s.id === inherited.id).target_google_calendar_id, 'assignment-a');
  assert.equal(sessions.find(s => s.id === exception.data.id).assigned_to, users[2]);
  const approved = await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[1], users[0]],
    session_calendar_moves: [{ session_id: inherited.id, publication_target: 'google:assignment-b' }] });
  assert.equal(approved.status, 200, JSON.stringify(approved));
  sessions = (await call('GET', `/tasks/${parent.id}/sessions`)).data;
  assert.equal(sessions.find(s => s.id === inherited.id).target_google_calendar_id, 'assignment-b');
  assert.equal(sessions.find(s => s.id === inherited.id).id, inherited.id);
  const forbidden = await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[2]],
    session_calendar_moves: [{ session_id: exception.data.id, publication_target: 'google:assignment-a' }] });
  assert.equal(forbidden.status, 400);
});

test('invalid override participants and primary choices reject without changing the session', async () => {
  const parent = await task({ assigned_to: [users[0]] });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  for (const body of [
    { session_assignment_mode: 'unknown' },
    { session_assignment_mode: 'override', assigned_to: users[1], assigned_users: [users[0]] },
    { session_assignment_mode: 'override', assigned_to: users[1], assigned_users: [users[1], users[1]] },
    { session_assignment_mode: 'override', assigned_to: 999999 },
    { session_assignment_mode: 'override', assigned_to: users[1], assigned_users: [] },
    { session_assignment_mode: 'inherited', assigned_to: users[1] },
  ]) assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, body)).status, 400);
  db.prepare("INSERT INTO access_permissions (subject_type,subject_id,resource_type,resource_key,access) VALUES ('user',?,'module','calendar','none')").run(String(users[2]));
  try {
    assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { session_assignment_mode: 'override', assigned_to: users[2] })).status, 400);
    assert.equal((await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[2]] })).status, 400);
  } finally { db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(users[2])); }
  const current = (await call('GET', `/tasks/${parent.id}/sessions`)).data[0];
  assert.equal(current.session_assignment_mode, 'inherited'); assert.equal(current.assigned_to, users[0]);
  assert.equal(current.start_datetime, session.start_datetime);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.assigned_to, users[0]);
});


test('editing elapsed inherited work preserves historical participants after parent reassignment', async () => {
  const parent = await task({ assigned_to: [users[1], users[0]] });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, start_datetime: '2001-01-01T10:00' })).data;
  await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[2], users[0]] });
  const edited = await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { session_assignment_mode: 'inherited', duration_minutes: 60 });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.assigned_to, users[1]);
  assert.deepEqual(edited.data.assigned_users, session.assigned_users);
});


test('ordinary scheduling self-assignment also updates existing unassigned future inherited plans', async () => {
  const parent = await task({ assigned_to: [users[1]] });
  const existing = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  assert.equal((await call('PUT', `/tasks/${parent.id}`, { assigned_to: [] })).status, 200);
  const unassigned = (await call('GET', `/tasks/${parent.id}/sessions`)).data[0];
  assert.equal(unassigned.assigned_to, null); assert.deepEqual(unassigned.assigned_users, []);
  const made = await call('POST', `/tasks/${parent.id}/sessions`, interval);
  assert.equal(made.status, 201);
  const current = (await call('GET', `/tasks/${parent.id}/sessions`)).data.find(s => s.id === existing.id);
  assert.equal(current.assigned_to, users[0]);
  assert.deepEqual(current.assigned_users.map(u => u.id), [users[0]]);
  assert.equal(current.id, existing.id); assert.equal(current.start_datetime, existing.start_datetime);
});
