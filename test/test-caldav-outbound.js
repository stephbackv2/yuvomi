/**
 * Test: ausgehender CalDAV/Apple-Sync für Löschungen, Änderungen und Umzüge (#593)
 * Zweck: Wie zuvor bei Google kannte der CalDAV- und der Apple-Outbound nur das
 *        Anlegen. Ein bereits synchronisierter Termin liess sich in Yuvomi löschen
 *        oder bearbeiten, ohne dass davon je etwas auf dem Server ankam.
 *
 *        CalDAV unterscheidet sich dabei grundlegend von Google:
 *          - Es gibt keinen Aufruf "ändere Event X in Kalender Y", nur PUT/DELETE
 *            auf die URL des Kalenderobjekts. Diese Suite prüft, dass die URL aus
 *            der Datenbank bzw. aus dem laufenden Abruf gefunden wird.
 *          - Ein PUT ersetzt das ganze Objekt. Der Patcher darf deshalb nur die
 *            gespiegelten Properties tauschen und muss Teilnehmer, Alarme und
 *            Ausnahme-Vorkommen unangetastet lassen - sonst wäre jede Bearbeitung
 *            ein Datenverlust auf dem Server.
 *          - CalDAV kennt kein Verschieben; ein Kalenderwechsel ist Anlegen im
 *            Ziel und Löschen in der Quelle, in genau dieser Reihenfolge.
 *
 *        Netz-frei: der tsdav-Client ist eine Attrappe.
 * Ausführen: node --experimental-sqlite --test test/test-caldav-outbound.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const outbound = await import('../server/services/calendar-outbound.js');
const {
  processPendingDeletions,
  processPendingUpdates,
  processScopedOperation,
  patchICSEventOccurrence,
  caldavWriteCapability,
  icsFieldsForEvent,
  filenameFromUrl,
} =
  await import('../server/services/caldav-outbound.js');
const { patchICSEvent, countVEvents, unfoldICS, foldICSLine } =
  await import('../server/utils/ics-patch.js');
const { nearestIcalColorName, resolveIcalColor, __test: icalColorTest } =
  await import('../server/utils/ical-color.js');
// Die ICS-Builder fuer frisch hochgeladene Termine liegen je einmal im CalDAV- und
// im Apple-Sync. Beide sind ueber __test erreichbar, weil der Sync-Pfad drumherum
// zu gross ist, um ihn fuer eine Property nachzustellen.
const { __test: caldavSyncTest } = await import('../server/services/caldav-sync.js');
const { __test: appleSyncTest }  = await import('../server/services/apple-calendar.js');
const editOperations = await import('../server/services/calendar-edit-operations.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const CAL_URL  = 'https://dav.example/cal/family/';
const CAL2_URL = 'https://dav.example/cal/work/';

// ── Fixtures ────────────────────────────────────────────────────────────────────

function reset() {
  db.prepare('DELETE FROM calendar_pending_deletions').run();
  db.prepare('DELETE FROM calendar_edit_operations').run();
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('DELETE FROM external_calendars').run();
  db.prepare('DELETE FROM caldav_accounts').run();
  db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
              VALUES ('Radicale', 'https://dav.example/', 'u', 'p')`).run();
}

function upsertCalendar(url, name = 'Familie') {
  return db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES ('caldav', ?, ?, '#4A90E2')
    ON CONFLICT(source, external_id) DO UPDATE SET name = excluded.name
    RETURNING id
  `).get(url, name).id;
}

let seq = 0;
function insertSyncedEvent({
  uid = `evt-${++seq}@test`, calRefId = null, objectUrl = null, source = 'caldav', ...fields
} = {}) {
  const f = {
    title: 'Zahnarzt', description: null, location: null, color: '#4A90E2',
    start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    all_day: 0, recurrence_rule: null, tzid: null, target: null,
    ...fields,
  };
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, description, location, color, start_datetime, end_datetime, all_day,
       recurrence_rule, tzid, external_calendar_id, external_source, calendar_ref_id,
       external_object_url, target_caldav_calendar_url, created_by)
    VALUES (@title, @description, @location, @color, @start_datetime, @end_datetime, @all_day,
       @recurrence_rule, @tzid, @uid, @source, @calRefId, @objectUrl, @target, 1)
  `).run({ ...f, uid, source, calRefId, objectUrl });
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(r.lastInsertRowid);
}

function reload(id) {
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
}

function tombstones() {
  return db.prepare('SELECT * FROM calendar_pending_deletions ORDER BY id').all();
}

/** Realistisches Serverobjekt: Termin mit Teilnehmer, Alarm und einem Override. */
function serverObject(uid, { withOverride = false, extra = [] } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T090000Z',
    'SEQUENCE:3',
    'SUMMARY:Alter Titel',
    'DTSTART;TZID=Europe/Berlin:20350310T090000',
    'DTEND;TZID=Europe/Berlin:20350310T100000',
    'LOCATION:Praxis',
    'ATTENDEE;CN=Maria:mailto:maria@example.com',
    'CATEGORIES:Gesundheit',
    ...extra,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT',
  ];
  if (withOverride) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'RECURRENCE-ID;TZID=Europe/Berlin:20350317T090000',
      'SUMMARY:Verschobene Ausnahme',
      'DTSTART;TZID=Europe/Berlin:20350317T110000',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/** tsdav-Attrappe. */
function fakeClient({ onDelete, onUpdate, onCreate } = {}) {
  const deletes = [];
  const updates = [];
  const creates = [];
  return {
    deletes, updates, creates,
    deleteCalendarObject: async (p) => { deletes.push(p); return onDelete?.(p); },
    updateCalendarObject: async (p) => { updates.push(p); return onUpdate?.(p); },
    createCalendarObject: async (p) => { creates.push(p); return onCreate?.(p); },
  };
}

function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  return err;
}

function indexFor(uid, { url = `${CAL_URL}${uid}.ics`, etag = '"v1"', data, calendarUrl = CAL_URL } = {}) {
  return new Map([[uid, { url, etag, data: data ?? serverObject(uid), calendarUrl }]]);
}

// ── ICS-Patcher ─────────────────────────────────────────────────────────────────

test('der Patch tauscht nur die verwalteten Properties aus', () => {
  const out = patchICSEvent(serverObject('a@t'), 'a@t', {
    SUMMARY: 'Neuer Titel',
    DTSTART: { value: '20350311T080000', params: ';TZID=Europe/Berlin' },
    DTEND:   { value: '20350311T090000', params: ';TZID=Europe/Berlin' },
  });

  assert.match(out, /SUMMARY:Neuer Titel/);
  assert.match(out, /DTSTART;TZID=Europe\/Berlin:20350311T080000/);
  assert.doesNotMatch(out, /SUMMARY:Alter Titel/);
});

test('alles, was Yuvomi nicht kennt, überlebt den Patch', () => {
  const out = patchICSEvent(serverObject('b@t'), 'b@t', { SUMMARY: 'Neu' });

  assert.match(out, /ATTENDEE;CN=Maria:mailto:maria@example.com/, 'Teilnehmer');
  assert.match(out, /CATEGORIES:Gesundheit/, 'Kategorien');
  assert.match(out, /BEGIN:VALARM/, 'Erinnerung');
  assert.match(out, /TRIGGER:-PT15M/);
});

test('ein Ausnahme-Vorkommen derselben UID bleibt unangetastet', () => {
  const out = patchICSEvent(serverObject('c@t', { withOverride: true }), 'c@t', {
    SUMMARY: 'Neu',
    DTSTART: { value: '20350310T120000', params: ';TZID=Europe/Berlin' },
  });

  assert.equal(countVEvents(out), 2);
  assert.match(out, /SUMMARY:Verschobene Ausnahme/, 'das Override behält seinen Titel');
  assert.match(out, /DTSTART;TZID=Europe\/Berlin:20350317T110000/, 'und seine Zeit');
});

test('ein leeres Feld entfernt die Property, ein neues wird ergänzt', () => {
  const out = patchICSEvent(serverObject('d@t'), 'd@t', {
    LOCATION: null,
    DESCRIPTION: 'Frisch, mit Komma; und Semikolon',
  });

  assert.doesNotMatch(out, /LOCATION:/);
  assert.match(out, /DESCRIPTION:Frisch\\, mit Komma\\; und Semikolon/);
});

test('ergänzte Properties stehen vor der ersten Subkomponente', () => {
  const out = patchICSEvent(serverObject('e@t'), 'e@t', { DESCRIPTION: 'Text' });
  const lines = unfoldICS(out).split('\n');
  assert.ok(lines.indexOf('DESCRIPTION:Text') < lines.indexOf('BEGIN:VALARM'),
    'RFC 5545 ordnet einem VEVENT erst seine Properties zu, dann seine Alarme');
});

test('SEQUENCE wird hochgezählt, damit Clients ihre Kopie als veraltet erkennen', () => {
  const out = patchICSEvent(serverObject('f@t'), 'f@t', { SUMMARY: 'Neu' });
  assert.match(out, /SEQUENCE:4/);
});

test('ohne passendes VEVENT liefert der Patch null statt eines kaputten Objekts', () => {
  assert.equal(patchICSEvent(serverObject('g@t'), 'gibt-es-nicht', { SUMMARY: 'x' }), null);
});

test('lange Zeilen werden RFC-konform gefaltet, ohne Zeichen zu zerschneiden', () => {
  const out = patchICSEvent(serverObject('h@t'), 'h@t', { SUMMARY: 'ü'.repeat(200) });
  for (const line of out.split('\r\n')) {
    assert.ok(Buffer.byteLength(line) <= 75, `Zeile zu lang: ${line.slice(0, 30)}…`);
  }
  // Zurückgefaltet muss der Titel wieder vollständig sein.
  assert.match(unfoldICS(out), new RegExp(`SUMMARY:${'ü'.repeat(200)}`));
});

