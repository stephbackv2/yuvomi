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
    const past = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { start_datetime: '2001-01-01T10:00', tzid: 'UTC' })).data;
    const future = (await request(page, 'post', `/tasks/${parent.id}/sessions`, { start_datetime: '2090-01-01T10:00', tzid: 'UTC' })).data;
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
