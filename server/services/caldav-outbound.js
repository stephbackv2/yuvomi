// --------------------------------------------------------
// Ausgehende Änderungen für CalDAV-Server (Issue #593).
//
// Geteilt vom generischen Multi-Account-Sync (caldav-sync.js) und vom
// Apple-Legacy-Sync (apple-calendar.js): beide sprechen dasselbe Protokoll und
// hätten sonst zwei Kopien derselben Logik.
//
// CalDAV kennt keinen Aufruf "ändere Event X in Kalender Y": ein Kalenderobjekt
// wird über SEINE eigene URL angefasst. Die URL steht seit Migration v106 in
// calendar_events.external_object_url; für Termine, die davor synchronisiert
// wurden, löst der laufende Sync sie über die UID der gerade geholten Objekte auf.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as outbound from './calendar-outbound.js';
import * as editOperations from './calendar-edit-operations.js';
import { patchICSEvent, unfoldICS, foldICSLine } from '../utils/ics-patch.js';
import { eventDateTimeFields } from '../utils/ics-datetime.js';
import { householdTimeZone, localToUTC, utcToWall } from '../utils/timezone.js';
import * as db from '../db.js';
import { nearestIcalColorName } from '../utils/ical-color.js';
import { outboundEvent } from './outbound-dtstart.js';

const log = createLogger('CalDAVOutbound');

const label = (source) => (source === 'apple' ? 'Apple' : 'CalDAV');

function privilegeTokens(value, tokens = []) {
  if (value === null || value === undefined) return tokens;
  if (typeof value === 'string') {
    tokens.push(...value.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
    return tokens;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => privilegeTokens(item, tokens));
    return tokens;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (typeof item === 'boolean') {
        if (item) privilegeTokens(key, tokens);
      } else {
        privilegeTokens(key, tokens);
        privilegeTokens(item, tokens);
      }
    });
  }
  return tokens;
}

/**
 * Interprets the optional write-right metadata returned by a CalDAV server.
 * Servers differ in whether tsdav exposes DAV privileges as strings, XML-like
 * objects, or a boolean `readOnly`; absent metadata is unknown and therefore
 * cannot authorize a scoped write. An explicit read-only signal always wins
 * and is surfaced to the durable scoped-operation queue as a permanent error.
 */
export function caldavWriteCapability(calendar) {
  const explicitReadOnly = calendar?.readOnly ?? calendar?.read_only ?? calendar?.readonly;
  if (explicitReadOnly === true) {
    return { writable: false, readOnly: true, reason: 'provider_readonly' };
  }
  if (calendar?.writable === false || calendar?.canWrite === false || calendar?.can_write === false) {
    return { writable: false, readOnly: true, reason: 'provider_readonly' };
  }
  if (calendar?.writable === true || calendar?.canWrite === true || calendar?.can_write === true) {
    return { writable: true, readOnly: false, reason: null };
  }

  const raw = calendar?.privilegeSet ?? calendar?.privileges ?? calendar?.currentUserPrivilegeSet
    ?? calendar?.current_user_privilege_set ?? calendar?.projectedProps?.privilegeSet
    ?? calendar?.projectedProps?.currentUserPrivilegeSet
    ?? calendar?.projectedProps?.current_user_privilege_set;
  const tokens = privilegeTokens(raw);
  if (tokens.length) {
    const hasWrite = tokens.some((token) => token === 'write' || token.startsWith('write-')
      || token === 'bind' || token === 'unbind');
    return hasWrite
      ? { writable: true, readOnly: false, reason: null }
      : { writable: false, readOnly: true, reason: 'provider_readonly' };
  }
  return { writable: null, readOnly: false, reason: 'provider_capability_unknown' };
}

function readOnlyCalDAVError(calendar, context = 'calendar') {
  const capability = caldavWriteCapability(calendar);
  if (capability.writable === true) return null;
  const err = new Error(`CalDAV ${context} is read-only.`);
  err.code = 403;
  err.readOnly = capability.writable === false;
  err.reason = capability.reason;
  return err;
}

function icsPropertyName(line) {
  const cut = line.search(/[;:]/);
  return (cut === -1 ? line : line.slice(0, cut)).toUpperCase();
}

function eventBlocks(icsText) {
  const lines = unfoldICS(icsText).split('\n');
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VEVENT') current = { start: index, end: -1 };
    else if (upper === 'END:VEVENT' && current) {
      current.end = index;
      blocks.push(current);
      current = null;
    }
  });
  return { lines, blocks };
}

function propertyValue(line) {
  const cut = line.indexOf(':');
  return cut < 0 ? '' : line.slice(cut + 1).trim();
}

function occurrenceDigits(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)/);
  if (iso) {
    return `${iso[1]}${iso[2]}${iso[3]}T${iso[4]}${iso[5]}${iso[6] || '00'}`;
  }
  const compact = raw.replace(/[^0-9T]/gi, '');
  const match = compact.match(/^(\d{8})(?:T?(\d{6}))?/i);
  return match ? `${match[1]}${match[2] ? `T${match[2]}` : ''}` : '';
}

function sameOccurrenceIdentity(left, right) {
  const a = occurrenceDigits(left);
  const b = occurrenceDigits(right);
  if (!a || !b) return false;
  const aHasTime = a.includes('T');
  const bHasTime = b.includes('T');
  return a.slice(0, 8) === b.slice(0, 8)
    && (!aHasTime || !bHasTime || a.slice(9) === b.slice(9));
}

function occurrenceAtOrAfter(value, cut) {
  const a = occurrenceDigits(value);
  const b = occurrenceDigits(cut);
  if (!a || !b) return false;
  if (a.slice(0, 8) !== b.slice(0, 8)) return a.slice(0, 8) >= b.slice(0, 8);
  if (!a.includes('T') || !b.includes('T')) return true;
  return a.slice(9) >= b.slice(9);
}

