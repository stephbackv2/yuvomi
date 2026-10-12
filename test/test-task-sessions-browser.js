/** Real browser drag from the basic task source and normal calendar rendering. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';
const today = new Date().toISOString().slice(0, 10);
const fixture = {};
function seed(path) {
  const db = new Database(path);
  try {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')").run();
    db.prepare("UPDATE tasks SET start_date = '2099-01-01'").run();
    const actor = db.prepare("SELECT id FROM users WHERE username = 'linda'").get().id;
    const other = db.prepare("SELECT id FROM users WHERE username = 'alex'").get().id;
    fixture.other = other;
    db.prepare("INSERT OR REPLACE INTO sync_config (key,value) VALUES ('google_refresh_token','browser-fixture'), ('google_readonly','0')").run();
    db.prepare("INSERT INTO google_calendar_selection (calendar_id,name,enabled,access_role) VALUES ('browser-task-move','Browser task calendar',1,'writer')").run();
    for (const provider of ['mealie', 'tandoor']) {
      const account = db.prepare("INSERT INTO recipe_provider_accounts (name, base_url, api_token, provider, created_by) VALUES (?, ?, 'x', ?, ?)").run(provider, `https://${provider}.example.com`, provider, actor).lastInsertRowid;
      const recipe = db.prepare(`INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, instructions, provider_instructions_version)
        VALUES (?, ?, ?, 'bread', ?, 1)`).run(`${provider} bread`, actor, account, JSON.stringify(['Mix dough', 'Bake bread'])).lastInsertRowid;
      fixture[provider] = Number(db.prepare(`INSERT INTO meals (date, meal_type, title, recipe_id, created_by) VALUES (?, 'dinner', ?, ?, ?)`).run(today, provider, recipe, actor).lastInsertRowid);
    }
  } finally { db.close(); }
}
async function request(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const { api } = await import('/api.js'); return api[method](path, body);
  }, { method, path, body });
}
function calendarRead(page) {
  return page.waitForResponse(res => res.url().includes('/calendar?') && res.request().method() === 'GET', { timeout: 15000 });
}
async function renderedCalendar(page, read) {
  await read;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function drag(page, taskId, view) {
  const column = view === 'day' ? '#day-col' : `.week-view__col[data-date="${today}"]`;
  await page.$eval(view === 'day' ? '#day-scroll' : '#week-scroll', el => { el.scrollTop = 400; });
  const point = await page.$eval(column, el => {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 10 / 24 + 5 };
  });
  const card = await page.$(`[data-plannable-task-id="${taskId}"]`);
  assert.ok(card);
  await card.scrollIntoView();
  const response = page.waitForResponse(res => res.url().endsWith(`/tasks/${taskId}/sessions`) && res.request().method() === 'POST');
  await page.mouse.dragAndDrop(await card.clickablePoint(), point, { delay: 100 });
  await page.waitForSelector('#task-session-target:not([disabled])');
  await page.select('#task-session-target', 'local');
  await page.click('#task-session-form [type="submit"]');
  const res = await response;
  assert.equal(res.status(), 201, await res.text());
  const session = (await res.json()).data;
  await page.waitForSelector(`[data-task-session][data-id="${session.id}"]`);
  return session;
}

test('actual desktop panel schedules durable overlapping shared sessions, opens tasks, preserves deadlines; mobile reads; provider steps are readable', async () => {
  const harness = await startHarness({ seed });
  try {
    const page = await openPage(harness, { device: 'desktop', locale: 'en' });
    await page.setBypassServiceWorker(true);
    page.on('console', message => { if (message.type() === 'error') console.log('Browser error:', message.text()); });
    page.on('pageerror', error => console.log('Browser exception:', error.message));
    await page.setViewport({ width: 1440, height: 950 });
    await page.setDragInterception(true);
    // The existing fixture's authenticated member owns an initially unassigned task.
    const parent = (await request(page, 'post', '/tasks', { title: 'Drag fixture task', due_date: today, start_date: '2000-01-01', is_recurring: true, recurrence_rule: 'FREQ=DAILY' })).data;
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'day'));
    await gotoRoute(page, '/calendar');
    await page.waitForSelector(`[data-plannable-task-id="${parent.id}"]`);
    assert.match(await page.$eval(`[data-task-id="${parent.id}"]`, el => el.textContent), /Deadline:/);
    await page.setViewport({ width: 1024, height: 768 });
    for (const placement of ['beside', 'below']) {
      await page.select('#task-panel-placement', placement);
      for (const size of [160, 480]) {
        await page.$eval('#task-panel-size', (el, size) => { el.value = String(size); el.dispatchEvent(new Event('input', { bubbles: true })); }, size);
        await page.$eval(`[data-plannable-task-id="${parent.id}"]`, el => el.scrollIntoView({ block: 'nearest' }));
        // Today is intentionally hidden while the displayed range contains today.
        const usable = await page.evaluate(taskId => {
          const rect = document.querySelector('#cal-body').getBoundingClientRect();
          const visible = selector => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
          };
          return { calendar: { width: rect.width, height: rect.height }, controls: ['#cal-prev', '#cal-next', '#cal-view-tab-day', `[data-plannable-task-id="${taskId}"]`].map(selector => ({ selector, visible: visible(selector), rect: document.querySelector(selector).getBoundingClientRect().toJSON() })) };
        }, parent.id);
        assert.ok(usable.calendar.width > 200 && usable.calendar.height > 180 && usable.controls.every(control => control.visible), `calendar controls and task remain visible: ${placement}, ${size}: ${JSON.stringify(usable)}`);
      }
    }
    await page.select('#task-panel-placement', 'beside');
    await page.$eval('#task-panel-size', el => { el.value = '280'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.setViewport({ width: 1440, height: 950 });

    await page.select('#task-panel-allocation', 'unscheduled');
    await page.type('#task-panel-search', 'Drag fixture');
    console.log('Panel loaded; dragging filtered first allocation');
    const first = await drag(page, parent.id, 'day');
    await page.select('#task-panel-allocation', 'unscheduled');
    assert.equal(await page.$(`[data-plannable-task-id="${parent.id}"]`), null);
    await page.select('#task-panel-allocation', 'all');
    await page.$eval('#task-panel-search', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('#task-panel-search', 'no matching task');
    assert.equal(await page.$(`[data-plannable-task-id="${parent.id}"]`), null);
    await page.$eval('#task-panel-search', el => { el.value = 'Drag fixture'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForSelector(`[data-plannable-task-id="${parent.id}"]`);
    await page.select('#task-panel-placement', 'below');
    await page.$eval('#task-panel-size', el => { el.value = '240'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#task-panel-collapse');
    assert.equal(await page.$eval('#task-panel-collapse', el => el.getAttribute('aria-expanded')), 'false');
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await page.$eval('.calendar-workspace', el => el.dataset.taskPlacement), 'below');
    assert.equal(await page.$eval('#task-panel-collapse', el => el.getAttribute('aria-expanded')), 'false');
    await page.click('#task-panel-collapse');
    assert.equal(await page.$eval('#task-panel-size', el => el.value), '240');
    const layout = await page.evaluate(() => {
      const calendar = document.querySelector('#cal-body').getBoundingClientRect();
      const panel = document.querySelector('#calendar-task-panel').getBoundingClientRect();
      return { height: calendar.height, below: panel.top >= calendar.bottom - 1 };
    });
    assert.ok(layout.height > 200); assert.ok(layout.below);
    console.log('First allocation created; dragging again from below');
    const second = await drag(page, parent.id, 'day');
    assert.notEqual(first.id, second.id);
    assert.equal(Date.parse(first.end_datetime) - Date.parse(first.start_datetime), 1_800_000);
    assert.equal(new Date(first.start_datetime).getUTCMinutes() % 15, 0);
    const unchanged = (await request(page, 'get', `/tasks/${parent.id}`)).data;
    assert.equal(unchanged.due_date, today); assert.equal(unchanged.start_date, '2000-01-01'); assert.ok(unchanged.assigned_to);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector(`[data-task-session][data-id="${first.id}"]`);
    const rects = await page.evaluate(ids => ids.map(id => {
      const rect = document.querySelector(`[data-task-session][data-id="${id}"]`).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width };
    }), [first.id, second.id]);
    assert.notEqual(rects[0].x, rects[1].x); assert.ok(rects[0].width > 0);
    // Real pointer gestures use the same retained event identity, immediately
    // after creation. Disable HTML drag interception for pointer manipulation.
    await page.setDragInterception(false);
    async function gesture(id, edge, minutes) {
      await page.$eval(`[data-task-session][data-id="${id}"]`, el => el.scrollIntoView({ block: 'center' }));
      const selector = `[data-task-session][data-id="${id}"]${edge ? ` [data-resize-edge="${edge}"]` : ''}`;
      const point = await page.$eval(selector, el => {
        const r = el.getBoundingClientRect();
        const col = el.closest('.day-view__col');
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, hour: col.getBoundingClientRect().height / 24, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.outerHTML.slice(0, 180), col: col.getBoundingClientRect().toJSON() };
      });
      console.log('Session gesture', edge || 'move', point);
      const read = calendarRead(page);
      const response = page.waitForResponse(res => res.url().endsWith(`/tasks/${parent.id}/sessions/${id}`) && res.request().method() === 'PUT', { timeout: 15000 });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x, point.y + point.hour * minutes / 60, { steps: 10 });
      await page.mouse.up();
      const res = await response;
      assert.equal(res.status(), 200, await res.text());
      console.log('Session gesture saved', edge || 'move');
      await renderedCalendar(page, read);
      return (await res.json()).data;
    }
    const resized = await gesture(first.id, 'end', 30);
    assert.equal(Date.parse(resized.end_datetime) - Date.parse(resized.start_datetime), 60 * 60000);
    const moved = await gesture(first.id, null, 60);
    assert.equal(moved.id, first.id);
    assert.equal(Date.parse(moved.start_datetime) - Date.parse(resized.start_datetime), 60 * 60000);
    assert.equal(Date.parse(moved.end_datetime) - Date.parse(moved.start_datetime), 60 * 60000);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}/sessions`)).data.length, 2);
    await page.$eval('#task-panel-duration', el => { el.value = '45'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await page.$eval('#task-panel-duration', el => el.value), '45');
    await page.setDragInterception(true);
    const preferred = await drag(page, parent.id, 'day');
    assert.equal(Date.parse(preferred.end_datetime) - Date.parse(preferred.start_datetime), 45 * 60000);

    async function pickerDrop(view, target) {
      await page.evaluate(view => localStorage.setItem('yuvomi:calendar:view', view), view);
      await gotoRoute(page, '/calendar');
      await page.select('#task-panel-placement', 'beside');
      const card = await page.$(`[data-plannable-task-id="${parent.id}"]`);
      await card.scrollIntoView();
      const point = await page.$eval(target, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.dragAndDrop(await card.clickablePoint(), point, { delay: 100 });
      await page.waitForSelector('#task-session-form');
      assert.equal(await page.$eval('#task-session-start', el => el.value.slice(0, 10)), today);
      assert.equal(await page.$eval('#task-session-duration', el => el.value), '45');
    }
    await pickerDrop('month', `.month-day[data-date="${today}"]`);
    await page.click('#task-session-cancel');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    assert.equal((await request(page, 'get', `/tasks/${parent.id}/sessions`)).data.length, 3);
    await pickerDrop('day', `.allday-cell[data-date="${today}"]`);
    const pickerRead = calendarRead(page);
    const pickerResponse = page.waitForResponse(res => res.url().endsWith(`/tasks/${parent.id}/sessions`) && res.request().method() === 'POST');
    // Hold the real outgoing request to exercise dismissal during submission.
    page.removeAllListeners('request');
    let releaseSave, saveStarted;
    const heldSave = new Promise(resolve => { releaseSave = resolve; });
    const startedSave = new Promise(resolve => { saveStarted = resolve; });
    page.on('request', async req => {
      if (req.url().endsWith(`/tasks/${parent.id}/sessions`) && req.method() === 'POST') {
        saveStarted(); await heldSave;
      }
      if (new URL(req.url()).pathname === '/sw.js') await req.abort();
      else await req.continue();
    });
    if (await page.$('#task-session-target')) {
      await page.waitForSelector('#task-session-target:not([disabled])');
      await page.select('#task-session-target', 'local');
    }
    await page.click('#task-session-form [type="submit"]');
    await startedSave;
    try {
      assert.equal(await page.$eval('#task-session-cancel', el => el.disabled), true);
      await page.keyboard.press('Escape');
      assert.ok(await page.$('#task-session-form'));
      await page.click('#shared-modal-overlay [data-action="close-modal"]');
      assert.ok(await page.$('#task-session-form'));
    } finally { releaseSave(); }
    assert.equal((await pickerResponse).status(), 201);
    page.removeAllListeners('request');
    page.on('request', req => {
      if (new URL(req.url()).pathname === '/sw.js') req.abort();
      else req.continue();
    });
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    await renderedCalendar(page, pickerRead);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}/sessions`)).data.length, 4);
    console.log('Allocations survived reload; opening task details');
    await page.click(`[data-task-session][data-id="${first.id}"]`);
    await page.waitForFunction(() => document.querySelector('.task-detail-sheet, .detail-view, #shared-modal-overlay')?.textContent.includes('Drag fixture task'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    await page.click(`[data-task-session][data-id="${first.id}"]`);
    await page.waitForSelector(`[data-session-edit="${first.id}"]`);
    await page.click(`[data-session-edit="${first.id}"]`);
    await page.waitForSelector('#task-session-form');
    await page.$eval('#task-session-duration', el => { el.value = '90'; });
    const detailRead = calendarRead(page);
    const detailResponse = page.waitForResponse(res => res.url().endsWith(`/tasks/${parent.id}/sessions/${first.id}`) && res.request().method() === 'PUT');
    if (await page.$('#task-session-target')) {
      await page.waitForSelector('#task-session-target:not([disabled])');
      await page.select('#task-session-target', 'local');
    }
    await page.click('#task-session-form [type="submit"]');
    assert.equal((await detailResponse).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    await renderedCalendar(page, detailRead);
    const edited = (await request(page, 'get', `/tasks/${parent.id}/sessions`)).data.find(s => s.id === first.id);
    assert.equal(Date.parse(edited.end_datetime) - Date.parse(edited.start_datetime), 90 * 60000);
    await page.click(`[data-task-session][data-id="${first.id}"]`);
    await page.waitForSelector(`[data-session-remove="${preferred.id}"]`);
    await page.click(`[data-session-remove="${preferred.id}"]`);
    await page.waitForFunction(id => !document.querySelector(`[data-session-remove="${id}"]`), {}, preferred.id);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}/sessions`)).data.length, 3);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}`)).data.due_date, today);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    console.log('Task details opened; scheduling shared task');
    const shared = (await request(page, 'post', '/tasks', { title: 'Shared drag task', assigned_to: [fixture.other, unchanged.assigned_to] })).data;
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'week'));
    await gotoRoute(page, '/calendar');
    await page.select('#task-panel-placement', 'beside');
    await page.select('#task-panel-assignee', String(fixture.other));
    await page.waitForSelector(`[data-plannable-task-id="${shared.id}"]`);
    const sharedSession = await drag(page, shared.id, 'week');
    assert.equal(sharedSession.assigned_to, fixture.other); assert.equal(sharedSession.assigned_users.length, 2);
    for (const view of ['month', 'agenda']) {
      await page.evaluate(view => localStorage.setItem('yuvomi:calendar:view', view), view);
      await gotoRoute(page, '/calendar');
      await page.waitForSelector(`[data-id="${first.id}"]`);
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'day'));
    await gotoRoute(page, '/calendar');
    assert.equal(await page.$eval('#calendar-task-panel', el => getComputedStyle(el).display), 'none');
    await page.waitForSelector(`[data-task-session][data-id="${first.id}"]`);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60000)));
    for (const provider of ['mealie', 'tandoor']) {
      await gotoRoute(page, '/meals');
      await page.click(`.meal-card[data-meal-id="${fixture[provider]}"] .meal-card__open`);
      await page.waitForSelector('.recipe-reader');
      const steps = await page.$$eval('.recipe-reader li', els => els.map(el => el.textContent));
      assert.ok(steps.some(step => step.includes('Mix dough'))); assert.ok(steps.some(step => step.includes('Bake bread')));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    }
    assert.equal((await request(page, 'get', '/tasks?include_future=1')).data.filter(t => t.recurrence_origin_id === parent.id).length, 0);
    const past = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: '2001-01-01T10:00', tzid: 'UTC' })).data;
    const future = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: '2090-01-01T10:00', tzid: 'UTC' })).data;
    await request(page, 'patch', `/tasks/${parent.id}/status`, { status: 'done' });
    const history = (await request(page, 'get', `/tasks/${parent.id}/sessions`)).data;
    assert.ok(history.some(session => session.id === past.id));
    assert.ok(!history.some(session => session.id === future.id));
    await request(page, 'delete', `/tasks/${parent.id}`);
    const remaining = (await request(page, 'get', `/calendar?from=2001-01-01&to=2090-01-02`)).data;
    assert.ok(!remaining.some(session => session.task_id === parent.id));
  } catch (error) { console.error(error); throw error; }
  finally { await harness.close(); }
});

test('agenda checkboxes complete shared sessions and show scheduled work separately from subtasks', async () => {
  const harness = await startHarness({ seed });
  try {
    const page = await openPage(harness, { device: 'desktop', locale: 'en' });
    await page.setBypassServiceWorker(true);
    const parent = (await request(page, 'post', '/tasks', { title: 'Weighted browser work' })).data;
    await request(page, 'post', '/tasks', { title: 'Independent child', parent_task_id: parent.id });
    const a = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: `${today}T10:00`, duration_minutes: 30, tzid: 'UTC' })).data;
    const b = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: `${today}T12:00`, duration_minutes: 90, tzid: 'UTC' })).data;
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'agenda'));
    await gotoRoute(page, '/calendar');
    const completed = page.waitForResponse(res => res.url().endsWith(`/sessions/${a.id}/complete`) && res.request().method() === 'POST');
    await page.click(`[data-session-complete="${a.id}"]`);
    assert.equal((await completed).status(), 200);
    await page.waitForSelector(`[data-session-complete="${a.id}"]:checked:disabled`);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}`)).data.scheduled_work.percentage, 25);
    await page.click(`.agenda-event[data-id="${a.id}"]`);
    await page.waitForSelector('.task-sessions [data-scheduled-work]');
    assert.match(await page.$eval('.task-sessions', el => el.textContent), /Scheduled work: 25%/);
    assert.match(await page.$eval('.task-sessions', el => el.textContent), /Subtasks: 0\/1/);
    assert.equal(await page.$(`[data-session-edit="${a.id}"]`), null);
    const finished = page.waitForResponse(res => res.url().endsWith(`/sessions/${b.id}/complete`) && res.request().method() === 'POST');
    await page.click(`.task-sessions [data-session-complete="${b.id}"]`);
    assert.equal((await finished).status(), 200);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}`)).data.status, 'done');
  } catch (error) { console.error(error); throw error; }
  finally { await harness.close(); }
});

test('session assignment override retains destinations, cancels coherently, returns to inherited and reopens editable history', async () => {
  const harness = await startHarness({ seed });
  try {
    const page = await openPage(harness, { device: 'desktop', locale: 'en' });
    await page.setBypassServiceWorker(true);
    const parent = (await request(page, 'post', '/tasks', { title: 'Assignment browser work' })).data;
    const original = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: `${today}T10:00`, tzid: 'UTC' })).data;
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'agenda'));
    await gotoRoute(page, '/calendar');
    const openEditor = async () => {
      await page.click(`.agenda-event[data-id="${original.id}"]`);
      await page.waitForSelector(`[data-session-edit="${original.id}"]`);
      await page.click(`[data-session-edit="${original.id}"]`);
      await page.waitForSelector('#task-session-primary');
      await page.waitForSelector('#task-session-form [type="submit"]:not([disabled])');
    };
    await openEditor();
    await page.select('#task-session-mode', 'override');
    await page.select('#task-session-primary', String(fixture.other));
    await page.waitForSelector('#task-session-move-group:not([hidden])');
    await page.waitForSelector('#task-session-form [type="submit"]:not([disabled])');
    await page.select('#task-session-move', 'move');
    await page.waitForSelector('#task-session-target:not([disabled])');
    assert.equal(await page.$eval('#task-session-target', el => el.value), '', 'no connected default requires an explicit destination');
    await page.click('#task-session-cancel');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    let current = (await request(page, 'get', `/tasks/${parent.id}/sessions`)).data[0];
    assert.equal(current.assigned_to, original.assigned_to);
    assert.equal(current.session_assignment_mode, 'inherited');
    await openEditor();
    await page.select('#task-session-mode', 'override');
    await page.select('#task-session-primary', String(fixture.other));
    await page.waitForSelector('#task-session-form [type="submit"]:not([disabled])');
    const saved = page.waitForResponse(res => res.url().endsWith(`/sessions/${original.id}`) && res.request().method() === 'PUT');
    await page.click('#task-session-form [type="submit"]');
    const override = await saved;
    assert.equal(override.status(), 200, await override.text());
    const payload = JSON.parse(override.request().postData());
    assert.equal(payload.assigned_to, fixture.other);
    assert.ok(payload.assigned_users.includes(fixture.other));
    assert.ok(!Object.hasOwn(payload, 'publication_target'), 'retain omits publication move');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    current = (await request(page, 'get', `/tasks/${parent.id}/sessions`)).data[0];
    assert.equal(current.session_assignment_mode, 'override');
    assert.equal(current.assigned_to, fixture.other);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}`)).data.assigned_to, original.assigned_to);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector(`.agenda-event[data-id="${original.id}"] .event-assignees__segment`);
    assert.ok((await page.$$eval(`.agenda-event[data-id="${original.id}"] .event-assignees__segment`, els => els.map(el => el.title))).length >= 1);
    await openEditor();
    await page.select('#task-session-mode', 'inherited');
    await page.waitForSelector('#task-session-form [type="submit"]:not([disabled])');
    await page.select('#task-session-move', 'move');
    await page.waitForSelector('#task-session-target:not([disabled])');
    await page.select('#task-session-target', 'local');
    const inherited = page.waitForResponse(res => res.url().endsWith(`/sessions/${original.id}`) && res.request().method() === 'PUT');
    await page.click('#task-session-form [type="submit"]');
    const inheritedResponse = await inherited;
    assert.equal(inheritedResponse.status(), 200, await inheritedResponse.text());
    assert.ok(!Object.hasOwn(JSON.parse(inheritedResponse.request().postData()), 'assigned_to'));
    assert.equal(JSON.parse(inheritedResponse.request().postData()).publication_target, 'local');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    await request(page, 'post', `/tasks/${parent.id}/sessions/${original.id}/complete`, {});
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector(`[data-session-reopen="${original.id}"]`);
    const reopened = page.waitForResponse(res => res.url().endsWith(`/sessions/${original.id}/reopen`) && res.request().method() === 'POST');
    await page.click(`[data-session-reopen="${original.id}"]`);
    assert.equal((await reopened).status(), 200);
    await page.waitForSelector(`[data-session-complete="${original.id}"]:not(:checked):not([disabled])`);
    assert.equal((await request(page, 'get', `/tasks/${parent.id}`)).data.status, 'in_progress');
    await openEditor();
    await page.$eval('#task-session-duration', el => { el.value = '75'; });
    const edited = page.waitForResponse(res => res.url().endsWith(`/sessions/${original.id}`) && res.request().method() === 'PUT');
    await page.click('#task-session-form [type="submit"]');
    assert.equal((await edited).status(), 200);
    current = (await request(page, 'get', `/tasks/${parent.id}/sessions`)).data[0];
    assert.equal(current.id, original.id);
    assert.equal(Date.parse(current.end_datetime) - Date.parse(current.start_datetime), 75 * 60000);
  } finally { await harness.close(); }
});

test('task reassignment reviews only future inherited plans and preserves cancelled changes and overrides', async () => {
  const harness = await startHarness({ seed });
  try {
    const page = await openPage(harness, { device: 'desktop', locale: 'en' });
    await page.setBypassServiceWorker(true);
    const parent = (await request(page, 'post', '/tasks', { title: 'Future reassignment browser' })).data;
    const inherited = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: '2090-01-01T10:00', tzid: 'UTC' })).data;
    const exception = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: '2090-01-02T10:00', tzid: 'UTC', session_assignment_mode: 'override', assigned_to: fixture.other, assigned_users: [fixture.other] })).data;
    const past = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { publication_target: 'local', start_datetime: '2001-01-01T10:00', tzid: 'UTC' })).data;
    const edit = async () => {
      await gotoRoute(page, '/tasks');
      await page.click(`[data-action="open-task"][data-id="${parent.id}"]`);
      await page.waitForSelector('#detail-view-edit', { visible: true });
      await page.click('#detail-view-edit');
      await page.waitForSelector('#task-form', { visible: true });
      await page.click('.user-ms__option:has([data-ms-input="task_assigned"].user-ms__none)');
      await page.click(`.user-ms__option:has([data-ms-input="task_assigned"][value="${fixture.other}"])`);
    };
    await edit();
    await page.click('#task-submit-btn');
    await page.waitForSelector('[data-session-move-choices]');
    assert.deepEqual(await page.$$eval('[data-move-session]', rows => rows.map(row => Number(row.dataset.moveSession))), [inherited.id]);
    await page.select('[data-move-decision]', 'move');
    assert.equal(await page.$eval('[data-move-target]', el => el.value), '');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay') || document.querySelector('#confirm-modal-ok'));
    if (await page.$('#confirm-modal-ok')) await page.click('#confirm-modal-ok');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    assert.equal((await request(page, 'get', `/tasks/${parent.id}`)).data.assigned_to, inherited.assigned_to);
    await edit();
    await page.click('#task-submit-btn');
    await page.waitForSelector('[data-session-move-choices]');
    const save = page.waitForResponse(res => res.url().endsWith(`/tasks/${parent.id}`) && res.request().method() === 'PUT');
    await page.click('#task-submit-btn');
    const response = await save;
    assert.equal(response.status(), 200, await response.text());
    assert.ok(!Object.hasOwn(JSON.parse(response.request().postData()), 'session_calendar_moves'));
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    const sessions = (await request(page, 'get', `/tasks/${parent.id}/sessions`)).data;
    assert.equal(sessions.find(session => session.id === inherited.id).assigned_to, fixture.other);
    assert.equal(sessions.find(session => session.id === exception.id).session_assignment_mode, 'override');
    assert.equal(sessions.find(session => session.id === past.id).assigned_to, past.assigned_to);
    await gotoRoute(page, '/tasks');
    await page.click(`[data-action="open-task"][data-id="${parent.id}"]`);
    await page.waitForSelector('#detail-view-edit', { visible: true });
    await page.click('#detail-view-edit');
    await page.waitForSelector('#task-form', { visible: true });
    await page.click('.user-ms__option:has([data-ms-input="task_assigned"].user-ms__none)');
    await page.click(`.user-ms__option:has([data-ms-input="task_assigned"][value="${inherited.assigned_to}"])`);
    await page.click('#task-submit-btn');
    await page.waitForSelector('[data-session-move-choices]');
    await page.select('[data-move-decision]', 'move');
    assert.equal(await page.$eval('[data-move-target]', el => el.value), '', 'no default requires explicit writable choice');
    await page.select('[data-move-target]', 'google:browser-task-move');
    const approved = page.waitForResponse(res => res.url().endsWith(`/tasks/${parent.id}`) && res.request().method() === 'PUT');
    await page.click('#task-submit-btn');
    const approvedResponse = await approved;
    assert.equal(approvedResponse.status(), 200, await approvedResponse.text());
    assert.deepEqual(JSON.parse(approvedResponse.request().postData()).session_calendar_moves, [{ session_id: inherited.id, publication_target: 'google:browser-task-move' }]);
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    const published = (await request(page, 'get', `/tasks/${parent.id}/sessions`)).data;
    assert.equal(published.find(session => session.id === inherited.id).target_google_calendar_id, 'browser-task-move');
    assert.equal(published.find(session => session.id === exception.id).target_google_calendar_id, null);
    const users = (await request(page, 'get', '/auth/users')).data;
    const primary = users[1].id;
    const ordered = (await request(page, 'post', '/tasks', { title: 'Preserve second DOM primary', assigned_to: [primary, users[0].id] })).data;
    const allocation = (await request(page, 'post', `/tasks/${ordered.id}/sessions`, { publication_target: 'local', start_datetime: '2090-01-03T10:00', tzid: 'UTC' })).data;
    await gotoRoute(page, '/tasks');
    await page.click(`[data-action="open-task"][data-id="${ordered.id}"]`);
    await page.waitForSelector('#detail-view-edit', { visible: true });
    await page.click('#detail-view-edit');
    await page.waitForSelector('#task-form', { visible: true });
    await page.$eval('#task-form [name="title"]', el => { el.value += ' edited'; });
    const unrelated = page.waitForResponse(res => res.url().endsWith(`/tasks/${ordered.id}`) && res.request().method() === 'PUT');
    await page.click('#task-submit-btn');
    const unrelatedResponse = await unrelated;
    assert.equal(unrelatedResponse.status(), 200, await unrelatedResponse.text());
    assert.equal(JSON.parse(unrelatedResponse.request().postData()).assigned_to[0], primary);
    assert.equal(await page.$('[data-session-move-choices]'), null);
    assert.equal((await request(page, 'get', `/tasks/${ordered.id}/sessions`)).data.find(session => session.id === allocation.id).assigned_to, primary);
  } finally { await harness.close(); }
});

test('existing session can explicitly change destination without reassignment and cancel a failed pending transfer', async () => {
  const harness = await startHarness({ seed(path) {
    seed(path);
    const db = new Database(path);
    try {
      const actor = db.prepare("SELECT id FROM users WHERE username='linda'").get().id;
      db.prepare("INSERT INTO google_calendar_selection (calendar_id,name,enabled,access_role) VALUES ('browser-writable','Browser writable calendar',1,'writer')").run();
      fixture.pendingTask = Number(db.prepare("INSERT INTO tasks (title,created_by,assigned_to) VALUES ('Failed transfer browser',?,?)").run(actor,actor).lastInsertRowid);
      db.prepare('INSERT INTO task_assignments (task_id,user_id) VALUES (?,?)').run(fixture.pendingTask,actor);
      fixture.pendingSession = Number(db.prepare(`INSERT INTO calendar_events (title,start_datetime,end_datetime,tzid,created_by,assigned_to,task_id,session_status,session_assignment_mode,session_pending_target,sync_state,sync_error)
        VALUES ('Failed transfer browser',?,?,'UTC',?,?,?,'unfinished','inherited',?,'error','Transfer failed')`).run(`${today}T19:00:00Z`,`${today}T19:30:00Z`,actor,actor,fixture.pendingTask,JSON.stringify({target_google_calendar_id:'browser-writable'})).lastInsertRowid);
      db.prepare('INSERT INTO event_assignments (event_id,user_id) VALUES (?,?)').run(fixture.pendingSession,actor);
    } finally { db.close(); }
  } });
  try {
    const page = await openPage(harness, { device: 'desktop', locale: 'en' });
    await page.setBypassServiceWorker(true);
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'agenda'));
    await gotoRoute(page, '/calendar');
    await page.click(`.agenda-event[data-id="${fixture.pendingSession}"]`);
    await page.waitForSelector(`[data-session-edit="${fixture.pendingSession}"]`);
    await page.click(`[data-session-edit="${fixture.pendingSession}"]`);
    await page.waitForSelector('#task-session-form [type="submit"]:not([disabled])');
    await page.select('#task-session-move', 'move');
    await page.waitForSelector('#task-session-target:not([disabled])');
    assert.equal(await page.$eval('#task-session-target', el => el.value), 'local', 'original destination can cancel failed transfer');
    assert.ok(await page.$('#task-session-target option[value="google:browser-writable"]'), 'existing local session can choose a writable external destination');
    const save = page.waitForResponse(res => res.url().endsWith(`/sessions/${fixture.pendingSession}`) && res.request().method() === 'PUT');
    await page.click('#task-session-form [type="submit"]');
    const response = await save;
    assert.equal(response.status(),200,await response.text());
    assert.equal(JSON.parse(response.request().postData()).publication_target,'local');
    const session = (await request(page,'get',`/tasks/${fixture.pendingTask}/sessions`)).data[0];
    assert.equal(session.id,fixture.pendingSession);
    assert.equal(session.session_pending_target,null);
    assert.equal(session.target_google_calendar_id,null);
  } finally { await harness.close(); }
});
