/** Parent and subtask status transitions with atomic completion effects.
 * Task routes validate definition edits and module permissions. A locked task
 * remains completable by any actor who can see it; no definition is changed here.
 * Future session commands can use this operation after their own command gates.
 */
import { createHash } from 'node:crypto';
import * as db from '../db.js';
import { nextDueAfterCompletion } from './recurrence.js';
import { syncTaskRewards } from './rewards.js';
import { syncTaskCompletion } from './task-completions.js';
import { visibilityWhere } from './visibility.js';
import { markTodoOutbound, queueTodoDeletion } from './caldav-todo-outbound.js';
import { loadTags, setTags } from '../utils/task-tags.js';
import { setAssignments } from '../utils/task-assignments.js';
import { todayKey } from '../utils/timezone.js';

/** One command writes the status and all completion/reopening side effects. */
export function transitionTaskStatus({ taskId, status, actingUserId, updateDefinition }) {
  if (!['open', 'in_progress', 'done'].includes(status)) {
    throw Object.assign(new Error('Invalid task status.'), { status: 400 });
  }
  return db.get().transaction(() => {
    const previous = db.get().prepare(`SELECT t.* FROM tasks t WHERE t.id = @taskId
      AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}`)
      .get({ taskId, me: actingUserId });
    if (!previous) throw Object.assign(new Error('Task not found.'), { status: 404 });
    // PUT applies its validated definition after the access check and before
    // rewards/recurrence read the new assignments, dates and rule.
    updateDefinition?.();
    db.get().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const pending = markTodoOutbound('tasks', previous, task);
    syncHousekeepingPaymentStatus(db.get(), taskId, status);
    // Remove a follow-up before revoking history: legacy protection can use it.
    const undone = previous.status === 'done' && status !== 'done'
      ? discardRecurrenceFollowup(taskId) : 0;
    syncTaskRewards(db.get(), taskId, previous.status, status, actingUserId);
    syncTaskCompletion(db.get(), taskId, previous.status, status, actingUserId);
    if (status === 'done' && previous.status !== 'done') spawnRecurrenceFollowup(task);
    return { task, pending, undone };
  })();
}

function syncHousekeepingPaymentStatus(d, taskId, status) {
  const table = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'housekeeping_work_sessions'").get();
  if (!table) return;
  d.prepare(`
    UPDATE housekeeping_work_sessions
    SET paid_at = CASE
      WHEN ? = 'done' THEN COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ELSE NULL
    END
    WHERE payment_task_id = ?
  `).run(status, taskId);
}

/**
 * Die Folgeinstanz, die beim Erledigen dieser Aufgabe entstanden ist (#650) -
 * oder null. Es gibt höchstens eine: der Spawn legt nur an, wenn hier nichts
 * steht.
 *
 * `parent_task_id IS NULL` ist keine Beschleunigung, sondern die Bedingung
 * selbst: `recurrence_origin_id` trägt seit #742 zwei Bedeutungen. An einer
 * Wurzelaufgabe heißt es "ich bin der nächste Durchlauf von X", an einer
 * Unteraufgabe nur "ich bin die Kopie von Y in diesem Durchlauf". Ohne die
 * Einschränkung fand das Enthaken einer Unteraufgabe der erledigten Instanz
 * deren Kopie im neuen Durchlauf, hielt sie für die Folgeinstanz und löschte
 * sie - die nächste Instanz verlor lautlos eine Unteraufgabe (#924). Nur die
 * erste Bedeutung ist eine Folgeinstanz.
 */
function recurrenceFollowupOf(taskId) {
  return db.get().prepare(
    `SELECT * FROM tasks
      WHERE recurrence_origin_id = ? AND parent_task_id IS NULL
      ORDER BY id LIMIT 1`
  ).get(taskId) ?? null;
}

/**
 * Prüft, ob Unteraufgaben einer Folgeinstanz durch den Benutzer verändert wurden
 * (editiert, erledigt, hinzugefügt oder gelöscht).
 */