test('gefaltete Eingaben werden vor dem Patchen zusammengeführt', () => {
  const folded = serverObject('i@t').replace('SUMMARY:Alter Titel', 'SUMMARY:Alter\r\n  Titel');
  const out = patchICSEvent(folded, 'i@t', { SUMMARY: 'Neu' });
  assert.match(out, /SUMMARY:Neu/);
  assert.doesNotMatch(unfoldICS(out), /Alter Titel/);
});

test('foldICSLine lässt kurze Zeilen unangetastet', () => {
  assert.equal(foldICSLine('SUMMARY:kurz'), 'SUMMARY:kurz');
});

// ── Feldabbildung ───────────────────────────────────────────────────────────────

test('ein getimter Termin behält die Zone, in der er importiert wurde', () => {
  const { fields } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    tzid: 'Europe/Berlin', all_day: 0,
  });
  assert.deepEqual(fields.DTSTART, { value: '20350310T090000', params: ';TZID=Europe/Berlin' });
  assert.deepEqual(fields.DTEND,   { value: '20350310T100000', params: ';TZID=Europe/Berlin' });
});

test('eine UTC-Zeit bekommt keine zusätzliche TZID aufgesetzt', () => {
  const { fields, tzid } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-03-10T09:00:00Z', tzid: 'Europe/Berlin', all_day: 0,
  });
  assert.equal(fields.DTSTART.params, '', 'Wert und Parameter würden sich sonst widersprechen');
  assert.equal(tzid, null, 'ein UTC-Instant braucht kein VTIMEZONE');
});

// ── Zeitzone im ausgehenden Objekt (#938) ────────────────────────────────────
//
// Ein lokal angelegter Termin hat kein `tzid`: die Zone steht nicht am Event,
// sondern am Haushalt. Bis #938 fiel er deshalb durch jede Verzweigung hindurch
// und ging als `DTSTART:20350310T090000` hinaus - "floating time", laut RFC 5545
// gueltig und genau deshalb heimtueckisch: es heisst "9 Uhr auf der Uhr dessen,
// der es liest". iOS und eM Client raten die Systemzone und liegen richtig; ein
// DAViCal-Backend nimmt das Objekt an, gibt es unveraendert zurueck und zeigt es
// in seiner eigenen Oberflaeche nie an, weil sein Index einen Zeitpunkt braucht.
//
// Der Melder hat genau diesen Unterschied gemessen: derselbe Termin, sichtbar im
// nativen Client, unsichtbar im Web-Frontend desselben Servers.

test('#938: ein lokal angelegter Termin traegt die Zone des Haushalts', () => {
  const { fields, tzid } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    tzid: null, all_day: 0,
  }, 'Europe/Berlin');
  assert.deepEqual(fields.DTSTART, { value: '20350310T090000', params: ';TZID=Europe/Berlin' });
  assert.deepEqual(fields.DTEND,   { value: '20350310T100000', params: ';TZID=Europe/Berlin' });
  assert.equal(tzid, 'Europe/Berlin', 'die Zone muss ihr VTIMEZONE bekommen');
});

test('#938: ohne bekannte Zone wird der Wert UTC - floating bleibt es nie', () => {
  // Die Ziffern sind dann als UTC gemeint statt als "irgendeine Uhr". Das ist
  // die schlechtere der beiden richtigen Antworten, aber es ist eine: ein
  // Zeitpunkt, den jeder Server gleich einordnet.
  const { fields, tzid } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-03-10T09:00', end_datetime: null, tzid: null, all_day: 0,
  }, null);
  assert.equal(fields.DTSTART.params, '');
  assert.match(fields.DTSTART.value, /Z$/, 'ohne Z waere es wieder floating time');
  assert.equal(tzid, null);
});

test('#938: eine Haushaltszone, die UTC gleicht, ergibt Z statt eines VTIMEZONE', () => {
  // Ein VTIMEZONE ueber 'Etc/UTC' fuehrt nicht jeder Client als Zone; ein 'Z'
  // versteht jeder.
  for (const zone of ['UTC', 'Etc/UTC', 'Etc/GMT']) {
    const { fields, tzid } = icsFieldsForEvent({
      title: 'X', start_datetime: '2035-03-10T09:00', tzid: null, all_day: 0,
    }, zone);
    assert.equal(fields.DTSTART.params, '', `${zone} sollte kein TZID setzen`);
    assert.match(fields.DTSTART.value, /Z$/);
    assert.equal(tzid, null);
  }
});

test('#938: die Zone des Termins schlaegt die des Haushalts', () => {
  // Ein importierter Termin bringt seine eigene mit; sie darf nicht von der
  // Haushaltszone ueberschrieben werden, nur weil die auch bekannt ist.
  const { fields, tzid } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-03-10T09:00', tzid: 'America/New_York', all_day: 0,
  }, 'Europe/Berlin');
  assert.equal(fields.DTSTART.params, ';TZID=America/New_York');
  assert.equal(tzid, 'America/New_York');
});

test('#938: eine unbekannte Zone ergibt kein TZID, zu dem der Block fehlte', () => {
  // Ein TZID, fuer das sich kein VTIMEZONE bauen laesst, waere schlechter als
  // gar keins: ungueltig statt nur unbestimmt.
  const { fields, tzid } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-03-10T09:00', tzid: null, all_day: 0,
  }, 'Nirgendwo/Erfunden');
  assert.equal(fields.DTSTART.params, '');
  assert.match(fields.DTSTART.value, /Z$/);
  assert.equal(tzid, null);
});

test('#938: eine Serie mit Zone geht als Wanduhrzeit hinaus, nicht als UTC', () => {
  // Der DST-Punkt (#549, hier fuer den CalDAV-Weg): eine woechentliche Serie,
  // UTC-verankert, springt am Zeitumstellungswochenende um eine Stunde. Mit
  // TZID rechnet der Empfaenger jedes Vorkommen selbst.
  const { fields, tzid } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-03-10T08:00:00Z', end_datetime: '2035-03-10T09:00:00Z',
    tzid: 'Europe/Berlin', all_day: 0, recurrence_rule: 'FREQ=WEEKLY',
  }, 'Europe/Berlin');
  assert.equal(fields.DTSTART.params, ';TZID=Europe/Berlin');
  assert.equal(fields.DTSTART.value, '20350310T090000', 'Wanduhrzeit, nicht der UTC-Wert');
  assert.equal(tzid, 'Europe/Berlin');
});

test('ein ganztägiger Termin nutzt VALUE=DATE mit exklusivem Ende', () => {
  const { fields } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-07-01', end_datetime: '2035-07-03', all_day: 1,
  });
  assert.deepEqual(fields.DTSTART, { value: '20350701', params: ';VALUE=DATE' });
  assert.deepEqual(fields.DTEND,   { value: '20350704', params: ';VALUE=DATE' }, 'RFC 5545: DTEND ist exklusiv');
});

test('ein ganztägiger Termin braucht kein VTIMEZONE - ein Datum hat keine Zone', () => {
  const { tzid } = icsFieldsForEvent({
    title: 'X', start_datetime: '2035-07-01', end_datetime: '2035-07-03', all_day: 1,
  }, 'Europe/Berlin');
  assert.equal(tzid, null);
});

// ── COLOR: die Eigenfarbe erreicht den Anbieter (#897, #899) ──────────────────
//
// `color` stand seit jeher in MIRRORED_FIELDS, aber COLOR kam im Server nur
// LESEND vor (ics-parser.js). Eine Umfaerbung kostete damit einen PUT, der beim
// Server nichts aenderte - und seit ein Termin gar keine Eigenfarbe mehr haben
// muss (#891), fehlte auch der Weg, eine gesetzte wieder loszuwerden.
//
// DREI ZUSTAENDE, nicht zwei, und das ist der Beitrag von #899: eine Farbe, die
// hinausgeht; eine geleerte, die drueben verschwinden soll; und eine, die wir
// nie gelernt haben und deshalb nicht anfassen duerfen. Die letzten beiden sahen
// vor der Spalte `color_modified` gleich aus, weshalb #898 zunaechst ganz
// geschwiegen hat.

test('die Eigenfarbe geht als CSS3-Name hinaus, nicht als Hex', () => {
  const { fields } = icsFieldsForEvent({
    title: 'Zahnarzt', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    color: '#CE5053',
  });
  assert.equal(fields.COLOR, 'indianred');
  assert.doesNotMatch(String(fields.COLOR), /^#/,
    'RFC 7986 §5.9 laesst fuer COLOR nur einen CSS3-Namen zu - ein Hex darf ein strenger Server verwerfen');
});

test('ein Termin, dessen Farbe nie gelernt wurde, gibt COLOR gar nicht erst mit', () => {
  // "Kein Feld" heisst fuer den Patcher "nicht anfassen". Ein null hiesse
  // "entfernen" - und das darf hier nicht stehen, weil eine nie gelernte Farbe
  // nicht dasselbe ist wie eine geleerte. Siehe den Repro-Test weiter unten.
  const { fields } = icsFieldsForEvent({
    title: 'Zahnarzt', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    color: null, color_modified: 0,
  });
  assert.ok(!Object.hasOwn(fields, 'COLOR'));
});

test('eine GELEERTE Farbe geht als null hinaus und entfernt COLOR (#899)', () => {
  // Die Haelfte, die #898 offenlassen musste: erst `color_modified` macht aus
  // "keine Farbe" eine Aussage. Der Patcher entfernt die Zeile daraufhin - die
  // Faehigkeit dazu steht seit #897 bereit und bekommt hier ihren Aufrufer.
  const { fields } = icsFieldsForEvent({
    title: 'Zahnarzt', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    color: null, color_modified: 1,
  });
  assert.ok(Object.hasOwn(fields, 'COLOR'), 'das Feld MUSS stehen, sonst entfernt der Patch nichts');
  assert.equal(fields.COLOR, null);
});

