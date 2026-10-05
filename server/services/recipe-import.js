/**
 * Imports public recipe pages through their schema.org Recipe metadata.
 *
 * Fetching is deliberately limited to the named recipe sites below. Together
 * with the guarded DNS lookup this keeps the endpoint from becoming a generic
 * server-side proxy while still allowing redirects within the public web.
 */

import { safeRequest } from '../utils/http.js';
import { createGuardedLookup } from '../utils/ssrf.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';
import { RECIPE_IMPORT_SOURCES } from '../../public/utils/recipe-import.js';

export { RECIPE_IMPORT_SOURCES };

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;

function cleanText(value) {
  return decodeHtmlEntities(String(value ?? ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function hostMatches(hostname, domain) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

export function validateRecipeImportUrl(sourceId, rawUrl) {
  const source = RECIPE_IMPORT_SOURCES.find((entry) => entry.id === sourceId);
  if (!source) throw Object.assign(new Error('Unsupported recipe source.'), { code: 'UNSUPPORTED_SOURCE' });

  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw Object.assign(new Error('Enter a valid recipe URL.'), { code: 'INVALID_URL' });
  }
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('Recipe URLs must use HTTPS.'), { code: 'INVALID_URL' });
  }
  if (url.href.length > 2000) {
    throw Object.assign(new Error('The recipe URL is too long.'), { code: 'INVALID_URL' });
  }
  if (url.username || url.password || !source.domains.some((domain) => hostMatches(url.hostname, domain))) {
    throw Object.assign(new Error(`The URL does not belong to ${source.label}.`), { code: 'SOURCE_MISMATCH' });
  }
  url.hash = '';
  return { source, url };
}

function recipeType(value) {
  const types = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
  return types.some((type) => String(type).toLowerCase() === 'recipe');
}

function findRecipeNode(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (recipeType(value)) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findRecipeNode(child, seen);
    if (found) return found;
  }
  return null;
}

function jsonLdBlocks(html) {
  const blocks = [];
  const scripts = String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    const typeAttribute = match[1].match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const mediaType = String(typeAttribute?.[1] || typeAttribute?.[2] || typeAttribute?.[3] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/ld+json') continue;
    const raw = match[2].trim().replace(/^<!--|-->$/g, '').trim();
    if (!raw) continue;
    try { blocks.push(JSON.parse(raw)); } catch { /* unrelated or malformed metadata */ }
  }
  return blocks;
}

function instructionTexts(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const text = cleanText(value);
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) instructionTexts(item, out);
    return out;
  }
  if (typeof value === 'object') {
    if (value.itemListElement) {
      instructionTexts(value.itemListElement, out);
    } else if (value.text || value.name) {
      const text = cleanText(value.text || value.name);
      if (text) out.push(text);
    }
    if (!value.text && !value.name && value.steps) instructionTexts(value.steps, out);
  }
  return out;
}

// Quantity extraction is intentionally conservative. A line that cannot be
// split safely remains intact as the ingredient name, so no source text is lost.
const QUANTITY_RE = /^((?:\d+[\d.,/\s]*|[¼½¾⅓⅔⅛⅜⅝⅞])(?:\s*(?:g|kg|mg|ml|cl|dl|l|oz|lb|tsp|tbsp|tl|el|cup|cups|tasse|tassen|stück|stk\.?|prise|prisen|bund|dose|dosen|päckchen|packung|zehe|zehen))?)\s+(.+)$/iu;

export function splitIngredient(line) {
  const text = cleanText(line);
  const match = text.match(QUANTITY_RE);
  if (!match) return { name: text, quantity: null, category: 'Sonstiges' };
  return { name: match[2].trim(), quantity: match[1].trim(), category: 'Sonstiges' };
}

export function parseRecipeHtml(html, recipeUrl) {
  let recipe = null;
  for (const block of jsonLdBlocks(html)) {
    recipe = findRecipeNode(block);
    if (recipe) break;
  }
  if (!recipe) {
    throw Object.assign(new Error('No structured recipe data was found on this page.'), { code: 'NO_RECIPE_DATA' });
  }

  const title = cleanText(recipe.name).slice(0, 200);
  if (!title) {
    throw Object.assign(new Error('The recipe page does not contain a title.'), { code: 'NO_RECIPE_DATA' });
  }
  const rawIngredients = Array.isArray(recipe.recipeIngredient)
    ? recipe.recipeIngredient
    : (recipe.recipeIngredient ? [recipe.recipeIngredient] : []);
  const ingredients = rawIngredients
    .map(splitIngredient)
    .filter((ingredient) => ingredient.name)
    .slice(0, 250);
  const steps = instructionTexts(recipe.recipeInstructions).slice(0, 100);
  const notes = cleanText(recipe.description).slice(0, 5000) || null;

  return {
    title,
    recipe_url: recipeUrl,
    notes,
    instructions: steps.map((step) => step.slice(0, 5000)),
    ingredients,
  };
}

async function readTextBody(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_PAGE_BYTES) {
      response.body.destroy();
      throw Object.assign(new Error('The recipe page is too large to import.'), { code: 'PAGE_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function importRecipeFromUrl({ sourceId, rawUrl, request = safeRequest }) {
  const { url } = validateRecipeImportUrl(sourceId, rawUrl);
  const response = await request(url.href, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    lookup: createGuardedLookup(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    response.body?.resume?.();
    throw Object.assign(new Error(`The recipe page returned HTTP ${response.status}.`), { code: 'FETCH_FAILED' });
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    response.body?.resume?.();
    throw Object.assign(new Error('The URL did not return an HTML page.'), { code: 'FETCH_FAILED' });
  }
  return parseRecipeHtml(await readTextBody(response), url.href);
}
