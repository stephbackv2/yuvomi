// --------------------------------------------------------

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Validate with the XML engine already installed by tsdav's XML converter. */
async function completeDavMultistatus(text) {
  // xml-js suppresses its parser's errors; use the same engine directly so
  // truncated XML cannot masquerade as an authoritative empty collection.
  const resolve = createRequire(import.meta.url).resolve;
  const resolveDav = createRequire(resolve('tsdav')).resolve;
  const resolveXml = createRequire(resolveDav('xml-js')).resolve;
  const { default: sax } = await import(pathToFileURL(resolveXml('sax')).href);
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  let depth = 0; let root = false; let complete = true;
  let response = null; let status = null;
  parser.onerror = (error) => { throw error; };
  parser.onopentag = (node) => {
    if (depth === 0) {
      if (root || node.uri !== 'DAV:' || node.local !== 'multistatus') complete = false;
      root = true;
    } else if (depth === 1 && (node.uri !== 'DAV:' || !['response', 'responsedescription'].includes(node.local))) {
      complete = false;
    }
    if (depth === 1 && node.uri === 'DAV:' && node.local === 'response') response = { href: false, status: false };
    if (depth === 2 && response) {
      if (node.uri !== 'DAV:' || !['href', 'status', 'propstat', 'error', 'responsedescription', 'location'].includes(node.local)) complete = false;
      if (node.local === 'href') response.href = true;
    }
    if (node.uri === 'DAV:' && node.local === 'status') {
      status = { depth: depth + 1, text: '' };
      if (response) response.status = true;
    }
    if (node.uri === 'DAV:' && node.local === 'error') complete = false;
    depth++;
  };
  parser.onclosetag = () => {
    if (status?.depth === depth) {
      if (!/^HTTP\/\d+(?:\.\d+)?\s+2\d\d(?:\s|$)/.test(status.text.trim())) complete = false;
      status = null;
    }
    if (depth === 2 && response) {
      if (!response.href || !response.status) complete = false;
      response = null;
    }
    depth--;
  };
  parser.ontext = (value) => {
    if (depth === 0 && value.trim()) complete = false;
    if (status) status.text += value;
  };
  parser.ondoctype = () => { complete = false; };
  try { parser.write(text).close(); } catch { return false; }
  return root && complete && depth === 0;
}
// tsdav-Client für ein caldav_accounts-Konto.
//
// Termine (caldav-sync.js), VTODO-Inbound (caldav-reminders-sync.js) und der
// VTODO-Outbound (caldav-todo-outbound.js) sprechen denselben Server mit
// denselben Zugangsdaten an; die Factory lag dreimal wortgleich herum. tsdav wird
// bewusst dynamisch geladen: der Import zieht spürbar Code nach, und wer keinen
// CalDAV-Account eingerichtet hat, soll ihn nie laden.
// --------------------------------------------------------

/**
 * @param {{caldav_url: string, username: string, password: string}} account
 * @returns {Promise<object>} tsdav-Client
 */
export async function createCalDAVClient(account) {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl:          account.caldav_url,
    credentials:        { username: account.username, password: account.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });
  return withCalendarObjectUrlFilter(client);
}

/**
 * Pfad einer Objekt-URL, vergleichbar gemacht. Absolute URL und href aus einer
 * Server-Antwort laufen beide hier durch, damit der Vergleich in
 * `calendarObjectUrlFilter` nicht an Host oder Schreibweise scheitert.
 */
/**
 * Zerlegt eine Objekt- oder Collection-URL in die zwei Teile, die der Filter
 * getrennt braucht - er stellt nämlich zwei verschiedene Fragen an sie:
 *
 * - WELCHE Ressource ist das? Darüber entscheidet `pathname` PLUS `search`:
 *   tsdav adressiert Objekte selbst als `pathname + search`, und ein Server
 *   darf Collection und Mitglied allein über den Query unterscheiden.
 * - Ist es eine Collection? Darüber entscheidet allein der `pathname`. Ein
 *   Objektbezeichner im Query darf auf einen Schrägstrich enden
 *   (`?object=folder/item/`), und der ist keine Collection-Markierung.
 *
 * Beides in einen String zu ziehen hiesse, die zweite Frage am Ende des Query
 * zu beantworten - und ein Objekt, dessen Bezeichner so endet, fiele still
 * heraus. Genau die Auslassung, gegen die diese Datei geschrieben ist.
 */
function urlParts(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, 'http://caldav.invalid/');
    return { path: parsed.pathname, search: parsed.search };
  } catch { return { path: raw, search: '' }; }
}

/**
 * Welche href aus einer `calendar-query`-Antwort ist ein Kalenderobjekt?
 *
 * tsdav filtert hier per Default auf `.ics` im Pfad (`fetchCalendarObjects`,
 * v2.3.1). Die Endung ist aber reine Konvention: RFC 4791 schreibt keinen
 * Namen für die Objekt-Ressource vor, und ein Server darf sie frei vergeben.
 * Stalwart tut das für alles, was über JMAP angelegt wurde ("NZtPkIOMoK"),
 * während per CalDAV-PUT abgelegte Objekte den Clientnamen `<uid>.ics`
 * behalten - im selben Kalender fielen deshalb einzelne Termine still aus dem
 * Sync (#883), ohne dass sie je abgerufen und damit je geloggt wurden.
 *
 * Was der Filter wirklich fernhalten muss, ist die Collection selbst: manche
 * Server liefern sie bei `Depth: 1` mit. Genau so macht es tsdav auf der
 * CardDAV-Seite (`fetchVCards` filtert `urlEquals(url, addressBook.url)`), nur
 * auf der CalDAV-Seite eben nicht.
 *
 * @param {string} collectionUrl  URL des Kalenders, dessen Objekte geholt werden
 */
