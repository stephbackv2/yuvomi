/**
 * Standalone Bring recipe exporter.
 *
 * Bring does not publish a supported shopping/recipe API. This client mirrors
 * the request shape used by the community `miaucl/bring-api` project and may
 * need adjustment when Bring changes its private mobile API.
 *
 * Library usage:
 *   import { exportBringRecipes } from './tools/bring/export-recipes.mjs';
 *   const data = await exportBringRecipes({ email, password });
 *
 * CLI usage (PowerShell):
 *   $env:BRING_EMAIL='you@example.com'
 *   $env:BRING_PASSWORD='...'
 *   node tools/bring/export-recipes.mjs --output bring-recipes.json
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://api.getbring.com/rest/';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 1_000;
const DETAIL_CONCURRENCY = 4;

// Bring's Android application key. This is a public client identifier copied
// from the open-source community client, not a user secret. Account credentials
// and tokens must still never be committed or written into the export.
const DEFAULT_API_KEY = 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';

export class BringExportError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'BringExportError';
    if (status != null) this.status = status;
  }
}

function requiredString(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new BringExportError(`${name} is required`);
  return normalized;
}

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new BringExportError('Bring base URL must use HTTPS');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

async function requestJson(fetchImpl, url, options, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new BringExportError(`${label} failed: ${cause.message}`, { cause });
  }

  if (!response.ok) {
    throw new BringExportError(`${label} failed with HTTP ${response.status}`, {
      status: response.status,
    });
  }

  if (options.method === 'PUT') {
    await response.body?.cancel();
    return;
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new BringExportError(`${label} returned invalid JSON`, { cause });
  }
}

export class BringRecipeClient {
  constructor({
    email,
    password,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    apiKey = DEFAULT_API_KEY,
    country = 'DE',
    pageSize = DEFAULT_PAGE_SIZE,
  }) {
    this.email = requiredString(email, 'Bring email');
    this.password = requiredString(password, 'Bring password');
    if (typeof fetchImpl !== 'function') throw new BringExportError('A fetch implementation is required');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
      throw new BringExportError('pageSize must be an integer between 1 and 1000');
    }

    this.fetch = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = requiredString(apiKey, 'Bring API key');
    this.country = requiredString(country, 'Bring country').toUpperCase();
    this.pageSize = pageSize;
    this.auth = null;
  }

  async login() {
    const body = new URLSearchParams({ email: this.email, password: this.password });
    let data;
    try {
      data = await requestJson(this.fetch, new URL('v2/bringauth', this.baseUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
      }, 'Bring login');
    } catch (error) {
      if (error instanceof BringExportError && error.status === 401) {
        throw new BringExportError(
          'Bring login failed with HTTP 401. For an account created with Google, Apple, or Facebook, create or reset a separate Bring password first; do not use the identity-provider password.',
          { status: error.status, cause: error },
        );
      }
      throw error;
    }

    const uuid = requiredString(data.uuid, 'Bring login response uuid');
    const publicUuid = requiredString(data.publicUuid, 'Bring login response publicUuid');
    const accessToken = requiredString(data.access_token, 'Bring login response access_token');
    const tokenType = String(data.token_type || 'Bearer').trim() || 'Bearer';

    this.auth = { uuid, publicUuid, accessToken, tokenType };
    return { uuid, publicUuid };
  }

  #headers() {
    if (!this.auth) throw new BringExportError('Call login() before requesting recipes');
    return {
      Accept: 'application/json',
      Authorization: `${this.auth.tokenType} ${this.auth.accessToken}`,
      'X-BRING-API-KEY': this.apiKey,
      'X-BRING-CLIENT': 'android',
      'X-BRING-APPLICATION': 'bring',
      'X-BRING-COUNTRY': this.country,
      'X-BRING-USER-UUID': this.auth.uuid,
      'X-BRING-PUBLIC-USER-UUID': this.auth.publicUuid,
    };
  }

  async readList(listId) {
    const url = new URL(`v2/bringlists/${encodeURIComponent(listId)}`, this.baseUrl);
    const data = await requestJson(this.fetch, url, {
      method: 'GET', headers: this.#headers(),
    }, 'Bring list read');
    const { purchase, recently } = data.items ?? {};
    if (!Array.isArray(purchase) || !Array.isArray(recently)) {
      throw new BringExportError('Bring list response is missing purchase or recently items');
    }
    return { purchase, recently };
  }

  async changeListItem(listId, itemId, specification, operation) {
    const url = new URL(`v2/bringlists/${encodeURIComponent(listId)}/items`, this.baseUrl);
    await requestJson(this.fetch, url, {
      method: 'PUT',
      headers: { ...this.#headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changes: [{ itemId, specification, operation, accuracy: '0.0', altitude: '0.0', latitude: '0.0', longitude: '0.0' }],
        sender: '',
      }),
    }, 'Bring list mutation');
  }

  async getInspirationsPage({ filter = 'mine', offset = 0 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BringExportError('offset must be a non-negative integer');
    }
    const url = new URL(`v2/bringusers/${encodeURIComponent(this.auth?.uuid || '')}/inspirations`, this.baseUrl);
    url.search = new URLSearchParams({
      filterTags: requiredString(filter, 'Inspiration filter'),
      offset: String(offset),
      limit: String(this.pageSize),
    });
    const data = await requestJson(this.fetch, url, {
      method: 'GET',
      headers: this.#headers(),
    }, 'Bring recipe request');

    if (!Array.isArray(data.entries)) {
      throw new BringExportError('Bring recipe response is missing entries[]');
    }
    return data;
  }

  async getAllInspirations(filter = 'mine') {
    const entries = [];
    let offset = 0;
    let reportedTotal = null;
    let previousPageFingerprint = null;
    let finished = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.getInspirationsPage({ filter, offset });
      const pageEntries = data.entries;
      const total = Number(data.total);
      if (Number.isSafeInteger(total) && total >= 0) reportedTotal = total;

      if (pageEntries.length === 0) {
        if (reportedTotal != null && offset < reportedTotal) {
          throw new BringExportError('Bring recipe export ended before the reported total');
        }
        finished = true;
        break;
      }

      // Fail closed if the private API ever stops honoring offset. Returning a
      // duplicate-filled "complete" export would be worse than a clear error.
      const fingerprint = JSON.stringify(pageEntries);
      if (previousPageFingerprint === fingerprint) {
        throw new BringExportError('Bring recipe pagination did not advance');
      }
      previousPageFingerprint = fingerprint;

      entries.push(...pageEntries);
      offset += pageEntries.length;
      if (reportedTotal != null && offset >= reportedTotal) {
        finished = true;
        break;
      }
    }

    if (!finished) {
      throw new BringExportError(`Bring recipe export exceeded ${MAX_PAGES} pages`);
    }

    return { entries, total: reportedTotal ?? entries.length };
  }

  async getTemplateContent(contentSrcUrl) {
    const url = new URL(requiredString(contentSrcUrl, 'Bring content source URL'));
    const base = new URL(this.baseUrl);
    const expectedPath = `${base.pathname}v2/bringtemplates/content/`.replace(/\/{2,}/g, '/');
    if (url.protocol !== base.protocol || url.origin !== base.origin || !url.pathname.startsWith(expectedPath)) {
      throw new BringExportError('Bring content source URL points outside the expected template endpoint');
    }

    const detail = await requestJson(this.fetch, url, {
      method: 'GET',
      headers: this.#headers(),
    }, 'Bring recipe-detail request');
    const content = detail?.content && typeof detail.content === 'object' ? detail.content : detail;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new BringExportError('Bring recipe-detail response is not an object');
    }
    return content;
  }

  async hydrateInspirations(entries) {
    const result = new Array(entries.length);
    const cache = new Map();
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(DETAIL_CONCURRENCY, entries.length) },
      async () => {
        while (cursor < entries.length) {
          const index = cursor;
          cursor += 1;
          const entry = entries[index];
          const sourceUrl = entry?.content?.contentSrcUrl;
          if (!sourceUrl) {
            result[index] = entry;
            continue;
          }
          if (!cache.has(sourceUrl)) {
            cache.set(sourceUrl, this.getTemplateContent(sourceUrl));
          }
          const detail = await cache.get(sourceUrl);
          result[index] = {
            ...entry,
            content: { ...entry.content, ...detail },
          };
        }
      },
    );
    await Promise.all(workers);
    return result;
  }
}

function inspirationType(entry) {
  return String(entry?.type || entry?.content?.type || '').toUpperCase();
}

/**
 * Fetch every recipe in Bring's personal `mine` collection.
 *
 * The returned entries are deliberately kept in Bring's original shape so an
 * export does not lose fields that the private API may add later. TEMPLATE
 * entries are optional; editorial/ad POST entries are always excluded.
 */
