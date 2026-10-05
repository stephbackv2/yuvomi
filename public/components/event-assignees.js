import { esc } from '/utils/html.js';
import { AVATAR_FALLBACK_COLOR } from '/utils/color.js';

/** Stable user-color segments, independent of the event's calendar color.
 * Effective session assignees use the same assigned_users read contract.
 * Identity remains available in the card's avatars and title/aria label.
 */
export function renderEventAssigneeBar(event) {
  const users = [...(event.assigned_users ?? [])].sort((a, b) => a.id - b.id);
  if (!users.length) return '';
  return `<span class="event-assignees" aria-hidden="true">${users.map((user) =>
    `<span class="event-assignees__segment" style="background-color:${esc(user.color || AVATAR_FALLBACK_COLOR)}" title="${esc(user.display_name || '')}"></span>`
  ).join('')}</span>`;
}
