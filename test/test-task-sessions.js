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
let actor = users[0];
let scopes = null;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.authUserId = actor; req.authRole = 'member'; req.authScopes = scopes; req.session = { userId: actor }; next(); });
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
const interval = { start_datetime: '2090-03-31T10:00', tzid: 'Europe/Berlin' };
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
    const past = (await call('POST', `/tasks/${parent.id}/sessions`, { start_datetime: '2001-01-01T10:00', tzid: 'UTC' })).data;
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
  const made = await call('POST', `/tasks/${parent.id}/sessions`, { start_datetime: '2026-03-29T01:45', tzid: 'Europe/Berlin', duration_minutes: 45 });
  assert.equal(made.status, 201);
  assert.equal(made.data.end_datetime, '2026-03-29T01:30:00.000Z');
  const preciseParent = await task();
  const precise = await call('POST', `/tasks/${preciseParent.id}/sessions`, { start_datetime: '2026-03-29T01:45:00.333', tzid: 'Europe/Berlin', duration_minutes: 15 });
  assert.equal(precise.status, 201);
  assert.equal(precise.data.start_datetime, '2026-03-29T00:45:00.333Z');
  assert.equal(precise.data.end_datetime, '2026-03-29T01:00:00.333Z');
  const path = `/tasks/${parent.id}/sessions/${made.data.id}`;
  const moved = await call('PUT', path, { start_datetime: '2026-10-25T01:45', expected_revision: made.data.edit_revision });
  assert.equal(moved.status, 200);
  assert.equal(Date.parse(moved.data.end_datetime) - Date.parse(moved.data.start_datetime), 45 * 60_000);
  for (const body of [{ duration_minutes: 0 }, { duration_minutes: -15 }, { duration_minutes: '45' }, { start_datetime: '2026-03-29T02:15' }, { assigned_to: users[1] }]) {
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