export async function exportBringRecipes({
  email,
  password,
  includeTemplates = false,
  hydrate = true,
  now = () => new Date(),
  ...clientOptions
}) {
  const client = new BringRecipeClient({ email, password, ...clientOptions });
  await client.login();
  const source = await client.getAllInspirations('mine');
  const entries = hydrate ? await client.hydrateInspirations(source.entries) : source.entries;
  const recipes = entries.filter((entry) => inspirationType(entry) === 'RECIPE');
  const templates = includeTemplates
    ? entries.filter((entry) => inspirationType(entry) === 'TEMPLATE')
    : [];

  return {
    format: 'yuvomi-bring-recipes',
    version: 1,
    exportedAt: now().toISOString(),
    filter: 'mine',
    includeTemplates: Boolean(includeTemplates),
    hydrated: Boolean(hydrate),
    sourceCount: source.entries.length,
    sourceTotal: source.total,
    recipeCount: recipes.length,
    templateCount: templates.length,
    recipes,
    templates,
  };
}

export async function writeBringRecipeExport(outputPath, options) {
  const destination = requiredString(outputPath, 'Output path');
  const data = await exportBringRecipes(options);
  await writeFile(destination, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return data;
}

function parseCliArgs(args) {
  let outputPath = null;
  let includeTemplates = false;
  let hydrate = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--include-templates') {
      includeTemplates = true;
    } else if (arg === '--summaries-only') {
      hydrate = false;
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[index + 1];
      index += 1;
      if (!outputPath) throw new BringExportError(`${arg} requires a path`);
    } else {
      throw new BringExportError(`Unknown argument: ${arg}`);
    }
  }
  return { outputPath, includeTemplates, hydrate };
}

async function main() {
  const { outputPath, includeTemplates, hydrate } = parseCliArgs(process.argv.slice(2));
  const options = {
    email: process.env.BRING_EMAIL,
    password: process.env.BRING_PASSWORD,
    includeTemplates,
    hydrate,
  };

  if (outputPath) {
    const data = await writeBringRecipeExport(outputPath, options);
    const templateSummary = data.templateCount ? ` and ${data.templateCount} templates` : '';
    process.stderr.write(`Exported ${data.recipeCount} Bring recipes${templateSummary} to ${outputPath}\n`);
    return;
  }

  const data = await exportBringRecipes(options);
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Bring recipe export failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
