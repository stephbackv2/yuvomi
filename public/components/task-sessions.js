/** Task allocation controls shared by calendar drops and task details. */
import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';
import { displayTimeZone, zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { moduleAccess } from '/permissions.js';
import { openModal, closeModal } from '/components/modal.js';

export function canPlanTaskSessions() {
  return window.matchMedia('(min-width: 1024px)').matches
    && moduleAccess('tasks') === 'write' && moduleAccess('calendar') === 'write';
}

const sessionDurationMinutes = session => (Date.parse(session.end_datetime) - Date.parse(session.start_datetime)) / 60000;

export function openTaskSessionEditor({ taskId, session = null, date, duration = 30, onChanged }) {
  if (!canPlanTaskSessions()) return;
  let saving = false;
  const start = session ? `${zonedDateKey(session.start_datetime)}T${zonedTimeKey(session.start_datetime)}` : `${date}T09:00`;
  const minutes = session ? sessionDurationMinutes(session) : duration;
  openModal({
    title: t(session ? 'calendar.sessionEdit' : 'calendar.sessionSchedule'),
    canClose: () => !saving,
    content: `<form id="task-session-form"><div class="form-group"><label class="label" for="task-session-start">${esc(t('calendar.sessionStart'))}</label><input class="input" id="task-session-start" type="datetime-local" step="900" required value="${esc(start)}"></div>
      <div class="form-group"><label class="label" for="task-session-duration">${esc(t('calendar.sessionDuration'))}</label><input class="input" id="task-session-duration" type="number" min="15" step="15" required value="${minutes}"></div>
      <p id="task-session-error" role="alert"></p><div class="modal-actions"><button type="button" id="task-session-cancel" class="btn btn--secondary">${esc(t('common.cancel'))}</button><button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button></div></form>`,
    onSave(panel) {
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
      const { data: sessions } = await api.get(`/tasks/${task.id}/sessions`);
      node.replaceChildren();
      for (const session of sessions) {
        const row = document.createElement('div');
        row.dataset.sessionId = session.id;
        const minutes = sessionDurationMinutes(session);
        row.insertAdjacentHTML('beforeend', `<p>${esc(formatDate(zonedDateKey(session.start_datetime)))} · ${esc(formatTime(zonedTimeKey(session.start_datetime)))} · ${esc(t('calendar.sessionMinutes', { minutes }))}</p>`);
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
      if (!sessions.length) node.textContent = t('calendar.sessionEmpty');
    } catch { node.textContent = t('calendar.loadError'); }
  };
  void load();
  return node;
}
