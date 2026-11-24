/**
 * Imports a hydrated Bring export as native Yuvomi recipes.
 *
 * The module deliberately talks to Yuvomi's normal recipe interface instead
 * of writing SQLite directly. That preserves validation, ownership, audit
 * behavior, and compatibility with remote/containerized installations.
 *
 * CLI:
 *   node tools/bring/import-recipes.mjs --input bring-recipes.json
 *   node tools/bring/import-recipes.mjs --input bring-recipes.json --apply
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { categorizeIngredient } from '../../server/services/recipe-providers/categorize.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class BringImportError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'BringImportError';
    if (status != null) this.status = status;
  }
}

function requiredString(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new BringImportError(`${name} is required`);
  return normalized;
}

function normalizeYuvomiUrl(value, allowInsecureHttp) {
  const url = new URL(requiredString(value, 'Yuvomi URL'));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BringImportError('Yuvomi URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new BringImportError('Yuvomi URL must not contain credentials');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !local && !allowInsecureHttp) {
    throw new BringImportError(
      'Refusing to send an API token over plain HTTP. Use HTTPS or set YUVOMI_ALLOW_INSECURE_HTTP=true for a trusted local network.',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  url.search = '';
  url.hash = '';
  return url;
}

function exportEntries(data) {
  const recipes = Array.isArray(data?.recipes) ? data.recipes : [];
  const templates = Array.isArray(data?.templates) ? data.templates : [];
  return [...recipes, ...templates];
}

function contentIdentity(content) {
  return String(content?.contentUuid || content?.uuid || '').trim() || null;
}

function normalizeTitle(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function ingredientRows(content) {
  if (Array.isArray(content?.ingredients) && content.ingredients.length) return content.ingredients;
  if (Array.isArray(content?.items)) return content.items;
  return [];
}

function combineNotes(content) {
  const parts = [content?.tagline, content?.text]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(parts)].join('\n\n') || null;
}

/** Convert one raw Bring Inspiration entry into Yuvomi's native recipe shape. */
export function mapBringRecipe(entry) {
  const content = entry?.content || {};
  const title = String(content.name || content.title || '').trim();
  if (!title) throw new BringImportError('Bring recipe has no title');

  const ingredients = ingredientRows(content)
    .map((item) => {
      const name = String(item?.itemId || item?.name || '').trim();
      if (!name) return null;
      return {
        name,
        quantity: String(item?.spec || item?.specification || '').trim() || null,
        category: categorizeIngredient({ foodName: name }),
      };
    })
    .filter(Boolean);

  return {
    bringId: contentIdentity(content),
    payload: {
      title,
      notes: combineNotes(content),
      recipe_url: String(content.linkOutUrl || '').trim() || null,
      ingredients,
    },
  };
}

/**
 * Build the full import plan before performing writes. Existing Yuvomi titles
 * are skipped case-insensitively so a repeated one-time import is safe.
 */
export function planBringRecipeImport(exportData, existingRecipes = []) {
  if (exportData?.format !== 'yuvomi-bring-recipes' || exportData?.version !== 1) {
    throw new BringImportError('Input is not a supported Yuvomi Bring recipe export');
  }

  const existingTitles = new Set(existingRecipes.map((recipe) => normalizeTitle(recipe?.title)).filter(Boolean));
  const seenBringIds = new Set();
  const seenTitles = new Set();
  const create = [];
  const skippedExisting = [];
  const skippedDuplicate = [];
  const invalid = [];

  for (const entry of exportEntries(exportData)) {
    let mapped;
    try {
      mapped = mapBringRecipe(entry);
    } catch (error) {
      invalid.push({ reason: error.message });
      continue;
    }

    const titleKey = normalizeTitle(mapped.payload.title);
    if (existingTitles.has(titleKey)) {
      skippedExisting.push({ bringId: mapped.bringId, title: mapped.payload.title });
      continue;
    }
    if ((mapped.bringId && seenBringIds.has(mapped.bringId)) || seenTitles.has(titleKey)) {
      skippedDuplicate.push({ bringId: mapped.bringId, title: mapped.payload.title });
      continue;
    }

    if (mapped.bringId) seenBringIds.add(mapped.bringId);
    seenTitles.add(titleKey);
    create.push(mapped);
  }

  return { create, skippedExisting, skippedDuplicate, invalid };
}

