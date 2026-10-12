/** Ticket 12: real assignment commands and injected provider transport boundaries. */
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'session-moves-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
const db = (await import('../server/db.js')).get();
const users = ['move-owner', 'move-primary', 'move-no-default'].map(name => Number(db.prepare("INSERT INTO users (username,display_name,password_hash,role) VALUES (?,?,'x','member')").run(name, name).lastInsertRowid));
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.authUserId = users[0]; req.authRole = 'member'; req.session = { userId: users[0] }; next(); });
app.use('/tasks', (await import('../server/routes/tasks.js')).default);
app.use('/calendar', (await import('../server/routes/calendar.js')).default);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
test.after(() => new Promise(resolve => server.close(resolve)));
async function call(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...(response.status === 204 ? {} : await response.json()) };
}
async function ok(method, path, body, status = 200) {
  const result = await call(method, path, body);
  assert.equal(result.status, status, JSON.stringify(result));
  return result.data;
}
const interval = { start_datetime: '2090-03-31T10:00', tzid: 'UTC' };
const task = (fields = {}) => ok('POST', '/tasks', { title: 'Calendar move', start_date: '2000-01-01', assigned_to: [users[0], users[1]], ...fields }, 201);
const sessions = parent => ok('GET', `/tasks/${parent.id}/sessions`);
const path = (parent, session) => `/tasks/${parent.id}/sessions/${session.id}`;
const override = primary => ({ session_assignment_mode: 'override', assigned_to: primary, assigned_users: [primary, users[0]] });
const google = await import('../server/services/google-calendar.js');
const remote = new Map();
const key = (calendarId, eventId) => `${calendarId}|${eventId}`;
const client = {
  colors: { get: async () => ({ data: { event: {} } }) },
  calendarList: { get: async ({ calendarId }) => ({ data: { id: calendarId, summary: calendarId, accessRole: 'writer', timeZone: 'UTC' } }) },
  events: {
    list: async ({ calendarId }) => ({ data: { items: [...remote.values()].filter(e => e.calendarId === calendarId), nextSyncToken: 'fixture' } }),
    insert: async ({ calendarId, requestBody }) => {
      const id = key(calendarId, requestBody.id);
      if (remote.has(id)) throw Object.assign(new Error('Already exists'), { code: 409 });
      remote.set(id, { ...requestBody, calendarId }); return { data: remote.get(id) };
    },
    get: async ({ calendarId, eventId }) => ({ data: remote.get(key(calendarId, eventId)) }),
    patch: async ({ calendarId, eventId, requestBody }) => { const id = key(calendarId, eventId); remote.set(id, { ...remote.get(id), ...requestBody }); return { data: remote.get(id) }; },
    delete: async ({ calendarId, eventId }) => { remote.delete(key(calendarId, eventId)); return {}; },
  },
};
const syncGoogle = () => google.sync({ calendarClient: client });
db.prepare("INSERT OR REPLACE INTO sync_config (key,value) VALUES ('google_refresh_token','fixture')").run();
for (const id of ['deliberate', 'new-default']) db.prepare("INSERT INTO google_calendar_selection (calendar_id,name,enabled,access_role) VALUES (?,?,1,'writer')").run(id, id);
db.prepare('INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)').run(`calendar_default_target:user:${users[1]}`, 'google:new-default');
async function published(parent, fields = {}) {
  const session = await ok('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: 'google:deliberate', ...fields }, 201);
  await syncGoogle();
  const current = (await sessions(parent)).find(s => s.id === session.id);
  assert.equal(current.external_source, 'google');
  assert.ok(remote.has(key('deliberate', current.external_calendar_id)));
  return current;
}
async function cleanup(parent) { await ok('DELETE', `/tasks/${parent.id}`); await syncGoogle(); }

test('session reassignment declines then approves moving a published deliberate destination', async () => {
  const parent = await task();
  const session = await published(parent);
  const targets = await ok('GET', `/tasks/${parent.id}/session-targets?assigned_to=${users[1]}`);
  assert.equal(targets.default_target, 'google:new-default');
  const retained = await ok('PUT', path(parent, session), override(users[1]));
  assert.equal(retained.assigned_to, users[1]);
  assert.deepEqual(retained.assigned_users.map(u => u.id).sort(), [users[0], users[1]].sort());
  await syncGoogle();
  assert.ok(remote.has(key('deliberate', session.external_calendar_id)));
  assert.equal((await sessions(parent))[0].target_google_calendar_id, 'deliberate');
  assert.equal((await ok('GET', `/tasks/${parent.id}/session-targets?session_id=${session.id}`)).default_target, 'google:new-default');
  await ok('PUT', path(parent, session), { ...override(users[1]), publication_target: 'google:new-default' });
  await syncGoogle(); await syncGoogle();
  const moved = (await sessions(parent))[0];
  assert.equal(moved.id, session.id); assert.equal(moved.target_google_calendar_id, 'new-default');
  assert.equal(remote.size, 1); assert.ok(!remote.has(key('deliberate', session.external_calendar_id)));
  assert.ok(remote.has(key('new-default', moved.external_calendar_id)));
  assert.equal((await ok('GET', `/tasks/${parent.id}`)).assigned_to, users[0]);
  await cleanup(parent); assert.equal(remote.size, 0);
});

test('task reassignment moves only approved future inherited publications and preserves exceptions and history', async () => {
  const parent = await task();
  const approved = await published(parent);
  const declined = await published(parent);
  const past = await published(parent, { start_datetime: '2001-01-01T10:00' });
  const complete = await published(parent);
  await ok('POST', `${path(parent, complete)}/complete`, {});
  const exception = await published(parent, override(users[1]));
  const before = await sessions(parent);
  const rejected = await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[1], users[0]], session_calendar_moves: [
    { session_id: approved.id, publication_target: 'google:new-default' },
    { session_id: declined.id, publication_target: 'google:missing' },
  ] });
  assert.equal(rejected.status, 400);
  assert.equal((await ok('GET', `/tasks/${parent.id}`)).assigned_to, users[0]);
  assert.deepEqual(await sessions(parent), before, 'invalid choice rolls back all session decisions');
  for (const excluded of [past, complete, exception]) {
    assert.equal((await call('PUT', `/tasks/${parent.id}`, { assigned_to: [users[1], users[0]], session_calendar_moves: [{ session_id: excluded.id, publication_target: 'google:new-default' }] })).status, 400);
    assert.equal((await ok('GET', `/tasks/${parent.id}`)).assigned_to, users[0]);
  }
  await ok('PUT', `/tasks/${parent.id}`, { assigned_to: [users[1], users[0]], session_calendar_moves: [{ session_id: approved.id, publication_target: 'google:new-default' }] });
  await syncGoogle(); await syncGoogle();
  const rows = await sessions(parent);
  for (const session of [approved, declined]) {
    const row = rows.find(s => s.id === session.id);
    assert.equal(row.assigned_to, users[1]);
    assert.deepEqual(row.assigned_users.map(u => u.id).sort(), users.slice(0, 2).sort());
    assert.equal(row.target_google_calendar_id, session.id === approved.id ? 'new-default' : 'deliberate');
  }
  for (const session of [past, complete, exception]) {
    const row = rows.find(s => s.id === session.id);
    assert.equal(row.assigned_to, session.assigned_to);
    assert.equal(row.target_google_calendar_id, 'deliberate');
    assert.ok(remote.has(key('deliberate', session.external_calendar_id)));
  }
  assert.equal(remote.size, 5);
  await cleanup(parent); assert.equal(remote.size, 0);
});

