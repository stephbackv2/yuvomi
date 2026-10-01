/**
 * Bring recipe exporter tests.
 *
 * No requests leave the process: an injected fetch implementation records the
 * private API request shape and returns deterministic Response objects.
 * Run with: node --test test/test-bring-recipes-export.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BringExportError,
  BringRecipeClient,
  exportBringRecipes,
} from '../tools/bring/export-recipes.mjs';

const AUTH = {
  uuid: 'private-user-id',
  publicUuid: 'public-user-id',
  access_token: 'access-token',
  token_type: 'Bearer',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createFetch(pages, { loginStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.endsWith('/v2/bringauth')) {
      return jsonResponse(loginStatus === 200 ? AUTH : { error: 'invalid_grant' }, loginStatus);
    }
    const offset = Number(url.searchParams.get('offset'));
    if (!pages.has(offset)) return jsonResponse({ entries: [], count: 0, total: 0 });
    return jsonResponse(pages.get(offset));
  };
  return { calls, fetchImpl };
}

test('exportBringRecipes authenticates, paginates mine, and exports only recipes', async () => {
  const pages = new Map([
    [0, {
      entries: [
        { type: 'RECIPE', content: { uuid: 'r1', name: 'Soup', ingredients: [] } },
        { type: 'TEMPLATE', content: { uuid: 't1', name: 'Weekly shop', items: [] } },
      ],
      count: 2,
      total: 4,
    }],
    [2, {
      entries: [
        { type: 'POST', content: { uuid: 'ad1', title: 'Promotion' } },
        { content: { uuid: 'r2', type: 'RECIPE', name: 'Cake', newFutureField: true } },
      ],
      count: 2,
      total: 4,
    }],
  ]);
  const { calls, fetchImpl } = createFetch(pages);

  const result = await exportBringRecipes({
    email: 'cook@example.com',
    password: 'secret',
    fetchImpl,
    baseUrl: 'http://127.0.0.1:1234/rest/',
    pageSize: 2,
    now: () => new Date('2026-09-22T12:00:00.000Z'),
  });

  assert.equal(result.format, 'yuvomi-bring-recipes');
  assert.equal(result.exportedAt, '2026-09-22T12:00:00.000Z');
  assert.equal(result.sourceCount, 4);
  assert.equal(result.sourceTotal, 4);
  assert.equal(result.recipeCount, 2);
  assert.equal(result.templateCount, 0);
  assert.deepEqual(result.recipes.map((entry) => entry.content.uuid), ['r1', 'r2']);
  assert.equal(result.recipes[1].content.newFutureField, true, 'unknown Bring fields are preserved');

  assert.equal(calls.length, 3);
  const loginBody = calls[0].options.body;
  assert.equal(loginBody.get('email'), 'cook@example.com');
  assert.equal(loginBody.get('password'), 'secret');
  assert.equal(calls[1].url.searchParams.get('filterTags'), 'mine');
  assert.equal(calls[1].url.searchParams.get('offset'), '0');
  assert.equal(calls[2].url.searchParams.get('offset'), '2');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer access-token');
  assert.equal(calls[1].options.headers['X-BRING-USER-UUID'], 'private-user-id');
  assert.equal(calls[1].options.headers['X-BRING-PUBLIC-USER-UUID'], 'public-user-id');
});

test('exportBringRecipes optionally includes list templates but never POST entries', async () => {
  const pages = new Map([[0, {
    entries: [
      { type: 'RECIPE', content: { uuid: 'r1' } },
      { type: 'TEMPLATE', content: { uuid: 't1' } },
      { type: 'POST', content: { uuid: 'p1' } },
    ],
    count: 3,
    total: 3,
  }]]);
  const { fetchImpl } = createFetch(pages);

  const result = await exportBringRecipes({
    email: 'cook@example.com',
    password: 'secret',
    includeTemplates: true,
    fetchImpl,
    baseUrl: 'http://localhost:1234/rest/',
  });

  assert.deepEqual(result.recipes.map((entry) => entry.content.uuid), ['r1']);
  assert.deepEqual(result.templates.map((entry) => entry.content.uuid), ['t1']);
  assert.equal(result.recipeCount, 1);
  assert.equal(result.templateCount, 1);
});

test('BringRecipeClient rejects repeated pages instead of producing duplicate exports', async () => {
  const repeated = {
    entries: [{ type: 'RECIPE', content: { uuid: 'r1' } }],
    count: 1,
    total: 3,
  };
  const { fetchImpl } = createFetch(new Map([[0, repeated], [1, repeated]]));
  const client = new BringRecipeClient({
    email: 'cook@example.com',
    password: 'secret',
    fetchImpl,
    baseUrl: 'http://127.0.0.1:1234/rest/',
    pageSize: 1,
  });
  await client.login();

  await assert.rejects(() => client.getAllInspirations(), /pagination did not advance/);
});

test('authentication failures expose only the status, not credentials or response body', async () => {
  const { fetchImpl } = createFetch(new Map(), { loginStatus: 401 });

  await assert.rejects(
    () => exportBringRecipes({
      email: 'cook@example.com',
      password: 'very-secret-password',
      fetchImpl,
      baseUrl: 'http://127.0.0.1:1234/rest/',
    }),
    (error) => {
      assert.ok(error instanceof BringExportError);
      assert.equal(error.status, 401);
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /separate Bring password/);
      assert.doesNotMatch(error.message, /very-secret-password|invalid_grant/);
      return true;
    },
  );
});

test('malformed Inspiration responses fail instead of silently exporting nothing', async () => {
  const { fetchImpl } = createFetch(new Map([[0, { count: 0, total: 0 }]]));
  const client = new BringRecipeClient({
    email: 'cook@example.com',
    password: 'secret',
    fetchImpl,
    baseUrl: 'http://127.0.0.1:1234/rest/',
  });
  await client.login();

  await assert.rejects(() => client.getAllInspirations(), /missing entries\[\]/);
});

test('exportBringRecipes hydrates recipe cards through their pinned contentSrcUrl', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname.endsWith('/v2/bringauth')) return jsonResponse(AUTH);
    if (url.pathname.endsWith('/inspirations')) {
      return jsonResponse({
        entries: [{
          type: 'TEMPLATE',
          content: {
            uuid: 'summary-id',
            name: 'Soup',
            contentSrcUrl: 'http://127.0.0.1:1234/rest/v2/bringtemplates/content/detail-id',
          },
        }],
        count: 1,
        total: 1,
      });
    }
    if (url.pathname.endsWith('/bringtemplates/content/detail-id')) {
      return jsonResponse({
        content: {
          uuid: 'detail-id',
          items: [{ itemId: 'Carrot', spec: '2', stock: false }],
        },
      });
    }
    return jsonResponse({}, 404);
  };

  const result = await exportBringRecipes({
    email: 'cook@example.com',
    password: 'secret',
    includeTemplates: true,
    fetchImpl,
    baseUrl: 'http://127.0.0.1:1234/rest/',
  });

  assert.equal(result.hydrated, true);
  assert.equal(result.templates[0].content.name, 'Soup', 'summary fields remain available');
  assert.equal(result.templates[0].content.uuid, 'detail-id', 'detail fields override summary fields');
  assert.deepEqual(result.templates[0].content.items, [{ itemId: 'Carrot', spec: '2', stock: false }]);
  assert.equal(calls.filter((path) => path.includes('/bringtemplates/content/')).length, 1);
});

test('recipe detail fetching refuses to send auth headers to an untrusted contentSrcUrl', async () => {
  const { fetchImpl } = createFetch(new Map());
  const client = new BringRecipeClient({
    email: 'cook@example.com',
    password: 'secret',
    fetchImpl,
    baseUrl: 'http://127.0.0.1:1234/rest/',
  });
  await client.login();

  await assert.rejects(
    () => client.getTemplateContent('https://attacker.example/steal-token'),
    /outside the expected template endpoint/,
  );
});