test('eine nicht abbildbare Farbe laesst die Property des Servers in Ruhe', () => {
  // Der Termin TRAEGT eine Farbe, wir koennen sie nur nicht schreiben. Sie beim
  // Anbieter dafuer zu loeschen waere ein Datenverlust - auch dann, wenn an
  // diesem Termin schon einmal die Farbe gewaehlt wurde (#899): geleert wurde
  // nichts, der Wert steht, er passt nur in kein CSS3-Wort.
  const { fields } = icsFieldsForEvent({
    title: 'Zahnarzt', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    color: 'nicht-hex', color_modified: 1,
  });
  assert.ok(!Object.hasOwn(fields, 'COLOR'),
    'ein fehlendes Feld heisst "nicht anfassen", ein null-Feld hiesse "entfernen"');
});

test('kein Farbname stammt aus CSS Color Level 4 - RFC 7986 kennt nur Level 3', () => {
  // rebeccapurple kam 2014 mit Level 4 dazu; RFC 7986 §5.9 verweist auf die
  // Level-3-Liste von 2011. Ein strenger Server darf den Wert verwerfen, und
  // weil ein abgelehnter PUT das ganze Kalenderobjekt betrifft, naehme er die
  // uebrigen Aenderungen desselben Termins mit.
  const { NON_CSS3_NAMES, CSS_COLOR_NAMES } = icalColorTest;
  assert.ok(NON_CSS3_NAMES.size > 0, 'die Liste steht nicht leer da');
  for (const name of NON_CSS3_NAMES) {
    assert.ok(CSS_COLOR_NAMES[name], `${name} muss beim LESEN weiter gelten`);
    const hex = CSS_COLOR_NAMES[name];
    assert.notEqual(nearestIcalColorName(hex), name,
      `${name} (${hex}) darf beim Schreiben nicht gewaehlt werden`);
    assert.ok(resolveIcalColor(name), `${name} muss beim Lesen weiter aufloesen`);
  }
});

test('jede Farbe der Yuvomi-Palette findet einen Namen, den der eigene Parser zurueckliest', () => {
  // Die Palette aus public/pages/calendar.js. Sie steht hier als Kopie, weil der
  // Server die Frontend-Palette nicht importieren darf (Schichtgrenze). Driftet sie,
  // meldet dieser Test nur den Fall, auf den es ankommt: eine Farbe, die keinen Namen
  // findet - und damit farblos hinausginge.
  const palette = [
    '#587DCE', '#3CA368', '#E0843E', '#CE5053', '#8156C0',
    '#DB684C', '#3E9DCA', '#D8B349', '#85868B', '#279EA4',
  ];
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  for (const hex of palette) {
    const name = nearestIcalColorName(hex);
    assert.ok(name, `${hex} bekommt keinen Namen und ginge damit farblos hinaus`);
    assert.match(name, /^[a-z]+$/, `${hex} -> ${name} ist kein CSS3-Name`);

    const back = resolveIcalColor(name);
    assert.ok(back, `${name} liest sich nicht zurueck - der Inbound saehe eine unbekannte Farbe`);

    // Die Schwelle prueft den DISTANZVERGLEICH, nicht die Feinheit der Tabelle:
    // die CSS3-Liste ist mit 147 Eintraegen dicht genug, dass die groesste echte
    // Abweichung ueber diese Palette bei 28 liegt. Ein Wert jenseits von 48 hiesse
    // nicht "knapp danebengegriffen", sondern "im falschen Farbbereich gelandet".
    const drift = Math.max(...channels(hex).map((v, i) => Math.abs(v - channels(back)[i])));
    assert.ok(drift <= 48, `${hex} -> ${name} (${back}) weicht um ${drift} je Kanal ab`);
  }
});

test('der Patch traegt COLOR in ein Objekt ein, das bisher keins hatte', () => {
  const out = patchICSEvent(serverObject('col1@t'), 'col1@t', { COLOR: 'indianred' });
  assert.match(out, /^COLOR:indianred$/m);
});

test('der Patch ersetzt ein vorhandenes COLOR, statt ein zweites danebenzustellen', () => {
  const out = patchICSEvent(
    serverObject('col2@t', { extra: ['COLOR:tomato'] }), 'col2@t', { COLOR: 'steelblue' },
  );
  assert.match(out, /^COLOR:steelblue$/m);
  assert.doesNotMatch(out, /^COLOR:tomato$/m);
  assert.equal(unfoldICS(out).split('\n').filter((l) => l.startsWith('COLOR:')).length, 1);
});

test('ein null entfernt COLOR - die Faehigkeit des Patchers, noch ohne Aufrufer', () => {
  // Verwaltet heisst ersetzen UND entfernen, hier fuer COLOR wie fuer LOCATION.
  // Der CalDAV-Outbound loest das NICHT aus: er schickt gar kein Feld, solange
  // "lokal keine Farbe" nicht von "wir haben nie eine gelernt" zu unterscheiden
  // ist (siehe den Repro weiter unten). Der Test steht trotzdem hier, weil die
  // Faehigkeit gebraucht wird, sobald es einen eigenen Zustand fuers Leeren gibt -
  // und weil ein spaeterer Aufrufer sich darauf verlassen koennen muss.
  const out = patchICSEvent(
    serverObject('col3@t', { extra: ['COLOR:tomato'] }), 'col3@t', { COLOR: null },
  );
  assert.doesNotMatch(out, /^COLOR:/m);
  assert.match(out, /ATTENDEE;CN=Maria/, 'und der Rest des Objekts bleibt unangetastet');
});

test('beide ICS-Builder geben einem frisch hochgeladenen Termin seine Farbe mit', () => {
  const event = {
    id: 7, title: 'Zahnarzt', description: null, location: null, color: '#CE5053',
    start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    all_day: 0, recurrence_rule: null,
  };
  for (const [label, build] of [['CalDAV', caldavSyncTest.buildCalDAVICS], ['Apple', appleSyncTest.buildICS]]) {
    assert.match(build(event), /^COLOR:indianred$/m, label);
  }
});

test('ohne Eigenfarbe schreiben die Builder gar keine COLOR-Zeile', () => {
  const event = {
    id: 8, title: 'Zahnarzt', description: null, location: null, color: null,
    start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    all_day: 0, recurrence_rule: null,
  };
  for (const [label, build] of [['CalDAV', caldavSyncTest.buildCalDAVICS], ['Apple', appleSyncTest.buildICS]]) {
    assert.doesNotMatch(build(event), /^COLOR:/m, label);
  }
});

// ── Das ganze Objekt: was wirklich auf dem Server ankommt (#938) ─────────────
//
// Die Feldabbildung oben prueft Werte und Parameter. Diese Tests pruefen das
// fertige VCALENDAR - die Ebene, auf der der Melder seinen Befund gemessen hat
// (er hat das Objekt per GET vom Server zurueckgeholt). Beide Builder muessen
// hier gleich handeln: ein Termin darf nicht davon abhaengen, ueber welchen der
// zwei Wege er hochgeladen wurde.

const BOTH_BUILDERS = () => [
  ['CalDAV', caldavSyncTest.buildCalDAVICS],
  ['Apple', appleSyncTest.buildICS],
];

// Nur der VEVENT-Teil. Ein VTIMEZONE fuehrt eigene DTSTART-Zeilen (die Onsets
// seiner DST-Regeln), und die tragen absichtlich keine Zone - sie SIND die Zone.
// Ein Suchen ueber das ganze Objekt findet seit dem Fix zuerst diese und misst
// damit die falsche Zeile.
function veventOf(ics) {
  const body = unfoldICS(ics);
  return body.slice(body.indexOf('BEGIN:VEVENT'), body.indexOf('END:VEVENT'));
}

test('#938: kein Builder gibt einen getimten Termin ohne Zonenangabe hinaus', () => {
  const event = {
    id: 983, title: 'Test-Sync-01', description: null, location: null, color: null,
    start_datetime: '2026-08-30T10:00', end_datetime: '2026-08-30T11:00',
    all_day: 0, recurrence_rule: null, tzid: null,
  };
  for (const [label, build] of BOTH_BUILDERS()) {
    const dtstart = /^DTSTART.*$/m.exec(veventOf(build(event, 'Europe/Berlin')))?.[0];
    // Der Befund im Wortlaut: DTSTART ohne TZID, ohne Z, ohne VTIMEZONE.
    assert.notEqual(dtstart, 'DTSTART:20260830T100000', `${label}: floating time`);
    assert.ok(/;TZID=|Z$/.test(dtstart), `${label}: ${dtstart} nennt keine Zone`);
  }
});

test('#938: zu jedem TZID steht sein VTIMEZONE im selben VCALENDAR', () => {
  // RFC 5545 §3.2.19. Ohne den Block darf ein strenger Server das Objekt
  // zurueckweisen - und mit dem Block kann ein Client offene Serien selbst
  // weiterrechnen, weil die DST-Uebergaenge als RRULE drinstehen.
  const event = {
    id: 984, title: 'Serie', description: null, location: null, color: null,
    start_datetime: '2026-08-30T10:00', end_datetime: '2026-08-30T11:00',
    all_day: 0, recurrence_rule: null, tzid: null,
  };
  for (const [label, build] of BOTH_BUILDERS()) {
    const ics = unfoldICS(build(event, 'Europe/Berlin'));
    assert.match(ics, /^BEGIN:VTIMEZONE$/m, `${label}: VTIMEZONE fehlt`);
    assert.match(ics, /^TZID:Europe\/Berlin$/m, label);
    assert.match(ics, /^BEGIN:DAYLIGHT$/m, `${label}: ohne DST-Regel ist der Block wertlos`);
    // Reihenfolge: die Zone muss stehen, bevor ein DTSTART sie benutzt.
    assert.ok(ics.indexOf('BEGIN:VTIMEZONE') < ics.indexOf('BEGIN:VEVENT'), `${label}: Block steht zu spaet`);
  }
});

