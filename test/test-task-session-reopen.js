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
test('sole completed session reopens the parent once and reverses recurrence and rewards', async () => {
  for (const user of users.slice(0, 2)) db.prepare('INSERT OR REPLACE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(user);
  const parent = await task({ assigned_to: users.slice(0, 2), points: 7, is_recurring: true, recurrence_rule: 'FREQ=DAILY' });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions/${session.id}/complete`, {})).status, 200);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.status, 'done');
  assert.equal((await call('GET', `/tasks/${parent.id}/completions`)).data.length, 1);
  assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 60 })).status, 409);
  const successor = (await call('GET', '/tasks?include_future=1')).data.find(row => row.recurrence_origin_id === parent.id);
  assert.ok(successor);
  for (let i = 0; i < 2; i++) {
    const reopened = await call('POST', `/tasks/${parent.id}/sessions/${session.id}/reopen`, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened));
    assert.equal(reopened.data.id, session.id);
    assert.equal(reopened.data.task_id, parent.id);
    assert.equal(reopened.data.session_status, 'unfinished');
    assert.equal(reopened.data.session_completed_at, null);
    assert.equal(reopened.data.session_completed_by, null);
    assert.deepEqual(reopened.data.assigned_users, session.assigned_users);
  }
  const updated = (await call('GET', `/tasks/${parent.id}`)).data;
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.scheduled_work.percentage, 0);
  assert.equal((await call('GET', `/tasks/${parent.id}/completions`)).data.length, 0);
  assert.equal((await call('GET', `/tasks/${successor.id}`)).status, 404);
  const ledger = (await call('GET', '/rewards/ledger')).data.filter(entry => entry.task_id === parent.id);
  assert.equal(ledger.length, 0);
  assert.equal(ledger.reduce((total, entry) => total + entry.delta, 0), 0);
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`)).data.length, 1);
  assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 60 })).status, 200);
});

test('reopening final work retains earlier completion and a modified successor with independent calendar work', async () => {
  const parent = await task({ is_recurring: true, recurrence_rule: 'FREQ=DAILY' });
  const first = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, duration_minutes: 30 })).data;
  const final = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, duration_minutes: 90 })).data;
  await call('POST', `/tasks/${parent.id}/sessions/${first.id}/complete`, {});
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.scheduled_work.percentage, 25);
  await call('POST', `/tasks/${parent.id}/sessions/${final.id}/complete`, {});
  const successor = (await call('GET', '/tasks?include_future=1')).data.find(row => row.recurrence_origin_id === parent.id);
  assert.equal((await call('PUT', `/tasks/${successor.id}`, { title: 'Changed successor', start_date: '2000-01-01' })).status, 200);
  const ownSession = await call('POST', `/tasks/${successor.id}/sessions`, interval);
  assert.equal(ownSession.status, 201, JSON.stringify(ownSession));
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', `/tasks/${parent.id}/sessions/${final.id}/reopen`, {})).status, 200);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.scheduled_work.percentage, 25);
  const sessions = (await call('GET', `/tasks/${parent.id}/sessions`)).data;
  assert.equal(sessions.find(row => row.id === first.id).session_status, 'completed');
  assert.equal(sessions.find(row => row.id === final.id).session_status, 'unfinished');
  assert.equal((await call('GET', `/tasks/${successor.id}`)).data.title, 'Changed successor');
  assert.deepEqual((await call('GET', `/tasks/${successor.id}/sessions`)).data, [ownSession.data]);
  assert.equal((await call('GET', `/calendar/${ownSession.data.id}`)).data.task_id, successor.id);
  await call('POST', `/tasks/${parent.id}/sessions/${final.id}/complete`, {});
  assert.equal((await call('GET', '/tasks?include_future=1')).data.filter(row => row.recurrence_origin_id === parent.id).length, 1);
});