function occurrenceDateKey(value, tzid = null) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (tzid && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const wall = utcToWall(raw, tzid);
    if (wall?.date) return wall.date;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

function temporalMillis(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const input = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z`
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? ms : null;
}

function compactTemporalMillis(raw) {
  const value = String(raw || '').trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/i.exec(value);
  if (!match) return null;
  return {
    ms: Date.UTC(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4] || '0'), Number(match[5] || '0'), Number(match[6] || '0'),
    ),
    hasTime: !!match[4],
    suffix: match[7] ? 'Z' : '',
  };
}

function compactFromMillis(ms, { hasTime, suffix }) {
  const date = new Date(ms);
  const base = `${date.getUTCFullYear().toString().padStart(4, '0')}`
    + `${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    + `${String(date.getUTCDate()).padStart(2, '0')}`;
  if (!hasTime) return base;
  return `${base}T${String(date.getUTCHours()).padStart(2, '0')}`
    + `${String(date.getUTCMinutes()).padStart(2, '0')}`
    + `${String(date.getUTCSeconds()).padStart(2, '0')}${suffix || ''}`;
}

function rebaseRecurrenceLine(line, deltaMs) {
  if (!deltaMs || icsPropertyName(line) !== 'RECURRENCE-ID') return line;
  const cut = line.indexOf(':');
  if (cut < 0) return line;
  const parsed = compactTemporalMillis(line.slice(cut + 1));
  if (!parsed) return line;
  return `${line.slice(0, cut + 1)}${compactFromMillis(parsed.ms + deltaMs, parsed)}`;
}

function rebaseExceptionComponent(component, deltaMs) {
  if (!deltaMs) return component;
  return unfoldICS(String(component)).split('\n').map((line) => (
    rebaseRecurrenceLine(line, deltaMs)
  )).map(foldICSLine).join('\r\n');
}

function blockUid(lines, block) {
  const line = lines.slice(block.start + 1, block.end).find((item) => icsPropertyName(item) === 'UID');
  return line ? propertyValue(line) : null;
}

function blockRecurrenceId(lines, block) {
  const line = lines.slice(block.start + 1, block.end).find((item) => icsPropertyName(item) === 'RECURRENCE-ID');
  return line ? propertyValue(line) : null;
}

function matchingOccurrenceBlock(lines, blocks, uid, occurrenceStart, occurrenceUid = null) {
  return blocks.find((block) => (blockUid(lines, block) === uid
      || (occurrenceUid && blockUid(lines, block) === occurrenceUid))
    && blockRecurrenceId(lines, block)
    && sameOccurrenceIdentity(blockRecurrenceId(lines, block), occurrenceStart));
}

function replaceBlockUidAndRecurrence(lines, block, uid, recurrenceName = 'RECURRENCE-ID') {
  const sentinelUid = `__yuvomi_occurrence_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  const out = [...lines];
  for (let i = block.start + 1; i < block.end; i++) {
    if (icsPropertyName(out[i]) === 'UID') out[i] = `UID:${sentinelUid}`;
    if (icsPropertyName(out[i]) === 'RECURRENCE-ID') {
      const cut = out[i].indexOf(':');
      out[i] = `${recurrenceName}${out[i].slice(0, cut).slice('RECURRENCE-ID'.length)}${out[i].slice(cut)}`;
    }
  }
  return { out, sentinelUid };
}

function restoreOccurrenceSentinels(text, sentinelUid, uid, restoreUid = uid) {
  return unfoldICS(text).split('\n').map((line) => {
    if (icsPropertyName(line) === 'UID' && propertyValue(line) === sentinelUid) return `UID:${restoreUid}`;
    if (icsPropertyName(line) === 'X-YUVOMI-RECURRENCE-ID') {
      return `RECURRENCE-ID${line.slice('X-YUVOMI-RECURRENCE-ID'.length)}`;
    }
    return line;
  }).map(foldICSLine).join('\r\n');
}

/**
 * Patches a particular RECURRENCE-ID component while preserving the master,
 * alarms, attendees and every property Yuvomi does not own. If a provider
 * exposes the occurrence only through the master, a new override is cloned
 * from that master instead of falling back to a master patch.
 */
export function patchICSEventOccurrence(
  icsText,
  uid,
  occurrenceStart,
  fields = {},
  { tzid = null, occurrenceUid = null } = {},
) {
  const { lines, blocks } = eventBlocks(icsText);
  const target = matchingOccurrenceBlock(lines, blocks, uid, occurrenceStart, occurrenceUid);
  if (target) {
    const { out, sentinelUid } = replaceBlockUidAndRecurrence(lines, target, uid, 'X-YUVOMI-RECURRENCE-ID');
    const patched = patchICSEvent(out.join('\r\n'), sentinelUid, fields, { tzid });
    // occurrenceUid is a local lookup identity (for example UID::date) when
    // the detached row has no separate CalDAV resource. It must never leak
    // into the VEVENT UID written back to the provider.
    return patched ? restoreOccurrenceSentinels(patched, sentinelUid, uid, uid) : null;
  }

  const master = blocks.find((block) => blockUid(lines, block) === uid && !blockRecurrenceId(lines, block));
  if (!master) return null;
  const { out, sentinelUid } = replaceBlockUidAndRecurrence(lines, master, uid, 'X-YUVOMI-RECURRENCE-ID');
  const masterLines = out.slice(master.start, master.end + 1).filter((line) => {
    const name = icsPropertyName(line);
    return name !== 'RRULE' && name !== 'EXDATE' && name !== 'RECURRENCE-ID';
  });
  const recLine = fields.DTSTART?.params?.includes('VALUE=DATE')
    ? `X-YUVOMI-RECURRENCE-ID;VALUE=DATE:${String(occurrenceStart).slice(0, 10).replaceAll('-', '')}`
    : `X-YUVOMI-RECURRENCE-ID${fields.DTSTART?.params || (tzid ? `;TZID=${tzid}` : '')}:${occurrenceDigits(occurrenceStart)}`;
  const component = [...masterLines];
  const insertAt = Math.max(1, component.length - 1);
  component.splice(insertAt, 0, recLine);
  const wrapper = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', ...component, 'END:VCALENDAR',
  ].join('\r\n').replace(`UID:${sentinelUid}`, `UID:${sentinelUid}`);
  const patched = patchICSEvent(wrapper, sentinelUid, fields, { tzid });
  if (!patched) return null;
  const patchLines = unfoldICS(patched).split('\n');
  const generated = patchLines.slice(patchLines.findIndex((line) => line.trim() === 'BEGIN:VEVENT'),
    patchLines.findIndex((line) => line.trim() === 'END:VEVENT') + 1);
  const originalLines = unfoldICS(icsText).split('\n');
  let end = originalLines.findIndex((line) => line.trim().toUpperCase() === 'END:VCALENDAR');
  if (end < 0) end = originalLines.length;
  const restored = generated.map((line) => {
    if (icsPropertyName(line) === 'UID' && propertyValue(line) === sentinelUid) {
      return `UID:${uid}`;
    }
    if (icsPropertyName(line) === 'X-YUVOMI-RECURRENCE-ID') {
      return `RECURRENCE-ID${line.slice('X-YUVOMI-RECURRENCE-ID'.length)}`;
    }
    return line;
  });
  return [...originalLines.slice(0, end), ...restored, ...originalLines.slice(end)]
    .map(foldICSLine).join('\r\n');
}

/**
 * Kalender-Properties eines lokalen Termins für patchICSEvent.
 *
 * Die Zeitangaben kommen seit #938 aus `eventDateTimeFields`: der Fall, den es
 * hier gab und der hier nicht auffiel, ist der lokal angelegte Termin. Er hat
 * kein `tzid`, also stand ein `DTSTART:20260830T100000` ohne jede Zone im PUT -
 * floating time, die iOS richtig raet und ein DAViCal-Backend gar nicht erst
 * anzeigt. Jetzt traegt er die Zone des Haushalts.
 *
 * Zurueck kommt das Feld-Objekt UND die Zone, deren VTIMEZONE mitgeschickt
 * werden muss - zusammen, weil ein TZID ohne seinen Block ein ungueltiges
 * Objekt ergibt und getrennte Rueckgabewerte den Aufrufer einladen, das zweite
 * zu vergessen.
 *
 * @param {object} event
 * @param {string|null} householdZone Zone des Haushalts; ohne sie bleibt es beim
 *        UTC-Suffix - eindeutig, aber ohne Zonenbezug.
 * @returns {{ fields: object, tzid: string|null }}
 */
export function icsFieldsForEvent(event, householdZone = null) {
  // Start/Ende mit der eigenen Wiederholungsregel in Einklang (#986); ein
  // importiertes DTSTART bleibt unberuehrt (#756).
  const when = eventDateTimeFields(outboundEvent(event), householdZone);

  const fields = {
    SUMMARY:     event.title,
    DESCRIPTION: event.description || null,
    LOCATION:    event.location || null,
    RRULE:       event.recurrence_rule || null,
    DTSTART:     when.dtstart,
    DTEND:       when.dtend,
  };

  // COLOR ist Teil von MIRRORED_FIELDS, wurde aber nie geschrieben (#897): eine
  // Umfaerbung kostete einen PUT, der beim Server nichts aenderte.
  //
  // DREI FAELLE, und der Unterschied zwischen den letzten beiden ist der ganze
  // Punkt von #899:
  //
  //   1. Eine Eigenfarbe, die sich abbilden laesst → ihr CSS3-Name geht hinaus.
  //   2. Keine Eigenfarbe, und der Nutzer hat sie GELEERT (color_modified = 1)
  //      → null, und der Patcher entfernt die COLOR-Zeile. Verwaltet heisst
  //      ersetzen UND entfernen; erst hier wird die zweite Haelfte gebraucht.
  //   3. Keine Eigenfarbe, weil wir nie eine gelernt haben (color_modified = 0)
  //      → das Feld bleibt weg, "nicht anfassen".
  //
  // Fall 3 ist keine Vorsicht ohne Anlass. Ein Termin kommt ohne COLOR herein,
  // jemand faerbt ihn spaeter auf dem SERVER, und Yuvomi erfaehrt davon erst
  // beim naechsten Inbound-Lauf - der aber laeuft nicht zwischen der Bearbeitung
  // und ihrem Push. Ein pauschales null haette dessen Farbe abgeraeumt, und vor
  // #899 dauerhaft: das Gatter hing an `user_modified`, das jede Bearbeitung
  // setzt, also holte auch kein spaeterer Lauf sie zurueck.
  //
  // Eine Farbe, die sich nicht abbilden laesst (kein gueltiges #RRGGBB), faellt
  // NICHT in Fall 2: `event.color` steht, geleert wurde nichts. Sie bleibt in
  // Fall 3 - ein null wuerde eine fremde Farbe wegwerfen, um einen Wert
  // wiederzugeben, den wir gar nicht ausdruecken koennen.
  const colorName = nearestIcalColorName(event.color);
  if (colorName) fields.COLOR = colorName;
  else if (!event.color && event.color_modified) fields.COLOR = null;

  return { fields, tzid: when.tzid };
}

/** Dateiname eines Kalenderobjekts aus seiner URL, ersatzweise aus der UID. */
export function filenameFromUrl(url, uid) {
  const last = String(url).split('/').filter(Boolean).pop();
  return last && last.includes('.') ? last : `${uid}.ics`;
}

/**
 * Holt gezielt einzelne Kalenderobjekte statt ganzer Kalender - die Grundlage des
 * Sofortversuchs direkt nach einer Bearbeitung (#593). Ein voller Kalenderabruf
 * wäre dafür unverhältnismäßig; hier zählt nur das eine geänderte Objekt.
 *
 * @param {object} client
 * @param {Array<{uid:string,url:string,calendarUrl:string}>} wanted
 * @returns {Promise<Map>} UID → { url, etag, data, calendarUrl }
 */
export async function fetchObjectsByUrl(client, wanted) {
  const index = new Map();
  if (!wanted.length) return index;

  // Nach Kalender gruppieren: fetchCalendarObjects adressiert Objekte innerhalb
  // einer Collection.
  const byCalendar = new Map();
  for (const item of wanted) {
    if (!item.url || !item.calendarUrl) continue;
    if (!byCalendar.has(item.calendarUrl)) byCalendar.set(item.calendarUrl, []);
    byCalendar.get(item.calendarUrl).push(item);
  }

  for (const [calendarUrl, items] of byCalendar) {
    try {
      const objects = await client.fetchCalendarObjects({
        calendar:   { url: calendarUrl },
        objectUrls: items.map((i) => i.url),
      });
      // Über die URL zurück auf den Termin abbilden - verlässlicher als die UID
      // erneut aus dem Objekt zu parsen.
      for (const obj of objects || []) {
        const match = items.find((i) => i.url === obj.url) || (items.length === 1 ? items[0] : null);
        if (!match) continue;
        index.set(match.uid, {
          url: obj.url || match.url, etag: obj.etag, data: obj.data, calendarUrl,
        });
      }
    } catch (err) {
      // Kein Grund zur Sorge: der reguläre Sync-Lauf holt den Kalender ohnehin.
      log.warn(`Could not fetch calendar objects from ${calendarUrl} for the immediate attempt: ${err.message}`);
    }
  }
  return index;
}

/**
 * Sofortversuch für einen CalDAV-Account: erledigt, was ohne vollen Kalenderabruf
 * geht. Löschungen brauchen nur die gespeicherte Objekt-URL, Änderungen zusätzlich
 * das Originalobjekt; ein Umzug zusätzlich die Kalenderliste.
 *
 * Was hier nicht klappt, bleibt vorgemerkt und läuft im nächsten Sync mit.
 * @returns {Promise<{deleted:number,updated:number}>}
 */
export async function flushAccount(client, source, { deletions, updates, needsCalendars }) {
  const wanted = updates
    .filter((e) => e.external_object_url)
    .map((e) => ({
      uid: e.external_calendar_id,
      url: e.external_object_url,
      calendarUrl: e.__calendarUrl,
    }));

  const objectIndex = await fetchObjectsByUrl(client, wanted);

  let calendarsByUrl = new Map();
  if (needsCalendars) {
    try {
      const cals = await client.fetchCalendars();
      calendarsByUrl = new Map((cals || []).map((c) => [c.url, c]));
    } catch (err) {
      log.warn(`Could not list calendars for the immediate attempt: ${err.message}`);
    }
  }

  // ownCalendarUrls bewusst nicht gesetzt: ohne vollen Abruf ist "der Server
  // führt das Objekt nicht mehr" nicht belegbar, und ein Tombstone ohne bekannte
  // URL darf hier nicht als erledigt gelten. Er bleibt für den Sync liegen.
  const deleted = deletions.length ? await processPendingDeletions(client, source, objectIndex) : 0;
  const updated = objectIndex.size ? await processPendingUpdates(client, source, objectIndex, calendarsByUrl) : 0;
  return { deleted, updated };
}

/**
 * Arbeitet vorgemerkte Löschungen auf einem CalDAV-Server ab.
 * @param {object} client       tsdav-Client
 * @param {string} source       'caldav' | 'apple'
 * @param {Map}    objectIndex  UID → { url, etag, data, calendarUrl } aus dem Inbound dieses Laufs
 * @param {Set}    [ownCalendarUrls] Kalender dieses Accounts; fremde Tombstones bleiben unangetastet
 * @returns {Promise<number>} erledigte Tombstones
 */
export async function processPendingDeletions(client, source, objectIndex, ownCalendarUrls = null) {
  const rows = outbound.pendingDeletions(source);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    // Mehrere Accounts teilen sich die Tombstone-Tabelle: nur anfassen, was zu den
    // gerade abgerufenen Kalendern gehört, sonst zählt ein fremder Account fremde
    // Fehlversuche hoch und verwirft am Ende eine fremde Löschung.
    if (ownCalendarUrls && row.calendar_external_id && !ownCalendarUrls.has(row.calendar_external_id)) continue;

    const known = objectIndex.get(row.event_external_id);
    const url   = row.object_url || known?.url || null;

    if (!url) {
      // Zuständig, aber der Server liefert das Objekt nicht mehr aus: dann ist es
      // dort bereits weg und der Tombstone hat sein Ziel erreicht.
      if (ownCalendarUrls) {
        log.info(`[${label(source)}] Event ${row.event_external_id} is no longer on the server, dropping the pending deletion.`);
        outbound.dropDeletion(row.id);
        done++;
      }
      continue;
    }

    try {
      await client.deleteCalendarObject({ calendarObject: { url, etag: known?.etag } });
      outbound.dropDeletion(row.id);
      done++;
    } catch (err) {
      if (outbound.handleDeletionError(err, row, label(source))
          && outbound.classifyOutboundError(err) === 'settled') {
        done++;
      }
    }
  }
  return done;
}

/**
 * Schiebt lokal bearbeitete, bereits synchronisierte Termine zum Server.
 * Ein Wechsel des Zielkalenders wird als Anlegen im Ziel + Löschen in der Quelle
 * ausgeführt: CalDAV kennt kein Verschieben.
 * @returns {Promise<number>} erfolgreich verarbeitete Termine
 */
export async function processPendingUpdates(client, source, objectIndex, calendarsByUrl = new Map()) {
  const events = outbound.pendingUpdates(source);
  if (events.length === 0) return 0;

  // Einmal je Lauf, nicht je Termin: die Zone steht in sync_config und aendert
  // sich waehrend eines Sync-Durchlaufs nicht.
  const zone = householdTimeZone(db.get());

  let done = 0;
  for (const event of events) {
    const known = objectIndex.get(event.external_calendar_id);
    const url   = event.external_object_url || known?.url || null;

    // Weder gespeichert noch im aktuellen Abruf enthalten: das Objekt gehört zu
    // einem anderen Account. Nichts tun, nichts verwerfen - dessen Lauf übernimmt.
    if (!url) continue;

    if (!known?.data) {
      // Ohne das Originalobjekt bliebe nur, es neu zu bauen - und das verlöre
      // alles, was Yuvomi nicht kennt (Teilnehmer, Alarme, Kategorien).
      log.warn(`[${label(source)}] No source object for event ${event.id} in this run, deferring its update.`);
      continue;
    }

    // Frisch nachladen: zwischen der Auswahl und hier liegt ein await, in dem eine
    // weitere Bearbeitung eingetroffen sein kann.
    const fresh = outbound.reloadEvent(event.id);
    if (!fresh) continue; // parallel gelöscht - der Tombstone-Pfad übernimmt

    const { fields, tzid } = icsFieldsForEvent(fresh, zone);
    const patched = patchICSEvent(known.data, event.external_calendar_id, fields, { tzid });
    if (!patched) {
      log.warn(`[${label(source)}] Event ${event.external_calendar_id} has no editable VEVENT in its calendar object, dropping its update.`);
      outbound.clearOutbound(event.id);
      continue;
    }

    // ── Wechsel des Zielkalenders: anlegen im Ziel, löschen in der Quelle ──────
    const moveTo = event.outbound_move_to;
    if (moveTo && moveTo !== known.calendarUrl) {
      const destCal = calendarsByUrl.get(moveTo);
      if (!destCal) {
        log.warn(`[${label(source)}] Destination calendar ${moveTo} is not available, keeping event ${event.id} where it is.`);
        outbound.clearOutboundMove(event.id);
      } else {
        try {
          await client.createCalendarObject({
            calendar:   destCal,
            filename:   filenameFromUrl(url, event.external_calendar_id),
            iCalString: patched,
          });
          // Erst nach erfolgreichem Anlegen löschen: scheitert das Löschen, steht
          // der Termin doppelt - das ist reparabel. Umgekehrt wäre er weg.
          try {
            await client.deleteCalendarObject({ calendarObject: { url, etag: known.etag } });
          } catch (err) {
            log.error(`[${label(source)}] Event ${event.id} was copied to ${moveTo} but could not be removed from its old calendar:`, err.message);
          }
          outbound.clearOutbound(event.id);
          done++;
          continue; // der Patch ist mit dem Anlegen bereits geschrieben
        } catch (err) {
          outbound.handleUpdateError(err, event, 'move', label(source), outbound.clearOutboundMove);
          continue;
        }
      }
    } else if (moveTo) {
      outbound.clearOutboundMove(event.id);
    }

    if (!event.outbound_dirty) continue;

    try {
      await client.updateCalendarObject({
        calendarObject: { url, etag: known.etag, data: patched },
      });
      outbound.clearOutbound(event.id);
      done++;
    } catch (err) {
      outbound.handleUpdateError(err, event, 'update', label(source));
    }
  }
  return done;
}

// --------------------------------------------------------
// Bereichsbezogene Serienänderungen
// --------------------------------------------------------

function scopedPayload(operation) {
  return editOperations.parseScopedOperationPayload(operation) || {};
}

function scopedSnapshot(operation, side) {
  const payload = scopedPayload(operation);
  const value = side === 'before' ? payload.before : payload.after;
  if (!value || typeof value !== 'object') return null;
  return value.event || value.override || value.master || value.new_master || value;
}

function scopedLocalIdentity(operation) {
  if (!operation?.event_id) return { event: null, parent: null };
  try {
    const event = db.get().prepare(`
      SELECT id, external_calendar_id, external_object_url, calendar_ref_id,
             target_caldav_calendar_url, exception_of_event_id
      FROM calendar_events WHERE id = ?
    `).get(operation.event_id) || null;
    const parent = event?.exception_of_event_id
      ? db.get().prepare(`
          SELECT id, external_calendar_id, external_object_url, calendar_ref_id,
                 target_caldav_calendar_url
          FROM calendar_events WHERE id = ?
        `).get(event.exception_of_event_id) || null
      : null;
    return { event, parent };
  } catch {
    return { event: null, parent: null };
  }
}

function scopedProvider(operation) {
  const payload = scopedPayload(operation);
  const before = payload.before || {};
  const after = payload.after || {};
  const local = scopedLocalIdentity(operation);
  const isDetachedOccurrence = operation.scope === 'this'
    && !!local.event?.exception_of_event_id
    && !!local.parent?.external_calendar_id;
  const provider = {
    ...(payload.remote || {}),
    ...(payload.provider || {}),
    ...(before.provider || {}),
    ...(after.provider || {}),
    ...(payload.master_external_id ? { masterUid: payload.master_external_id } : {}),
    ...(operation.provider_uid ? { uid: operation.provider_uid } : {}),
    ...(operation.provider_object_url ? { objectUrl: operation.provider_object_url } : {}),
    ...(operation.provider_etag ? { etag: operation.provider_etag } : {}),
  };
  let localCalendarUrl = local.event?.target_caldav_calendar_url || local.parent?.target_caldav_calendar_url || null;
  if (!localCalendarUrl) {
    try {
      const refId = local.event?.calendar_ref_id || local.parent?.calendar_ref_id;
      localCalendarUrl = refId
        ? db.get().prepare(
          `SELECT external_id FROM external_calendars WHERE source = 'caldav' AND id = ?`
        ).get(refId)?.external_id || null
        : null;
    } catch { /* Focused provider schemas may omit external calendar metadata. */ }
  }
  const suppliedUid = provider.uid || provider.masterUid || payload.master_external_id || payload.provider_uid
    || operation.provider_uid || operation.event_external_id || local.event?.external_calendar_id || null;
  const masterUid = [
    provider.masterUid, provider.master_uid, payload.master_external_id,
    local.parent?.external_calendar_id, local.event?.external_calendar_id,
  ].find((candidate) => candidate && !syntheticLocalOccurrenceUid(candidate)) || null;
  const lookupUid = syntheticLocalOccurrenceUid(suppliedUid) ? masterUid : suppliedUid;
  const calendarUrl = provider.calendarUrl || provider.calendar_url || payload.target_calendar_url
    || payload.target_calendar_id || operation.target_calendar_url || operation.target_calendar_id
    || localCalendarUrl || null;
  const uid = isDetachedOccurrence
    ? local.parent.external_calendar_id
    : lookupUid;
  let cached = null;
  if (calendarUrl && uid) {
    try {
      const value = db.get().prepare('SELECT value FROM sync_config WHERE key = ?')
        .get(`calendar_provider_event:caldav:${encodeURIComponent(calendarUrl)}:${encodeURIComponent(uid)}`)?.value;
      cached = value ? JSON.parse(value) : null;
    } catch { cached = null; }
  }
  return {
    ...provider,
    uid,
    masterUid: uid,
    ...((provider.occurrenceUid || provider.occurrence_uid || syntheticLocalOccurrenceUid(suppliedUid))
      ? {
          occurrenceUid: provider.occurrenceUid || provider.occurrence_uid || suppliedUid,
        }
      : (isDetachedOccurrence && local.event.external_calendar_id
        ? { occurrenceUid: local.event.external_calendar_id } : {})),
    calendarUrl,
    ...(provider.objectUrl || !cached?.object_url ? {} : { objectUrl: cached.object_url }),
    ...(provider.etag || !cached?.etag ? {} : { etag: cached.etag }),
  };
}

function scopedConflict(message, code = 412) {
  const err = new Error(message);
  err.code = code;
  err.conflict = true;
  return err;
}

function componentFromMaster(icsText, uid, newUid, fields, { tzid = null } = {}) {
  const { lines, blocks } = eventBlocks(icsText);
  const master = blocks.find((block) => blockUid(lines, block) === uid && !blockRecurrenceId(lines, block));
  if (!master) return null;
  const source = lines.slice(master.start, master.end + 1).filter((line) => {
    const name = icsPropertyName(line);
    return name !== 'RRULE' && name !== 'EXDATE' && name !== 'RECURRENCE-ID';
  }).map((line) => icsPropertyName(line) === 'UID' ? `UID:${newUid}` : line);
  const wrapper = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...source, 'END:VCALENDAR'].join('\r\n');
  const patched = patchICSEvent(wrapper, newUid, fields, { tzid });
  if (!patched) return null;
  const patchLines = unfoldICS(patched).split('\n');
  const start = patchLines.findIndex((line) => line.trim().toUpperCase() === 'BEGIN:VEVENT');
  const end = patchLines.findIndex((line, index) => index > start && line.trim().toUpperCase() === 'END:VEVENT');
  return start >= 0 && end > start ? patchLines.slice(start, end + 1).map(foldICSLine).join('\r\n') : null;
}

function eventBlockKey(lines, block) {
  return `${blockUid(lines, block) || ''}\u0000${blockRecurrenceId(lines, block) || ''}`;
}

function withComponentUid(lines, uid) {
  return lines.map((line) => {
    if (icsPropertyName(line) !== 'UID') return line;
    const cut = line.indexOf(':');
    return cut < 0 ? `UID:${uid}` : `${line.slice(0, cut + 1)}${uid}`;
  });
}

/**
 * Move provider exception components at or after a following split to the new
 * series UID. RECURRENCE-ID remains the original occurrence identity, while
 * all attendee/alarm/vendor properties survive byte-for-byte after unfolding.
 */
function splitFollowingExceptions(icsText, uid, newUid, occurrenceStart, rebasedOccurrenceStart = null) {
  const { lines, blocks } = eventBlocks(icsText);
  const moved = blocks.filter((block) => blockUid(lines, block) === uid
    && blockRecurrenceId(lines, block)
    && occurrenceAtOrAfter(blockRecurrenceId(lines, block), occurrenceStart));
  if (!moved.length) return { icsText, components: [] };

  const removed = new Set(moved.flatMap((block) => {
    const indexes = [];
    for (let index = block.start; index <= block.end; index++) indexes.push(index);
    return indexes;
  }));
  const remaining = lines.filter((_, index) => !removed.has(index));
  const oldMs = temporalMillis(occurrenceStart);
  const newMs = temporalMillis(rebasedOccurrenceStart);
  const deltaMs = oldMs !== null && newMs !== null ? newMs - oldMs : 0;
  const components = moved.map((block) => rebaseExceptionComponent(
    withComponentUid(lines.slice(block.start, block.end + 1), newUid)
      .map(foldICSLine).join('\r\n'),
    deltaMs,
  ));
  return {
    icsText: remaining.map(foldICSLine).join('\r\n'),
    components,
  };
}

/** Partition master exclusions using their original DATE/UTC/TZID form. */
function splitFollowingExdates(icsText, uid, occurrenceStart, newStart, recurrenceZone = null) {
  const { lines, blocks } = eventBlocks(icsText);
  const master = blocks.find((block) => blockUid(lines, block) === uid && !blockRecurrenceId(lines, block));
  const oldMs = temporalMillis(occurrenceStart);
  const newMs = temporalMillis(newStart);
  const delta = oldMs !== null && newMs !== null ? newMs - oldMs : 0;
  const exclusions = [];
  const rewritten = lines.flatMap((line, index) => {
    if (!master || index <= master.start || index >= master.end || icsPropertyName(line) !== 'EXDATE') return [line];
    const cut = line.indexOf(':');
    const head = line.slice(0, cut + 1);
    const kept = [];
    const moved = [];
    const sourceZone = /;TZID=([^:;]+)/i.exec(head)?.[1] || null;
    for (const value of line.slice(cut + 1).split(',')) {
      const parsed = compactTemporalMillis(value);
      if (!parsed) throw new Error('Cannot preserve an invalid CalDAV EXDATE.');
      // EXDATE may use UTC or a different TZID from the series. Compare and
      // shift it on the recurrence's civil clock, then restore its wire form.
      const sourceInstant = parsed.suffix ? new Date(parsed.ms).toISOString()
        : sourceZone ? localToUTC(new Date(parsed.ms).toISOString().slice(0, 19), sourceZone) : null;
      const wall = parsed.hasTime && sourceInstant && recurrenceZone
        ? utcToWall(sourceInstant, recurrenceZone) : null;
      const wallMs = wall ? temporalMillis(wall.date + 'T' + wall.time) : parsed.ms;
      const identity = compactFromMillis(wallMs, { ...parsed, suffix: '' });
      if (!occurrenceAtOrAfter(identity, occurrenceStart)) { kept.push(value); continue; }
      const shiftedWall = new Date(wallMs + delta).toISOString().slice(0, 19);
      const shiftedInstant = wall && recurrenceZone ? localToUTC(shiftedWall, recurrenceZone) : null;
      const shiftedSourceWall = shiftedInstant && sourceZone ? utcToWall(shiftedInstant, sourceZone) : null;
      const shiftedMs = shiftedInstant && parsed.suffix ? Date.parse(shiftedInstant)
        : shiftedSourceWall ? temporalMillis(shiftedSourceWall.date + 'T' + shiftedSourceWall.time) : wallMs + delta;
      moved.push(compactFromMillis(shiftedMs, parsed));
    }
    if (moved.length) exclusions.push(head + moved.join(','));
    return kept.length ? [head + kept.join(',')] : [];
  });
  return { icsText: rewritten.map(foldICSLine).join('\r\n'), exclusions };
}

function addContinuationExdates(component, exclusions, operations, newFields, recurrenceZone) {
  const slot = newFields.fields.DTSTART;
  const timed = String(slot.value).includes('T');
  // EXDATE must have the same value type as the continuation DTSTART. Keep
  // existing timezone/UTC form when compatible; conversions use its new slot.
  const lines = exclusions.map((line) => {
    const cut = line.indexOf(':');
    const values = line.slice(cut + 1).split(',');
    if (values.every((value) => value.includes('T') === timed)) return line;
    const sourceZone = /;TZID=([^:;]+)/i.exec(line.slice(0, cut))?.[1] || null;
    const normalized = values.map((value) => {
      const parsed = compactTemporalMillis(value);
      const instant = parsed?.suffix ? new Date(parsed.ms).toISOString()
        : parsed?.hasTime && sourceZone ? localToUTC(new Date(parsed.ms).toISOString().slice(0, 19), sourceZone) : null;
      const wall = instant && (newFields.tzid || recurrenceZone) ? utcToWall(instant, newFields.tzid || recurrenceZone) : null;
      const date = wall ? wall.date.replaceAll('-', '') : value.slice(0, 8);
      return date + String(slot.value).slice(8);
    });
    return 'EXDATE' + (slot.params || '') + ':' + normalized.join(',');
  });
  const represented = new Set(lines.flatMap((line) => line.slice(line.indexOf(':') + 1).split(',')
    .map((value) => {
      const parsed = compactTemporalMillis(value);
      const wall = parsed?.suffix && newFields.tzid ? utcToWall(new Date(parsed.ms).toISOString(), newFields.tzid) : null;
      return wall ? wall.date.replaceAll('-', '') : value.slice(0, 8);
    })));
  for (const item of operations) {
    if (String(item.method).toLowerCase() !== 'delete') continue;
    const value = item.continuation_start || item.occurrence_start || item.original_start;
    const digits = occurrenceDigits(value);
    if (!digits || represented.has(digits.slice(0, 8))) continue;
    // Route exclusions can be date-only metadata. Their time is the regular
    // continuation slot, rather than midnight or a detached event's time.
    const exclusion = digits.slice(0, 8) + String(slot.value).slice(8);
    lines.push('EXDATE' + (slot.params || '') + ':' + exclusion);
    represented.add(digits.slice(0, 8));
  }
  return component.replace(/END:VEVENT/i, lines.length
    ? lines.map(foldICSLine).join('\r\n') + '\r\nEND:VEVENT' : 'END:VEVENT');
}

function appendICSComponents(icsText, components = []) {
  if (!components.length) return icsText;
  const lines = unfoldICS(icsText).split('\n');
  const existing = eventBlocks(icsText);
  const seen = new Set(existing.blocks.map((block) => eventBlockKey(existing.lines, block)));
  let end = lines.findIndex((line) => line.trim().toUpperCase() === 'END:VCALENDAR');
  if (end < 0) end = lines.length;
  const additions = [];
  for (const component of components) {
    const rawComponent = component && typeof component === 'object'
      ? (component.component || component.ics || component.data || component.raw || '')
      : component;
    const parsed = eventBlocks(Array.isArray(rawComponent) ? rawComponent.join('\r\n') : String(rawComponent));
    if (!parsed.blocks.length) continue;
    for (const block of parsed.blocks) {
      const key = eventBlockKey(parsed.lines, block);
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(...parsed.lines.slice(block.start, block.end + 1));
    }
  }
  return [...lines.slice(0, end), ...additions, ...lines.slice(end)].map(foldICSLine).join('\r\n');
}

function scopedProviderProgress(operation) {
  const payload = scopedPayload(operation);
  return operation?.progress || payload.provider_progress || payload.providerProgress
    || operation?.provider_progress || operation?.providerProgress || {};
}

function scopedClaim(claim) {
  if (!claim || typeof claim !== 'object') return null;
  const token = claim.claim_token ?? claim.claimToken;
  const generation = claim.claim_generation ?? claim.claimGeneration;
  if (typeof token !== 'string' || !token || !Number.isSafeInteger(Number(generation))) return null;
  return { claimToken: token, claimGeneration: Number(generation) };
}

function recordScopedProviderProgress(operation, progress, claim = null) {
  const record = editOperations.updateCalendarEditOperationProgress;
  if (typeof record !== 'function' || !operation?.id || !scopedClaim(claim)) return true;
  const result = record(operation.id, progress, db.get(), scopedClaim(claim));
  return result !== false;
}

function withProviderProgress(error, progress) {
  if (error && progress && typeof progress === 'object') error.providerProgress = progress;
  return error;
}

function resourceUidSet(icsText) {
  const { lines, blocks } = eventBlocks(icsText);
  return new Set(blocks.map((block) => blockUid(lines, block)).filter(Boolean));
}

function assertSingleResourceUid(icsText, expectedUid, labelText) {
  const { lines, blocks } = eventBlocks(icsText);
  const uids = blocks.map((block) => blockUid(lines, block));
  if (!blocks.length || uids.some((value) => !value) || uids.some((value) => value !== expectedUid)
      || resourceUidSet(icsText).size !== 1) {
    const actual = [...new Set(uids.filter(Boolean))].join(', ') || '(none)';
    const err = new Error(`CalDAV ${labelText} must contain only UID ${expectedUid}; found ${actual}.`);
    err.code = 400;
    err.permanent = true;
    throw err;
  }
}

function syntheticLocalOccurrenceUid(value) {
  const raw = String(value || '');
  return /::(?:following:)?\d{4}(?:[-]?\d{2}){1,2}/.test(raw);
}

function validProviderUid(value, originalUid = null) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw || /[\r\n]/.test(raw) || syntheticLocalOccurrenceUid(raw)) return null;
  if (originalUid && raw === String(originalUid)) return null;
  return raw;
}

function safeUidPart(value) {
  return String(value || 'yuvomi').replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '') || 'yuvomi';
}

function continuationUid(split, newMaster, operation, originalUid) {
  const candidates = [
    split.new_uid, split.newUid,
    newMaster?.provider?.uid, newMaster?.provider?.eventId,
    newMaster?.provider_uid, newMaster?.external_calendar_id,
  ];
  for (const candidate of candidates) {
    const accepted = validProviderUid(candidate, originalUid);
    if (accepted) return accepted;
  }
  const identity = occurrenceDigits(
    split.continuation_start || split.continuationStart
      || operation.occurrence_start || operation.occurrenceStart,
  ).replace(/[^A-Za-z0-9]/g, '') || String(operation.id || 'continuation');
  return `${safeUidPart(originalUid)}.yuvomi-following-${identity}`;
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name)
    || response?.headers?.get?.(name.toLowerCase())
    || response?.[name]
    || response?.[name.toLowerCase()]
    || response?.data?.[name]
    || response?.data?.[name.toLowerCase()]
    || null;
}

function responseEtag(response, fallback = null) {
  return responseHeader(response, 'etag') || responseHeader(response, 'ETag') || fallback;
}

function responseObjectUrl(response, fallback = null) {
  return responseHeader(response, 'url') || responseHeader(response, 'href')
    || responseHeader(response, 'location') || fallback;
}

function continuationObjectUrl(calendarUrl, uid, split, newMaster) {
  const explicit = split.new_object_url || split.newObjectUrl
    || newMaster?.provider?.objectUrl || newMaster?.provider?.object_url
    || newMaster?.external_object_url || null;
  if (explicit) return String(explicit);
  if (!calendarUrl) return null;
  const filename = `${encodeURIComponent(uid)}.ics`;
  return `${String(calendarUrl).replace(/\/?$/, '/')}${filename}`;
}

function resourceEnvelope(source, components) {
  const parsed = eventBlocks(source);
  const used = new Set(parsed.blocks.flatMap((block) => {
    const indexes = [];
    for (let index = block.start; index <= block.end; index++) indexes.push(index);
    return indexes;
  }));
  const header = parsed.lines.filter((line, index) => !used.has(index)
    && !/^\s*(BEGIN|END):VCALENDAR\s*$/i.test(line));
  return ['BEGIN:VCALENDAR', ...header, ...components.flatMap((component) => (
    unfoldICS(String(component)).split('\n').map(foldICSLine)
  )), 'END:VCALENDAR'].map(foldICSLine).join('\r\n');
}

function normalizeContinuationComponents(components, newUid) {
  const normalized = [];
  for (const component of components) {
    const raw = component && typeof component === 'object'
      ? (component.component || component.ics || component.data || component.raw || '')
      : component;
    const parsed = eventBlocks(Array.isArray(raw) ? raw.join('\r\n') : String(raw));
    for (const block of parsed.blocks) {
      const lines = parsed.lines.slice(block.start, block.end + 1);
      if (!blockUid(parsed.lines, block)) continue;
      normalized.push(withComponentUid(lines, newUid).map(foldICSLine).join('\r\n'));
    }
  }
  return normalized;
}

function uniqueICSComponents(components) {
  const seen = new Set();
  const unique = [];
  for (const component of components) {
    const parsed = eventBlocks(String(component || ''));
    const block = parsed.blocks[0];
    if (!block) continue;
    const key = eventBlockKey(parsed.lines, block);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(component);
  }
  return unique;
}

/**
 * Applies one backend-owned scope operation to an already fetched CalDAV
 * object. The caller supplies the URL/etag/data index from the current sync;
 * this function never reconstructs an object from local fields alone.
 */
export async function processScopedOperation(
  client,
  operation,
  objectIndex,
  calendarsByUrl = new Map(),
  claim = null,
) {
  const payload = scopedPayload(operation);
  const provider = scopedProvider(operation);
  const scope = operation.scope || payload.scope || 'series';
  const uid = provider.uid || provider.masterUid || payload.master_external_id
    || payload.provider_uid || operation.event_external_id || operation.external_calendar_id;
  const progress = scopedProviderProgress(operation);
  const oldMasterProgress = progress.old_master || progress.following?.old_resource || {};
  const continuationMasterProgress = progress.continuation_master
    || progress.following?.continuation_resource || {};
  const known = uid ? objectIndex.get(uid) : null;
  const url = provider.objectUrl || operation.provider_object_url
    || oldMasterProgress.url || known?.url || null;
  const data = known?.data || provider.data || null;
  if (!uid || !url || !data) {
    throw new Error('CalDAV scoped operation has no fetched source object; deferring it.');
  }
  const readbackAcceptedOldResource = scope === 'following'
    && oldMasterProgress.attempted === true && !!oldMasterProgress.desired_data
    && unfoldICS(data).trim() === unfoldICS(oldMasterProgress.desired_data).trim();
  const oldResourceCompleted = scope === 'following'
    && (oldMasterProgress.accepted === true || oldMasterProgress.completed === true || readbackAcceptedOldResource);
  if (!oldResourceCompleted && provider.etag && known?.etag
      && String(provider.etag) !== String(known.etag)) {
    throw scopedConflict(`CalDAV object ${uid} changed since the operation was queued.`);
  }
  const calendarUrl = provider.calendarUrl || known?.calendarUrl || operation.target_calendar_url
    || payload.target_calendar_url || payload.target_calendar_id || null;
  const calendar = calendarsByUrl.get(calendarUrl) || (calendarUrl ? { url: calendarUrl } : null);
  const readOnlyError = readOnlyCalDAVError(calendar, 'calendar');
  if (readOnlyError) throw readOnlyError;

  const after = scopedSnapshot(operation, 'after');
  if (!after) throw new Error('CalDAV scoped operation has no after snapshot.');
  const zone = householdTimeZone(db.get());
  const { fields, tzid } = icsFieldsForEvent(after, zone);
  const occurrenceStart = operation.occurrence_start || operation.occurrenceStart || payload.occurrence_start;
  const providerTzid = after.tzid || payload.tzid || provider.tzid || null;

  if (scope === 'following') {
    if (!occurrenceStart) throw new Error('Following CalDAV edit has no original split identity.');
    assertSingleResourceUid(data, uid, 'source resource');
    const split = payload.split || payload.remote?.split || payload.provider?.split || {};
    const masterAfter = split.master_after || payload.master_after || payload.parent_after || null;
    const newMaster = split.new_master || split.following || payload.new_master || payload.following || null;
    if (!masterAfter || !newMaster) {
      throw new Error('Following CalDAV edit lacks an explicit master split payload.');
    }

    // Keep the fetched pre-split components through uncertain responses and
    // retries: the accepted old resource no longer contains its future tail.
    const sourceData = oldMasterProgress.source_data || data;
    const masterFields = icsFieldsForEvent(masterAfter, zone);
    const truncated = patchICSEvent(sourceData, uid, masterFields.fields, { tzid: masterFields.tzid });
    if (!truncated) throw scopedConflict(`CalDAV series ${uid} is no longer present.`, 409);
    const newUid = continuationMasterProgress.id || continuationMasterProgress.uid
      || continuationUid(split, newMaster, operation, uid);
    const newFields = icsFieldsForEvent(newMaster, zone);
    let component = componentFromMaster(sourceData, uid, newUid, newFields.fields, { tzid: newFields.tzid });
    if (!component) throw new Error('Following CalDAV edit could not build the new master component.');
    const splitWall = providerTzid && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(occurrenceStart))
      ? utcToWall(occurrenceStart, providerTzid) : null;
    const splitStart = splitWall ? splitWall.date + 'T' + splitWall.time : occurrenceStart;
    const newSlot = compactTemporalMillis(newFields.fields.DTSTART.value);
    const newSlotStart = newSlot ? new Date(newSlot.ms).toISOString().slice(0, 19) : newMaster.start_datetime;
    const excluded = splitFollowingExdates(truncated, uid, splitStart, newSlotStart, providerTzid);
    const exceptionOperations = Array.isArray(split.exception_operations)
      ? split.exception_operations
      : (Array.isArray(split.exceptionOperations) ? split.exceptionOperations : []);
    component = addContinuationExdates(component, excluded.exclusions, exceptionOperations, newFields, providerTzid);
    const moved = splitFollowingExceptions(
      excluded.icsText,
      uid,
      newUid,
      splitStart,
      newSlotStart,
    );
    const explicitExceptions = split.exception_components || split.exceptionComponents || [];
    const explicitList = Array.isArray(explicitExceptions) ? explicitExceptions : [explicitExceptions];
    const newResource = continuationMasterProgress.desired_data || resourceEnvelope(sourceData, uniqueICSComponents([
      component,
      ...moved.components,
      ...normalizeContinuationComponents(explicitList, newUid),
    ]));
    const oldResource = oldMasterProgress.desired_data || moved.icsText;
    assertSingleResourceUid(oldResource, uid, 'truncated resource');
    assertSingleResourceUid(newResource, newUid, 'continuation resource');

    let nextProgress = {
      ...progress,
      phase: oldResourceCompleted
        ? (continuationMasterProgress.accepted === true || continuationMasterProgress.completed === true
          ? 'complete' : 'continuation_master')
        : 'old_master',
      old_master: { ...oldMasterProgress, url, uid, source_data: sourceData, desired_data: oldResource },
      continuation_master: { ...continuationMasterProgress, id: newUid, desired_data: newResource },
      exception_operations: progress.exception_operations || {},
    };
    const saveProgress = (next) => {
      nextProgress = next;
      if (!recordScopedProviderProgress(operation, nextProgress, claim)) {
        const stale = new Error(`CalDAV scoped operation ${operation.id} lost its queue claim.`);
        stale.code = 409;
        stale.claimLost = true;
        throw withProviderProgress(stale, nextProgress);
      }
    };

    // Persist intended identities/body before a network call can be accepted
    // with a lost response. Inbound protects this continuation before retry.
    saveProgress(nextProgress);
    let oldEtag = readbackAcceptedOldResource ? known?.etag
      : oldMasterProgress.etag || known?.etag || provider.etag || null;
    if (readbackAcceptedOldResource) saveProgress({
      ...nextProgress, phase: 'continuation_master',
      old_master: { ...nextProgress.old_master, accepted: true, etag: oldEtag },
    });
    if (!oldResourceCompleted) {
      saveProgress({ ...nextProgress, old_master: { ...nextProgress.old_master, attempted: true } });
      let updateResponse;
      try {
        updateResponse = await client.updateCalendarObject({
          calendarObject: { url, etag: known?.etag || provider.etag, data: oldResource },
          ...(calendar ? { calendar } : {}),
        });
      } catch (error) {
        throw withProviderProgress(error, nextProgress);
      }
      oldEtag = responseEtag(updateResponse, oldEtag);
      saveProgress({
        ...nextProgress,
        phase: 'continuation_master',
        old_master: { ...nextProgress.old_master, accepted: true, etag: oldEtag },
      });
    }

    let continuationUrl = continuationMasterProgress.url
      || continuationObjectUrl(calendarUrl, newUid, split, newMaster);
    let continuationEtag = continuationMasterProgress.etag || null;
    const continuationAccepted = continuationMasterProgress.accepted === true
      || continuationMasterProgress.completed === true;
    if (!continuationAccepted) {
      // A response can be lost after the server accepted the PUT. If the next
      // inbound already contains the new UID, adopt that resource instead of
      // creating a second VEVENT object with the same continuation identity.
      const existing = objectIndex.get(newUid);
      if (existing?.data) {
        assertSingleResourceUid(existing.data, newUid, 'read-back continuation resource');
        if (unfoldICS(existing.data).trim() !== unfoldICS(newResource).trim()) {
          throw scopedConflict('CalDAV continuation changed after an uncertain create.');
        }
        continuationUrl = existing.url || continuationUrl;
        continuationEtag = existing.etag || continuationEtag;
      } else {
        saveProgress({ ...nextProgress,
          continuation_master: { ...nextProgress.continuation_master, attempted: true },
        });
        let createResponse;
        try {
          createResponse = await client.createCalendarObject({
            calendar,
            filename: filenameFromUrl(continuationUrl, newUid),
            iCalString: newResource,
          });
        } catch (error) {
          throw withProviderProgress(error, nextProgress);
        }
        continuationUrl = responseObjectUrl(createResponse, continuationUrl);
        continuationEtag = responseEtag(createResponse, continuationEtag);
      }
      saveProgress({
        ...nextProgress,
        phase: 'complete',
        continuation_master: {
          ...nextProgress.continuation_master,
          accepted: true, id: newUid, url: continuationUrl, etag: continuationEtag,
        },
      });
    }

    const providerExceptionResults = exceptionOperations.map((item) => {
      const localEventId = item.local_event_id ?? item.localEventId ?? null;
      const continuationStart = item.continuation_start || item.continuationStart
        || item.original_start || item.originalStart || null;
      const dateKey = occurrenceDateKey(continuationStart, providerTzid);
      return {
        local_event_id: localEventId,
        localEventId,
        original_start: item.original_start || item.originalStart || null,
        previous_original_start: item.previous_original_start || null,
        continuation_start: continuationStart,
        providerUid: localEventId && dateKey ? `${newUid}::${dateKey}` : null,
        providerEtag: continuationEtag,
        providerObjectUrl: continuationUrl,
        providerCalendarUrl: calendarUrl,
      };
    }).filter((item) => item.localEventId && item.providerUid);

    return {
      providerUid: newUid,
      providerObjectUrl: continuationUrl,
      providerEtag: continuationEtag,
      providerCalendarUrl: calendarUrl,
      oldProviderObjectUrl: url,
      oldProviderEtag: oldEtag,
      providerProgress: nextProgress,
      exceptionOperations: providerExceptionResults,
      providerExceptionResults,
    };
  }

  const dataUidSet = resourceUidSet(data);
  if (dataUidSet.size !== 1 || !dataUidSet.has(uid)) {
    assertSingleResourceUid(data, uid, 'source resource');
  }
  let providerUid = uid;
  let patched;
  if (scope === 'this') {
    if (!occurrenceStart) throw new Error('CalDAV single-occurrence edit has no original identity.');
    patched = patchICSEventOccurrence(data, uid, occurrenceStart, fields, {
      tzid,
      occurrenceUid: provider.occurrenceUid || null,
    });
    if (!patched) throw scopedConflict(`CalDAV occurrence ${occurrenceStart} is no longer present.`, 409);
    providerUid = provider.occurrenceUid
      || (payload.before?.recurrence_rule || payload.after?.recurrence_rule
        ? `${uid}::${occurrenceDateKey(occurrenceStart, providerTzid) || String(occurrenceStart).slice(0, 10)}`
        : uid);
  } else if (scope === 'series') {
    patched = patchICSEvent(data, uid, fields, { tzid });
    if (!patched) throw scopedConflict(`CalDAV series ${uid} is no longer present.`, 409);
  } else {
    throw new Error(`Unknown CalDAV edit scope: ${scope}`);
  }

  assertSingleResourceUid(patched, uid, 'patched resource');
  const updateResponse = await client.updateCalendarObject({
    calendarObject: { url, etag: known?.etag || provider.etag, data: patched },
    ...(calendar ? { calendar } : {}),
  });
  const responseEtagValue = responseEtag(updateResponse, known?.etag || provider.etag || null);
  return {
    providerUid,
    providerObjectUrl: url,
    providerEtag: responseEtagValue,
    providerCalendarUrl: calendarUrl,
    exceptionOperations: [],
    providerExceptionResults: [],
  };
}