test('restricted first publication and a missing usable default require explicit choices after reassignment', async () => {
  const parent = await task({ visibility: 'assignees' });
  await ok('PUT', `/tasks/${parent.id}`, { assigned_to: [users[1], users[0]] });
  const targets = await ok('GET', `/tasks/${parent.id}/session-targets?assigned_to=${users[1]}`);
  assert.equal(targets.default_target, 'google:new-default'); assert.equal(targets.explicit_required, true);
  assert.equal((await call('POST', `/tasks/${parent.id}/sessions`, interval)).status, 409);
  assert.deepEqual(await sessions(parent), []);
  const local = await ok('POST', `/tasks/${parent.id}/sessions`, { ...interval, publication_target: 'local' }, 201);
  await ok('PUT', path(parent, local), override(users[1]));
  await syncGoogle(); assert.equal(remote.size, 0, 'assignment cannot consent to an external audience');
  await ok('PUT', path(parent, local), { ...override(users[1]), publication_target: 'google:new-default' });
  await syncGoogle(); assert.equal(remote.size, 1);
  await cleanup(parent);

  db.prepare("INSERT INTO google_calendar_selection (calendar_id,name,enabled,access_role) VALUES ('read-only','Read only',1,'reader')").run();
  db.prepare('INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)').run(`calendar_default_target:user:${users[2]}`, 'google:read-only');
  const noDefault = await task({ assigned_to: [users[2], users[0]] });
  const choices = await ok('GET', `/tasks/${noDefault.id}/session-targets?assigned_to=${users[2]}`);
  assert.equal(choices.default_target, null); assert.equal(choices.explicit_required, true);
  assert.equal((await call('POST', `/tasks/${noDefault.id}/sessions`, interval)).status, 409);
  assert.equal((await call('POST', `/tasks/${noDefault.id}/sessions`, { ...interval, publication_target: 'google:read-only' })).status, 400);
  const effectiveDefault = await ok('POST', `/tasks/${noDefault.id}/sessions`, { ...interval, ...override(users[1]) }, 201);
  assert.equal(effectiveDefault.target_google_calendar_id, 'new-default', 'new override uses effective primary rather than parent or actor');
  await ok('DELETE', path(noDefault, effectiveDefault), null, 204);
  const deliberate = await published(noDefault, override(users[1]));
  const before = await sessions(noDefault);
  assert.equal((await call('PUT', path(noDefault, deliberate), { ...override(users[2]), publication_target: null })).status, 400);
  assert.deepEqual(await sessions(noDefault), before);
  await ok('PUT', path(noDefault, deliberate), { ...override(users[2]), publication_target: 'google:new-default' });
  await syncGoogle(); await syncGoogle();
  assert.equal((await sessions(noDefault))[0].target_google_calendar_id, 'new-default');
  assert.equal(remote.size, 1);
  await cleanup(noDefault); assert.equal(remote.size, 0);
});