function isFollowupSubtasksTouched(followup) {
  const originTaskId = followup.recurrence_origin_id;
  const originSubtasks = originTaskId
    ? db.get().prepare('SELECT * FROM tasks WHERE parent_task_id = ?').all(originTaskId)
    : [];
  const currentSubtasks = db.get()
    .prepare('SELECT * FROM tasks WHERE parent_task_id = ?')
    .all(followup.id);

  if (currentSubtasks.length !== originSubtasks.length) return true;

  const originDueDate = originTaskId
    ? db.get().prepare('SELECT due_date FROM tasks WHERE id = ?').get(originTaskId)?.due_date
    : null;

  for (const sub of currentSubtasks) {
    if (sub.status !== 'open' || !sub.recurrence_origin_id) return true;
    const origin = originSubtasks.find((o) => o.id === sub.recurrence_origin_id);
    if (!origin) return true;

    if (
      sub.title !== origin.title ||
      (sub.description || '') !== (origin.description || '') ||
      sub.category !== origin.category ||
      sub.priority !== origin.priority ||
      sub.assigned_to !== origin.assigned_to ||
      sub.points !== origin.points ||
      sub.visibility !== origin.visibility ||
      sub.due_time !== origin.due_time
    ) {
      return true;
    }

    const subAnchorDate = originDueDate || origin.due_date;
    const expectedStart = shiftedStartDate(origin.start_date, subAnchorDate, followup.due_date) ?? origin.start_date;
    const expectedDue = origin.due_date
      ? (shiftedStartDate(origin.due_date, subAnchorDate, followup.due_date) ?? followup.due_date)
      : null;

    if (sub.start_date !== expectedStart || sub.due_date !== expectedDue) {
      return true;
    }
  }

  return false;
}

const DEFINITION_FIELDS = [
  'title', 'description', 'category', 'priority', 'status', 'start_date',
  'due_date', 'due_time', 'assigned_to', 'created_by', 'is_recurring',
  'recurrence_rule', 'recurrence_from_completion', 'points', 'visibility',
  'countdown', 'locked', 'archived_at', 'target_caldav_account_id', 'target_caldav_list_url',
];

