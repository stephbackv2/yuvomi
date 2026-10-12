/** Task allocation controls shared by calendar drops and task details. */
import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';
import { displayTimeZone, zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { syncTargetValueFromEvent } from '/utils/sync-target.js';
import { moduleAccess } from '/permissions.js';
import { renderAvatarStack, renderUserMultiSelect, bindUserMultiSelect, getSelectedUserIds } from '/components/user-multi-select.js';
import { openModal, closeModal, refocusAfterRender } from '/components/modal.js';

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
      <div id="task-session-assignment"></div>
      <div class="form-group" id="task-session-move-group" hidden><label class="label" for="task-session-move">${esc(t('calendar.sessionMoveChoice'))}</label><select class="input" id="task-session-move"><option value="retain">${esc(t('calendar.sessionRetain'))}</option><option value="move">${esc(t('calendar.sessionMove'))}</option></select></div>
      <div class="form-group"><label class="label" for="task-session-target">${esc(t('calendar.syncTargetLabel'))}</label><select class="input" id="task-session-target" required disabled></select><p>${esc(t('calendar.sessionAudience'))}</p></div>
      <p id="task-session-error" role="alert"></p><div class="modal-actions"><button type="button" id="task-session-cancel" class="btn btn--secondary">${esc(t('common.cancel'))}</button><button type="submit" class="btn btn--primary" disabled>${esc(t('common.save'))}</button></div></form>`,
    onSave(panel) {
      let parent, loadGeneration = 0;
      const mode = () => panel.querySelector('#task-session-mode')?.value || 'inherited';
      const primary = () => mode() === 'override' ? Number(panel.querySelector('#task-session-primary').value)
        : session?.session_assignment_mode === 'inherited' ? session.assigned_to : parent?.assigned_to;
      const loadTargets = async () => {
        const generation = ++loadGeneration;
        const select = panel.querySelector('#task-session-target');
        const submit = panel.querySelector('[type="submit"]');
        select.disabled = true; submit.disabled = true;
        try {
          const unchanged = session && mode() === session.session_assignment_mode && Number(primary()) === Number(session.assigned_to);
          const query = unchanged ? `session_id=${session.id}` : `assigned_to=${primary() || ''}`;
          const { data } = await api.get(`/tasks/${taskId}/session-targets${query ? '?' + query : ''}`);
          if (generation !== loadGeneration || !panel.isConnected) return;
          select.replaceChildren();
          const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = t('calendar.sessionChooseTarget'); select.append(placeholder);
          for (const target of data.options) {
            const option = document.createElement('option'); option.value = target.value;
            option.textContent = target.value === 'local' ? t('calendar.syncTargetLocal') : target.label;
            select.append(option);
          }
          const changed = session && Number(primary()) !== Number(session.assigned_to);
          panel.querySelector('#task-session-move-group').hidden = !session;
          const retain = session && panel.querySelector('#task-session-move').value === 'retain';
          select.closest('.form-group').hidden = !!retain;
          select.required = !retain;
          if (retain) select.value = '';
          else if (session && !changed && data.options.some(target => target.value === (syncTargetValueFromEvent(session) || 'local'))) select.value = syncTargetValueFromEvent(session) || 'local';
          else if (!data.explicit_required && data.default_target !== 'local') select.value = data.default_target || '';
          select.disabled = false; submit.disabled = false;
          panel.querySelector('#task-session-error').textContent = '';
        } catch (error) { if (generation === loadGeneration) panel.querySelector('#task-session-error').textContent = error.data?.error || t('calendar.loadError'); }
      };
      const loadAssignment = async () => {
        try {
          const [{ data: task }, { data: users }] = await Promise.all([api.get(`/tasks/${taskId}`), api.get('/auth/users')]);
          if (!panel.isConnected) return;
          parent = task;
          const effective = session || task;
          const inherited = session?.session_assignment_mode === 'inherited' ? session : task;
          const assignment = panel.querySelector('#task-session-assignment');
          assignment.insertAdjacentHTML('beforeend', `<label class="label" for="task-session-mode">${esc(t('calendar.sessionAssignment'))}</label><select class="input" id="task-session-mode"><option value="inherited">${esc(t('calendar.sessionInherited'))}</option><option value="override">${esc(t('calendar.sessionOverride'))}</option></select><p>${renderAvatarStack(inherited.assigned_users || [])} ${esc((inherited.assigned_users || []).map(user => user.display_name).join(', '))}</p><div id="task-session-override"><label class="label" for="task-session-primary">${esc(t('calendar.sessionPrimary'))}</label><select class="input" id="task-session-primary" required>${users.map(user => `<option value="${user.id}">${esc(user.display_name)}</option>`).join('')}</select>${renderUserMultiSelect(users, (effective.assigned_users || []).map(user => user.id), 'session_users', 'calendar.sessionParticipants')}</div>`);
          panel.querySelector('#task-session-mode').value = session?.session_assignment_mode || 'inherited';
          panel.querySelector('#task-session-primary').value = effective.assigned_to || users[0]?.id;
          bindUserMultiSelect(panel, 'session_users');
          const update = () => {
            const inherited = mode() === 'inherited';
            panel.querySelector('#task-session-override').hidden = inherited;
            panel.querySelector('#task-session-primary').disabled = inherited;
            panel.querySelector('#task-session-move').value = 'retain';
            void loadTargets();
          };
          panel.querySelector('#task-session-mode').onchange = update;
          panel.querySelector('#task-session-primary').onchange = update;
          panel.querySelector('#task-session-move').onchange = () => void loadTargets();
          update();
        } catch (error) { panel.querySelector('#task-session-error').textContent = error.data?.error || t('calendar.loadError'); }
      };
      void loadAssignment();
      panel.querySelector('#task-session-cancel').onclick = () => closeModal({ force: true });
      panel.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        if (saving) return;
        saving = true;
        const controls = [...panel.querySelectorAll('input, select, button')].map(control => [control, control.disabled]);
        for (const [control] of controls) control.disabled = true;
        try {
          const value = panel.querySelector('#task-session-start').value;
          const body = { start_datetime: session && value === start ? session.start_datetime : value,
            duration_minutes: Number(panel.querySelector('#task-session-duration').value),
            tzid: displayTimeZone() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
          if (session) body.expected_revision = session.revision;
          body.session_assignment_mode = mode();
          if (mode() === 'override') {
            body.assigned_to = primary();
            body.assigned_users = [...new Set([primary(), ...getSelectedUserIds(panel, 'session_users')])];
          }
          if (!session || (!panel.querySelector('#task-session-move-group').hidden && panel.querySelector('#task-session-move').value === 'move')) body.publication_target = panel.querySelector('#task-session-target').value;
          const path = `/tasks/${taskId}/sessions`;
          await (session ? api.put(`${path}/${session.id}`, body) : api.post(path, body));
          if (panel.isConnected && panel.closest('#shared-modal-overlay')) await closeModal({ force: true });
          await onChanged?.();
          refocusAfterRender();
        } catch (error) { panel.querySelector('#task-session-error').textContent = error.data?.error || t('calendar.saveError'); }
        finally { saving = false; for (const [control, disabled] of controls) control.disabled = disabled; }
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
        row.insertAdjacentHTML('beforeend', `<p data-session-assignment>${esc(t(session.session_assignment_mode === 'override' ? 'calendar.sessionOverride' : 'calendar.sessionInherited'))} · ${renderAvatarStack(session.assigned_users || [])} ${esc((session.assigned_users || []).map(user => `${user.display_name}${user.id === session.assigned_to ? ' (' + t('calendar.sessionPrimary') + ')' : ''}`).join(', '))}</p>`);
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
          if (session.session_status === 'completed') {
            const reopen = document.createElement('button');
            reopen.type = 'button'; reopen.className = 'btn btn--secondary'; reopen.dataset.sessionReopen = session.id;
            reopen.textContent = t('calendar.sessionReopen');
            reopen.onclick = async () => {
              reopen.disabled = true;
              try { await api.post(`/tasks/${task.id}/sessions/${session.id}/reopen`, {}); await load(); await ctx.onChanged?.(); }
              catch (error) { reopen.disabled = false; window.yuvomi?.showToast(error.data?.error || t('calendar.saveError'), 'danger'); }
            };
            row.append(reopen);
          }
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

/** Prepare choices inside the task form before any task mutation. */
export async function prepareTaskSessionMoves(form, taskId, assignedIds) {
  if (moduleAccess('tasks') !== 'write' || moduleAccess('calendar') !== 'write') return [];
  const { data: parent } = await api.get(`/tasks/${taskId}`);
  const primary = Number(assignedIds[0]) || null;
  const oldChoices = form.querySelector('[data-session-move-choices]');
  if (Number(parent.assigned_to) === Number(primary)) { oldChoices?.remove(); return []; }
  const signature = JSON.stringify(assignedIds);
  if (oldChoices?.dataset.assignment === signature) {
    const moves = [];
    for (const row of oldChoices.querySelectorAll('[data-move-session]')) {
      if (row.querySelector('[data-move-decision]').value !== 'move') continue;
      const target = row.querySelector('[data-move-target]').value;
      if (!target) { row.querySelector('[data-move-target]').reportValidity(); return null; }
      moves.push({ session_id: Number(row.dataset.moveSession), publication_target: target });
    }
    return moves;
  }
  oldChoices?.remove();
  const { data: sessions } = await api.get(`/tasks/${taskId}/sessions`);
  const affected = sessions.filter(session => session.session_assignment_mode === 'inherited' && session.session_status === 'unfinished' && Date.parse(session.start_datetime) > Date.now());
  if (!affected.length) return [];
  const { data: targets } = await api.get(`/tasks/${taskId}/session-targets?assigned_to=${primary || ''}`);
  const choices = document.createElement('fieldset');
  choices.dataset.sessionMoveChoices = ''; choices.dataset.assignment = signature;
  choices.insertAdjacentHTML('beforeend', `<legend>${esc(t('calendar.sessionTaskMoves'))}</legend>`);
  for (const session of affected) {
    const row = document.createElement('div'); row.dataset.moveSession = session.id;
    row.insertAdjacentHTML('beforeend', `<p>${esc(formatDate(zonedDateKey(session.start_datetime)))} · ${esc(formatTime(zonedTimeKey(session.start_datetime)))}</p><label>${esc(t('calendar.sessionMoveChoice'))}<select class="input" data-move-decision><option value="retain">${esc(t('calendar.sessionRetain'))}</option><option value="move">${esc(t('calendar.sessionMove'))}</option></select></label><label hidden>${esc(t('calendar.syncTargetLabel'))}<select class="input" data-move-target disabled><option value="">${esc(t('calendar.sessionChooseTarget'))}</option>${targets.options.filter(target => target.value !== 'local').map(target => `<option value="${esc(target.value)}">${esc(target.label)}</option>`).join('')}</select></label>`);
    const target = row.querySelector('[data-move-target]');
    if (!targets.explicit_required && targets.default_target !== 'local') target.value = targets.default_target || '';
    row.querySelector('[data-move-decision]').onchange = event => {
      const move = event.target.value === 'move'; target.disabled = !move; target.required = move; target.parentElement.hidden = !move;
    };
    choices.append(row);
  }
  form.append(choices);
  choices.scrollIntoView({ block: 'nearest' });
  return null;
}
