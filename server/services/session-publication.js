/** Retain an existing publication until the normal provider uploader accepts its replacement. */
import * as db from '../db.js';
import { queueDeletion, mirroredFieldsChanged } from './calendar-outbound.js';

export function sessionPublicationCandidate(event, provider) {
  if (!event.session_pending_target) return event;
  const target = JSON.parse(event.session_pending_target);
  if (!target[`target_${provider}_calendar_id`] && !target[`target_${provider}_account_id`]) return null;
  return { ...event, ...target };
}

export function queueSessionPublicationDeletion(event) {
  if (!event?.external_calendar_id || !['google', 'caldav'].includes(event.external_source)) return;
  const calendar = event.calendar_ref_id ? db.get().prepare('SELECT external_id FROM external_calendars WHERE id = ?').get(event.calendar_ref_id)?.external_id : null;
  queueDeletion({ source: event.external_source, calendarExternalId: calendar || event.target_google_calendar_id || event.target_caldav_calendar_url,
    eventExternalId: event.external_calendar_id, objectUrl: event.external_object_url });
}

export function finishSessionPublication(event, replacement) {
  if (!event.task_id) return true;
  return db.get().transaction(() => {
    const current = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
    const sameDestination = current && (event.session_pending_target
      ? current.session_pending_target === event.session_pending_target
      : !current.session_pending_target && ['target_google_calendar_id', 'target_caldav_account_id', 'target_caldav_calendar_url', 'target_outlook_account_id', 'target_outlook_calendar_id'].every(key => current[key] === event[key]));
    if (!sameDestination) {
      if (replacement) queueDeletion(replacement);
      return false;
    }
    if (replacement) db.get().prepare('DELETE FROM calendar_pending_deletions WHERE source = ? AND calendar_external_id = ? AND event_external_id = ? AND session_publication_event_id = ?')
      .run(replacement.source, replacement.calendarExternalId, replacement.eventExternalId, event.id);
    if (!event.session_pending_target) return true;
    queueSessionPublicationDeletion(current);
    const target = JSON.parse(event.session_pending_target);
    db.get().prepare(`UPDATE calendar_events SET target_google_calendar_id = ?, target_caldav_account_id = ?, target_caldav_calendar_url = ?,
      target_outlook_account_id = ?, target_outlook_calendar_id = ?, session_pending_target = NULL WHERE id = ?`).run(
      target.target_google_calendar_id, target.target_caldav_account_id, target.target_caldav_calendar_url,
      target.target_outlook_account_id, target.target_outlook_calendar_id, event.id);
    return true;
  })();
}

/** A deterministic remote identity survives a lost creation response. */
export function rememberSessionPublication(event, remote) {
  if (!event.task_id) return;
  queueDeletion(remote);
  const target = Object.fromEntries(['target_google_calendar_id', 'target_caldav_account_id', 'target_caldav_calendar_url', 'target_outlook_account_id', 'target_outlook_calendar_id'].map(key => [key, event[key]]));
  db.get().prepare(`UPDATE calendar_pending_deletions SET session_publication_event_id = ?, session_publication_target = ?
    WHERE source = ? AND calendar_external_id = ? AND event_external_id = ?`).run(event.id, JSON.stringify(target), remote.source, remote.calendarExternalId, remote.eventExternalId);
}

export function sessionPublicationDirty(event) {
  if (!event.task_id) return 0;
  const current = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
  return current && mirroredFieldsChanged(event, current) ? 1 : 0;
}