function generatedDefinitionHash(taskId) {
  const rows = db.get().prepare('SELECT * FROM tasks WHERE id = ? OR parent_task_id = ? ORDER BY id')
    .all(taskId, taskId);
  const definition = rows.map((task) => ({
    id: task.id,
    fields: DEFINITION_FIELDS.map((field) => task[field] ?? null),
    assignments: db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
      .all(task.id).map((row) => row.user_id),
    tags: loadTags(db.get(), task.id).sort(),
    sessions: db.get().prepare('SELECT id FROM calendar_events WHERE task_id = ? ORDER BY id').all(task.id).map(row => row.id),
    documents: db.get().prepare('SELECT document_id FROM task_documents WHERE task_id = ? ORDER BY document_id')
      .all(task.id).map((row) => row.document_id),
    comments: db.get().prepare('SELECT id, user_id, comment FROM task_comments WHERE task_id = ? ORDER BY id').all(task.id),
    // User configuration counts as work; delivery/dismissal metadata does not.
    reminders: db.get().prepare(`SELECT id, created_by, remind_at FROM reminders
      WHERE entity_type = 'task' AND entity_id = ? ORDER BY id`).all(task.id),
  }));
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

function isGeneratedFollowupTouched(followup) {
  const snapshot = db.get().prepare('SELECT definition_hash FROM task_recurrence_snapshots WHERE task_id = ?').get(followup.id);
  if (snapshot) return snapshot.definition_hash !== generatedDefinitionHash(followup.id);
  // Older generated tasks have no snapshot. Keep the existing subtask guard
  // and conservatively retain a successor whose copied definition differs.
  const origin = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(followup.recurrence_origin_id);
  const copied = ['title', 'description', 'category', 'priority', 'assigned_to',
    'created_by', 'is_recurring', 'recurrence_rule', 'recurrence_from_completion',
    'points', 'visibility', 'countdown'];
  if (!origin || copied.some((field) => followup[field] !== origin[field])
    || followup.archived_at || followup.locked || isFollowupSubtasksTouched(followup)) return true;
  // Generated successors start without a destination or document links.
  if (db.get().prepare(`SELECT 1 FROM tasks t WHERE (t.id = ? OR t.parent_task_id = ?)
    AND (t.target_caldav_account_id IS NOT NULL OR t.target_caldav_list_url IS NOT NULL
      OR EXISTS (SELECT 1 FROM task_documents td WHERE td.task_id = t.id)
      OR EXISTS (SELECT 1 FROM task_comments tc WHERE tc.task_id = t.id)
      OR EXISTS (SELECT 1 FROM reminders r WHERE r.entity_type = 'task' AND r.entity_id = t.id))`).get(followup.id, followup.id)) return true;
  const assignmentIds = (id) => db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
    .all(id).map((row) => row.user_id);
  if (JSON.stringify(assignmentIds(followup.id)) !== JSON.stringify(assignmentIds(origin.id))
    || JSON.stringify(loadTags(db.get(), followup.id).sort()) !== JSON.stringify(loadTags(db.get(), origin.id).sort())) return true;
  const completedAt = db.get().prepare('SELECT completed_at FROM task_completions WHERE task_id = ?').get(origin.id)?.completed_at;
  // Without an original completion time the generated dates cannot be proven.
  if (!completedAt) return true;
  const dueDate = nextDueAfterCompletion({
    anchorDate: origin.due_date, rule: origin.recurrence_rule,
    completedOn: todayKey(db.get(), completedAt), fromCompletion: !!origin.recurrence_from_completion,
  });
  return followup.due_date !== dueDate
    || followup.start_date !== shiftedStartDate(origin.start_date, origin.due_date, dueDate)
    || followup.due_time !== origin.due_time;
}

/**
 * Nimmt die Folgeinstanz zurück, wenn ein Abhaken rückgängig gemacht wird (#650).
 * Nur unangetastete Instanzen verschwinden: hat jemand sie selbst erledigt (und
 * damit die Serie weitergeschrieben) oder ihr Unteraufgaben gegeben/erledigt/bearbeitet, steckt dort
 * Arbeit, die ein Klick auf die Vorgängerin nicht wegwerfen darf.
 * Rückgabe: Anzahl vorgemerkter CalDAV-Löschungen.
 */
function discardRecurrenceFollowup(taskId) {
  const followup = recurrenceFollowupOf(taskId);
  if (!followup || followup.status !== 'open') return 0;

  if (isGeneratedFollowupTouched(followup) || recurrenceFollowupOf(followup.id)) return 0;

  // Vor dem DELETE vormerken, wie in DELETE /:id: danach sind UID und Objekt-URL
  // weg. Lokal erzeugte Folgeinstanzen sind nicht gespiegelt, dann ist das ein No-op.
  const queued = queueTodoDeletion('tasks', followup) ? 1 : 0;
  db.get().prepare('DELETE FROM tasks WHERE id = ?').run(followup.id);
  return queued;
}

/**
 * Der Vorlauf gehört zum Durchlauf, nicht zum Kalender: beginnt eine Aufgabe
 * drei Tage vor ihrer Fälligkeit, tut sie das auch beim nächsten Mal.
 *
 * Ohne Start- oder Fälligkeitsdatum gibt es nichts zu verschieben (NULL). Der
 * zweite Fall ist erreichbar: eine erledigungsverankerte Serie (#658) läuft
 * auch ohne Fälligkeitsdatum weiter, und dann fehlt der Bezugspunkt, an dem ein
 * Vorlauf gemessen wäre.
 */
function shiftedStartDate(startDate, dueDate, nextDue) {
  if (!startDate || !dueDate) return null;
  const lead = Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(lead)) return null;
  return new Date(Date.parse(`${nextDue}T00:00:00Z`) - lead).toISOString().slice(0, 10);
}

/**
 * Schreibt die Serie weiter: nächste Instanz anlegen, wenn eine wiederkehrende
 * Aufgabe erledigt wurde. Erwartet die bereits auf 'done' gesetzte Zeile.
 *
 * Beide Wege zum Haken müssen hier durch - die Checkbox (PATCH /:id/status) und
 * das Status-Dropdown im Bearbeiten-Dialog (PUT /:id). Lag der Spawn nur im
 * einen, beendete der andere die Serie lautlos.
 *
 * Ohne Rückgabewert, anders als discardRecurrenceFollowup: die Folgeinstanz
 * entsteht ohne external_uid/external_source, markTodoOutbound lässt sie
 * deshalb liegen. Es gibt nichts zu pushen.
 *
 * Beide Aufrufer halten bereits eine Transaktion, die eigene läuft darin als
 * Savepoint. Sie bleibt trotzdem stehen: sie hält Aufgabe, Zuweisungen und Tags
 * auch dann zusammen, wenn später jemand von außerhalb einer Transaktion ruft.
 */
