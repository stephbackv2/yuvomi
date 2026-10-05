/** Normalize provider cooking text without discarding malformed source data. */
export function normalizeCookingSteps(steps, textFor) {
  if (steps == null) return [];
  if (!Array.isArray(steps)) throw new Error('Invalid provider cooking instructions.');
  return steps.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Invalid provider cooking step.');
    const parts = textFor(step);
    if (parts.some((part) => part != null && typeof part !== 'string')) throw new Error('Invalid provider cooking text.');
    return parts.map((part) => (part || '').trim()).filter(Boolean).join('\n');
  }).filter(Boolean);
}


/** Providers may omit pagination totals, but a supplied total must be complete. */
export function assertCompleteRecipeList(recipes, count) {
  if (count == null) return;
  if (!Number.isSafeInteger(count) || count < 0 || recipes.length !== count) {
    throw new Error('Incomplete provider recipe collection.');
  }
}