export function calendarObjectUrlFilter(collectionUrl) {
  // Der Schrägstrich am Ende wird nur am PFAD normalisiert - im Query ist er
  // ein Zeichen des Bezeichners und kein Trennzeichen.
  const identity = (parts) => `${parts.path.replace(/\/+$/, '')}${parts.search}`;
  const collectionParts = urlParts(collectionUrl);
  const collection = collectionParts ? identity(collectionParts) : '';
  return (url) => {
    const parts = urlParts(url);
    if (!parts || !parts.path) return false;
    // Eine Collection endet im PFAD auf einen Schrägstrich und trägt keinen
    // Query: `/dav/cal/x/default/` ist eine, `/dav/calendar?object=a/b/` nicht.
    if (parts.path.endsWith('/') && !parts.search) return false;
    return identity(parts) !== collection;
  };
}

/**
 * Hängt `calendarObjectUrlFilter` als Default an `fetchCalendarObjects`.
 *
 * Der Filter sitzt am Client statt an den Aufrufstellen, weil er einen
 * Bibliotheks-Default neutralisiert: fünf Stellen holen Kalenderobjekte, und
 * eine sechste würde die Regel sonst wieder verlieren. Ein explizit
 * übergebener `urlFilter` gewinnt weiterhin.
 */
export function withCalendarObjectUrlFilter(client) {
  const fetchCalendarObjects = client.fetchCalendarObjects.bind(client);
  // ÜBER DEN PROTOTYP, NICHT ÜBER SPREAD: `createDAVClient` gibt heute ein
  // Objektliteral zurück, dessen Methoden alle eigene Eigenschaften sind - ein
  // Spread käme damit durch. Er käme aber still NICHT durch, sobald tsdav auf
  // die Klassenform (`new DAVClient()`) wechselt, deren Methoden am Prototyp
  // hängen: der Wrapper verlöre `fetchCalendars`, `deleteCalendarObject` und
  // den Rest, und zwar erst zur Laufzeit. Die Delegation kostet hier nichts und
  // nimmt die Abhängigkeit von einer fremden Rückgabeform ganz weg.
  return Object.create(Object.getPrototypeOf(client), {
    ...Object.getOwnPropertyDescriptors(client),
    fetchCalendarObjects: {
      value: async (params = {}) => {
        const { davRequest } = await import('tsdav');
        const urlFilter = params.urlFilter || calendarObjectUrlFilter(params?.calendar?.url);
        const reports = [];
        const requestFetch = params.fetch || globalThis.fetch;
        const objects = await fetchCalendarObjects({ urlFilter, ...params, fetch: async (url, options) => {
          const response = await requestFetch(url, options);
          const text = await response.clone().text();
          // Reuse the installed DAV parser, retaining its response provenance
          // before fetchCalendarObjects flattens insufficient replies into [].
          const parsed = await davRequest({ url, init: { method: 'REPORT' }, fetch: async () => response.clone() });
          reports.push({ parsed, complete: response.status === 207 && await completeDavMultistatus(text)
            && /xml/i.test(response.headers.get('content-type') || '')
            && parsed.every((item) => item.ok && !item.error && (!item.raw || (item.raw.multistatus && item.href))) });
          return response;
        } });
        const query = reports[0];
        const expected = query?.parsed.filter((item) => item.href && urlFilter(new URL(item.href, params.calendar.url).href)) || [];
        const key = (url) => new URL(url, params.calendar.url).href;
        objects.complete = !params.objectUrls && !params.timeRange && !params.filters && !params.urlFilter
          && reports.length > 0 && reports.every((report) => report.complete)
          && expected.every((item) => item.props?.getetag != null)
          && expected.length === objects.length
          && new Set(objects.map((item) => key(item.url))).size === objects.length
          && expected.every((item) => objects.some((object) => key(object.url) === key(item.href)
            && object.etag != null && typeof object.data === 'string' && object.data.length > 0));
        return objects;
      },
      writable: true, enumerable: true, configurable: true,
    },
  });
}

/**
 * Trägt eine Collection die gesuchte iCalendar-Komponente?
 *
 * `supported-calendar-component-set` ist laut RFC 4791 §5.2.3 optional: fehlt die
 * Property, muss der Client alle Komponenten annehmen. tsdav liefert dann ein
 * leeres `components`-Array - wer darauf strikt filtert, blendet auf solchen
 * Servern jede Collection aus. Die Regel steht hier einmal, weil Termine und
 * Aufgaben sie spiegelbildlich brauchen und sie vorher auf der einen Seite fehlte
 * (Aufgabenlisten landeten in der Kalenderauswahl) und auf der anderen zu streng
 * war (#617).
 *
 * @param {{components?: string[]}} cal  Collection aus `fetchCalendars()`
 * @param {string} component            'VEVENT' | 'VTODO'
 */
export function supportsComponent(cal, component) {
  const comps = Array.isArray(cal?.components) ? cal.components : [];
  if (comps.length === 0) return true;
  return comps.map(c => String(c).toUpperCase()).includes(String(component).toUpperCase());
}

/**
 * Collection-URL eines Kalenderobjekts: alles bis zum letzten Segment.
 * CalDAV-Objekte liegen unmittelbar in ihrer Collection, deshalb ist der Pfad
 * ohne Dateinamen die Liste, zu der das Objekt gehört. Nötig, weil tsdav ein
 * Objekt nur innerhalb seiner Collection adressiert, Aufgaben und Einkaufsposten
 * aber nur ihre Objekt-URL tragen.
 */
export function collectionUrlOf(objectUrl) {
  const url = String(objectUrl || '');
  const cut = url.lastIndexOf('/');
  return cut === -1 ? null : url.slice(0, cut + 1);
}
