import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal } from '/components/modal.js';
import { recipeThumbHtml, wireRecipeThumbs } from '/utils/recipe-thumb.js';

/** Read-only recipe details shared by both planner entry points. Persisted
 * meal ingredients are already scaled; never scale them again here.
 */
export function openRecipeReader(recipe, { meal = null } = {}) {
  const planned = Boolean(meal?.ingredients?.length);
  const ingredients = planned ? meal.ingredients : (recipe.ingredients || []);
  openModal({
    title: recipe.title,
    size: 'lg',
    content: `<article class="recipe-reader">
      ${recipe.has_own_image || recipe.provider_has_image ? recipeThumbHtml({
        recipeId: recipe.id, hasOwnImage: recipe.has_own_image,
        hasImage: recipe.provider_has_image, className: 'recipe-reader__image',
      }) : ''}
      <section aria-labelledby="reader-ingredients">
        <h3 id="reader-ingredients">${t('recipes.ingredientsLabel')}</h3>
        <p class="recipe-reader__quantities">${t(planned ? 'recipes.plannedQuantities' : 'recipes.originalQuantities')}</p>
        <ul>${ingredients.map((ingredient) => `<li>${esc(ingredient.quantity || '')} ${esc(ingredient.name)}</li>`).join('')}</ul>
      </section>
      ${recipe.instructions?.length ? `<section aria-labelledby="reader-instructions">
        <h3 id="reader-instructions">${t('recipes.instructionsLabel')}</h3>
        <ol>${recipe.instructions.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>
      </section>` : ''}
      ${recipe.notes ? `<section aria-labelledby="reader-notes">
        <h3 id="reader-notes">${t('recipes.notesLabel')}</h3>
        <p class="recipe-reader__notes">${esc(recipe.notes)}</p>
      </section>` : ''}
      <div class="recipe-reader__actions">
        ${/^https?:\/\//i.test(recipe.recipe_url || '') ? `<a class="btn btn--secondary" href="${esc(recipe.recipe_url)}" target="_blank" rel="noopener noreferrer">${t('meals.openRecipe')}</a>` : ''}
        <a class="btn btn--primary" href="/recipes?open=${encodeURIComponent(recipe.id)}" data-reader-page>${t('recipes.fullRecipe')}</a>
      </div>
    </article>`,
    onSave(panel) {
      wireRecipeThumbs(panel);
      panel.querySelector('[data-reader-page]').addEventListener('click', async (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        const href = event.currentTarget.getAttribute('href');
        await closeModal({ force: true });
        window.yuvomi?.navigate(href);
      });
    },
  });
}