for (const provider of ['caldav', 'outlook']) {
  test(`assignment-approved Google to ${provider} transfer retains the original after lost response and converges on retry/reload`, async () => {
    const objects = new Map(); let loseResponse = true;
    let destination, syncDestination;
    if (provider === 'caldav') {
      const dav = await import('../server/services/caldav-sync.js');
      const account = Number(db.prepare("INSERT INTO caldav_accounts (name,caldav_url,username,password) VALUES ('Moves DAV','https://moves.example','fixture','fixture')").run().lastInsertRowid);
      const url = 'https://moves.example/calendar/';
      db.prepare("INSERT INTO caldav_calendar_selection (account_id,calendar_url,calendar_name,enabled,write_capability) VALUES (?,?,'Moves',1,'write')").run(account, url);
      destination = `caldav:${account}|${url}`;
      const davClient = {
        fetchCalendars: async () => [{ url, displayName: 'Moves', writable: true, components: ['VEVENT'] }],
        fetchCalendarObjects: async () => [...objects.values()],
        createCalendarObject: async ({ filename, iCalString }) => {
          if (objects.has(url + filename)) return { ok: false, status: 412 };
          objects.set(url + filename, { url: url + filename, data: iCalString, etag: 'fixture' });
          if (loseResponse) { loseResponse = false; throw new Error('Lost DAV transfer response'); }
          return { ok: true };
        },
        updateCalendarObject: async ({ calendarObject }) => { objects.set(calendarObject.url, calendarObject); return { ok: true }; },
        deleteCalendarObject: async ({ calendarObject }) => { objects.delete(calendarObject.url); return { ok: true }; },
      };
      syncDestination = () => dav.sync({ createClient: async () => davClient });
    } else {
      process.env.MS_CLIENT_ID = 'fixture'; process.env.MS_CLIENT_SECRET = 'fixture'; process.env.MS_REDIRECT_URI = 'http://fixture';
      const outlook = await import('../server/services/outlook-calendar.js');
      const account = Number(db.prepare("INSERT INTO outlook_accounts (name,access_token,refresh_token,token_expiry,auto_sync_calendar_id,owner_user_id) VALUES ('Moves Graph','fixture','fixture','2099-01-01T00:00:00Z','moves',?)").run(users[1]).lastInsertRowid);
      db.prepare("INSERT INTO outlook_calendar_selection (account_id,calendar_id,calendar_name,enabled,can_edit) VALUES (?,'moves','Moves',1,1)").run(account);
      destination = `outlook:${account}|moves`;
      const fetchImpl = async (url, options = {}) => {
        const method = options.method || 'GET'; const body = options.body ? JSON.parse(options.body) : null;
        if (method === 'POST') {
          assert.ok(body.transactionId, 'task session publication carries retry identity');
          const id = body.transactionId;
          objects.set(id, { ...body, id, changeKey: 'fixture' });
          if (loseResponse) { loseResponse = false; throw new Error('Lost Graph transfer response'); }
          return Response.json(objects.get(id), { status: 201 });
        }
        const id = decodeURIComponent(url.split('/').at(-1));
        if (method === 'PATCH') { objects.set(id, { ...objects.get(id), ...body }); return Response.json(objects.get(id)); }
        if (method === 'DELETE') { objects.delete(id); return new Response(null, { status: 204 }); }
        return Response.json({ value: [...objects.values()] });
      };
      syncDestination = () => outlook.sync({ fetchImpl });
    }
    db.prepare('INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)').run(`calendar_default_target:user:${users[1]}`, destination);
    const parent = await task();
    const original = await published(parent);
    assert.equal((await ok('GET', `/tasks/${parent.id}/session-targets?assigned_to=${users[1]}`)).default_target, destination);
    // Exercise both assignment command seams against actual provider publications.
    if (provider === 'caldav') await ok('PUT', path(parent, original), { ...override(users[1]), publication_target: destination });
    else await ok('PUT', `/tasks/${parent.id}`, { assigned_to: [users[1], users[0]], session_calendar_moves: [{ session_id: original.id, publication_target: destination }] });
    await syncDestination();
    const failed = (await sessions(parent))[0];
    assert.equal(failed.id, original.id); assert.equal(failed.assigned_to, users[1]);
    assert.equal(failed.external_source, 'google'); assert.equal(failed.external_calendar_id, original.external_calendar_id);
    assert.equal(failed.target_google_calendar_id, 'deliberate'); assert.ok(failed.session_pending_target);
    assert.equal((await ok('GET', `/calendar/${original.id}`)).sync.state, 'error');
    assert.ok(remote.has(key('deliberate', original.external_calendar_id)), 'original survives ambiguous replacement');
    assert.equal(objects.size, 1, 'fixture actually created replacement before losing its response');
    await syncDestination(); await syncGoogle();
    const reloaded = (await sessions(parent))[0];
    assert.equal(reloaded.id, original.id); assert.equal(reloaded.assigned_to, users[1]);
    assert.equal(reloaded.session_pending_target, null);
    if (provider === 'caldav') assert.equal(reloaded.external_source, 'caldav');
    else assert.equal(reloaded.target_outlook_calendar_id, 'moves');
    assert.equal(remote.size, 0, 'original is deleted only after successful replacement');
    assert.equal(objects.size, 1);
    await syncDestination(); await syncGoogle();
    assert.equal((await sessions(parent)).length, 1); assert.equal(objects.size, 1); assert.equal(remote.size, 0);
    await ok('DELETE', `/tasks/${parent.id}`); await syncDestination(); await syncGoogle();
    assert.equal(objects.size, 0, 'deleting reloaded task leaves no replacement orphan');
    assert.equal(remote.size, 0);
    const cancelledParent = await task();
    const retained = await published(cancelledParent);
    await ok('PUT', path(cancelledParent, retained), { ...override(users[1]), publication_target: destination });
    loseResponse = true;
    await syncDestination();
    assert.ok(remote.has(key('deliberate', retained.external_calendar_id)));
    await ok('PUT', path(cancelledParent, retained), { publication_target: 'google:deliberate' });
    await syncDestination(); await syncGoogle(); await syncDestination();
    const cancelled = (await sessions(cancelledParent))[0];
    assert.equal(cancelled.assigned_to, users[1], 'cancelling transfer preserves the intended assignment');
    assert.equal(cancelled.target_google_calendar_id, 'deliberate');
    assert.equal(cancelled.session_pending_target, null);
    assert.equal(objects.size, 0, 'cancelling removes an uncertain replacement');
    assert.equal(remote.size, 1); assert.ok(remote.has(key('deliberate', retained.external_calendar_id)));
    await cleanup(cancelledParent); assert.equal(remote.size, 0);
    db.prepare('INSERT OR REPLACE INTO sync_config (key,value) VALUES (?,?)').run(`calendar_default_target:user:${users[1]}`, 'google:new-default');
  });
}