function spawnRecurrenceFollowup(task) {
  if (!task?.is_recurring || !task.recurrence_rule || task.parent_task_id) return;
  // Höchstens eine Folgeinstanz je Erledigung - sonst legt doppeltes Abhaken nach.
  if (recurrenceFollowupOf(task.id)) return;

  // Zwei Verankerungen, die Aufgabe entscheidet (#658): ab Fälligkeit
  // (Vorgabe, holt übersprungene Vorkommen auf, damit die nächste Instanz
  // nicht selbst überfällig entsteht) oder ab dem Tag des Abhakens.
  const completedOn = todayKey(db.get());
  const nextDate = nextDueAfterCompletion({
    anchorDate: task.due_date,
    rule: task.recurrence_rule,
    completedOn,
    fromCompletion: !!task.recurrence_from_completion,
  });
  if (!nextDate) return;

  const existingAssignments = db.get()
    .prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
    .all(task.id).map((r) => r.user_id);
  // Die Tags gehören zur Aufgabe, nicht zum einzelnen Durchlauf (#586).
  // Ohne das Mitnehmen verlöre eine wöchentliche Aufgabe ihre Etiketten
  // beim ersten Abhaken - und zwar lautlos, weil die Folgeinstanz sonst
  // vollständig aussieht.
  const existingTags = loadTags(db.get(), task.id);
  // Unteraufgaben gehören ebenfalls zur Aufgabenstruktur (#742).
  // Beim Folgedurchlauf werden sie mit zurückgesetztem Status ('open') kopiert.
  const existingSubtasks = db.get()
    .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY id ASC')
    .all(task.id);

  db.get().transaction(() => {
    const newTask = db.get().prepare(`
      INSERT INTO tasks (title, description, category, priority, status,
        start_date, due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule,
        points, visibility, recurrence_from_completion, countdown, recurrence_origin_id)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      task.title, task.description, task.category, task.priority,
      shiftedStartDate(task.start_date, task.due_date, nextDate),
      nextDate, task.due_time, task.assigned_to, task.created_by,
      task.recurrence_rule, task.points, task.visibility,
      // Ohne das Mitnehmen fiele die Serie ab der zweiten Instanz auf die
      // Fälligkeitsrechnung zurück - lautlos, weil die Folgeinstanz sonst
      // vollständig aussieht (wie bei den Tags oben).
      task.recurrence_from_completion ? 1 : 0,
      // Und aus demselben Grund die Countdown-Markierung (#647). Sie ist bei
      // dieser Sorte Aufgabe sogar der Anlass: „immer wieder N Jahre" (Führer-
      // schein) oder „N Tage ab Reinigung" (Luftfilter) ist eine Serie, die ab
      // Erledigung rechnet - der Countdown, der genau davon lebt, dürfte beim
      // ersten Zurücksetzen nicht verschwinden.
      task.countdown ? 1 : 0,
      task.id
    );
    setAssignments(db.get(), newTask.lastInsertRowid, existingAssignments);
    setTags(db.get(), newTask.lastInsertRowid, existingTags);

    for (const sub of existingSubtasks) {
      const subAssignments = db.get()
        .prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
        .all(sub.id).map((r) => r.user_id);
      const subTags = loadTags(db.get(), sub.id);

      const subAnchorDate = task.due_date || sub.due_date;

      const newSub = db.get().prepare(`
        INSERT INTO tasks (title, description, category, priority, status,
          start_date, due_date, due_time, assigned_to, created_by, parent_task_id,
          is_recurring, recurrence_rule, points, visibility, recurrence_origin_id)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
      `).run(
        sub.title, sub.description, sub.category, sub.priority,
        shiftedStartDate(sub.start_date, subAnchorDate, nextDate) ?? sub.start_date,
        sub.due_date ? (shiftedStartDate(sub.due_date, subAnchorDate, nextDate) ?? nextDate) : null,
        sub.due_time, sub.assigned_to, sub.created_by, newTask.lastInsertRowid,
        sub.points, sub.visibility, sub.id
      );
      setAssignments(db.get(), newSub.lastInsertRowid, subAssignments);
      setTags(db.get(), newSub.lastInsertRowid, subTags);
    }
    db.get().prepare('INSERT INTO task_recurrence_snapshots (task_id, definition_hash) VALUES (?, ?)')
      .run(newTask.lastInsertRowid, generatedDefinitionHash(newTask.lastInsertRowid));
  })();
}
