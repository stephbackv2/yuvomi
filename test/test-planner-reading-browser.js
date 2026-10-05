/** Real planner/calendar behavior using the existing isolated browser harness. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';

const today = new Date().toISOString().slice(0, 10);
let fixturePath;
const fixture = {};

function seedCalendar(dbPath) {
  fixturePath = dbPath;
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM calendar_events').run();
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')").run();
    const users = db.prepare("SELECT id, display_name, avatar_color FROM users WHERE username IN ('linda', 'marco') ORDER BY id").all();
    assert.equal(users.length, 2);
    fixture.users = users;
    fixture.calendarId = Number(db.prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('google', 'browser-fixture', 'Fixture calendar', '#587DCE')").run().lastInsertRowid);
    for (const [index, [name, color, assignees]] of [
      ['Explicit color', '#8156C0', users],
      ['Inherited color', null, users.slice(0, 1)],
      ['Neutral color', null, []],
    ].entries()) {
      const id = Number(db.prepare(`INSERT INTO calendar_events (title, start_datetime, end_datetime, color, created_by, assigned_to, calendar_ref_id, countdown)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(name, `${today}T23:${index * 15 === 0 ? '00' : index * 15}`, `${today}T23:59`, color,
          users[0].id, assignees[0]?.id ?? null, index === 2 ? null : fixture.calendarId).lastInsertRowid);
      for (const user of assignees) db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, user.id);
      fixture[name] = id;
    }
  } finally { db.close(); }
}

async function request(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const { api } = await import('/api.js');
    return api[method](path, body);
  }, { method, path, body });
}

async function closeReader(page, focusSelector) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#shared-modal-overlay', { hidden: true });
  if (focusSelector) assert.equal(await page.$eval(focusSelector, (el) => el === document.activeElement), true);
}

async function assertCard(page, selector, color, segments) {
  const rendered = await page.$eval(selector, (card) => {
    const css = getComputedStyle(card);
    const bar = card.querySelector('.event-assignees');
    return {
      color: card.style.getPropertyValue('--ev-color').trim() || card.querySelector('.event-item__bar')?.style.backgroundColor
        || card.style.getPropertyValue('--seal-accent').trim(),
      segments: [...card.querySelectorAll('.event-assignees__segment')].map((segment) => ({
        color: segment.style.backgroundColor, title: segment.title, width: segment.getBoundingClientRect().width,
      })),
      barHeight: bar ? bar.getBoundingClientRect().height : 0,
      height: card.getBoundingClientRect().height,
      visible: css.display !== 'none',
      label: card.getAttribute('aria-label') || card.title || card.textContent,
    };
  });
  // CSS serializes inline hex backgrounds as RGB while custom properties retain hex.
  const rgb = (hex) => `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
  assert.ok([color, rgb(color)].includes(rendered.color), JSON.stringify(rendered));
  assert.equal(rendered.segments.length, segments.length);
  assert.equal(rendered.visible, true);
  assert.ok(rendered.height > 0);
  for (const [index, user] of segments.entries()) {
    assert.equal(rendered.segments[index].color, rgb(user.avatar_color));
    assert.equal(rendered.segments[index].title, user.display_name);
    assert.ok(rendered.segments[index].width > 0);
    assert.ok(rendered.label.includes(user.display_name) || await page.$(`${selector} .avatar-stack`));
  }
  if (segments.length) assert.ok(rendered.barHeight > 0 && rendered.barHeight < rendered.height);
}

test('calendar and dashboard retain calendar colors and readable segmented assignments', async () => {
  const harness = await startHarness({ seed: seedCalendar });
  try {
    const page = await openPage(harness, { device: 'desktop', locale: 'en' });
    for (const device of ['desktop', 'mobile']) {
      await page.setViewport(device === 'desktop' ? { width: 1366, height: 900 } : { width: 390, height: 844 });
      for (const view of ['month', 'week', 'day', 'agenda']) {
        await page.evaluate((view) => localStorage.setItem('yuvomi:calendar:view', view), view);
        await gotoRoute(page, '/calendar');
        const type = { month: '.month-day__event', week: '.week-event', day: '.day-event', agenda: '.agenda-event' }[view];
        const selector = (name) => `${type}[data-id="${fixture[name]}"]`;
        await page.waitForSelector(selector('Explicit color'));
        await assertCard(page, selector('Explicit color'), '#8156C0', fixture.users);
        await assertCard(page, selector('Inherited color'), '#587DCE', fixture.users.slice(0, 1));
        await assertCard(page, selector('Neutral color'), '#8E8E93', []);
      }
      await gotoRoute(page, '/');
      const selector = (name) => `.event-item[data-route*="open=${fixture[name]}"]`;
      await page.waitForSelector(selector('Explicit color'));
      await assertCard(page, selector('Explicit color'), '#8156C0', fixture.users);
      await assertCard(page, selector('Inherited color'), '#587DCE', fixture.users.slice(0, 1));
    }
    // Simulate a provider calendar-color refresh; reload through real reads.
    const db = new Database(fixturePath);
    db.prepare('UPDATE external_calendars SET color = ? WHERE id = ?').run('#3CA368', fixture.calendarId);
    db.close();
    await gotoRoute(page, '/calendar');
    await assertCard(page, `.agenda-event[data-id="${fixture['Inherited color']}"]`, '#3CA368', fixture.users.slice(0, 1));
    await assertCard(page, `.agenda-event[data-id="${fixture['Explicit color']}"]`, '#8156C0', fixture.users);
  } finally { await harness.close(); }
});

test('planner recipe reading preserves quantities, actions, keyboard focus, drag and mobile layout', async () => {
  const harness = await startHarness();
  try {
    const page = await openPage(harness, { device: 'desktop', locale: 'en' });
    const recipe = (await request(page, 'post', '/recipes', {
      title: 'Reader fixture', notes: 'Legacy note <keep this>',
      recipe_url: 'https://example.org/fixture',
      instructions: Array.from({ length: 80 }, (_, index) => `Step ${index + 1}: stir carefully and simmer until ready.`),
      ingredients: [{ name: 'Fixture flour', quantity: '200 g' }],
    })).data;
    const createMeal = async (title, ingredients, recipeId = recipe.id) => (await request(page, 'post', '/meals', {
      date: today, meal_type: 'dinner', title, recipe_id: recipeId, ingredients,
    })).data;
    const planned = await createMeal('Planned reading', [{ name: 'Fixture flour', quantity: '400 g' }]);
    const fallback = await createMeal('Original fallback', []);
    const unlinked = await createMeal('Manual meal', [], null);
    await gotoRoute(page, '/meals');
    const button = (id) => `.meal-card[data-meal-id="${id}"] .meal-card__open`;
    await page.waitForSelector(button(planned.id));
    await page.focus(button(planned.id));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.recipe-reader');
    const text = await page.$eval('.recipe-reader', (el) => el.textContent);
    assert.match(text, /Planned meal quantities/);
    assert.match(text, /400 g Fixture flour/);
    assert.doesNotMatch(text, /800 g/);
    assert.match(text, /Step 80/);
    assert.match(text, /Legacy note <keep this>/);
    assert.equal(await page.$eval('.recipe-reader a[target="_blank"]', (el) => el.href), 'https://example.org/fixture');
    assert.equal(await page.$eval('[data-reader-page]', (el) => el.getAttribute('href')), `/recipes?open=${recipe.id}`);
    assert.equal(await page.$eval('.modal-panel__body', (el) => el.scrollHeight > el.clientHeight), true);
    await closeReader(page, button(planned.id));
    assert.ok((await page.url()).endsWith('/meals'));
    for (const action of ['edit-meal', 'open-linked-recipe', 'transfer-meal', 'delete-meal']) {
      assert.ok(await page.$(`.meal-card[data-meal-id="${planned.id}"] [data-action="${action}"]`));
    }
    await page.click(button(fallback.id));
    await page.waitForSelector('.recipe-reader');
    assert.match(await page.$eval('.recipe-reader', (el) => el.textContent), /Original recipe quantities[\s\S]*200 g Fixture flour/);
    await closeReader(page);
    const sidebar = `.recipe-sidebar__card[data-recipe-id="${recipe.id}"]`;
    await page.focus(sidebar);
    await page.keyboard.press('Space');
    await page.waitForSelector('.recipe-reader');
    assert.match(await page.$eval('.recipe-reader', (el) => el.textContent), /Original recipe quantities[\s\S]*200 g Fixture flour/);
    await closeReader(page, sidebar);
    await page.$eval(sidebar, (card) => {
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      card.click();
    });
    assert.equal(await page.$('.recipe-reader'), null);
    await page.click(`.meal-card[data-meal-id="${planned.id}"] [data-action="edit-meal"]`);
    await page.waitForSelector('#meal-title');
    await closeReader(page);
    await page.click(button(unlinked.id));
    await page.waitForSelector('#meal-title');
    await closeReader(page);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await gotoRoute(page, '/meals');
    await page.click(button(planned.id));
    await page.waitForSelector('.recipe-reader');
    assert.equal(await page.$eval('.modal-panel', (el) => el.getBoundingClientRect().width <= window.innerWidth), true);
    assert.match(await page.$eval('.recipe-reader', (el) => el.textContent), /400 g Fixture flour/);
    await closeReader(page);
  } finally { await harness.close(); }
});
