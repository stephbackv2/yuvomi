/** Session publication uses existing provider targets, with assignee-owned defaults. */
import * as db from '../db.js';
import { queueSessionPublicationDeletion } from './session-publication.js';
import { parseSyncTargetValue, googleTargetValue, caldavTargetValue, outlookTargetValue } from '../../public/utils/sync-target.js';

export function sessionTargets(task, actor) {
  const conn = db.get();
  const config = key => conn.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value;
  const options = [{ value: 'local', label: 'Local' }];
  if (config('google_refresh_token') && config('google_readonly') !== '1') {
    for (const row of conn.prepare("SELECT calendar_id, name FROM google_calendar_selection WHERE enabled = 1 AND access_role IN ('owner','writer')").all()) {
      options.push({ value: googleTargetValue(row.calendar_id), label: `Google · ${row.name}` });
    }
  }
  for (const row of conn.prepare(`SELECT s.*, a.name AS account_name FROM caldav_calendar_selection s JOIN caldav_accounts a ON a.id = s.account_id
    WHERE s.enabled = 1 AND s.write_capability = 'write'`).all()) {
    options.push({ value: caldavTargetValue(row.account_id, row.calendar_url), label: `CalDAV · ${row.account_name} · ${row.calendar_name || row.calendar_url}` });
  }
  for (const row of conn.prepare(`SELECT s.*, a.name AS account_name FROM outlook_calendar_selection s JOIN outlook_accounts a ON a.id = s.account_id
    WHERE s.enabled = 1 AND s.can_edit = 1`).all()) {
    options.push({ value: outlookTargetValue(row.account_id, row.calendar_id), label: `Outlook · ${row.account_name} · ${row.calendar_name}` });
  }
  const primary = task.assigned_to || actor;
  const preferred = config(`calendar_default_target:user:${primary}`);
  const default_target = options.some(option => option.value === preferred && preferred !== 'local') ? preferred : null;
  return { options, default_target, explicit_required: task.visibility !== 'all' || !default_target };
}

export function resolveSessionTarget(task, actor, body) {
  const targets = sessionTargets(task, actor);
  const explicit = Object.hasOwn(body, 'publication_target');
  if (!explicit && targets.explicit_required) throw Object.assign(new Error('Choose a session calendar destination explicitly.'), { status: 409 });
  const value = explicit ? body.publication_target : targets.default_target;
  if (!targets.options.some(option => option.value === value)) throw Object.assign(new Error('Session destination is unavailable or not writable.'), { status: 400 });
  const fields = { target_google_calendar_id: null, target_caldav_account_id: null, target_caldav_calendar_url: null,
    target_outlook_account_id: null, target_outlook_calendar_id: null };
  const target = parseSyncTargetValue(value === 'local' ? '' : value);
  if (target.kind === 'google') fields.target_google_calendar_id = target.calendarId;
  else if (target.kind === 'caldav') {
    fields.target_caldav_account_id = target.accountId; fields.target_caldav_calendar_url = target.calendarUrl;
  } else if (target.kind === 'outlook') {
    fields.target_outlook_account_id = target.accountId; fields.target_outlook_calendar_id = target.calendarId;
  }
  return fields;
}

/** Destination changes use the existing durable publication transfer workflow. */
export function setSessionDestination(before, effectiveTask, actor, body) {
  const target = resolveSessionTarget(effectiveTask, actor, body);
  const changed = Object.entries(target).some(([key, value]) => before[key] !== value);
  if (!changed && before.session_pending_target) {
    db.get().prepare("UPDATE calendar_events SET session_pending_target = NULL, sync_state = 'clean', sync_error = NULL WHERE id = ?").run(before.id);
  }
  if (!changed) return;
  const published = before.external_source !== 'local' || db.get().prepare('SELECT 1 FROM outlook_event_links WHERE event_id = ?').get(before.id);
  if (published && Object.values(target).some(Boolean)) {
    db.get().prepare("UPDATE calendar_events SET session_pending_target = ?, sync_state = 'pending', sync_error = NULL WHERE id = ?").run(JSON.stringify(target), before.id);
  } else {
    queueSessionPublicationDeletion(before);
    db.get().prepare(`UPDATE calendar_events SET external_source = 'local', external_calendar_id = NULL,
      calendar_ref_id = NULL, external_object_url = NULL, session_pending_target = NULL,
      target_google_calendar_id = ?, target_caldav_account_id = ?, target_caldav_calendar_url = ?,
      target_outlook_account_id = ?, target_outlook_calendar_id = ?, outbound_dirty = ?, sync_state = 'clean', sync_error = NULL WHERE id = ?`).run(
      target.target_google_calendar_id, target.target_caldav_account_id, target.target_caldav_calendar_url,
      target.target_outlook_account_id, target.target_outlook_calendar_id, Object.values(target).some(Boolean) ? 1 : 0, before.id);
  }
}
