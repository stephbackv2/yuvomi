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
async function drag(page, taskId, view) {
  const column = view === 'day' ? '#day-col' : `.week-view__col[data-date="${today}"]`;
  await page.$eval(view === 'day' ? '#day-scroll' : '#week-scroll', el => { el.scrollTop = 400; });
  const point = await page.$eval(column, el => {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 10 / 24 + 5 };
  });
  const card = await page.$(`[data-plannable-task-id="${taskId}"]`);
  assert.ok(card);
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
    await page.setViewport({ width: 1440, height: 950 });
    await page.setDragInterception(true);
    // The existing fixture's authenticated member owns an initially unassigned task.
    const parent = (await request(page, 'post', '/tasks', { title: 'Drag fixture task', due_date: today, start_date: '2000-01-01', is_recurring: true, recurrence_rule: 'FREQ=DAILY' })).data;
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'day'));
    await gotoRoute(page, '/calendar');
    await page.waitForSelector(`[data-plannable-task-id="${parent.id}"]`);
    assert.match(await page.$eval(`[data-task-id="${parent.id}"]`, el => el.textContent), /Deadline:/);
    console.log('Panel loaded; dragging first allocation');
    const first = await drag(page, parent.id, 'day');
    console.log('First allocation created; dragging again');
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
    console.log('Allocations survived reload; opening task details');
    await page.click(`[data-task-session][data-id="${first.id}"]`);
    await page.waitForFunction(() => document.querySelector('.task-detail-sheet, .detail-view, #shared-modal-overlay')?.textContent.includes('Drag fixture task'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    console.log('Task details opened; scheduling shared task');
    const shared = (await request(page, 'post', '/tasks', { title: 'Shared drag task', assigned_to: [fixture.other, unchanged.assigned_to] })).data;
    await page.evaluate(() => localStorage.setItem('yuvomi:calendar:view', 'week'));
    await gotoRoute(page, '/calendar');
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
  } finally { await harness.close(); }
});