export class YuvomiClient {
  constructor({ baseUrl, apiToken, fetchImpl = globalThis.fetch, allowInsecureHttp = false }) {
    if (typeof fetchImpl !== 'function') throw new BringImportError('A fetch implementation is required');
    this.baseUrl = normalizeYuvomiUrl(baseUrl, allowInsecureHttp);
    this.apiToken = requiredString(apiToken, 'Yuvomi API token');
    this.fetch = fetchImpl;
  }

  async #request(path, options = {}) {
    let response;
    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        ...options,
        redirect: 'error',
        signal: options.signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
          ...options.headers,
        },
      });
    } catch (cause) {
      throw new BringImportError(`Yuvomi request failed: ${cause.message}`, { cause });
    }
    if (!response.ok) {
      throw new BringImportError(`Yuvomi request failed with HTTP ${response.status}`, {
        status: response.status,
      });
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new BringImportError('Yuvomi returned invalid JSON', { cause });
    }
  }

  async listRecipes() {
    const body = await this.#request('api/v1/recipes', { method: 'GET' });
    if (!Array.isArray(body.data)) throw new BringImportError('Yuvomi recipe response is missing data[]');
    return body.data;
  }

  async createRecipe(payload) {
    const body = await this.#request('api/v1/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!body.data?.id) throw new BringImportError('Yuvomi create-recipe response is missing data.id');
    return body.data;
  }

  async listShoppingItems(listId) {
    const body = await this.#request(`api/v1/shopping/${listId}/items`);
    if (!Array.isArray(body.data)) throw new BringImportError('Yuvomi shopping response is missing data[]');
    return body.data;
  }

  async changeShoppingItem(path, method, payload) {
    const body = await this.#request(`api/v1/shopping/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return body.data;
  }
}

export async function importBringRecipes({
  exportData,
  yuvomiUrl,
  apiToken,
  apply = false,
  rejectInvalid = false,
  fetchImpl = globalThis.fetch,
  allowInsecureHttp = false,
}) {
  const client = new YuvomiClient({
    baseUrl: yuvomiUrl,
    apiToken,
    fetchImpl,
    allowInsecureHttp,
  });
  const existing = await client.listRecipes();
  const plan = planBringRecipeImport(exportData, existing);
  if (rejectInvalid && plan.invalid.length) {
    throw new BringImportError(`Bring export contains ${plan.invalid.length} invalid recipes`);
  }
  const created = [];

  if (apply) {
    for (const recipe of plan.create) {
      const result = await client.createRecipe(recipe.payload);
      created.push({ bringId: recipe.bringId, yuvomiId: result.id });
    }
  }

  return {
    apply: Boolean(apply),
    planned: plan.create.length,
    created: created.length,
    withIngredients: plan.create.filter((recipe) => recipe.payload.ingredients.length > 0).length,
    withoutIngredients: plan.create.filter((recipe) => recipe.payload.ingredients.length === 0).length,
    skippedExisting: plan.skippedExisting.length,
    skippedDuplicate: plan.skippedDuplicate.length,
    invalid: plan.invalid.length,
    createdLinks: created,
  };
}

function parseCliArgs(args) {
  let inputPath = null;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--input' || arg === '-i') {
      inputPath = args[index + 1];
      index += 1;
      if (!inputPath) throw new BringImportError(`${arg} requires a path`);
    } else {
      throw new BringImportError(`Unknown argument: ${arg}`);
    }
  }
  return { inputPath: requiredString(inputPath, 'Input path'), apply };
}

async function main() {
  const { inputPath, apply } = parseCliArgs(process.argv.slice(2));
  const exportData = JSON.parse(await readFile(inputPath, 'utf8'));
  const result = await importBringRecipes({
    exportData,
    yuvomiUrl: process.env.YUVOMI_URL,
    apiToken: process.env.YUVOMI_API_TOKEN,
    allowInsecureHttp: process.env.YUVOMI_ALLOW_INSECURE_HTTP === 'true',
    apply,
  });

  const mode = result.apply ? 'Import complete' : 'Dry run';
  process.stdout.write(
    `${mode}: ${result.planned} planned, ${result.created} created, `
    + `${result.withIngredients} with ingredients, ${result.withoutIngredients} without ingredients, `
    + `${result.skippedExisting} existing-title skips, ${result.skippedDuplicate} duplicate skips, `
    + `${result.invalid} invalid.\n`,
  );
  if (!result.apply && result.planned > 0) {
    process.stdout.write('No recipes were changed. Re-run with --apply to create the planned recipes.\n');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Bring recipe import failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
