/** Shared event card color: explicit override, calendar inheritance, neutral. */
export const EVENT_FALLBACK_COLOR = '#8E8E93';

export function resolveEventColor(ev) {
  return resolveEventColorOrNull(ev) ?? EVENT_FALLBACK_COLOR;
}

/** Callers with their own neutral surface can supply a fallback. */
export function resolveEventColorOrNull(ev) {
  return ev?.color || ev?.cal_color || null;
}