test('#938: ein ganztaegiger Termin bekommt kein VTIMEZONE angehaengt', () => {
  const event = {
    id: 985, title: 'Urlaub', description: null, location: null, color: null,
    start_datetime: '2026-08-30', end_datetime: '2026-09-01',
    all_day: 1, recurrence_rule: null, tzid: null,
  };
  for (const [label, build] of BOTH_BUILDERS()) {
    const ics = unfoldICS(build(event, 'Europe/Berlin'));
    assert.doesNotMatch(ics, /BEGIN:VTIMEZONE/, `${label}: ein Datum hat keine Zone`);
    assert.match(veventOf(ics), /^DTSTART;VALUE=DATE:20260830$/m, label);
    assert.match(veventOf(ics), /^DTEND;VALUE=DATE:20260902$/m, `${label}: DTEND ist exklusiv`);
  }
});

test('#938: der Patch-Pfad schreibt das VTIMEZONE nach, wenn es fehlt', () => {
  // Der dritte Weg nach draussen: eine AENDERUNG an einem Objekt, das schon auf
  // dem Server liegt. Der Patcher tauscht nur Properties - das VTIMEZONE hat
  // dort nie jemand ergaenzt, obwohl der Serien-Pfad sein TZID seit #549 setzt.
  const original = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fremd//EN',
    'BEGIN:VEVENT', 'UID:tz@t', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:Alt', 'DTSTART:20260830T100000', 'DTEND:20260830T110000',
    'ATTENDEE;CN=Maria:mailto:maria@example.com',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const { fields, tzid } = icsFieldsForEvent({
    title: 'Neu', start_datetime: '2026-08-30T10:00', end_datetime: '2026-08-30T11:00',
    tzid: null, all_day: 0,
  }, 'Europe/Berlin');
  const out = unfoldICS(patchICSEvent(original, 'tz@t', fields, { tzid }));

  assert.match(veventOf(out), /^DTSTART;TZID=Europe\/Berlin:20260830T100000$/m);
  assert.match(out, /^TZID:Europe\/Berlin$/m, 'das VTIMEZONE muss mitkommen');
  assert.match(out, /ATTENDEE;CN=Maria/, 'und der Rest des fremden Objekts bleibt stehen');
});

test('#938: das VTIMEZONE-Jahr kommt vom Termin, nicht aus einem fremden Block', () => {
  // Ein Objekt kann schon ein VTIMEZONE fuer eine ANDERE Zone tragen, und die
  // sind ueblicherweise auf 1970 datiert. Wer das Jahr aus der ersten
  // DTSTART-Zeile des Textes liest, trifft dessen Onset - und fuer 1970 kennt
  // Europe/Berlin keine Sommerzeit. Herausgekommen waere ein fester
  // +0100-Block, unter dem jeder Sommertermin eine Stunde zu spaet gelesen wird.
  const foreign = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fremd//EN',
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500',
    'DTSTART:19701101T020000', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:yr@t', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:Alt', 'DTSTART:20350830T100000', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const { fields, tzid } = icsFieldsForEvent({
    title: 'Neu', start_datetime: '2035-08-30T10:00', end_datetime: '2035-08-30T11:00',
    tzid: null, all_day: 0,
  }, 'Europe/Berlin');
  const out = unfoldICS(patchICSEvent(foreign, 'yr@t', fields, { tzid }));

  const berlin = out.split('BEGIN:VTIMEZONE').find((b) => b.includes('TZID:Europe/Berlin'));
  assert.ok(berlin, 'der Berlin-Block fehlt');
  assert.match(berlin, /BEGIN:DAYLIGHT/, 'ein Sommerzeit-loser Block heisst: falsches Jahr gerechnet');
  // 2035 unterscheidet DREI Faelle, die sonst zusammenfallen: das Jahr des
  // Termins (richtig), 1970 aus dem fremden Block (der Fehler) und das laufende
  // Jahr (der Rueckfall). Mit einem Termin im laufenden Jahr waere der letzte
  // vom richtigen nicht zu unterscheiden - und die erste Fassung dieser
  // Gegenprobe blieb genau deshalb gruen.
  assert.match(berlin, /DTSTART:2035\d{4}T\d{6}/, 'die Onsets muessen aus dem Jahr des Termins stammen');
  // Der fremde Block bleibt unangetastet daneben stehen.
  assert.match(out, /TZID:America\/New_York/);
});

test('#938: Ausnahmen und Ueberschreibungen bekommen dieselbe Zone wie der Master', () => {
  // Ein Vorkommen wird ueber seinen ZEITWERT identifiziert. Hebt man nur den
  // Master von floating auf TZID, zeigen EXDATE und RECURRENCE-ID ins Leere:
  // der gestrichene Termin taucht wieder auf, der bearbeitete loest sich von
  // seiner Serie - beides durch eine Aenderung, die mit Serien nichts zu tun hat.
  const series = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fremd//EN',
    'BEGIN:VEVENT', 'UID:ser@t', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Alt',
    'DTSTART:20260830T100000', 'DTEND:20260830T110000', 'RRULE:FREQ=WEEKLY',
    'EXDATE:20260906T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:ser@t', 'RECURRENCE-ID:20260913T100000',
    'DTSTART:20260913T140000', 'DTEND:20260913T150000', 'SUMMARY:Ausnahme', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const { fields, tzid } = icsFieldsForEvent({
    title: 'Neu', start_datetime: '2026-08-30T10:00', end_datetime: '2026-08-30T11:00',
    tzid: null, all_day: 0, recurrence_rule: 'FREQ=WEEKLY',
  }, 'Europe/Berlin');
  const out = unfoldICS(patchICSEvent(series, 'ser@t', fields, { tzid }));

  assert.match(out, /^EXDATE;TZID=Europe\/Berlin:20260906T100000$/m);
  assert.match(out, /^RECURRENCE-ID;TZID=Europe\/Berlin:20260913T100000$/m);
});

test('#938: was seinen Bezug schon hat, wird nicht angefasst', () => {
  // Ein EXDATE mit eigenem TZID oder einem Z ist bereits eindeutig. Ein zweiter
  // Parameter daneben ergaebe eine ungueltige Zeile.
  const mixed = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fremd//EN',
    'BEGIN:VEVENT', 'UID:mix@t', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Alt',
    'DTSTART:20260830T100000', 'RRULE:FREQ=WEEKLY',
    'EXDATE;TZID=America/New_York:20260906T100000',
    'EXDATE:20260920T080000Z',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const { fields, tzid } = icsFieldsForEvent({
    title: 'Neu', start_datetime: '2026-08-30T10:00', tzid: null, all_day: 0,
    recurrence_rule: 'FREQ=WEEKLY',
  }, 'Europe/Berlin');
  const out = unfoldICS(patchICSEvent(mixed, 'mix@t', fields, { tzid }));

  assert.match(out, /^EXDATE;TZID=America\/New_York:20260906T100000$/m, 'fremde Zone ueberschrieben');
  assert.match(out, /^EXDATE:20260920T080000Z$/m, 'ein UTC-Wert braucht keine Zone');
  assert.doesNotMatch(out, /TZID=[^:]*TZID=/, 'kein doppelter Parameter');
});

test('#938: ein vorhandenes VTIMEZONE wird nicht verdoppelt', () => {
  // Jeder Sync-Lauf patcht dasselbe Objekt erneut. Ein Block je Durchgang waere
  // ein Wachstum ohne Ende.
  const withZone = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fremd//EN',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
    'DTSTART:19701025T030000', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:tz2@t', 'DTSTAMP:20260101T000000Z',
    'SUMMARY:Alt', 'DTSTART;TZID=Europe/Berlin:20260830T100000',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const { fields, tzid } = icsFieldsForEvent({
    title: 'Neu', start_datetime: '2026-08-30T10:00', tzid: 'Europe/Berlin', all_day: 0,
  }, 'Europe/Berlin');
  const out = unfoldICS(patchICSEvent(withZone, 'tz2@t', fields, { tzid }));

  assert.equal((out.match(/BEGIN:VTIMEZONE/g) || []).length, 1);
  // Und der fremde Block bleibt der des Servers - nicht durch unseren ersetzt.
  assert.match(out, /^DTSTART:19701025T030000$/m);
});

test('filenameFromUrl nimmt den Dateinamen der URL, sonst die UID', () => {
  assert.equal(filenameFromUrl('https://dav.example/cal/abc.ics', 'x@t'), 'abc.ics');
  assert.equal(filenameFromUrl('https://dav.example/cal/', 'x@t'), 'x@t.ics');
});

// ── Vormerkung über die providerneutrale Fassade ────────────────────────────────

test('ein gelöschter CalDAV-Termin wird mit Kalender und Objekt-URL vorgemerkt', () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const event = insertSyncedEvent({ uid: 'del@t', calRefId, objectUrl: `${CAL_URL}del.ics` });

  assert.equal(outbound.queueEventDeletion(event), true);

  const [row] = tombstones();
  assert.equal(row.source, 'caldav');
  assert.equal(row.calendar_external_id, CAL_URL);
  assert.equal(row.event_external_id, 'del@t');
  assert.equal(row.object_url, `${CAL_URL}del.ics`);
});

