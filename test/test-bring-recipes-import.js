/**
 * Bring → Yuvomi recipe importer tests.
 * All Yuvomi HTTP calls use an injected fetch implementation.
 * Run with: node --test test/test-bring-recipes-import.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BringImportError,
  importBringRecipes,
  mapBringRecipe,
  planBringRecipeImport,
} from '../tools/bring/import-recipes.mjs';

function entry(id, title, rows, field = 'items') {
  return {
    type: 'TEMPLATE',
    content: {
      uuid: id,
      contentUuid: `content-${id}`,
      name: title,
      tagline: 'A useful note',
      linkOutUrl: 'https://recipes.example/item',
      [field]: rows,
    },
  };
}

function exportData(entries) {
  return {
    format: 'yuvomi-bring-recipes',
    version: 1,
    recipes: [],
    templates: entries,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('mapBringRecipe maps Bring items to Yuvomi ingredients', () => {
  const mapped = mapBringRecipe(entry('r1', 'Vegetable soup', [
    { itemId: 'Carrot', spec: '2 pieces', stock: false },
    { itemId: 'Milk', spec: '250 ml', stock: true },
  ]));

  assert.equal(mapped.bringId, 'content-r1');
  assert.equal(mapped.payload.title, 'Vegetable soup');
  assert.equal(mapped.payload.notes, 'A useful note');
  assert.equal(mapped.payload.recipe_url, 'https://recipes.example/item');
  assert.deepEqual(mapped.payload.ingredients, [
    { name: 'Carrot', quantity: '2 pieces', category: 'Obst & Gemüse' },
    { name: 'Milk', quantity: '250 ml', category: 'Milchprodukte' },
  ]);
});

test('mapBringRecipe prefers recipe ingredients and ignores empty rows', () => {
  const mapped = mapBringRecipe(entry('r2', 'Cake', [
    { itemId: 'Flour', spec: '200 g' },
    { itemId: '', spec: 'ignored' },
  ], 'ingredients'));

  assert.deepEqual(mapped.payload.ingredients, [
    { name: 'Flour', quantity: '200 g', category: 'Backwaren' },
  ]);
});

test('planBringRecipeImport skips existing titles and duplicate Bring entries', () => {
  const first = entry('r1', 'Soup', []);
  const duplicate = structuredClone(first);
  const plan = planBringRecipeImport(
    exportData([first, duplicate, entry('r2', 'Cake', [])]),
    [{ id: 10, title: 'cake' }],
  );

  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].payload.title, 'Soup');
  assert.equal(plan.skippedDuplicate.length, 1);
  assert.equal(plan.skippedExisting.length, 1);
});

test('importBringRecipes is a dry run by default and performs no POST', async () => {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    calls.push({ url: String(input), options });
    return jsonResponse({ data: [] });
  };

  const result = await importBringRecipes({
    exportData: exportData([entry('r1', 'Soup', [{ itemId: 'Carrot', spec: '2' }])]),
    yuvomiUrl: 'http://127.0.0.1:3000/',
    apiToken: 'token-secret',
    fetchImpl,
  });

  assert.equal(result.apply, false);
  assert.equal(result.planned, 1);
  assert.equal(result.created, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-secret');
});

test('importBringRecipes posts the validated plan when apply=true', async () => {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    calls.push({ url: String(input), options });
    if (options.method === 'GET') return jsonResponse({ data: [] });
    return jsonResponse({ data: { id: 42 } }, 201);
  };

  const result = await importBringRecipes({
    exportData: exportData([entry('r1', 'Soup', [{ itemId: 'Carrot', spec: '2' }])]),
    yuvomiUrl: 'http://localhost:3000',
    apiToken: 'token-secret',
    apply: true,
    fetchImpl,
  });

  assert.equal(result.created, 1);
  assert.deepEqual(result.createdLinks, [{ bringId: 'content-r1', yuvomiId: 42 }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.title, 'Soup');
  assert.deepEqual(payload.ingredients[0], {
    name: 'Carrot',
    quantity: '2',
    category: 'Obst & Gemüse',
  });
});

test('import refuses to send the Yuvomi token over non-local plain HTTP', async () => {
  await assert.rejects(
    () => importBringRecipes({
      exportData: exportData([]),
      yuvomiUrl: 'http://yuvomi.lan',
      apiToken: 'token-secret',
      fetchImpl: async () => jsonResponse({ data: [] }),
    }),
    (error) => error instanceof BringImportError && /plain HTTP/.test(error.message),
  );
});
