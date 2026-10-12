/** Task allocation controls shared by calendar drops and task details. */
import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';
import { displayTimeZone, zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { moduleAccess } from '/permissions.js';
import { syncTargetValueFromEvent } from '/utils/sync-target.js';
import { openModal, closeModal } from '/components/modal.js';

export function canPlanTaskSessions() {
  return window.matchMedia('(min-width: 1024px)').matches
    && moduleAccess('tasks') === 'write' && moduleAccess('calendar') === 'write';
}

const sessionDurationMinutes = session => (Date.parse(session.end_datetime) - Date.parse(session.start_datetime)) / 60000;

export function openTaskSessionEditor({ taskId, session = null, date, time = '09:00', duration = 30, onChanged }) {
  if (!canPlanTaskSessions()) return;
  let saving = false;
  const start = session ? `${zonedDateKey(session.start_datetime)}T${zonedTimeKey(session.start_datetime)}` : `${date}T${time}`;
  const minutes = session ? sessionDurationMinutes(session) : duration;
  openModal({
    title: t(session ? 'calendar.sessionEdit' : 'calendar.sessionSchedule'),
    canClose: () => !saving,
    content: `<form id="task-session-form"><div class="form-group"><label class="label" for="task-session-start">${esc(t('calendar.sessionStart'))}</label><input class="input" id="task-session-start" type="datetime-local" step="900" required value="${esc(start)}"></div>
      <div class="form-group"><label class="label" for="task-session-duration">${esc(t('calendar.sessionDuration'))}</label><input class="input" id="task-session-duration" type="number" min="15" step="15" required value="${minutes}"></div>
      <div class="form-group"><label class="label" for="task-session-target">${esc(t('calendar.syncTargetLabel'))}</label><select class="input" id="task-session-target" required disabled></select><p>${esc(t('calendar.sessionAudience'))}</p></div>
      <p id="task-session-error" role="alert"></p><div class="modal-actions"><button type="button" id="task-session-cancel" class="btn btn--secondary">${esc(t('common.cancel'))}</button><button type="submit" class="btn btn--primary" disabled>${esc(t('common.save'))}</button></div></form>`,
    onSave(panel) {
      const loadTargets = async () => {
        const select = panel.querySelector('#task-session-target');
        try {
          const { data } = await api.get(`/tasks/${taskId}/session-targets`);
          const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = t('calendar.sessionChooseTarget'); select.append(placeholder);
          for (const target of data.options) {
            const option = document.createElement('option'); option.value = target.value;
            option.textContent = target.value === 'local' ? t('calendar.syncTargetLocal') : target.label;
            select.append(option);
          }
          if (session) select.value = syncTargetValueFromEvent(session.session_pending_target ? { ...session, ...JSON.parse(session.session_pending_target) } : session) || 'local';
          else if (!data.explicit_required) select.value = data.default_target;
          select.disabled = false;
          panel.querySelector('[type="submit"]').disabled = false;
        } catch (error) { panel.querySelector('#task-session-error').textContent = error.data?.error || t('calendar.loadError'); }
      };
      void loadTargets();
      panel.querySelector('#task-session-cancel').onclick = () => closeModal({ force: true });
      panel.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        if (saving) return;
        saving = true;
        const cancel = panel.querySelector('#task-session-cancel');
        const submit = panel.querySelector('[type="submit"]');
        cancel.disabled = true;
        submit.disabled = true;
        try {
          const value = panel.querySelector('#task-session-start').value;
          const body = { start_datetime: session && value === start ? session.start_datetime : value,
            duration_minutes: Number(panel.querySelector('#task-session-duration').value),
            tzid: displayTimeZone() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
          if (session) body.expected_revision = session.revision;
          body.publication_target = panel.querySelector('#task-session-target').value;
          const path = `/tasks/${taskId}/sessions`;
          await (session ? api.put(`${path}/${session.id}`, body) : api.post(path, body));
          if (panel.isConnected && panel.closest('#shared-modal-overlay')) await closeModal({ force: true });
          await onChanged?.();
        } catch (error) { panel.querySelector('#task-session-error').textContent = error.data?.error || t('calendar.saveError'); }
        finally { saving = false; submit.disabled = false; cancel.disabled = false; }
      };
    },
  });
}

export function taskSessionsNode(task, ctx) {
  const node = document.createElement('div');
  node.className = 'task-sessions';
  const load = async () => {
    try {
      const [{ data: sessions }, { data: parent }] = await Promise.all([api.get(`/tasks/${task.id}/sessions`), api.get(`/tasks/${task.id}`)]);
      node.replaceChildren();
      const progress = document.createElement('p');
      progress.dataset.scheduledWork = '';
      progress.textContent = `${t('tasks.scheduledWork')}: ${Math.round(parent.scheduled_work.percentage)}%`;
      node.append(progress);
      if (parent.subtasks?.length) {
        const subtasks = document.createElement('p');
        subtasks.textContent = `${t('tasks.subtaskProgress')}: ${parent.subtasks.filter(child => child.status === 'done').length}/${parent.subtasks.length}`;
        node.append(subtasks);
      }
      for (const session of sessions) {
        const row = document.createElement('div');
        row.dataset.sessionId = session.id;
        const minutes = sessionDurationMinutes(session);
        row.insertAdjacentHTML('beforeend', `<p>${esc(formatDate(zonedDateKey(session.start_datetime)))} · ${esc(formatTime(zonedTimeKey(session.start_datetime)))} · ${esc(t('calendar.sessionMinutes', { minutes }))}</p>`);
        const sync = document.createElement('p');
        sync.textContent = session.sync?.state === 'error' ? `${t('calendar.syncError')}: ${session.sync.error || ''}` : session.session_pending_target ? t('calendar.sessionPending') : session.target_google_calendar_id || session.target_caldav_account_id || session.target_outlook_account_id
          ? t(session.sync?.state === 'clean' && !session.outbound_dirty && (session.external_source !== 'local' || session.target_outlook_account_id) ? 'calendar.sessionSynced' : 'calendar.sessionPending')
          : t('calendar.syncTargetLocal');
        row.append(sync);
        if (moduleAccess('tasks') === 'write' && moduleAccess('calendar') === 'write') {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox'; checkbox.dataset.sessionComplete = session.id;
          checkbox.setAttribute('aria-label', t('calendar.sessionComplete'));
          checkbox.checked = session.session_status === 'completed'; checkbox.disabled = checkbox.checked;
          checkbox.onchange = async () => {
            checkbox.disabled = true;
            try { await api.post(`/tasks/${task.id}/sessions/${session.id}/complete`, {}); await load(); await ctx.onChanged?.(); }
            catch (error) { checkbox.checked = false; checkbox.disabled = false; window.yuvomi?.showToast(error.data?.error || t('calendar.saveError'), 'danger'); }
          };
          row.prepend(checkbox);
        }
        if (canPlanTaskSessions()) {
          if (session.session_status !== 'completed') {
            const edit = document.createElement('button');
            edit.type = 'button'; edit.className = 'btn btn--secondary'; edit.dataset.sessionEdit = session.id;
            edit.textContent = t('common.edit');
            edit.onclick = () => openTaskSessionEditor({ taskId: task.id, session, onChanged: ctx.onChanged });
            row.append(edit);
          }
          const remove = document.createElement('button');
          remove.type = 'button'; remove.className = 'btn btn--secondary'; remove.dataset.sessionRemove = session.id;
          remove.textContent = t('calendar.sessionRemove');
          remove.onclick = async () => {
            remove.disabled = true;
            try {
              await api.delete(`/tasks/${task.id}/sessions/${session.id}`);
              await load(); await ctx.onChanged?.();
            } catch (error) { window.yuvomi?.showToast(error.data?.error || t('calendar.saveError'), 'danger'); }
            finally { remove.disabled = false; }
          };
          row.append(remove);
        }
        node.append(row);
      }
      if (!sessions.length) node.insertAdjacentHTML('beforeend', `<p>${esc(t('calendar.sessionEmpty'))}</p>`);
    } catch { node.textContent = t('calendar.loadError'); }
  };
  void load();
  return node;
}