test('auch ohne gespeicherte Objekt-URL entsteht ein Tombstone', () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const event = insertSyncedEvent({ uid: 'nourl@t', calRefId });

  assert.equal(outbound.queueEventDeletion(event), true);
  assert.equal(tombstones()[0].object_url, null, 'die URL löst der nächste Sync auf');
});

test('ohne konfiguriertes CalDAV-Konto entsteht kein Tombstone', () => {
  reset();
  db.prepare('DELETE FROM caldav_accounts').run();
  const event = insertSyncedEvent({ uid: 'noacc@t', calRefId: upsertCalendar(CAL_URL) });

  assert.equal(outbound.queueEventDeletion(event), false);
  assert.equal(tombstones().length, 0);
});

test('eine Bearbeitung markiert den Termin für den Push', () => {
  reset();
  const before = insertSyncedEvent({ uid: 'edit@t', calRefId: upsertCalendar(CAL_URL) });
  db.prepare("UPDATE calendar_events SET title = 'Neuer Titel' WHERE id = ?").run(before.id);

  assert.equal(outbound.markEventOutbound(before, reload(before.id)), true);
  assert.equal(reload(before.id).outbound_dirty, 1);
});

test('ein gewechselter CalDAV-Zielkalender wird als Umzug vorgemerkt', () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const before = insertSyncedEvent({ uid: 'move@t', calRefId, target: CAL_URL });
  db.prepare('UPDATE calendar_events SET target_caldav_calendar_url = ? WHERE id = ?').run(CAL2_URL, before.id);

  assert.equal(outbound.markEventOutbound(before, reload(before.id)), true);
  assert.equal(reload(before.id).outbound_move_to, CAL2_URL);
});