test('published sessions reopen with one external event, historical participants and selected calendar', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key,value) VALUES ('google_refresh_token','fixture')").run();
  db.prepare("INSERT INTO google_calendar_selection (calendar_id,name,enabled,access_role) VALUES ('reopen-cal','Work',1,'writer')").run();
  const google = await import('../server/services/google-calendar.js');
  const remote = new Map(); let creates = 0;
  const client = {
    colors: { get: async () => ({ data: { event: {} } }) },
    calendarList: { get: async ({ calendarId }) => ({ data: { id: calendarId, summary: 'Work', accessRole: 'writer', timeZone: 'UTC' } }) },
    events: {
      list: async () => ({ data: { items: [...remote.values()], nextSyncToken: 'fixture' } }),
      insert: async ({ requestBody }) => { creates++; remote.set(requestBody.id, requestBody); return { data: requestBody }; },
      get: async ({ eventId }) => ({ data: remote.get(eventId) }),
      patch: async ({ eventId, requestBody }) => { remote.set(eventId, { ...remote.get(eventId), ...requestBody }); return { data: remote.get(eventId) }; },
      delete: async ({ eventId }) => { remote.delete(eventId); return {}; },
    },
  };
  const parent = await task({ assigned_to: users.slice(0, 2) });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: 'google:reopen-cal' })).data;
  await google.sync({ calendarClient: client });
  const published = (await call('GET', `/tasks/${parent.id}/sessions`)).data[0];
  assert.equal(published.external_source, 'google');
  await call('POST', `/tasks/${parent.id}/sessions/${session.id}/complete`, {});
  await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[0]] });
  for (let i = 0; i < 2; i++) {
    assert.equal((await call('POST', `/tasks/${parent.id}/sessions/${session.id}/reopen`, {})).status, 200);
    await google.sync({ calendarClient: client });
  }
  const reopened = (await call('GET', `/tasks/${parent.id}/sessions`)).data[0];
  for (const key of ['id', 'task_id', 'session_publication_uid', 'external_calendar_id', 'calendar_ref_id', 'target_google_calendar_id']) assert.equal(reopened[key], published[key], key);
  assert.deepEqual(reopened.assigned_users, published.assigned_users);
  assert.equal(creates, 1); assert.equal(remote.size, 1);
  assert.ok(remote.has(published.external_calendar_id));
  await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 75 });
  await google.sync({ calendarClient: client });
  const external = remote.get(published.external_calendar_id);
  assert.equal(Date.parse(external.end.dateTime) - Date.parse(external.start.dateTime), 75 * 60000);
  assert.equal(creates, 1); assert.equal(remote.size, 1);
});

test('reopening advances the revision once and keeps archival history and removed allocations', async () => {
  const parent = await task();
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  const future = (await call('POST', `/tasks/${parent.id}/sessions`, { ...interval, start_datetime: '2091-01-01T10:00' })).data;
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions/${session.id}/complete`, {})).status, 200);
  assert.equal((await call('PATCH', `/tasks/${parent.id}/status`, { status: 'done' })).status, 200);
  const completedRead = await call('GET', `/tasks/${parent.id}/sessions`);
  assert.equal(completedRead.status, 200, JSON.stringify(completedRead));
  assert.equal(completedRead.data.length, 1, JSON.stringify(completedRead));
  const completed = completedRead.data[0];
  await call('PATCH', `/tasks/${parent.id}/archive`, { archived: true });
  const archived = (await call('GET', `/tasks/${parent.id}`)).data.archived_at;
  assert.ok(archived);
  const reopened = await call('POST', `/tasks/${parent.id}/sessions/${session.id}/reopen`, {});
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.edit_revision, completed.edit_revision + 1);
  assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 60, expected_revision: completed.revision })).status, 409);
  assert.equal((await call('PUT', `/tasks/${parent.id}/sessions/${session.id}`, { duration_minutes: 60, expected_revision: session.revision })).status, 409);
  const repeated = await call('POST', `/tasks/${parent.id}/sessions/${session.id}/reopen`, {});
  assert.equal(repeated.data.edit_revision, reopened.data.edit_revision);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.archived_at, archived);
  assert.deepEqual((await call('GET', `/tasks/${parent.id}/sessions`)).data.map(row => row.id), [session.id]);
  assert.equal((await call('GET', `/calendar/${future.id}`)).status, 404);
});

test('reopen enforces current parent visibility, task/session identity and both module scopes', async () => {
  const parent = await task({ visibility: 'assignees', assigned_to: users.slice(0, 2) });
  const session = (await call('POST', `/tasks/${parent.id}/sessions`, interval)).data;
  await call('POST', `/tasks/${parent.id}/sessions/${session.id}/complete`, {});
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions/${session.id}/reopen`, {}, users[2])).status, 404);
  scopes = ['tasks:write'];
  try { assert.equal((await call('POST', `/tasks/${parent.id}/sessions/${session.id}/reopen`, {})).status, 403); }
  finally { scopes = null; }
  const other = await task();
  assert.equal((await call('POST', `/tasks/${other.id}/sessions/${session.id}/reopen`, {})).status, 404);
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions/invalid/reopen`, {})).status, 400);
  assert.equal((await call('GET', `/tasks/${parent.id}`)).data.status, 'done');
  assert.equal((await call('GET', `/tasks/${parent.id}/sessions`)).data[0].session_status, 'completed');
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions/${session.id}/reopen`, {}, users[1])).status, 200);
});