test('Apple kennt keinen Zielkalender und damit keinen Umzug', () => {
  reset();
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('apple_caldav_url','https://caldav.icloud.com')").run();
  const calRefId = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES ('apple', ?, 'iCloud', '#FC3C44') RETURNING id
  `).get(CAL_URL).id;
  const before = insertSyncedEvent({ uid: 'apple@t', calRefId, source: 'apple' });
  db.prepare("UPDATE calendar_events SET title = 'Anders' WHERE id = ?").run(before.id);

  assert.equal(outbound.markEventOutbound(before, reload(before.id)), true);
  const row = reload(before.id);
  assert.equal(row.outbound_dirty, 1);
  assert.equal(row.outbound_move_to, null);
  db.prepare("DELETE FROM sync_config WHERE key = 'apple_caldav_url'").run();
});

// ── Löschungen ausführen ────────────────────────────────────────────────────────

test('löscht das Kalenderobjekt über die gespeicherte URL', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const event = insertSyncedEvent({ uid: 'x1@t', calRefId, objectUrl: `${CAL_URL}x1.ics` });
  outbound.queueEventDeletion(event);

  const client = fakeClient();
  assert.equal(await processPendingDeletions(client, 'caldav', new Map(), new Set([CAL_URL])), 1);

  assert.equal(client.deletes.length, 1);
  assert.equal(client.deletes[0].calendarObject.url, `${CAL_URL}x1.ics`);
  assert.equal(tombstones().length, 0);
});

test('findet die URL eines Bestandstermins über den laufenden Abruf', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  // Altbestand: vor Migration v106 synchronisiert, daher ohne gespeicherte URL.
  const event = insertSyncedEvent({ uid: 'x2@t', calRefId });
  outbound.queueEventDeletion(event);

  const client = fakeClient();
  const index = indexFor('x2@t', { url: `${CAL_URL}found.ics`, etag: '"e2"' });
  assert.equal(await processPendingDeletions(client, 'caldav', index, new Set([CAL_URL])), 1);

  assert.equal(client.deletes[0].calendarObject.url, `${CAL_URL}found.ics`);
  assert.equal(client.deletes[0].calendarObject.etag, '"e2"');
});

test('ein Termin, den der Server nicht mehr führt, gilt als erledigt', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  outbound.queueEventDeletion(insertSyncedEvent({ uid: 'gone@t', calRefId }));

  const client = fakeClient();
  assert.equal(await processPendingDeletions(client, 'caldav', new Map(), new Set([CAL_URL])), 1);
  assert.equal(client.deletes.length, 0, 'nichts zu löschen');
  assert.equal(tombstones().length, 0);
});

test('ein fremder Account lässt die Vormerkung eines anderen in Ruhe', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  outbound.queueEventDeletion(insertSyncedEvent({ uid: 'other@t', calRefId }));

  const client = fakeClient();
  // Lauf eines Accounts, der diesen Kalender gar nicht kennt.
  assert.equal(await processPendingDeletions(client, 'caldav', new Map(), new Set([CAL2_URL])), 0);

  assert.equal(client.deletes.length, 0);
  assert.equal(tombstones().length, 1, 'der zuständige Account übernimmt sie');
});

test('ein Serverfehler lässt die Löschung für den nächsten Lauf stehen', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const event = insertSyncedEvent({ uid: 'err@t', calRefId, objectUrl: `${CAL_URL}err.ics` });
  outbound.queueEventDeletion(event);

  const client = fakeClient({ onDelete: () => { throw httpError(503); } });
  assert.equal(await processPendingDeletions(client, 'caldav', new Map(), new Set([CAL_URL])), 0);

  const [row] = tombstones();
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /503/);
});

test('ein 404 zählt als erledigt, nicht als Fehlversuch', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  outbound.queueEventDeletion(insertSyncedEvent({ uid: '404@t', calRefId, objectUrl: `${CAL_URL}a.ics` }));

  const client = fakeClient({ onDelete: () => { throw httpError(404); } });
  assert.equal(await processPendingDeletions(client, 'caldav', new Map(), new Set([CAL_URL])), 1);
  assert.equal(tombstones().length, 0);
});

// ── Änderungen ausführen ────────────────────────────────────────────────────────

function seedDirty(uid, fields = {}, { objectUrl = `${CAL_URL}${uid}.ics` } = {}) {
  const calRefId = upsertCalendar(CAL_URL);
  const before = insertSyncedEvent({ uid, calRefId, objectUrl, tzid: 'Europe/Berlin' });
  if (Object.keys(fields).length) {
    const sets = Object.keys(fields).map((f) => `${f} = @${f}`).join(', ');
    db.prepare(`UPDATE calendar_events SET ${sets} WHERE id = @id`).run({ ...fields, id: before.id });
  }
  outbound.markEventOutbound(before, reload(before.id));
  return reload(before.id);
}

test('schreibt die Änderung als PUT auf die Objekt-URL zurück', async () => {
  reset();
  const event = seedDirty('u1@t', { title: 'Neuer Titel' });

  const client = fakeClient();
  assert.equal(await processPendingUpdates(client, 'caldav', indexFor('u1@t', { url: `${CAL_URL}u1@t.ics` })), 1);

  assert.equal(client.updates.length, 1);
  const sent = client.updates[0].calendarObject;
  assert.equal(sent.url, `${CAL_URL}u1@t.ics`);
  assert.match(sent.data, /SUMMARY:Neuer Titel/);
  assert.match(sent.data, /ATTENDEE;CN=Maria/, 'der Teilnehmer des Servers bleibt erhalten');
  assert.equal(reload(event.id).outbound_dirty, 0);
});

test('eine Umfaerbung erreicht den Server, statt einen leeren PUT zu kosten', async () => {
  reset();
  const event = seedDirty('c1@t', { color: '#3CA368' });

  const client = fakeClient();
  assert.equal(await processPendingUpdates(client, 'caldav', indexFor('c1@t', {
    url: `${CAL_URL}c1@t.ics`, data: serverObject('c1@t', { extra: ['COLOR:tomato'] }),
  })), 1);

  assert.match(client.updates[0].calendarObject.data, /^COLOR:mediumseagreen$/m);
  assert.equal(reload(event.id).outbound_dirty, 0);
});

test('eine Bearbeitung ohne Farbwahl laesst die des Servers stehen', async () => {
  // Der Repro aus der Review von #898: ein Termin kommt ohne COLOR herein (lokal
  // null), der Nutzer aendert nur den TITEL, und danach faerbt ein anderer
  // Client ihn auf dem Server ein. Yuvomi erfaehrt davon zwischen Bearbeitung
  // und Push nichts. Ginge hier ein pauschales null hinaus, raeumte die
  // Titelaenderung eine fremde Farbe ab - vor #899 sogar dauerhaft, weil das
  // Gatter des Inbound an user_modified hing und sie nie zurueckholte.
  reset();
  const event = seedDirty('c2@t', { color: null, title: 'Neuer Titel' });
  assert.equal(reload(event.id).color_modified, 0, 'Vorbedingung: hier wurde keine Farbe gewaehlt');

  const client = fakeClient();
  assert.equal(await processPendingUpdates(client, 'caldav', indexFor('c2@t', {
    url: `${CAL_URL}c2@t.ics`, data: serverObject('c2@t', { extra: ['COLOR:tomato'] }),
  })), 1);

  const sent = client.updates[0].calendarObject.data;
  assert.match(sent, /^COLOR:tomato$/m, 'die fremde Farbe ueberlebt die Bearbeitung');
  assert.match(sent, /SUMMARY:Neuer Titel/, 'und die Bearbeitung selbst kommt an');
  assert.equal(reload(event.id).outbound_dirty, 0);
});

test('ein geleertes Feld raeumt die Farbe beim Server ab (#899)', async () => {
  // Die Gegenprobe zum Test darueber und der Fall, den #898 zurueckbekommt:
  // dieselbe Ausgangslage, nur hat der Nutzer die Farbe hier wirklich geleert.
  // Ohne diesen Test waere der Test darueber auch dann gruen, wenn der Ausgang
  // ueberhaupt keine Farbe mehr entfernen koennte.
  reset();
  const event = seedDirty('c3@t', { color: null, color_modified: 1 });

  const client = fakeClient();
  assert.equal(await processPendingUpdates(client, 'caldav', indexFor('c3@t', {
    url: `${CAL_URL}c3@t.ics`, data: serverObject('c3@t', { extra: ['COLOR:tomato'] }),
  })), 1);

  const sent = client.updates[0].calendarObject.data;
  assert.doesNotMatch(sent, /^COLOR:/m, 'die geleerte Farbe muss auch drueben verschwinden');
  assert.match(sent, /ATTENDEE;CN=Maria/, 'und nur sie - der Rest des Objekts bleibt unangetastet');
  assert.equal(reload(event.id).outbound_dirty, 0);
});

test('ohne das Originalobjekt wird nichts geschrieben, sondern vertagt', async () => {
  reset();
  const event = seedDirty('u2@t', { title: 'Neu' });

  const client = fakeClient();
  // Der Lauf hat dieses Objekt nicht geholt (anderer Kalender, Fetch-Fehler).
  assert.equal(await processPendingUpdates(client, 'caldav', new Map()), 0);

  assert.equal(client.updates.length, 0, 'ein Neuaufbau würde Serverfelder verlieren');
  assert.equal(reload(event.id).outbound_dirty, 1, 'die Änderung bleibt vorgemerkt');
});

test('ein Serverfehler lässt die Änderung für den nächsten Lauf stehen', async () => {
  reset();
  const event = seedDirty('u3@t', { title: 'Neu' });

  const client = fakeClient({ onUpdate: () => { throw httpError(500); } });
  await processPendingUpdates(client, 'caldav', indexFor('u3@t'));

  const row = reload(event.id);
  assert.equal(row.outbound_dirty, 1);
  assert.equal(row.outbound_attempts, 1);
});

test('ein etag-Konflikt (412) ist ein Wiederholungsfall', async () => {
  reset();
  const event = seedDirty('u4@t', { title: 'Neu' });

  const client = fakeClient({ onUpdate: () => { throw httpError(412); } });
  await processPendingUpdates(client, 'caldav', indexFor('u4@t'));

  assert.equal(reload(event.id).outbound_dirty, 1, 'der nächste Lauf liest den frischen etag');
});

test('ein auf dem Server gelöschter Termin verwirft die Änderung', async () => {
  reset();
  const event = seedDirty('u5@t', { title: 'Neu' });

  const client = fakeClient({ onUpdate: () => { throw httpError(404); } });
  await processPendingUpdates(client, 'caldav', indexFor('u5@t'));

  assert.equal(reload(event.id).outbound_dirty, 0);
});

test('ein Objekt ohne passendes VEVENT verwirft die Änderung, statt es zu zerstören', async () => {
  reset();
  const event = seedDirty('u6@t', { title: 'Neu' });

  const client = fakeClient();
  const index = indexFor('u6@t', { data: serverObject('jemand-anderes@t') });
  assert.equal(await processPendingUpdates(client, 'caldav', index), 0);

  assert.equal(client.updates.length, 0);
  assert.equal(reload(event.id).outbound_dirty, 0);
});

// ── Kalenderwechsel ─────────────────────────────────────────────────────────────

test('ein Kalenderwechsel legt im Ziel an und löscht danach in der Quelle', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const before = insertSyncedEvent({
    uid: 'mv@t', calRefId, objectUrl: `${CAL_URL}mv@t.ics`, target: CAL_URL,
  });
  db.prepare('UPDATE calendar_events SET target_caldav_calendar_url = ? WHERE id = ?').run(CAL2_URL, before.id);
  outbound.markEventOutbound(before, reload(before.id));

  const client = fakeClient();
  const calendars = new Map([[CAL2_URL, { url: CAL2_URL, displayName: 'Arbeit' }]]);
  assert.equal(await processPendingUpdates(client, 'caldav', indexFor('mv@t'), calendars), 1);

  assert.equal(client.creates.length, 1);
  assert.equal(client.creates[0].calendar.url, CAL2_URL);
  assert.equal(client.deletes.length, 1, 'die Quelle wird erst nach dem Anlegen geräumt');
  assert.equal(client.deletes[0].calendarObject.url, `${CAL_URL}mv@t.ics`);
  assert.equal(reload(before.id).outbound_move_to, null);
});

test('scheitert das Anlegen im Ziel, wird in der Quelle nichts gelöscht', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const before = insertSyncedEvent({
    uid: 'mv2@t', calRefId, objectUrl: `${CAL_URL}mv2@t.ics`, target: CAL_URL,
  });
  db.prepare('UPDATE calendar_events SET target_caldav_calendar_url = ? WHERE id = ?').run(CAL2_URL, before.id);
  outbound.markEventOutbound(before, reload(before.id));

  const client = fakeClient({ onCreate: () => { throw httpError(507); } });
  const calendars = new Map([[CAL2_URL, { url: CAL2_URL, displayName: 'Arbeit' }]]);
  await processPendingUpdates(client, 'caldav', indexFor('mv2@t'), calendars);

  assert.equal(client.deletes.length, 0, 'sonst wäre der Termin nirgends mehr');
  assert.equal(reload(before.id).outbound_move_to, CAL2_URL, 'der nächste Lauf versucht es erneut');
});

// ── Sofortversuch ───────────────────────────────────────────────────────────────

/** Attrappe mit gezieltem Objektabruf, wie ihn der Sofortversuch nutzt. */
function fakeImmediateClient({ objects = {}, ...rest } = {}) {
  const client = fakeClient(rest);
  client.fetches = [];
  client.fetchCalendarObjects = async ({ calendar, objectUrls }) => {
    client.fetches.push({ calendarUrl: calendar?.url, objectUrls });
    return (objectUrls || []).filter((u) => objects[u]).map((u) => ({ url: u, etag: '"e"', data: objects[u] }));
  };
  client.fetchCalendars = async () => [{ url: CAL2_URL, displayName: 'Arbeit' }];
  return client;
}

function seedAccountCalendar(url = CAL_URL) {
  const accountId = db.prepare('SELECT id FROM caldav_accounts LIMIT 1').get().id;
  db.prepare(`INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, enabled)
              VALUES (?, ?, 'Familie', 1)`).run(accountId, url);
  return accountId;
}

test('der Sofortversuch löscht ohne jeden Kalenderabruf', async () => {
  reset();
  db.prepare('DELETE FROM caldav_calendar_selection').run();
  seedAccountCalendar();
  const calRefId = upsertCalendar(CAL_URL);
  const event = insertSyncedEvent({ uid: 'now@t', calRefId, objectUrl: `${CAL_URL}now@t.ics` });
  outbound.queueEventDeletion(event);

  const client = fakeImmediateClient();
  const { flushOutbound } = await import('../server/services/caldav-sync.js');
  const res = await flushOutbound({ createClient: async () => client });

  assert.equal(res.deleted, 1);
  assert.equal(client.deletes[0].calendarObject.url, `${CAL_URL}now@t.ics`);
  assert.equal(client.fetches.length, 0, 'für eine Löschung genügt die gespeicherte URL');
  assert.equal(tombstones().length, 0);
});

test('der Sofortversuch holt für eine Änderung nur das eine Objekt', async () => {
  reset();
  db.prepare('DELETE FROM caldav_calendar_selection').run();
  seedAccountCalendar();
  const event = seedDirty('now2@t', { title: 'Sofort' });

  const url = `${CAL_URL}now2@t.ics`;
  const client = fakeImmediateClient({ objects: { [url]: serverObject('now2@t') } });
  const { flushOutbound } = await import('../server/services/caldav-sync.js');
  const res = await flushOutbound({ createClient: async () => client });

  assert.equal(res.updated, 1);
  assert.deepEqual(client.fetches, [{ calendarUrl: CAL_URL, objectUrls: [url] }],
    'kein voller Kalenderabruf, nur das betroffene Objekt');
  assert.match(client.updates[0].calendarObject.data, /SUMMARY:Sofort/);
  assert.equal(reload(event.id).outbound_dirty, 0);
});

test('ohne bekannte Objekt-URL bleibt alles für den Sync liegen', async () => {
  reset();
  db.prepare('DELETE FROM caldav_calendar_selection').run();
  seedAccountCalendar();
  const calRefId = upsertCalendar(CAL_URL);
  // Altbestand vor Migration v106: URL unbekannt.
  outbound.queueEventDeletion(insertSyncedEvent({ uid: 'old@t', calRefId }));

  const client = fakeImmediateClient();
  const { flushOutbound } = await import('../server/services/caldav-sync.js');
  const res = await flushOutbound({ createClient: async () => client });

  assert.deepEqual(res, { deleted: 0, updated: 0 });
  assert.equal(client.deletes.length, 0);
  assert.equal(tombstones().length, 1, 'der nächste Sync löst die URL über den Kalender auf');
});

test('der Sofortversuch fasst einen fremden Account nicht an', async () => {
  reset();
  db.prepare('DELETE FROM caldav_calendar_selection').run();
  // Der Kalender des Termins ist keinem Konto zugeordnet.
  const calRefId = upsertCalendar(CAL2_URL);
  outbound.queueEventDeletion(insertSyncedEvent({
    uid: 'foreign@t', calRefId, objectUrl: `${CAL2_URL}foreign.ics`,
  }));

  const client = fakeImmediateClient();
  const { flushOutbound } = await import('../server/services/caldav-sync.js');
  assert.deepEqual(await flushOutbound({ createClient: async () => client }), { deleted: 0, updated: 0 });
  assert.equal(tombstones().length, 1);
});

test('ein nicht erreichbarer Server lässt die Vormerkung unangetastet', async () => {
  reset();
  db.prepare('DELETE FROM caldav_calendar_selection').run();
  seedAccountCalendar();
  const calRefId = upsertCalendar(CAL_URL);
  outbound.queueEventDeletion(insertSyncedEvent({
    uid: 'down@t', calRefId, objectUrl: `${CAL_URL}down.ics`,
  }));

  const { flushOutbound } = await import('../server/services/caldav-sync.js');
  const res = await flushOutbound({ createClient: async () => { throw new Error('ECONNREFUSED'); } });

  assert.deepEqual(res, { deleted: 0, updated: 0 });
  assert.equal(tombstones().length, 1, 'der Sync zieht nach');
});

test('ohne offene Arbeit baut der Sofortversuch keine Verbindung auf', async () => {
  reset();
  db.prepare('DELETE FROM caldav_calendar_selection').run();
  seedAccountCalendar();

  let built = false;
  const { flushOutbound } = await import('../server/services/caldav-sync.js');
  const res = await flushOutbound({ createClient: async () => { built = true; return fakeImmediateClient(); } });

  assert.deepEqual(res, { deleted: 0, updated: 0 });
  assert.equal(built, false);
});

test('ein unbekannter Zielkalender lässt den Termin, wo er ist', async () => {
  reset();
  const calRefId = upsertCalendar(CAL_URL);
  const before = insertSyncedEvent({
    uid: 'mv3@t', calRefId, objectUrl: `${CAL_URL}mv3@t.ics`, target: CAL_URL,
  });
  db.prepare('UPDATE calendar_events SET target_caldav_calendar_url = ? WHERE id = ?').run(CAL2_URL, before.id);
  outbound.markEventOutbound(before, reload(before.id));

  const client = fakeClient();
  await processPendingUpdates(client, 'caldav', indexFor('mv3@t'), new Map());

  assert.equal(client.creates.length, 0);
  assert.equal(client.deletes.length, 0);
  assert.equal(reload(before.id).outbound_move_to, null, 'die Vormerkung läuft nicht ewig nach');
});

test('patchICSEvent setzt genau ein RRULE-Präfix, egal welche Schreibweise ankommt (#761)', async () => {
  // Ein Termin trägt seine Regel in zwei Schreibweisen: lokal angelegt als
  // nackter Körper, aus ICS/CalDAV eingelesen mit `RRULE:` davor. Der Patch-Pfad
  // bekommt beide und muss beide auf dieselbe eine Zeile bringen - sonst landet
  // beim Server, was Home Assistant im Feed abgewiesen hat.
  const { patchICSEvent } = await import('../server/utils/ics-patch.js');
  const original = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:abc',
    'DTSTART:20260105T070000Z', 'SUMMARY:Alt', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  for (const rule of ['FREQ=DAILY;INTERVAL=2', 'RRULE:FREQ=DAILY;INTERVAL=2']) {
    const out = patchICSEvent(original, 'abc', { RRULE: rule });
    const lines = out.split('\r\n').filter((l) => /^RRULE/i.test(l));
    assert.deepEqual(lines, ['RRULE:FREQ=DAILY;INTERVAL=2'], `Eingabe: ${rule}`);
  }
});

// ── Durable scoped provider operations ──────────────────────────────────────────

function scopedCalDAVOperation({ scope = 'this', uid = 'series@t', occurrenceStart = '2035-03-17T09:00', after = {}, split = null, provider = null } = {}) {
  const next = {
    title: 'Neue Ausnahme', description: null, location: null, color: null,
    start_datetime: '2035-03-17T12:00', end_datetime: '2035-03-17T13:00',
    all_day: 0, recurrence_rule: 'RRULE:FREQ=WEEKLY', tzid: 'Europe/Berlin', ...after,
  };
  return {
    id: 1,
    source: 'caldav',
    scope,
    occurrence_start: occurrenceStart,
    payload_json: JSON.stringify({
      source: 'caldav', scope, occurrence_start: occurrenceStart,
      before: { ...next, title: 'Vorher' }, after: next,
      master_external_id: uid, target_calendar_id: CAL_URL,
      ...(provider ? { provider } : {}),
      ...(split ? { split } : {}),
    }),
  };
}

test('CalDAV this edit patches only the original override and preserves the master', async () => {
  const uid = 'scoped@t';
  const data = serverObject(uid, { withOverride: true });
  const updates = [];
  const creates = [];
  const client = {
    updateCalendarObject: async (params) => { updates.push(params); },
    createCalendarObject: async (params) => {
      creates.push(params);
      return { etag: '"continuation-v1"' };
    },
  };
  const operation = scopedCalDAVOperation({ uid });

  assert.equal(caldavWriteCapability({ url: CAL_URL, writable: true }).writable, true);
  await processScopedOperation(
    client,
    operation,
    indexFor(uid, { data, etag: '"v1"', calendarUrl: CAL_URL }),
    new Map([[CAL_URL, { url: CAL_URL, writable: true }]]),
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0].calendarObject.etag, '"v1"');
  const sent = updates[0].calendarObject.data;
  const blocks = unfoldICS(sent).split('\n');
  const masterStart = blocks.indexOf('BEGIN:VEVENT');
  const masterEnd = blocks.indexOf('END:VEVENT', masterStart);
  const overrideStart = blocks.indexOf('BEGIN:VEVENT', masterEnd + 1);
  const overrideEnd = blocks.indexOf('END:VEVENT', overrideStart);
  const master = blocks.slice(masterStart, masterEnd + 1).join('\n');
  const override = blocks.slice(overrideStart, overrideEnd + 1).join('\n');
  assert.match(master, /SUMMARY:Alter Titel/);
  assert.match(override, /SUMMARY:Neue Ausnahme/);
  assert.match(override, /DTSTART;TZID=Europe\/Berlin:20350317T120000/);
  assert.match(master, /ATTENDEE;CN=Maria/);
  assert.match(master, /BEGIN:VALARM/);
});

test('CalDAV detached edits keep the synthetic local identity out of VEVENT UID', async () => {
  const uid = 'detached@t';
  const occurrenceUid = `${uid}::2035-03-17`;
  let source = serverObject(uid, { withOverride: true });
  const writes = [];
  const client = {
    updateCalendarObject: async ({ calendarObject }) => {
      const uidLines = unfoldICS(calendarObject.data).split('\n')
        .filter((line) => /^UID:/i.test(line));
      assert.deepEqual([...new Set(uidLines)], [`UID:${uid}`]);
      assert.doesNotMatch(calendarObject.data, /UID:detached@t::2035-03-17/);
      writes.push(calendarObject.data);
      return { etag: `"v${writes.length + 1}"` };
    },
  };
  const operation = scopedCalDAVOperation({
    uid,
    provider: { uid: occurrenceUid, masterUid: uid, occurrenceUid, etag: '"v1"' },
  });

  const index = () => indexFor(uid, { data: source, etag: '"v1"' });
  const first = await processScopedOperation(
    client, operation, index(), new Map([[CAL_URL, { url: CAL_URL, writable: true }]]),
  );
  assert.equal(first.providerUid, occurrenceUid, 'the local exception remains traceable');
  source = writes[0];
  operation.payload_json = JSON.stringify({
    ...JSON.parse(operation.payload_json),
    after: {
      ...JSON.parse(operation.payload_json).after,
      title: 'Dritte Bearbeitung',
    },
  });
  await processScopedOperation(
    client, operation, index(), new Map([[CAL_URL, { url: CAL_URL, writable: true }]]),
  );
  assert.equal(writes.length, 2, 'a later scoped edit still patches the same resource');
});

test('CalDAV rejects a mixed-UID source instead of writing a corrupt resource', async () => {
  const uid = 'mixed@t';
  const invalid = `${serverObject(uid)}\r\nBEGIN:VEVENT\r\nUID:other@t\r\nSUMMARY:foreign\r\nEND:VEVENT`;
  let writes = 0;
  await assert.rejects(
    () => processScopedOperation(
      { updateCalendarObject: async () => { writes++; } },
      scopedCalDAVOperation({ uid }),
      indexFor(uid, { data: invalid }),
      new Map([[CAL_URL, { url: CAL_URL, writable: true }]]),
    ),
    (error) => error.code === 400 && error.permanent === true,
  );
  assert.equal(writes, 0);
});

test('CalDAV scoped write refuses an explicitly read-only calendar', async () => {
  const operation = scopedCalDAVOperation({ uid: 'readonly@t' });
  const client = { updateCalendarObject: async () => { throw new Error('must not write'); } };
  await assert.rejects(
    () => processScopedOperation(
      client,
      operation,
      indexFor('readonly@t', { data: serverObject('readonly@t'), calendarUrl: CAL_URL }),
      new Map([[CAL_URL, { url: CAL_URL, readOnly: true }]]),
    ),
    (error) => error.code === 403 && error.readOnly === true,
  );
});

test('CalDAV following split moves later exceptions and is idempotent on retry', async () => {
  const uid = 'following@t';
  const data = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', 'SEQUENCE:3',
    'SUMMARY:Serie', 'DTSTART;TZID=Europe/Berlin:20350310T090000',
    'DTEND;TZID=Europe/Berlin:20350310T100000', 'RRULE:FREQ=WEEKLY',
    'ATTENDEE;CN=Maria:mailto:maria@example.com',
    'END:VEVENT',
    'BEGIN:VEVENT', `UID:${uid}`, 'RECURRENCE-ID;TZID=Europe/Berlin:20350317T090000',
    'SUMMARY:Vorher verschoben', 'DTSTART;TZID=Europe/Berlin:20350317T110000',
    'DTEND;TZID=Europe/Berlin:20350317T120000', 'END:VEVENT',
    'BEGIN:VEVENT', `UID:${uid}`, 'RECURRENCE-ID;TZID=Europe/Berlin:20350324T090000',
    'SUMMARY:Nachher verschoben', 'DTSTART;TZID=Europe/Berlin:20350324T130000',
    'DTEND;TZID=Europe/Berlin:20350324T140000',
    'ATTENDEE;CN=Maria:mailto:maria@example.com', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const split = {
    master_after: {
      title: 'Serie', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
      all_day: 0, recurrence_rule: 'RRULE:FREQ=WEEKLY;UNTIL=20350323', tzid: 'Europe/Berlin',
    },
    new_master: {
      title: 'Neue Serie', start_datetime: '2035-03-24T11:00', end_datetime: '2035-03-24T12:00',
      all_day: 0, recurrence_rule: 'RRULE:FREQ=WEEKLY', tzid: 'Europe/Berlin',
    },
    exception_operations: [{
      local_event_id: 42,
      original_start: '2035-03-24T09:00',
      continuation_start: '2035-03-24T11:00',
    }],
    // The backend may also provide the raw component after a read-back. It is
    // the same moved exception and must not be duplicated in the new resource.
    exception_components: [
      'BEGIN:VEVENT\r\nUID:following@t.yuvomi-following-20350324T090000\r\nRECURRENCE-ID;TZID=Europe/Berlin:20350324T110000\r\nSUMMARY:Nachher verschoben\r\nDTSTART;TZID=Europe/Berlin:20350324T130000\r\nDTEND;TZID=Europe/Berlin:20350324T140000\r\nEND:VEVENT',
    ],
  };
  const operation = scopedCalDAVOperation({
    scope: 'following', uid, occurrenceStart: '2035-03-24T09:00', split,
  });
  const updates = [];
  const creates = [];
  const client = {
    updateCalendarObject: async (params) => { updates.push(params); },
    createCalendarObject: async (params) => {
      creates.push(params);
      return { etag: '"continuation-v1"' };
    },
  };
  const calendars = new Map([[CAL_URL, { url: CAL_URL, writable: true }]]);

  const firstResult = await processScopedOperation(
    client, operation, indexFor(uid, { data, etag: '"v1"' }), calendars,
  );
  assert.equal(firstResult.exceptionOperations.length, 1);
  assert.equal(firstResult.exceptionOperations[0].localEventId, 42);
  assert.equal(updates.length, 1, 'the old master is truncated in its original resource');
  assert.equal(creates.length, 1, 'the continuation is a distinct CalDAV resource');
  const oldResource = updates[0].calendarObject.data;
  const continuation = creates[0].iCalString;
  const newUid = 'following@t.yuvomi-following-20350324T090000';
  assert.doesNotMatch(oldResource, new RegExp(`UID:${newUid}`));
  assert.match(oldResource, /UID:following@t/);
  assert.equal(countVEvents(oldResource), 2, 'old resource keeps only the master and earlier exception');
  assert.match(continuation, new RegExp(`UID:${newUid}`));
  assert.doesNotMatch(continuation, /UID:following@t\r?\n/);
  assert.equal(countVEvents(continuation), 2, 'continuation resource has its master and moved exception');
  assert.equal(creates[0].filename, `${encodeURIComponent(newUid)}.ics`);
  assert.equal(firstResult.exceptionOperations[0].providerUid,
    `${newUid}::2035-03-24`);
  assert.equal(firstResult.exceptionOperations[0].providerEtag, '"continuation-v1"');
  assert.match(oldResource, /RRULE:FREQ=WEEKLY;UNTIL=20350323/);
  assert.match(continuation, /SUMMARY:Nachher verschoben/);
  assert.match(continuation, /RECURRENCE-ID;TZID=Europe\/Berlin:20350324T110000/);
  assert.match(continuation, /DTSTART;TZID=Europe\/Berlin:20350324T130000/);

  // A retry resumes from the provider progress checkpoint. It must not PUT the
  // old resource again or create a second continuation resource.
  operation.progress = firstResult.providerProgress;
  await processScopedOperation(
    client,
    operation,
    indexFor(uid, { data: oldResource, etag: '"v2"' }),
    calendars,
  );
  assert.equal(updates.length, 1);
  assert.equal(creates.length, 1);
});

test('CalDAV following queue resumes after old-resource success and continuation failure', async () => {
  reset();
  const uid = 'queued-following@t';
  const calRefId = upsertCalendar(CAL_URL);
  const event = insertSyncedEvent({
    uid, calRefId, objectUrl: `${CAL_URL}${uid}.ics`, target: CAL_URL,
    recurrence_rule: 'RRULE:FREQ=WEEKLY', tzid: 'Europe/Berlin',
  });
  const split = {
    master_after: {
      title: 'Serie', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
      all_day: 0, recurrence_rule: 'RRULE:FREQ=WEEKLY;UNTIL=20350323', tzid: 'Europe/Berlin',
    },
    new_master: {
      title: 'Neue Serie', start_datetime: '2035-03-24T11:00', end_datetime: '2035-03-24T12:00',
      all_day: 0, recurrence_rule: 'RRULE:FREQ=WEEKLY', tzid: 'Europe/Berlin',
    },
    exception_operations: [{
      local_event_id: 42, original_start: '2035-03-24T09:00', continuation_start: '2035-03-24T11:00',
    }],
  };
  const source = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', 'SEQUENCE:3',
    'SUMMARY:Serie', 'DTSTART;TZID=Europe/Berlin:20350310T090000',
    'DTEND;TZID=Europe/Berlin:20350310T100000', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    'BEGIN:VEVENT', `UID:${uid}`, 'RECURRENCE-ID;TZID=Europe/Berlin:20350324T090000',
    'SUMMARY:Später', 'DTSTART;TZID=Europe/Berlin:20350324T130000',
    'DTEND;TZID=Europe/Berlin:20350324T140000', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const template = scopedCalDAVOperation({ scope: 'following', uid, occurrenceStart: '2035-03-24T09:00', split });
  const operationId = editOperations.queueCalendarEditOperation({
    eventId: event.id, source: 'caldav', scope: 'following',
    occurrenceStart: '2035-03-24T09:00', payload: JSON.parse(template.payload_json),
  }, db);
  assert.ok(operationId);

  let createAttempts = 0;
  const updates = [];
  const creates = [];
  const client = {
    updateCalendarObject: async ({ calendarObject }) => {
      updates.push(calendarObject);
      return { etag: '"old-v2"' };
    },
    createCalendarObject: async (params) => {
      createAttempts++;
      creates.push(params);
      if (createAttempts === 1) throw httpError(503);
      return { etag: '"new-v1"', url: `${CAL_URL}queued-following-new.ics` };
    },
  };
  const calendars = new Map([[CAL_URL, { url: CAL_URL, writable: true }]]);
  const first = await caldavSyncTest.processScopedOperations(
    client, indexFor(uid, { data: source, etag: '"old-v1"' }), calendars, new Set([CAL_URL]),
  );
  assert.equal(first.retry, 1);
  assert.equal(updates.length, 1);
  assert.equal(creates.length, 1);
  const afterFailure = db.prepare(
    'SELECT status, progress_json FROM calendar_edit_operations WHERE id = ?',
  ).get(operationId);
  assert.equal(afterFailure.status, 'retry');
  const progress = JSON.parse(afterFailure.progress_json);
  assert.equal(progress.old_master.accepted, true);
  assert.equal(progress.continuation_master.accepted, undefined);

  const oldResource = updates[0].data;
  const second = await caldavSyncTest.processScopedOperations(
    client, indexFor(uid, { data: oldResource, etag: '"old-v2"' }), calendars, new Set([CAL_URL]),
  );
  assert.equal(second.completed, 1);
  assert.equal(updates.length, 1, 'accepted old resource is not overwritten on retry');
  assert.equal(creates.length, 2, 'the failed create is retried once');
  assert.equal(db.prepare('SELECT status FROM calendar_edit_operations WHERE id = ?').get(operationId).status, 'completed');
  assert.equal(reload(event.id).external_calendar_id, 'queued-following@t.yuvomi-following-20350324T090000');
});

test('Apple scoped consumer uses the fenced CalDAV adapter completion path', async () => {
  reset();
  const appleRefId = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES ('apple', ?, 'iCloud', '#FC3C44') RETURNING id
  `).get(CAL_URL).id;
  const event = insertSyncedEvent({
    uid: 'apple-scoped@t', source: 'apple', calRefId: appleRefId,
    objectUrl: `${CAL_URL}apple-scoped.ics`, target: CAL_URL,
  });
  const template = scopedCalDAVOperation({ uid: 'apple-scoped@t' });
  const payload = JSON.parse(template.payload_json);
  payload.source = 'apple';
  const operationId = editOperations.queueCalendarEditOperation({
    eventId: event.id, source: 'apple', scope: 'this',
    occurrenceStart: '2035-03-17T09:00', payload,
  }, db);
  const client = {
    updateCalendarObject: async () => ({ etag: '"apple-v2"' }),
  };
  const result = await appleSyncTest.processScopedAppleOperations(
    client,
    indexFor('apple-scoped@t', { data: serverObject('apple-scoped@t') }),
    new Map([[CAL_URL, { url: CAL_URL, writable: true }]]),
  );
  assert.deepEqual(result, { completed: 1, retry: 0, error: 0, conflict: 0 });
  assert.equal(db.prepare('SELECT status FROM calendar_edit_operations WHERE id = ?').get(operationId).status, 'completed');
  assert.equal(reload(event.id).external_source, 'apple');
  assert.equal(reload(event.id).provider_revision, '"apple-v2"');
});
