/**
 * Modul: Kalender (Calendar)
 * Zweck: Monats-/Wochen-/Tages-/Agenda-Ansicht mit vollem Termin-CRUD
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { openTaskSessionEditor, canPlanTaskSessions } from '/components/task-sessions.js';
import { api } from '/api.js';
import { moduleAccess } from '/permissions.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues, recurrenceRow } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal, confirmModal, advancedSection, wireBlurValidation, reportFieldError, refocusAfterRender } from '/components/modal.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { openDetailView, visibilityRow, assignedRow } from '/components/detail-view.js';
import { stagger, wireScrollFade, scheduleUndoableDelete } from '/utils/ux.js';
import { t, formatDate as formatPreferredDate, formatDayMonth, formatTime, timeSuffix, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput } from '/i18n.js';
import { esc, fmtLocation } from '/utils/html.js';
import { shiftEndDateKey, isEndBeforeStart, weekStartIndex, weekdayOrder,
         monthPeriodKeys, startOfLocalWeekKey, addLocalDays, defaultDateInPeriod,
         isWeekendKey } from '/utils/date.js';
import { truncateRuleBefore, followingMeansWholeSeries,
         isLocalRecurringSeries, isExternalRecurringSeries } from '/utils/recurrence-scope.js';
import { getReadableTextColor } from '/utils/color.js';
import { resolveEventColor } from '/utils/event-color.js';
import { renderEventAssigneeBar } from '/components/event-assignees.js';
import { refresh as refreshReminders } from '/reminders.js';
import { parseRemindAtAsUtc } from '/utils/reminder-offset.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';
import { wireTablist } from '/utils/tablist.js';
// EINE Schalterform, auch hier. Das Primitiv liegt unter `/settings/`, weil
// dort sein Anlass lag (vier Schalterformen nebeneinander, Critique
// 2026-07-27) - die Funktion selbst ist geteiltes UI-Vokabular und kein
// Einstellungs-Bauteil. Eine Kopie im Kalender waeren zwei Wahrheiten ueber
// dieselbe Form; der Umzug nach `/utils/` beruehrt zehn Blaetter und gehoert
// in eine eigene Runde. Der Import benennt die Schuld, statt sie zu umgehen.
import { toggleRowHtml } from '/settings/components.js';
import { localizeBirthdayEvent } from '/utils/birthday-event.js';
import { googleTargetValue, caldavTargetValue, outlookTargetValue } from '/utils/sync-target.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { findPageFab } from '/utils/fab.js';
import { displayTimeZone, nowFields, todayKey, zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import {
  CALENDAR_MIN_TIMED_MINUTES,
  CALENDAR_SNAP_MINUTES,
  civilMinute,
  civilParts,
  dayDifference,
  directEditBody,
  editBlockReason,
  editCapabilities,
  eventRange,
  eventOccurrenceStart,
  eventRevision,
  exceptionSummary,
  isDetachedEvent,
  isConflictError,
  isEditAllowed,
  isRecurringEvent,
  moveEventRange,
  previewEvent,
  recurrenceParent,
  recurrenceParentRevision,
  resizeEventRange,
  responseEvent,
  scopedRecurrencePayload,
  syncMetadata,
} from '/utils/calendar-edit.js';
import { maxUploadBytes, maxUploadMb } from '/utils/upload-limit.js';
import { emptyStateHTML, emptyHintHTML, mountLoadError } from '/utils/empty-state.js';
import {
  applyPendingCalendarDeleteOverlay,
  createCalendarLoadCoordinator,
  scheduleCalendarDeleteWithUndo,
} from '/utils/calendar-delete.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VIEWS      = ['month', 'week', 'day', 'agenda'];
let viewTabs = null; // wireTablist-Controller der View-Umschaltung (Sync aus switchToDayView)
const VIEW_LABELS = () => ({
  month: t('calendar.viewMonth'),
  week:  t('calendar.viewWeek'),
  day:   t('calendar.viewDay'),
  agenda: t('calendar.viewAgenda'),
});
const DAY_NAMES_SHORT = () => [
  t('calendar.dayShortSunday'), t('calendar.dayShortMonday'), t('calendar.dayShortTuesday'),
  t('calendar.dayShortWednesday'), t('calendar.dayShortThursday'), t('calendar.dayShortFriday'),
  t('calendar.dayShortSaturday'),
];
const DAY_NAMES_LONG  = () => [
  t('calendar.dayLongSunday'), t('calendar.dayLongMonday'), t('calendar.dayLongTuesday'),
  t('calendar.dayLongWednesday'), t('calendar.dayLongThursday'), t('calendar.dayLongFriday'),
  t('calendar.dayLongSaturday'),
];
const MONTH_NAMES     = () => [
  t('calendar.monthJanuary'), t('calendar.monthFebruary'), t('calendar.monthMarch'),
  t('calendar.monthApril'), t('calendar.monthMay'), t('calendar.monthJune'),
  t('calendar.monthJuly'), t('calendar.monthAugust'), t('calendar.monthSeptember'),
  t('calendar.monthOctober'), t('calendar.monthNovember'), t('calendar.monthDecember'),
];

// Kuratierte OKLCH-Palette (gedämpfte Jewel-Töne, verankert auf dem Violett der
// App-Identität statt der geliehenen iOS-System-Farben). Gleichmäßiger Chroma-/
// Hue-Abstand; jede Farbe ergibt sowohl eine ruhige getönte Fläche als auch eine
// WCAG-AA-lesbare dunkle Tinte (siehe eventSurfaceStyle + calendar.css). Konkreter
// Hex, weil Events die Farbe als Hex in der DB speichern und color.js Luminanz rechnet.
const EVENT_COLORS = [
  '#587DCE', '#3CA368', '#E0843E', '#CE5053',
  '#8156C0', '#DB684C', '#3E9DCA', '#D8B349',
  '#85868B', '#279EA4',
];

const EVENT_COLOR_NAMES = () => ({
  '#587DCE': t('calendar.colorBlue'),
  '#3CA368': t('calendar.colorGreen'),
  '#E0843E': t('calendar.colorOrange'),
  '#CE5053': t('calendar.colorRed'),
  '#8156C0': t('calendar.colorPurple'),
  '#DB684C': t('calendar.colorCoral'),
  '#3E9DCA': t('calendar.colorSkyBlue'),
  '#D8B349': t('calendar.colorYellow'),
  '#85868B': t('calendar.colorGray'),
  '#279EA4': t('calendar.colorCyan'),
});

/**
 * Hex-Vergleich ohne Ruecksicht auf Gross-/Kleinschreibung. Die Palette steht
 * hier in Grossbuchstaben, ein CalDAV-Server schickt `#34c759` genauso gern -
 * derselbe Farbwert, und ein `===` haelt die beiden fuer verschieden.
 */
const sameColor = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Die Farben, die der Picker eines Termins zeigt.
 *
 * Ein Termin traegt nicht zwangslaeufig eine Farbe AUS DIESER PALETTE. Sie kann
 * als RFC-7986-`COLOR` von einem CalDAV-Server kommen, sie kann die Avatar-Farbe
 * einer Person sein (deren Palette teilt mit dieser hier keinen einzigen Wert)
 * oder schlicht das alte `#007AFF` aus der Zeit vor der OKLCH-Palette.
 *
 * Ohne einen eigenen Swatch dafuer stand der Picker leer da, obwohl der Termin
 * eine Farbe trug - und weil der Speicherpfad auf die erste Palettenfarbe
 * zurueckfiel, schrieb der naechste Klick auf "Speichern" sie darueber. Die
 * Farbe wechselte also genau beim Bearbeiten, ohne dass jemand sie angefasst
 * hatte (#856).
 */
// Spiegelt COLOR_RE aus server/middleware/validate.js. Die Route prueft das
// bereits, aber die Sync-Dienste schreiben ihre Farben direkt in die Tabelle -
// was von dort kommt, hat diese Pruefung nie gesehen. Und der Wert landet gleich
// in einem style-Attribut, wo esc() zwar das Ausbrechen verhindert, nicht aber
// eine zweite CSS-Deklaration dahinter.
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function pickerColors(event) {
  const own = event?.color;
  if (!own || !HEX_COLOR_RE.test(own)) return EVENT_COLORS;
  if (EVENT_COLORS.some((c) => sameColor(c, own))) return EVENT_COLORS;
  return [own, ...EVENT_COLORS];
}

/**
 * Der Wert des Erben-Swatch: "dieser Termin hat keine eigene Farbe".
 *
 * Der Leerstring, nicht `null`, weil er aus `dataset.color` kommt - ein
 * data-Attribut kennt keinen Nullwert, und ein fehlendes Attribut waere
 * `undefined` und damit nicht mehr von "gar kein Swatch aktiv" zu
 * unterscheiden. Genau diese Unterscheidung traegt die Regel unten.
 */
const COLOR_INHERIT = '';

/**
 * Welche Farbe ein Speichern schreibt.
 *
 * Zwei Regeln, und die Reihenfolge ist der ganze Punkt:
 *
 * 1. Steht der Erben-Swatch auf aktiv, schreibt das Speichern `null` - der
 *    Termin bekommt KEINE eigene Farbe und leiht sich die der zugewiesenen
 *    Person (#891). Das ist eine ausdrueckliche Wahl und deshalb ein Wert, den
 *    das Backend annehmen muss; `crud.js` unterscheidet sie am mitgeschickten
 *    Feld von "nicht angefasst".
 * 2. Steht gar kein Swatch auf aktiv, darf ein Speichern die Farbe nicht
 *    veraendern - es gilt, was der Termin schon traegt. Fehlt auch die, bleibt
 *    es bei `null`: ein neuer Termin faengt ohne eigene Farbe an. Bis v2.48.0
 *    stand hier `EVENT_COLORS[0]`, und weil dieser Palettenerste ununterscheidbar
 *    von einer bewussten Wahl war, hat er die Personenfarbe verdraengt, ohne dass
 *    sie je jemand abgewaehlt haette.
 */
function colorToSave(activeSwatchColor, event) {
  if (activeSwatchColor === COLOR_INHERIT) return null;
  if (activeSwatchColor) return activeSwatchColor;
  return event?.color ?? null;
}

const EVENT_ICON_ALIASES = {
  drill: 'tooth',
};

const EVENT_ICON_CATEGORIES = () => [
  {
    key: 'general',
    label: t('calendar.iconCategoryGeneral'),
    icons: [
      { value: 'calendar', label: t('calendar.iconCalendar') },
      { value: 'alarm-clock', label: t('calendar.iconAlarm') },
      { value: 'clock', label: t('calendar.iconClock') },
      { value: 'bell', label: t('calendar.iconBell') },
      { value: 'map-pin', label: t('calendar.iconLocation') },
      { value: 'star', label: t('calendar.iconStar') },
      { value: 'flag', label: t('calendar.iconFlag') },
      { value: 'target', label: t('calendar.iconTarget') },
      { value: 'flame', label: t('calendar.iconFlame') },
    ],
  },
  {
    key: 'health',
    label: t('calendar.iconCategoryHealth'),
    icons: [
      { value: 'tooth', label: t('calendar.iconTooth') },
      { value: 'hospital', label: t('calendar.iconHospital') },
      { value: 'stethoscope', label: t('calendar.iconDoctor') },
      { value: 'syringe', label: t('calendar.iconVaccine') },
      { value: 'pill', label: t('calendar.iconMedicine') },
      { value: 'bandage', label: t('calendar.iconBandage') },
      { value: 'heart-pulse', label: t('calendar.iconHealth') },
      { value: 'activity', label: t('calendar.iconActivity') },
      { value: 'scissors', label: t('calendar.iconHaircut') },
      { value: 'dumbbell', label: t('calendar.iconSports') },
      { value: 'trophy', label: t('calendar.iconTrophy') },
    ],
  },
  {
    key: 'transport',
    label: t('calendar.iconCategoryTransport'),
    icons: [
      { value: 'car', label: t('calendar.iconCar') },
      { value: 'bus', label: t('calendar.iconBus') },
      { value: 'train', label: t('calendar.iconTrain') },
      { value: 'plane', label: t('calendar.iconPlane') },
      { value: 'plane-takeoff', label: t('calendar.iconFlight') },
      { value: 'fuel', label: t('calendar.iconFuel') },
      { value: 'navigation', label: t('calendar.iconNavigation') },
      { value: 'bike', label: t('calendar.iconBike') },
    ],
  },
  {
    key: 'work',
    label: t('calendar.iconCategoryWork'),
    icons: [
      { value: 'briefcase', label: t('calendar.iconWork') },
      { value: 'laptop', label: t('calendar.iconLaptop') },
      { value: 'presentation', label: t('calendar.iconPresentation') },
      { value: 'school', label: t('calendar.iconSchool') },
      { value: 'graduation-cap', label: t('calendar.iconEducation') },
      { value: 'book-open', label: t('calendar.iconReading') },
      { value: 'pencil', label: t('calendar.iconStudy') },
      { value: 'calculator', label: t('calendar.iconCalculator') },
    ],
  },
  {
    key: 'food',
    label: t('calendar.iconCategoryFood'),
    icons: [
      { value: 'utensils', label: t('calendar.iconMeal') },
      { value: 'cooking-pot', label: t('calendar.iconCooking') },
      { value: 'coffee', label: t('calendar.iconCoffee') },
      { value: 'cake', label: t('calendar.iconCake') },
      { value: 'pizza', label: t('calendar.iconPizza') },
      { value: 'wine', label: t('calendar.iconWine') },
      { value: 'beer', label: t('calendar.iconBeer') },
    ],
  },
  {
    key: 'shopping',
    label: t('calendar.iconCategoryShopping'),
    icons: [
      { value: 'shopping-bag', label: t('calendar.iconShopping') },
      { value: 'shopping-cart', label: t('calendar.iconGroceries') },
      { value: 'gift', label: t('calendar.iconGift') },
      { value: 'credit-card', label: t('calendar.iconCard') },
      { value: 'wallet', label: t('calendar.iconWallet') },
      { value: 'piggy-bank', label: t('calendar.iconSavings') },
      { value: 'landmark', label: t('calendar.iconBank') },
    ],
  },
  {
    key: 'leisure',
    label: t('calendar.iconCategoryLeisure'),
    icons: [
      { value: 'music', label: t('calendar.iconMusic') },
      { value: 'film', label: t('calendar.iconMovie') },
      { value: 'ticket', label: t('calendar.iconTicket') },
      { value: 'gamepad-2', label: t('calendar.iconGame') },
      { value: 'camera', label: t('calendar.iconPhoto') },
      { value: 'party-popper', label: t('calendar.iconParty') },
    ],
  },
  {
    key: 'family',
    label: t('calendar.iconCategoryFamily'),
    icons: [
      { value: 'users', label: t('calendar.iconFamily') },
      { value: 'baby', label: t('calendar.iconBaby') },
      { value: 'dog', label: t('calendar.iconDog') },
      { value: 'cat', label: t('calendar.iconCat') },
      { value: 'paw-print', label: t('calendar.iconPet') },
    ],
  },
  {
    key: 'home',
    label: t('calendar.iconCategoryHome'),
    icons: [
      { value: 'home', label: t('calendar.iconHome') },
      { value: 'building', label: t('calendar.iconBuilding') },
      { value: 'wrench', label: t('calendar.iconRepair') },
      { value: 'hammer', label: t('calendar.iconMaintenance') },
      { value: 'paintbrush', label: t('calendar.iconCleaning') },
      { value: 'sofa', label: t('calendar.iconFurniture') },
      { value: 'washing-machine', label: t('calendar.iconLaundry') },
    ],
  },
  {
    key: 'nature',
    label: t('calendar.iconCategoryNature'),
    icons: [
      { value: 'leaf', label: t('calendar.iconLeaf') },
      { value: 'tree-pine', label: t('calendar.iconTree') },
      { value: 'flower', label: t('calendar.iconFlower') },
      { value: 'sun', label: t('calendar.iconSun') },
      { value: 'moon', label: t('calendar.iconMoon') },
      { value: 'cloud-sun', label: t('calendar.iconWeather') },
    ],
  },
];

// Flache Liste aller Icons für Kompatibilität (z.B. eventIconName-Validierung)
const EVENT_ICONS = EVENT_ICON_CATEGORIES().flatMap((cat) => cat.icons);

// `balloon` was added to Lucide after the app's vendored v0.469.0 bundle. Keep
// this single glyph local instead of turning name-day polish into a full icon
// library upgrade. Its SVG paths come from Lucide v0.557.0 and are covered by
// public/vendor/lucide/LICENSE.balloon-v0.557.0.
const CUSTOM_EVENT_ICON_PATHS = Object.freeze({
  tooth: [
    'M8.5 3.5c1.2 0 2.1.5 3.5.5s2.3-.5 3.5-.5c2.4 0 4 1.8 4 4.4 0 2.2-1 4.2-1.7 5.7-.7 1.6-.8 3.1-1.1 4.7-.3 1.7-1.1 3.2-2.4 3.2-1.1 0-1.5-1.1-1.8-2.7-.2-1.2-.4-2.1-.5-2.1s-.3.9-.5 2.1c-.3 1.6-.7 2.7-1.8 2.7-1.3 0-2.1-1.5-2.4-3.2-.3-1.6-.4-3.1-1.1-4.7C5.5 12.1 4.5 10.1 4.5 7.9c0-2.6 1.6-4.4 4-4.4Z',
    'M10 6.2c.7.3 1.3.5 2 .5s1.3-.2 2-.5',
  ],
  balloon: [
    'M12 16v1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v1',
    'M12 6a2 2 0 0 1 2 2',
    'M18 8c0 4-3.5 8-6 8s-6-4-6-8a6 6 0 0 1 12 0',
  ],
});
const CUSTOM_EVENT_ICONS = new Set(Object.keys(CUSTOM_EVENT_ICON_PATHS));

const ATTACHMENT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CALENDAR_VIEW_STORAGE_KEY = 'yuvomi:calendar:view';
const LEGACY_CALENDAR_VIEW_STORAGE_KEY = 'yuvomi-calendar-view';
const LAYER_HOLIDAYS_KEY = 'yuvomi:calendar:layer:holidays';
const LAYER_SCHOOL_KEY    = 'yuvomi:calendar:layer:school';
const LAYER_BIRTHDAYS_KEY = 'yuvomi:calendar:layer:birthdays';
const LAYER_SCHEDULE_KEY = 'yuvomi:calendar:layer:schedule';
const SCHEDULE_DISPLAY_KEY = 'yuvomi:calendar:schedule-display';
// Monatszelle am Telefon: Titelzeilen statt Punkte. GERAETEWEIT, nicht pro
// Haushalt - die Frage, die der Schalter beantwortet ("passt ein Titel auf
// diesen Schirm?"), ist eine des Geraets, und dieselbe Person liest denselben
// Kalender abends am 27-Zoll-Monitor. Damit steht er neben scheduleDisplay in
// localStorage und nicht in den Haushaltseinstellungen.
const MONTH_TITLES_KEY = 'yuvomi:calendar:month-titles';
const ASSIGNED_TO_ME_KEY  = 'yuvomi:calendar:assignedToMe';
const PEOPLE_FILTER_KEY   = 'yuvomi:calendar:people';

/* DIE FEIERTAGSFARBEN, WENN DER HAUSHALT KEINE GEWAEHLT HAT.
 *
 * Sie standen zweimal als nacktes Hex im Markup dieser Datei und viermal im
 * Server (routes/preferences.js, services/holidays.js). Hier stehen sie
 * einmal - der Client erfindet keinen eigenen Wert, er nennt denselben wie
 * die Quelle.
 *
 * DIE WERTE SELBST SIND EIN OFFENER PUNKT, kein Versehen: `#FF3B30` und
 * `#34C759` sind iOS System Red und System Green, also genau die
 * Apple-Rohpalette, die der Direction Contract am 2026-08-10 ausdruecklich
 * verlassen hat. Sie zu aendern faerbt jeden Haushalt um, der nie eine Farbe
 * gewaehlt hat - das ist eine Entscheidung des Betreibers, keine Reparatur,
 * und sie muesste den Server mitnehmen. Bis dahin steht der Wert wenigstens
 * an einer Stelle statt an dreien. */
/* DIE MOBIL-GRENZE STEHT EINMAL, UND SIE FOLGT DEM CSS.
 *
 * Sie stand viermal als `(max-width: 639px)` im JS, waehrend calendar.css an
 * drei Stellen bei `max-width: 640px` schaltete. Bei GENAU 640px war die App
 * deshalb in zwei Zustaenden zugleich: das CSS hatte die Termin-Chips schon
 * auf Punkte reduziert, das JS hielt noch die Desktop-Klicklogik - ein Tap
 * musste einen 10px-Punkt treffen, statt die ganze Zelle als Ziel zu haben.
 * Verifiziert bei 640px: `cssMobile: true`, `jsMobile: false`.
 *
 * Der Wert ist seither ZWEIMAL gewandert, und beide Male wanderte nur eine
 * Seite: erst zog das JS auf die CSS-Zahl 640, dann zog der Breakpoint-Sweep
 * das CSS auf die Paarung 639 - und liess das JS wieder allein bei 640 stehen,
 * mit demselben Zwei-Zustaende-Bild bei genau 640px, nur seitenverkehrt. Ein
 * Guard, der Zahlen ohne ihre Richtung vergleicht, sah beide Male nichts:
 * `min-width: 640px` in layout.css deckte die JS-640 scheinbar ab.
 *
 * Der Guard vergleicht deshalb nicht mehr Zahlen, sondern SCHWELLEN (`test:
 * frontend-audit`): `max-width: 639px` und `min-width: 640px` sind dieselbe
 * Schwelle 640, `max-width: 640px` ist die Schwelle 641 - und die kennt kein
 * Stylesheet. Zwei Zahlen fuer dieselbe Schwelle sind genau die Bauart, an der
 * dieser Fehler zweimal entstanden ist. */
const MOBILE_MEDIA_QUERY = '(max-width: 639px)';

const HOLIDAY_PUBLIC_FALLBACK = '#FF3B30';
const HOLIDAY_SCHOOL_FALLBACK = '#34C759';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* DIE STUNDENHOEHE STEHT IN tokens.css UND NUR DORT.
 *
 * Sie stand hier als `HOUR_HEIGHT = 56` und dort als `--cal-hour-height: 56px`:
 * zwei Schreibweisen desselben Werts, von denen eine still veralten kann - wer
 * das Token anfasst, verschiebt die Stundenlinien und laesst die Termine
 * stehen, ohne dass ein Test das sieht. Positionen werden deshalb als calc()
 * gegen den Token-Namen ausgedrueckt; wer die Hoehe wirklich in Pixeln braucht
 * (Klick auf eine Uhrzeit, Scroll zur aktuellen Stunde), misst sie am Element.
 *
 * Es bleibt EIN Variablenname. Die Tagesansicht ist dichter (40px statt 56px),
 * aber sie sagt das in ihrem eigenen CSS - `.day-view` ueberschreibt
 * --cal-hour-height mit --cal-hour-height-day, und alles darin (Zeitspalte,
 * Stundenlinien, Termine, Now-Linie) folgt automatisch. JS kennt die Dichte
 * gar nicht, es kennt nur den Bezug. */
const HOUR_VAR = '--cal-hour-height';

/** Vertikaler Versatz einer Minutenzahl als calc() gegen die Stundenhoehe. */
function hourOffset(minutes) {
  return `calc(var(${HOUR_VAR}) * ${Math.round((minutes / 60) * 1e4) / 1e4})`;
}

/** Gemessene Stundenhoehe einer 24-Stunden-Spalte (Klick- und Scroll-Mathematik). */
function measuredHourHeight(colEl) {
  return (colEl?.getBoundingClientRect?.().height || 0) / 24;
}

function renderIconPickerResults(selectedIcon, query = '') {
  const q = query.trim().toLowerCase();
  if (q) {
    const filtered = EVENT_ICON_CATEGORIES()
      .flatMap((c) => c.icons)
      .filter((icon) => icon.label.toLowerCase().includes(q) || icon.value.includes(q));
    if (filtered.length === 0) {
      return emptyHintHTML(t('calendar.iconSearchEmpty'));
    }
    return `
      <div class="event-icon-picker__category-icons">
        ${filtered.map((icon) => iconPickerOptionHtml(icon, selectedIcon)).join('')}
      </div>`;
  }
  return EVENT_ICON_CATEGORIES().map((cat) => `
    <div class="event-icon-picker__category">
      <div class="event-icon-picker__category-label">${esc(cat.label)}</div>
      <div class="event-icon-picker__category-icons">
        ${cat.icons.map((icon) => iconPickerOptionHtml(icon, selectedIcon)).join('')}
      </div>
    </div>`).join('');
}

function iconPickerOptionHtml(icon, selectedIcon) {
  return `
    <button type="button"
            class="event-icon-picker__option ${selectedIcon === icon.value ? 'event-icon-picker__option--active' : ''}"
            data-icon="${icon.value}"
            role="radio"
            aria-checked="${selectedIcon === icon.value ? 'true' : 'false'}"
            aria-label="${esc(icon.label)}"
            title="${esc(icon.label)}">
      ${eventIconHtml(icon.value, 'event-icon-picker__option-icon')}
    </button>`;
}

function openIconPickerDialog(selectedIcon, onSelect, onClose = () => {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay event-icon-dialog';
  overlay.setAttribute('aria-modal', 'true');

  const panel = document.createElement('div');
  panel.className = 'modal-panel modal-panel--md event-icon-dialog__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('calendar.iconLabel'));
  panel.insertAdjacentHTML('beforeend', `
    <div class="modal-panel__header">
      <span class="modal-panel__title">${esc(t('calendar.iconLabel'))}</span>
      <button class="modal-panel__close btn--ghost" type="button" aria-label="${esc(t('common.close'))}">
        <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>
    <div class="modal-panel__body event-icon-dialog__body">
      <input type="search" class="form-input event-icon-picker__search" id="event-icon-dialog-search"
             placeholder="${esc(t('calendar.iconSearchPlaceholder'))}" autocomplete="off" aria-label="${esc(t('calendar.iconSearchPlaceholder'))}">
      <div class="event-icon-dialog__results" id="event-icon-dialog-results" role="radiogroup" aria-label="${esc(t('calendar.iconLabel'))}">
        ${renderIconPickerResults(selectedIcon)}
      </div>
    </div>
  `);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    onClose();
  }
  // Die Zurueck-Geste schliesst zuerst diesen Picker, nicht das Formular
  // darunter (#871).
  attachOverlay(overlay, close);
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  panel.querySelector('.modal-panel__close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  panel.querySelector('#event-icon-dialog-search')?.addEventListener('input', (e) => {
    const results = panel.querySelector('#event-icon-dialog-results');
    results?.replaceChildren();
    results?.insertAdjacentHTML('beforeend', renderIconPickerResults(selectedIcon, e.target.value));
    if (window.lucide) lucide.createIcons({ el: results });
  });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('.event-icon-picker__option');
    if (!btn) return;
    onSelect(btn.dataset.icon);
    close();
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKeydown);
  panel.querySelector('#event-icon-dialog-search')?.focus();
  if (window.lucide) lucide.createIcons({ el: panel });
}

// --------------------------------------------------------
// Farbberechnung: die spezifischste Angabe gewinnt
// Hierarchie: eigene Terminfarbe → Kalenderfarbe → Grau
// --------------------------------------------------------

/** Calendar color and assignment are independent presentation channels. */
function resolveEventBackground(ev) {
  return resolveEventColor(ev);
}

/**
 * Inline-Style für eine getönte Event-Fläche (Monat/Woche/Tag/Ganztägig).
 * Setzt nur `--ev-color`; Tönung, lesbare Tinte und Kante leitet calendar.css per
 * color-mix ab (theme-korrekt in Light & Dark, WCAG-AA für die gesamte Palette).
 * Ersetzt die frühere vollgesättigte Füllung + getContrastColor-Textfarbe.
 */
function eventSurfaceStyle(ev) {
  return `--ev-color:${esc(resolveEventColor(ev))};`;
}

/** Avatars supplement the segmented user-color bar with identity. */
function chipAssigneeStack(ev, { size, maxVisible }) {
  const users = ev.assigned_users ?? [];
  if (!users.length) return '';
  return `<span class="cal-chip__assigned">${renderAvatarStack(users, { size, maxVisible })}</span>`;
}

/**
 * Textalternative der Zuweisung, z. B. „Zugewiesen an: Linda, Marco". Trägt die
 * „Wer"-Information, die der Avatar-Stack nur visuell kommuniziert, in title-/
 * aria-label-Attribute — damit Screenreader sie im Gitter mitbekommen.
 * Leerstring, wenn niemand zugewiesen ist.
 */
function chipAssigneeLabel(ev) {
  const names = (ev.assigned_users ?? []).map((u) => u.display_name).filter(Boolean);
  return names.length ? `${t('calendar.assignedLabel')}: ${names.join(', ')}` : '';
}

/** Escapte ` · Zugewiesen an: …`-Ergänzung zum Anhängen an ein title-Attribut. */
function chipAssigneeTitleSuffix(ev) {
  const label = chipAssigneeLabel(ev);
  return label ? ` · ${esc(label)}` : '';
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  view:          'month',
  // Fehlerobjekt des letzten Bereichs-Ladeversuchs, oder null. Nicht `true`:
  // `mountLoadError` liest daraus den Statuscode.
  loadError:     null,
  today:         '',
  cursor:        null,     // aktuell angezeigte Referenz-Datum (YYYY-MM-DD)
  events:        [],
  panelTasks:    [],
  panelRequest: 0,
  panelSearch: "",
  panelAllocation: "all",
  panelAssignee: "",
  panelPlacement: "beside",
  panelCollapsed: false,
  panelSize: 280,
  tasks:         [],       // Aufgaben mit due_date für Kalender-Anzeige
  scheduleEntries: [],
  scheduleWarnings: [],
  users:         [],
  rangeFrom:     '',
  rangeTo:       '',
  holidays:      [],       // cached entries from holiday_cache
  holidayPrefs:  {},       // subset of /preferences
  weekStart:     1,        // getDay()-Index des Wochenstarts (0=So,1=Mo,6=Sa)
  documentUploadBackend: 'local',
  layerHolidays: true,     // toggle for public holiday layer
  layerSchool:   true,     // toggle for school holiday layer
  layerBirthdays: true,    // toggle for the birthday layer (#778)
  layerSchedule: true,     // computed schedule overlay
  // AUS ist die Vorgabe, und das ist eine Zusage an den Bestand: die Punkte
  // sind die gemessene Fassung (siehe den Block in calendar.css), und ein
  // Update, das die Monatsansicht jedes Telefons ungefragt umbaut, waere die
  // falsche Art, eine zweite Lesart anzubieten.
  monthTitles: false,      // Monat am Telefon: Titelzeilen statt Punkte
  scheduleDisplay: 'compact',
  offlineSince:  null,     // Date des letzten Cache-Stands, wenn offline bedient
  defaultDuration: 60,     // Standard-Termindauer (Minuten) aus den Präferenzen
  currentUserId: null,     // eigene User-ID für „Mir zugewiesen"-Filter
  // Der angemeldete Mensch, wie der Router ihn hereingibt. Gehalten fuer die
  // Aufgaben-Leseansicht (#918): an ihm haengt, wem seine eigenen Kommentare
  // gehoeren und wer eine gesperrte Aufgabe umschreiben darf. `currentUserId`
  // allein reichte dafuer nicht - die Rolle steht nicht darin.
  user: null,
  assignedToMe:  false,    // nur Termine/Aufgaben zeigen, die mir zugewiesen sind
  // Gewaehlte Personen als Set von User-IDs; LEER heisst ALLE, nicht KEINE.
  //
  // DIE ACHSE IST DIE PERSON, NICHT DER KALENDER - und das ist eine gemessene
  // Entscheidung, keine Auslegung. Die Critique vom 2026-08-28 verlangte einen
  // „Kalenderfilter mit Legende" nach Apples Muster. Eine FARBLEGENDE ist hier
  // Calendar colors describe sources; the separate bar describes assignees.
  // Explicit event overrides remain independent of both filters.
  people:        new Set(),
  // Direct manipulation lives in page state so a period change can replace
  // the calendar DOM without losing the active gesture.
  dragPreview:   null,
  dragNotice:    null,
};
let _container = null;
const calendarLoads = createCalendarLoadCoordinator();

let _activeCalendarGesture = null;
let _calendarGestureListeners = false;
let _gestureRenderRaf = 0;
let _gestureEdgeTimer = 0;
let _gestureEdgeRepeat = 0;
let _gestureEdgeDirection = 0;
let _gestureScrollTimer = 0;
let _gestureScrollDirection = 0;
let _suppressCalendarClickUntil = 0;

// Termin-Suche (#471): datumsunabhängiges Finden über den FTS-Index. Der
// Suchmodus blendet eine Leiste unter der Toolbar ein und ersetzt den Ansichts-
// Body durch eine chronologische Trefferliste; Schließen stellt die Ansicht her.
let searchActive  = false;
let searchQuery   = '';
let searchResults = [];
let searchTotal   = 0;

// --------------------------------------------------------
// Datumshelfer
// --------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function normalizeCalendarView(view, fallback = 'month') {
  return VIEWS.includes(view) ? view : fallback;
}

function defaultCalendarViewFromState({ savedView = null, isMobile = false } = {}) {
  return normalizeCalendarView(savedView, isMobile ? 'agenda' : 'month');
}

function defaultCalendarView() {
  try {
    const saved = localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY)
      ?? localStorage.getItem(LEGACY_CALENDAR_VIEW_STORAGE_KEY);
    const isMobile = window.matchMedia?.('(max-width: 767px)').matches ?? false;
    return defaultCalendarViewFromState({ savedView: saved, isMobile });
  } catch {
    return defaultCalendarViewFromState();
  }
}

function setSavedCalendarView(view) {
  if (!VIEWS.includes(view)) return;
  try {
    localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, view);
  } catch {}
}

function getRangeForView(view, cursor) {
  if (view === 'month') return getMonthRange(cursor);
  if (view === 'week') {
    const mobile = window.matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false;
    return getWeekRange(cursor, { mobile });
  }
  if (view === 'day') return { from: cursor, to: cursor };
  if (view === 'agenda') return getAgendaRange(cursor);
  return getMonthRange(cursor);
}

// Der Kalendertag eines gespeicherten Termin-Zeitpunkts in der Anzeigezone
// (#829 Teil 3). Vorher stand hier die Zone des Browsers; ein extern
// synchronisierter Termin sprang damit auf einem Gerät in einer anderen Zone auf
// den Nachbartag, während ein von Hand angelegter (zonenlose Wanduhrzeit)
// stehenblieb - zwei Termine derselben Uhrzeit an zwei Tagen.
function localDate(str) {
  if (!str || str.length <= 10) return (str || '').slice(0, 10);
  return zonedDateKey(str);
}

function validDateParam(value) {
  return DATE_KEY_RE.test(String(value || '')) ? String(value) : '';
}

function deepLinkTargetDate(initialEvent, dateParam) {
  return validDateParam(dateParam) || localDate(initialEvent?.start_datetime);
}

function findDeepLinkedOccurrence(events, initialEvent, targetDate) {
  if (!initialEvent) return null;
  return events.find(
    (ev) => ev.id === initialEvent.id && localDate(ev.start_datetime) === targetDate
  ) || initialEvent;
}

// Die Uhrzeit eines gespeicherten Termin-Zeitpunkts in der Anzeigezone (#829).
function localTime(str) {
  if (!str || str.length <= 10) return '00:00';
  return zonedTimeKey(str);
}

function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return isoDate(d);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// Erster Tag der Woche, die `dateStr` enthält, gemäß haushaltweitem Wochenstart
// (state.weekStart als getDay()-Index). Standard Montag – wie zuvor getMondayOf.
function startOfWeekOf(dateStr, weekStart = state.weekStart) {
  const d = new Date(dateStr + 'T00:00:00');
  const diff = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - diff);
  return isoDate(d);
}

function formatDate(dateStr, { long = false, weekday = false } = {}) {
  if (weekday) {
    const d = new Date(dateStr + 'T00:00:00');
    const wd = long ? DAY_NAMES_LONG()[d.getDay()] : DAY_NAMES_SHORT()[d.getDay()];
    return `${wd}, ${formatPreferredDate(dateStr)}`;
  }
  return formatPreferredDate(dateStr);
}

function formatDateTime(datetimeStr) {
  if (!datetimeStr) return '';
  const date    = localDate(datetimeStr);
  const hasTime = datetimeStr.length > 10;
  const time    = hasTime ? formatTime(datetimeStr) : '';
  return time ? `${formatDate(date)} ${time} ${timeSuffix()}`.trimEnd() : formatDate(date);
}

function eventIconName(icon) {
  const normalized = EVENT_ICON_ALIASES[icon] || icon;
  return CUSTOM_EVENT_ICONS.has(normalized) || EVENT_ICONS.some((item) => item.value === normalized)
    ? normalized
    : 'calendar';
}

/**
 * Hat dieser Termin ein EIGENES Icon - also eines, das etwas hinzufuegt?
 *
 * 'calendar' ist der Datenbank-Default der Spalte und zugleich der Rueckfall
 * von eventIconName() fuer alles Unbekannte: ein Termin, an dem nie jemand ein
 * Icon gewaehlt hat, traegt es trotzdem. Im Monat und in der Woche stoert das
 * nicht, dort steht der Chip in einem Raster voller Fremdherkunft. Im
 * Tagesraster waere es ein generisches Kalender-Glyph an jeder Zeile INNERHALB
 * des Kalenders - es sagt nichts (Herkunfts-Regel: im eigenen Raum ist die
 * Herkunft selbstverstaendlich) und kostet die Titelspalte 20px, die bei 16px
 * hohen Balken fehlen. Die Zugehoerigkeit traegt dort der Spine.
 */
function hasEventIcon(icon) {
  return eventIconName(icon) !== 'calendar';
}

function customEventIconHtml(icon, className) {
  const paths = CUSTOM_EVENT_ICON_PATHS[icon];
  if (!paths) return '';
  return `<svg class="${className} event-icon--custom" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${paths.map((path) => `<path d="${path}"/>`).join('\n    ')}
  </svg>`;
}

function eventIconHtml(icon, className = 'event-icon') {
  const name = eventIconName(icon);
  if (CUSTOM_EVENT_ICONS.has(name)) return customEventIconHtml(name, className);
  return `<i class="${className}" data-lucide="${name}" aria-hidden="true"></i>`;
}

function calendarMetaIconHtml(icon) {
  return `<i data-lucide="${icon}" class="calendar-meta-icon icon-sm" aria-hidden="true"></i>`;
}

function calendarRepeatIconHtml(event) {
  if (!event?.recurrence_rule && !event?.is_recurring_instance) return '';
  return `<span class="calendar-repeat-icon" role="img" aria-label="${esc(t('calendar.recurringEvent'))}"><i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i></span>`;
}

function eventIconElement(icon, className = 'event-icon') {
  const name = eventIconName(icon);
  const customPaths = CUSTOM_EVENT_ICON_PATHS[name];
  if (customPaths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `${className} event-icon--custom`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    for (const pathData of customPaths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      svg.append(path);
    }
    return svg;
  }

  const el = document.createElement('i');
  el.className = className;
  el.dataset.lucide = name;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function isImageAttachment(mime) {
  return ATTACHMENT_IMAGE_MIME.has(String(mime || '').toLowerCase());
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(t('calendar.attachmentReadError')));
    reader.readAsDataURL(file);
  });
}

function attachmentDataUrl(data, mime) {
  const raw = String(data || '');
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;
  return mime ? `data:${mime};base64,${raw}` : raw;
}

function hasAttachment(event) {
  return Boolean(event?.attachment_document_id || event?.attachment_data);
}

function attachmentUrls(event) {
  const legacyUrl = attachmentDataUrl(event?.attachment_data, event?.attachment_mime);
  return {
    preview: event?.attachment_preview_url || legacyUrl,
    download: event?.attachment_download_url || legacyUrl,
  };
}

function truncateDescription(description, maxLength = 500) {
  const text = String(description || '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)} (...)`;
}

function attachmentPreviewHtml(event) {
  if (!hasAttachment(event)) return '';
  const name = esc(event.attachment_name || t('calendar.attachmentFallback'));
  const urls = attachmentUrls(event);
  return isImageAttachment(event.attachment_mime)
    ? `<img src="${esc(urls.preview)}" alt="${name}">`
    : `<a href="${esc(urls.download)}" download="${name}">${name}</a>`;
}

function selectedAttachmentLabel(name) {
  return t('documents.selectedFileLabel', { name: name || t('calendar.attachmentFallback') });
}

function readDateInput(root, selector) {
  return parseDateInput(root.querySelector(selector)?.value || '');
}

function getMonthRange(dateStr) {
  const d     = new Date(dateStr + 'T00:00:00');
  const year  = d.getFullYear();
  const month = d.getMonth();
  // Start des Monats, dann bis auf den Montag zurückgehen (Kalenderraster)
  const firstOfMonth = new Date(year, month, 1);
  // Bis zum gewählten Wochenstart zurückgehen (Kalenderraster).
  const startOffset = (firstOfMonth.getDay() - state.weekStart + 7) % 7;
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - startOffset);
  const from = isoDate(gridStart);
  // 42 Tage (6 Wochen) abdecken
  const to   = addDays(from, 41);
  return { from, to };
}

/**
 * Ladefenster der Wochenansicht: das haushaltsweite 7-Tage-Raster, auf Mobile
 * erweitert um das 3-Tage-Fenster (cursor -1..+1), das renderWeekView() dort
 * tatsächlich zeichnet. Ohne diese Erweiterung klammerte buildDayIndex() auf
 * das reine 7-Tage-Raster, und ein Cursor am Wochenrand liess auf Mobile den
 * hereinragenden Nachbartag ohne seine Termine stehen (#1006) - obwohl
 * fetchWindow() ihn ohnehin mitlädt. Ein Randtag, der ausserhalb BEIDER
 * Fenster liegt, bleibt weiterhin draussen; das ist kein Sonderfall des
 * Ladefensters, sondern dieselbe Klammerung, die buildDayIndex() für jedes
 * mehrtägige Event ohnehin anwendet.
 */
function getWeekRange(dateStr, { weekStart = state.weekStart, mobile = false } = {}) {
  const start = startOfWeekOf(dateStr, weekStart);
  const desktopFrom = start;
  const desktopTo   = addDays(start, 6);
  if (!mobile) return { from: desktopFrom, to: desktopTo };
  const mobileFrom = addDays(dateStr, -1);
  const mobileTo   = addDays(dateStr, 1);
  return {
    from: mobileFrom < desktopFrom ? mobileFrom : desktopFrom,
    to:   mobileTo   > desktopTo   ? mobileTo   : desktopTo,
  };
}

function getAgendaRange(dateStr) {
  return { from: dateStr, to: addDays(dateStr, 30) };
}

/**
 * Der Zeitraum, den eine Ansicht gerade zeigt - als Zeitraum für einen neuen
 * Termin, nicht als Ladespanne. Deshalb nicht getRangeForView(): dessen
 * Monatsspanne ist das 42-Tage-Raster und begänne im Vormonat.
 */
function visibleDayRange(view, cursor, weekStart = 1) {
  if (view === 'month')  return monthPeriodKeys(cursor);
  if (view === 'week')   {
    const from = startOfLocalWeekKey(cursor, weekStart);
    return { from, to: addLocalDays(from, 6) };
  }
  if (view === 'agenda') return { from: cursor, to: addLocalDays(cursor, 30) };
  return { from: cursor, to: cursor };                  // day: der Cursor ist der Tag
}

/**
 * Vorbelegtes Datum für einen neuen Termin, bei dem niemand einen Tag angeklickt
 * hat: Toolbar-„+", FAB, Leerzustand der Agenda (#737). Die Entscheidung selbst
 * trifft defaultDateInPeriod() - sie gilt hausweit und nicht nur hier.
 */
function newEventDefaultDate(view, cursor, today, weekStart = 1) {
  if (!cursor) return today;
  const { from, to } = visibleDayRange(view, cursor, weekStart);
  return defaultDateInPeriod(from, to, today);
}

/** newEventDefaultDate() für den aktuellen State - der Normalfall an den Aufrufstellen. */
function newEventDate() {
  return newEventDefaultDate(state.view, state.cursor, state.today, state.weekStart);
}

// Per-Render-Pass Day-Buckets. Vermeidet, dass jede der 42 Monats-Zellen die
// komplette state.events/state.tasks-Liste neu filtert und pro Event ein neues
// Date parst (O(Zellen × Events) → O(Events + Zellen)).
// _dayIndex.active signalisiert, dass die Maps für die aktuelle Render-Phase
// gültig sind; ansonsten fallen die Helfer auf direktes Filtern zurück.
const _dayIndex = {
  active:  false,
  events:  new Map(), // isoDate -> Event[]
  tasks:   new Map(), // isoDate -> Task[]
};

/**
 * Baut die Tages-Buckets für Events und Tasks einmal pro Render-Durchlauf.
 * Jedes Datum wird genau einmal geparst; mehrtägige Events werden in jeden
 * Tag ihres Bereichs (geklammert auf das geladene Fenster) einsortiert.
 */
function buildDayIndex() {
  const evMap = new Map();
  // Events in Originalreihenfolge durchlaufen, damit pro Tag die Reihenfolge
  // identisch zum bisherigen .filter()-Verhalten bleibt.
  const lo = state.rangeFrom || '';
  const hi = state.rangeTo   || '';
  for (const source of state.events) {
    const e = displayCalendarEvent(source);
    const start = localDate(e.start_datetime);
    const end   = eventEndDate(e);
    // Auf das geladene Fenster klammern, damit mehrtägige/fehlerhafte Events
    // keinen unbegrenzten Bereich erzeugen.
    let from = lo && start < lo ? lo : start;
    const to = hi && end > hi ? hi : end;
    if (from > to) continue;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const bucket = evMap.get(day);
      if (bucket) bucket.push(e);
      else evMap.set(day, [e]);
    }
  }

  const taskMap = new Map();
  for (const t of state.tasks) {
    if (!t.due_date) continue;
    const bucket = taskMap.get(t.due_date);
    if (bucket) bucket.push(t);
    else taskMap.set(t.due_date, [t]);
  }

  _dayIndex.events = evMap;
  _dayIndex.tasks  = taskMap;
  _dayIndex.active = true;
}

/**
 * True, wenn der „Mir zugewiesen"-Filter aus ist oder das Element der eigenen
 * User-ID zugewiesen ist. Wird auf Termine und Kalender-Aufgaben angewandt.
 */
function belongsToMe(item) {
  if (!state.assignedToMe || state.currentUserId == null) return true;
  return (item.assigned_users ?? []).some((u) => u.id === state.currentUserId);
}

/**
 * True, solange der Personenfilter aus ist oder eine der gewaehlten Personen
 * zugewiesen ist.
 *
 * EIN LEERES SET HEISST „ALLE", NICHT „KEINE" - und das ist die einzige
 * Lesart, die einen Ruecknahmeweg hat. Die Umkehrung (leer = nichts zeigen)
 * haette einen Zustand erzeugt, aus dem der leere Kalender selbst nicht mehr
 * herausfuehrt: wer alle Haekchen entfernt, saehe nichts mehr und haette
 * ausserhalb des Blatts keinen Hinweis darauf, warum.
 *
 * Termine OHNE Zuweisung fallen bei aktivem Filter heraus. Das ist Absicht:
 * der Filter beantwortet „wessen Termin", und ein Termin ohne Person ist
 * keine Antwort darauf. Der Rueckweg steht im Blatt.
 */
function matchesPeopleFilter(item) {
  if (state.people.size === 0) return true;
  return (item.assigned_users ?? []).some((u) => state.people.has(u.id));
}

/**
 * Beide Personen-Achsen in einem Praedikat - „mir" und die Auswahl.
 *
 * Ebenen-Eintraege sind keine Antwort auf „wessen Termin" (#1054): ein
 * Geburtstag gehoert einem Kontakt, nicht einem Haushaltsmitglied, und traegt
 * deshalb nie eine Zuweisung. Er liefe bei jeder Personenauswahl und unter
 * „Mir zugewiesen" leer. Wie die Feiertage, die in ihrer eigenen Liste liegen
 * und den Personenfilter nie sehen, bleibt er stehen - ausblenden tut ihn
 * allein seine Ebene (isVisibleLayer), am selben Marker: birthday_name.
 */
function passesPersonFilters(item) {
  if (item.birthday_name) return true;
  return belongsToMe(item) && matchesPeopleFilter(item);
}

function displayCalendarEvent(event) {
  if (!event || !state.dragPreview || Number(state.dragPreview.id) !== Number(event.id)) {
    return event;
  }
  return previewEvent(event, state.dragPreview.range);
}

/** Wie viele Filter gerade etwas wegnehmen - die Zahl am Filterknopf. */
function activeFilterCount() {
  let n = 0;
  if (state.assignedToMe) n += 1;
  if (state.people.size > 0) n += 1;
  const hp = state.holidayPrefs ?? {};
  if (hp.holiday_show_public && !state.layerHolidays) n += 1;
  if (hp.holiday_show_school && !state.layerSchool) n += 1;
  if (!state.layerBirthdays) n += 1;
  if (scheduleEnabled() && !state.layerSchedule) n += 1;
  return n;
}

/**
 * True, solange die Ebene sichtbar ist, zu der ein Termin gehoert (#778).
 *
 * Geburtstage kommen aus den Kontakten und fuellen bei einem grossen Adressbuch
 * den Kalender mit Terminen, die niemand als Termin plant. Sie einzeln zu
 * loeschen half nicht: der naechste Abgleich legt sie wieder an - was der
 * Melder als "keeps coming back" beschrieb. Sie sind deshalb eine Ebene wie die
 * Feiertage, keine Sammlung loeschbarer Eintraege.
 *
 * `birthday_name` ist der Marker: die Leseroute haengt ihn nur an Termine, die
 * an einem Geburtstag haengen (siehe localizeBirthdayEvent).
 */
function isVisibleLayer(ev, showBirthdays = state.layerBirthdays) {
  return showBirthdays || !ev.birthday_name;
}

/** True, wenn im geladenen Bereich ueberhaupt Geburtstage liegen. */
function hasBirthdayEvents() {
  return state.events.some((e) => e.birthday_name);
}

function eventsOnDay(dateStr) {
  const list = _dayIndex.active
    ? (_dayIndex.events.get(dateStr) ?? [])
    : state.events.map(displayCalendarEvent).filter((e) => {
        const start = localDate(e.start_datetime);
        const end   = eventEndDate(e);
        return start <= dateStr && end >= dateStr;
      });
  const layered = state.layerBirthdays ? list : list.filter(isVisibleLayer);
  return layered.filter(passesPersonFilters);
}

/**
 * Letzter Kalendertag, auf dem ein Event erscheint.
 *
 * Ein Zeit-Event, das exakt um Mitternacht endet, belegt den Folgetag nicht:
 * 21:00-24:00 ist ein Freitagstermin, kein Freitag-und-Samstag-Termin (#804).
 * Ohne diese Korrektur galt das Ende als inklusiv, das Event landete im
 * Tages-Bucket des Folgetags und wurde zusaetzlich als mehrtaegig eingestuft -
 * dadurch rutschte es ueber isAllDayLike() faelschlich in die Ganztags-Zeile.
 *
 * Ganztags-Events sind bewusst ausgenommen: sie speichern ihr Ende als
 * T00:00 und meinen es INKLUSIV (eine Reise 07.-09.09. endet auf
 * '2026-09-09T00:00'). Die Regel gilt daher nur fuer Zeit-Events.
 */
function eventEndDate(ev) {
  const start = localDate(ev.start_datetime);
  if (!ev.end_datetime) return start;
  const end = localDate(ev.end_datetime);
  if (end <= start) return start;
  if (ev.all_day || !ev.end_datetime.includes('T')) return end;
  return localTime(ev.end_datetime) === '00:00' ? addDays(end, -1) : end;
}

/** True, wenn Start- und Enddatum auf verschiedene Kalendertage fallen. */
function isMultiDayEvent(ev) {
  if (!ev || !ev.start_datetime || !ev.end_datetime) return false;
  return localDate(ev.start_datetime) !== eventEndDate(ev);
}

/**
 * Events, die in der Ganztags-Zeile statt im Zeitraster gezeigt werden:
 * echte Ganztags-Events, datums-only Events und mehrtägige Zeit-Events.
 * Mehrtägige Events erscheinen dadurch als durchgehender Balken über alle Tage,
 * statt auf jedem Tag fälschlich als identischer Zeitblock (#225).
 */
function isAllDayLike(ev) {
  return !!ev.all_day || !ev.start_datetime.includes('T') || isMultiDayEvent(ev);
}

/**
 * Einordnung eines Events für einen bestimmten Tag in der Agenda:
 *   'all-day' | 'single' | 'start' | 'middle' | 'end'.
 * Mehrtägige Events liefern je nach Tag start/middle/end, damit die Uhrzeit den
 * durchgehenden Zeitraum widerspiegelt statt auf jedem Tag start–end (#225).
 */
function agendaSegmentKind(ev, dayStr) {
  if (ev.all_day || !ev.start_datetime.includes('T')) return 'all-day';
  if (!isMultiDayEvent(ev)) return 'single';
  const startDay = localDate(ev.start_datetime);
  const endDay   = eventEndDate(ev);
  if (dayStr === startDay) return 'start';
  if (dayStr === endDay)   return 'end';
  return 'middle';
}

/**
 * Filtert Tasks: nur open/in_progress mit due_date werden angezeigt.
 * Abgelegte bleiben draußen - der Server liefert sie hier ohnehin nicht mehr mit
 * (#688), die Prüfung steht als Rückfalllinie für vorgefüllte Listen.
 */
function filterTasksForCalendar(tasks) {
  return tasks.filter(
    (t) => t.due_date && t.status !== 'done' && !t.archived_at
  );
}

/** Tasks, die an einem bestimmten Tag fällig sind. */
function tasksOnDay(dateStr) {
  const list = _dayIndex.active
    ? (_dayIndex.tasks.get(dateStr) ?? [])
    : state.tasks.filter((t) => t.due_date === dateStr);
  return list.filter(passesPersonFilters);
}

/** Holiday entries that overlap a given date (respects layer toggles). */
function holidaysOnDay(dateStr) {
  if (!state.holidays?.length) return [];
  return state.holidays.filter((h) => {
    if (h.start_date > dateStr || h.end_date < dateStr) return false;
    if (h.type === 'public' && !state.layerHolidays) return false;
    if (h.type === 'school' && !state.layerSchool)   return false;
    return true;
  });
}

/** Rendert einen read-only Task-Chip für Kalenderansichten. In der Monatsansicht
 *  (interactive:false) ist die Tageszelle selbst der Drill-in-Button; die Chips
 *  sind dort nur visuelles Signal und dürfen kein eigenes role/tabindex tragen -
 *  sonst entsteht ein fokussierbarer Button im Zellen-Button (Audit P1).
 *  icon:false lässt das check-square-Icon weg: die Monats-Bars sind nach Kanon
 *  icon-frei, Woche/Tag/Agenda behalten es als Termin/Aufgabe-Unterscheidung. */
function renderTaskChip(task, { interactive = true, icon = true } = {}) {
  const priority = task.priority || 'none';
  const label    = esc(t('calendar.taskDeadline', { title: task.title }));
  const timeStr  = task.due_time ? ` · ${task.due_time.slice(0, 5)}` : '';
  const button   = interactive
    ? ` role="button" tabindex="0" aria-label="${esc(t('calendar.taskChipAriaLabel', { title: task.title }))}"`
    : '';
  // Die Prioritaet steht als Rangmarke im Punkt (list-row.css), nicht mehr als
  // getoentes Feld mit getoenter Schrift: dieselbe Stufe, die die Aufgabenliste
  // seit v2.23.0 so zeigt. „Ohne" bekommt keinen Punkt - eine Marke fuer eine
  // Abwesenheit waere eine fuenfte Stufe.
  const dot = priority !== 'none'
    ? `<span class="priority-dot priority-dot--${priority}" aria-hidden="true"></span>`
    : '';
  return `<div class="cal-task-chip cal-task-chip--${priority}"
               data-task-id="${task.id}"${button}
               title="${label}${esc(timeStr)}">
    ${icon ? '<i data-lucide="check-square" class="icon-sm" aria-hidden="true"></i>' : ''}
    ${dot}
    <span>${label}${esc(timeStr)}</span>
  </div>`;
}

// --------------------------------------------------------
// API
// --------------------------------------------------------

/**
 * Ladefenster mit einem Tag Rand an beiden Seiten.
 *
 * Extern synchronisierte Termine liegen als UTC in der Datenbank
 * (`2035-03-13T02:00:00Z`), der Serverfilter vergleicht deren UTC-Kalendertag
 * gegen die lokalen Tagesschluessel dieser Ansicht. Westlich von UTC faellt ein
 * Abendtermin dadurch auf den UTC-Folgetag und aus einem Fenster heraus, das
 * genau die angezeigten Tage umfasst: in der Tagesansicht (Fenster = ein Tag)
 * fehlte er komplett, in Woche und Monat nur am Rand (#824).
 *
 * Der Rand deckt jeden realen Zeitzonenversatz (UTC-12..UTC+14) ab. Welche
 * Termine wirklich auf einen Tag gehoeren, entscheidet ohnehin erst
 * buildDayIndex() lokal - dort klammert state.rangeFrom/rangeTo auf das
 * Anzeigefenster, weshalb die Randtage nichts Fremdes einblenden.
 */
function fetchWindow(from, to) {
  return { from: addLocalDays(from, -1), to: addLocalDays(to, 1) };
}

async function loadRange(from, to) {
  const win     = fetchWindow(from, to);
  const calPath = `/calendar?from=${win.from}&to=${win.to}`;
  const selection = { view: state.view, cursor: state.cursor, from, to, panelRequest: ++state.panelRequest };
  await calendarLoads.run(
    async () => {
      const [evRes, taskRes, holRes, scheduleRes, panelRes] = await Promise.all([
        api.get(calPath),
        api.get("/tasks?include_future=1").catch((err) => { console.warn("[Calendar] Tasks fetch failed:", err); return { data: [] }; }),
        api.get(`/calendar/holidays?from=${from}&to=${to}`).catch(() => ({ data: [] })),
        scheduleEnabled()
          ? api.get(`/schedule/entries?from=${from}&to=${to}`).catch(() => ({ data: { entries: [] } }))
          : Promise.resolve({ data: { entries: [] } }),
        api.get(taskPanelPath(state.panelAssignee)).catch(() => ({ data: [] })),
      ]);
      const offlineSince = navigator.onLine ? null : await getCachedAt(calPath);
      return { evRes, taskRes, holRes, scheduleRes, panelRes, offlineSince };
    },
    {
      isCurrent: () => {
        const selected = getRangeForView(state.view, state.cursor);
        return state.view === selection.view
          && state.cursor === selection.cursor
          && selected.from === selection.from
          && selected.to === selection.to;
      },
      apply: ({ evRes, taskRes, holRes, scheduleRes, panelRes, offlineSince }) => {
        state.loadError = null;
        state.events = (evRes.data ?? []).map(localizeBirthdayEvent);
        applyPendingCalendarDeleteOverlay(state, { freshEvents: true });
        if (state.panelRequest === selection.panelRequest) state.panelTasks = panelRes.data ?? [];
        state.tasks = filterTasksForCalendar(taskRes.data ?? []);
        state.holidays = holRes.data ?? [];
        state.scheduleEntries = scheduleRes.data?.entries ?? [];
        state.scheduleWarnings = scheduleRes.data?.warnings ?? [];
        state.offlineSince = offlineSince;
        state.rangeFrom = from;
        state.rangeTo   = to;
      },
      applyError: (err) => {
        console.error('[Calendar] loadRange Fehler:', err);
        // Der Toast allein liess ein leeres Monatsgitter stehen - nicht zu
        // unterscheiden von einem Monat ohne Termine - und in der Agenda den
        // Leerzustand „Keine Termine" samt „Neuer Termin". Dieselbe Verwechslung,
        // die Einkauf und Essensplan 2026-07-30 hatten (Critique P0). `renderView`
        // prueft das Feld jetzt vor allen vier Ansichten.
        state.loadError = err;
        state.events   = [];
        state.tasks    = [];
        state.holidays = [];
        state.scheduleEntries = [];
        state.scheduleWarnings = [];
        state.offlineSince = null;
        state.rangeFrom = from;
        state.rangeTo   = to;
      },
    },
  );
}

/**
 * Eine Aufgabe aus dem Kalender öffnen (#918).
 *
 * Bis dahin sprang ein Klick auf einen Aufgaben-Chip ins Aufgabenmodul: Der
 * Kalender war weg, der Monat, den man gerade las, auch, und der Weg zurück
 * ging über die Navigation. Für das Abhaken einer Aufgabe, die man auf ihrem
 * Tag stehen sieht, war das der ganze Vorgang.
 *
 * Jetzt öffnet dieselbe Leseansicht, die das Aufgabenmodul öffnet - über den
 * einen Einstieg dort, nicht über eine zweite, kleinere Fassung hier. Das
 * Modul wird dafür nachgeladen und nicht mit importiert: Es zieht das
 * Aufgabenformular mit sich, und dessen Gewicht gehört nicht in den Start des
 * Kalenders.
 *
 * Nach einer Änderung wird der sichtbare Bereich neu geholt statt nur neu
 * gezeichnet: Abhaken, Ablegen und Löschen ändern, WELCHE Aufgaben auf einem
 * Tag stehen, nicht nur wie sie aussehen.
 */
async function openTaskFromCalendar(taskId) {
  try {
    const { openTaskById } = await import('/pages/tasks.js');
    await openTaskById(taskId, {
      user: state.user,
      container: _container,
      onChanged: async () => {
        await loadRange(state.rangeFrom, state.rangeTo);
        renderView();
      },
    });
  } catch (err) {
    console.error('[Calendar] Aufgabe konnte nicht geöffnet werden:', err);
    window.yuvomi?.showToast(err.message ?? t('tasks.loadError'), 'danger');
  }
}

/**
 * Nur die Kalender-Events der aktuell gewählten Ansicht neu laden (ohne Tasks/Feiertage).
 * Für serienweite Bearbeitungen (#532), bei denen sich lediglich die Expansion
 * ändert - vermeidet das Überholen unveränderter Tasks/Feiertage aus loadRange.
 * Die Ansicht wird aus Cursor + View neu berechnet statt aus rangeFrom/rangeTo
 * gelesen: ein Delete-Commit kann genau während eines Navigations-Loads fällig
 * werden, und dann gehört die autoritative Antwort bereits zum neuen Cursor.
 */
async function reloadCalendarEventsOnly({ throwOnError = false } = {}) {
  try {
    const { from, to } = getRangeForView(state.view, state.cursor);
    const selection = { view: state.view, cursor: state.cursor, from, to };
    const win = fetchWindow(from, to);
    await calendarLoads.run(
      () => api.get(`/calendar?from=${win.from}&to=${win.to}`),
      {
        isCurrent: () => {
          const selected = getRangeForView(state.view, state.cursor);
          return state.view === selection.view
            && state.cursor === selection.cursor
            && selected.from === selection.from
            && selected.to === selection.to;
        },
        apply: (res) => {
          state.events = (res.data ?? []).map(localizeBirthdayEvent);
          applyPendingCalendarDeleteOverlay(state, { freshEvents: true });
        },
      },
    );
  } catch (err) {
    console.error('[Calendar] reloadCalendarEventsOnly Fehler:', err);
    if (throwOnError) throw err;
    return false;
  }
  return true;
}

/**
 * Reconcile every calendar layer after a delayed destructive commit.
 *
 * A delete changes only events, but this intentionally uses the full range
 * loader: it makes events, range bounds, load/offline state and every rendered
 * layer one authoritative snapshot after the five-second delay. Reusing the
 * event-only loader would leave the next reader tempted to restore the old
 * partial-state race this path exists to close.
 */
async function reloadCalendarRangeAfterDelete() {
  const { from, to } = getRangeForView(state.view, state.cursor);
  await loadRange(from, to);
}

/**
 * Liest den x-cached-at-Zeitstempel einer offline bedienten API-Antwort aus dem
 * Service-Worker-API-Cache. Findet den Cache versionsunabhängig per Prefix.
 * @returns {Promise<Date|null>}
 */
async function getCachedAt(path) {
  if (typeof caches === 'undefined') return null;
  try {
    const names    = await caches.keys();
    const apiCache = names.find((n) => n.startsWith('yuvomi-api-'));
    if (!apiCache) return null;
    const cache = await caches.open(apiCache);
    const res   = await cache.match(`/api/v1${path}`);
    const ts    = res?.headers.get('x-cached-at');
    const ms    = ts ? Number(ts) : NaN;
    return Number.isFinite(ms) ? new Date(ms) : null;
  } catch {
    return null;
  }
}

async function loadUsers() {
  try {
    const res   = await api.get('/auth/users');
    state.users = res.data;
  } catch {
    state.users = [];
  }
}

// --------------------------------------------------------
// Entry Point
// --------------------------------------------------------

export async function render(container, { user }) {
  _container = container;
  ensureCalendarGestureListeners();
  // Die Uhr des Haushalts: state.today markiert die Heute-Zelle, die Jetzt-Linie
  // und den Vorschlag fuer einen neuen Termin - alle drei muessen denselben Tag
  // meinen wie die Termine daneben (#829 Teil 3).
  state.today  = todayKey();
  state.cursor = state.today;
  state.view   = defaultCalendarView();
  state.panelAssignee = '';
  state.panelSearch = '';
  state.panelAllocation = 'all';
  state.panelDuration = 30;
  try {
    const saved = JSON.parse(localStorage.getItem(taskPanelStorageKey(user?.id)) || '{}');
    if (Number.isFinite(saved.duration) && saved.duration >= 15 && saved.duration % 15 === 0) state.panelDuration = saved.duration;
    state.panelPlacement = saved.placement === 'below' ? 'below' : 'beside';
    state.panelCollapsed = saved.collapsed === true;
    state.panelSize = Math.max(TASK_PANEL_SIZE.min, Math.min(TASK_PANEL_SIZE.max, Number(saved.size) || TASK_PANEL_SIZE.initial));
  } catch { state.panelPlacement = 'beside'; state.panelCollapsed = false; state.panelSize = TASK_PANEL_SIZE.initial; }


  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="calendar-page app-page app-page--full" id="calendar-page" data-composition="full">
      <div class="page-toolbar page-toolbar--wrap cal-toolbar" id="cal-toolbar"></div>
      <div class="calendar-workspace">
        <div id="cal-body" style="flex:1;display:flex;flex-direction:column;overflow:hidden;"></div>
        <aside class="calendar-task-panel page-scrollport" id="calendar-task-panel" hidden></aside>
      </div>
      <button class="page-fab" id="fab-new-event" aria-label="${t('calendar.newEvent')}" data-dock-label="${t('newLabel.calendar')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  // Lade-Skeleton sofort einblenden, damit der erste Frame nicht leer bleibt,
  // während Termine/Präferenzen laden (Sichtbarkeit des Systemstatus). Wird von
  // renderView() beim ersten Render ersetzt; aria-busy quittiert den Ladezustand.
  const bodyEl = container.querySelector('#cal-body');
  bodyEl.setAttribute('aria-busy', 'true');
  bodyEl.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));

  const params    = new URLSearchParams(window.location.search);
  const openId    = params.get('open');
  const dateParam = validDateParam(params.get('date'));
  let initialEvent = null;
  if (openId && /^\d+$/.test(openId)) {
    try {
      const eventRes = await api.get(`/calendar/${openId}`);
      if (eventRes?.data) {
        initialEvent = localizeBirthdayEvent(eventRes.data);
        state.cursor = deepLinkTargetDate(initialEvent, dateParam);
      } else {
        console.warn('[Calendar] Deep-link event not found:', openId);
      }
    } catch (err) {
      console.warn('[Calendar] Deep-link event load failed:', err);
    }
  }

  const { from, to } = getRangeForView(state.view, state.cursor);
  const [,, prefsRes, documentOptionsRes] = await Promise.all([
    loadRange(from, to),
    loadUsers(),
    api.get('/preferences').catch(() => ({ data: {} })),
    api.get('/documents/meta/options').catch(() => ({ data: {} })),
  ]);
  state.holidayPrefs  = prefsRes.data ?? {};
  state.weekStart     = weekStartIndex(prefsRes.data?.week_start);
  state.defaultDuration = Number(prefsRes.data?.calendar_default_duration) || 60;
  // Standardwerte für neue Termine (#497/#498).
  state.defaultReminders = Array.isArray(prefsRes.data?.calendar_default_reminders)
    ? prefsRes.data.calendar_default_reminders.map(Number)
    : [];
  state.defaultAssignMe  = !!prefsRes.data?.calendar_default_assign_me;
  // Standard-Sync-Ziel für eigene neue Termine (#620).
  state.defaultSyncTarget = prefsRes.data?.calendar_default_target || '';
  state.documentUploadBackend = documentOptionsRes.data?.active_upload_backend ?? 'local';
  state.layerHolidays = localStorage.getItem(LAYER_HOLIDAYS_KEY) !== 'false';
  state.layerSchool   = localStorage.getItem(LAYER_SCHOOL_KEY)   !== 'false';
  state.layerBirthdays = localStorage.getItem(LAYER_BIRTHDAYS_KEY) !== 'false';
  state.layerSchedule = localStorage.getItem(LAYER_SCHEDULE_KEY) !== 'false';
  state.scheduleDisplay = localStorage.getItem(SCHEDULE_DISPLAY_KEY) === 'blocks' ? 'blocks' : 'compact';
  // Gegen 'true' geprueft, nicht gegen 'false' wie die Ebenen darueber: die
  // Ebenen sind AN, solange nichts anderes dasteht, dieser Schalter ist AUS.
  state.monthTitles = localStorage.getItem(MONTH_TITLES_KEY) === 'true';
  state.currentUserId = user?.id ?? null;
  state.user          = user ?? null;
  state.assignedToMe  = localStorage.getItem(ASSIGNED_TO_ME_KEY) === '1';
  state.people = restorePeopleFilter(state.users);

  renderToolbar();
  renderView();
  bodyEl.removeAttribute('aria-busy');

  findPageFab('fab-new-event')?.addEventListener('click', () => openEventModal({ mode: 'create', date: newEventDate() }));

  if (initialEvent) {
    const targetDate = deepLinkTargetDate(initialEvent, dateParam);
    const occurrence = findDeepLinkedOccurrence(state.events, initialEvent, targetDate);

    const chip =
      container.querySelector(`[data-date="${CSS.escape(targetDate)}"] [data-id="${CSS.escape(openId)}"]`)
      ?? container.querySelector(`[data-id="${CSS.escape(openId)}"]`);

    if (chip) {
      chip.scrollIntoView({ block: 'center', behavior: 'instant' });
      openEventDetail(occurrence, chip);
    } else {
      // Kein sichtbarer Chip (Termin außerhalb der aktuellen Ansicht): Der
      // Deep-Link landet trotzdem in der Leseansicht, nur ohne Verankerung.
      openEventDetail(occurrence);
    }
  }
}

// --------------------------------------------------------
// Toolbar
// --------------------------------------------------------

function renderToolbar() {
  const bar = _container.querySelector('#cal-toolbar');
  if (!bar) return;

  // DIE EBENEN WOHNEN IM BLATT, NICHT IM KOPF (2026-08-28).
  //
  // Hier standen bis zu fuenf Chips plus den „Mir zugewiesen"-Schalter und
  // belegten damit eine eigene Kopfzeile - gemessen 56px auf 390px, also
  // 6,6% der Viewporthoehe, fuer Bedienelemente, die unter 640px ihr Label
  // verloren und deren An/Aus-Zustand eine Flaeche von 1,085:1 war. Was hier
  // bleibt, ist ein Knopf mit der ZAHL der aktiven Filter: er beantwortet die
  // einzige Frage, die der Kopf beantworten muss („nehme ich gerade etwas
  // weg?"), und der Rest steht beschriftet im Blatt (openCalendarFilters).
  const filterCount = activeFilterCount();

  // DIE UEBERLAPPUNGSWARNUNG BLEIBT IM KOPF. Sie ist eine Meldung mit
  // `role="status"`, kein Filter - im Blatt waere sie hinter einem Klick
  // versteckt, und eine Warnung, die man erst oeffnen muss, ist keine.
  const scheduleWarningHtml = (scheduleEnabled() && state.scheduleWarnings.length) ? `
    <span class="cal-toolbar__schedule-warning" role="status"
          title="${esc(t('schedule.overlapWarning', { date: state.scheduleWarnings[0].date_key, user: scheduleOwnerName(state.scheduleWarnings[0]) }))}">
      <i data-lucide="triangle-alert" class="icon-sm" aria-hidden="true"></i>
      <span>${t('schedule.overlapWarningShort')}</span>
    </span>
  ` : '';

  const filterBtnHtml = `
    ${scheduleWarningHtml}
    <button class="btn btn--icon cal-toolbar__filter-btn ${filterCount ? 'cal-toolbar__filter-btn--active' : ''}"
            id="cal-filters" aria-label="${filterCount ? esc(t('calendar.filtersActive', { count: filterCount })) : t('calendar.filtersOpen')}"
            title="${t('calendar.filters')}" aria-haspopup="dialog">
      <i data-lucide="sliders-horizontal" aria-hidden="true"></i>
      ${filterCount ? `<span class="cal-toolbar__filter-count" aria-hidden="true">${filterCount}</span>` : ''}
    </button>
  `;

  bar.replaceChildren();
  bar.insertAdjacentHTML('beforeend', `
    <h1 class="page-toolbar__title">${t('calendar.title')}</h1>
    <div class="page-toolbar__center cal-toolbar__month">
      <button class="btn btn--secondary cal-toolbar__today" id="cal-today">${t('calendar.today')}</button>
      <button class="btn btn--icon" id="cal-prev" aria-label="${t('calendar.back')}">
        <i data-lucide="chevron-left" aria-hidden="true"></i>
      </button>
      <span class="cal-toolbar__label" id="cal-label"></span>
      <button class="btn btn--icon" id="cal-next" aria-label="${t('calendar.forward')}">
        <i data-lucide="chevron-right" aria-hidden="true"></i>
      </button>
    </div>
    <div class="page-toolbar__actions">
      ${filterBtnHtml}
      <!-- KEIN aria-controls im geschlossenen Zustand: die Suchleiste entsteht
           erst beim Öffnen (openCalendarSearch), und ein Verweis auf eine ID, die
           es noch nicht gibt, kündigt einem Screenreader ein Ziel an, das nicht
           existiert. Gesetzt wird es dort, wo die Leiste entsteht, und beim
           Schließen wieder entfernt - dieselbe Regel wie in utils/sub-tabs.js:
           ohne aufgelöstes Ziel bleibt das Attribut weg. -->
      <button class="btn btn--icon cal-toolbar__search-btn" id="cal-search"
              aria-label="${t('calendar.searchOpen')}" title="${t('calendar.searchOpen')}"
              aria-expanded="false">
        <i data-lucide="search" aria-hidden="true"></i>
      </button>
      <button class="btn btn--primary toolbar-new-btn" id="cal-add" aria-label="${t('calendar.addEvent')}">
        <i data-lucide="plus" aria-hidden="true"></i>
        <span class="toolbar-new-btn__label">${t('newLabel.calendar')}</span>
      </button>
    </div>
    <!-- Bar-Zeile des Kopfs (Werkzeugzeilen-Regel, layout.css): das Ansichts-
         Segment hatte im Actions-Slot bei 1280px 212px fuer 245px Inhalt -
         "Agenda" lag hinter dem Fade und das Monatslabel daneben ellipsierte
         auf seine 7ch-Untergrenze. Der neutrale Wrapper haelt das Well des
         Segments auf intrinsischer Breite; die Zeile gehoert trotzdem ihm. -->
    <div class="page-toolbar__bar">
      <div class="cal-toolbar__views" role="tablist" aria-label="${t('nav.calendar')}">
        ${VIEWS.map((v) => `
          <button class="cal-toolbar__view-btn ${v === state.view ? 'cal-toolbar__view-btn--active' : ''}"
                  role="tab" id="cal-view-tab-${v}" data-tab-id="${v}"
                  aria-selected="${v === state.view ? 'true' : 'false'}"
                  ${v === state.view ? 'aria-controls="cal-body"' : ''}
                  tabindex="${v === state.view ? '0' : '-1'}">${VIEW_LABELS()[v]}</button>
        `).join('')}
      </div>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: bar });

  updateLabel();

  bar.querySelector('#cal-prev').addEventListener('click', () => navigate(-1));
  bar.querySelector('#cal-next').addEventListener('click', () => navigate(1));
  bar.querySelector('#cal-today').addEventListener('click', goToday);
  bar.querySelector('#cal-add').addEventListener('click', () => openEventModal({ mode: 'create', date: newEventDate() }));
  bar.querySelector('#cal-search').addEventListener('click', openCalendarSearch);
  bar.querySelector('#cal-filters').addEventListener('click', openCalendarFilters);

  // EIN wireScrollFade auf diesem Element, nicht zwei.
  //
  // Es stand hier oben UND unten am Tablist-Block - beide Male auf
  // `.cal-toolbar__views`, beide Rueckgabewerte verworfen. Der Helfer ist
  // nicht idempotent (utils/ux.js): jeder Aufruf haengt einen Scroll-Listener,
  // einen ResizeObserver und einen MutationObserver mit `subtree: true` an.
  // `renderToolbar()` laeuft bei jedem Filterwechsel erneut, also wuchs die
  // Zahl der Beobachter mit der Benutzung. Der Aufruf gehoert an den Ort, an
  // dem auch die Tablist verdrahtet wird - dort steht er jetzt, einmal.
  wireScrollFade(bar.querySelector('.cal-toolbar__views'));
  viewTabs = wireTablist(bar.querySelector('.cal-toolbar__views'), {
    activeId: state.view,
    activeClass: 'cal-toolbar__view-btn--active',
    onChange: async (view) => {
      if (searchActive) closeCalendarSearch({ restoreView: false });
      state.view = view;
      setSavedCalendarView(view);
      await reloadForView();
      updateLabel();
      renderView();
    },
  });
}

function updateLabel() {
  const lbl = _container.querySelector('#cal-label');
  if (!lbl) return;
  const d    = new Date(state.cursor + 'T00:00:00');
  const year = d.getFullYear();
  const mon  = MONTH_NAMES()[d.getMonth()];

  if (state.view === 'month')  lbl.textContent = `${mon} ${year}`;
  if (state.view === 'week') {
    // Mobil zeigt die "Woche" ein 3-Tage-Fenster um den Cursor (renderWeekView);
    // ein "KW 30"-Label würde dann einen Bereich behaupten, der nicht zu sehen
    // ist (Audit A1-19). Das Label nennt stattdessen den sichtbaren Bereich.
    lbl.textContent = window.matchMedia(MOBILE_MEDIA_QUERY).matches
      ? t('calendar.dayRangeLabel', { from: formatDayMonth(addDays(state.cursor, -1)), to: formatPreferredDate(addDays(state.cursor, 1)) })
      : t('calendar.weekNumberLabel', { week: getWeekNumber(state.cursor), month: mon, year });
  }
  if (state.view === 'day')    lbl.textContent = formatDate(state.cursor, { weekday: true, long: true });
  if (state.view === 'agenda') lbl.textContent = t('calendar.agendaFrom', { date: formatDate(state.cursor) });

  syncTodayButton();
  syncViewPanel();
}

/**
 * DER KOERPER IST DAS PANEL DER TABLEISTE - EINES, NICHT VIER.
 *
 * Die Leiste trug `role="tablist"` mit vier `role="tab"`, aber es gab kein
 * `role="tabpanel"` im Dokument und kein `aria-controls`: fuer einen
 * Screenreader endete die Beziehung beim Tab, und was er umschaltet, stand
 * nirgends.
 *
 * Der geteilte Helfer `syncTabPanels` (utils/sub-tabs.js) passt hier nicht,
 * und das ist kein Versehen: er verwaltet N Panels und versteckt die
 * inaktiven per `hidden`. Der Kalender hat EIN `#cal-body`, dessen INHALT bei
 * jedem Wechsel ersetzt wird - es gibt kein zweites Panel zum Verstecken. Die
 * Beziehung ist deshalb umgekehrt gerichtet: das Panel nennt den Tab, der es
 * gerade beschriftet, und nur der aktive Tab traegt `aria-controls`. Ein
 * inaktiver Tab, der auf dasselbe Panel zeigt, waere die Zusage, dass es
 * SEINEN Inhalt enthaelt - und die ist falsch.
 */
function syncViewPanel() {
  const body = _container?.querySelector('#cal-body');
  if (!body) return;
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', `cal-view-tab-${state.view}`);

  for (const btn of _container.querySelectorAll('.cal-toolbar__view-btn')) {
    if (btn.dataset.tabId === state.view) btn.setAttribute('aria-controls', 'cal-body');
    else btn.removeAttribute('aria-controls');
  }
}

/**
 * „HEUTE" ERSCHEINT NUR, WENN HEUTE NICHT ZU SEHEN IST.
 *
 * Ein Knopf, der an den aktuellen Zeitraum zurueckfuehrt, ist sinnlos, solange
 * man dort steht - Apple Kalender und Fantastical blenden ihn genau dann aus.
 * Hier ist er ausserdem die Gegenmassnahme zu `flex-basis: 0` am Center-Slot
 * (layout.css): der engere Slot kappt das Zeitraum-Label sonst auf seine
 * 7ch-Untergrenze, und die 66px dieses Knopfes sind genau die, die fehlen.
 *
 * `hidden` STATT ENTFERNEN, und das ist der Punkt: der Slot behaelt seine
 * Basis 0 und bleibt in der Titelzeile, egal ob der Knopf da ist. Die
 * KOPFHOEHE springt beim Navigieren damit nicht - nur die Labelbreite aendert
 * sich. Ein Kopf, der beim Blaettern seine Hoehe wechselt, waere derselbe
 * Fehler, den die kollabierende Leiste mit ihrem negativen `top` vermeidet.
 *
 * Die Frage „ist heute zu sehen" beantwortet der ANGEZEIGTE BEREICH, nicht
 * eine Fallunterscheidung je Ansicht: `getRangeForView` kennt ihn fuer alle
 * vier, und eine zweite Rechnung daneben waere die naechste Stelle, an der
 * Monat und Agenda auseinanderlaufen.
 */
function syncTodayButton() {
  const btn = _container.querySelector('#cal-today');
  if (!btn) return;
  const { from, to } = getRangeForView(state.view, state.cursor);
  btn.hidden = state.today >= from && state.today <= to;
}

function getWeekNumber(dateStr) {
  // ISO-8601: Woche 1 enthält den ersten Donnerstag des Jahres; Wochen beginnen
  // montags. Verhindert die Off-by-one-Abweichung des naiven Jan-1-Ansatzes an
  // Jahresgrenzen.
  const d = new Date(dateStr + 'T00:00:00');
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mo=0 … So=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // Donnerstag dieser Woche
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 86400000));
}

async function navigate(dir) {
  if (searchActive) closeCalendarSearch({ restoreView: false });
  if (state.view === 'month') {
    state.cursor = addMonths(state.cursor, dir);
  } else if (state.view === 'week') {
    const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    state.cursor = addDays(state.cursor, dir * (isMobile ? 3 : 7));
  } else if (state.view === 'day') {
    state.cursor = addDays(state.cursor, dir);
  } else if (state.view === 'agenda') {
    state.cursor = addDays(state.cursor, dir * 30);
  }
  await reloadForView();
  updateLabel();
  renderView();
}

async function goToday() {
  if (searchActive) closeCalendarSearch({ restoreView: false });
  state.cursor = state.today;
  await reloadForView();
  updateLabel();
  renderView();
}

/**
 * Drill-in aus einer Tageszelle - EINE NAVIGATION, KEINE EINSTELLUNG.
 *
 * Hier stand `setSavedCalendarView('day')`. Eine Geste, die „zeig mir diesen
 * Tag" meint, schrieb damit still die STANDARDANSICHT des Kalenders um: wer
 * dreimal auf eine Monatszelle tippte, oeffnete den Kalender fortan in der
 * Tagesansicht und bekam dafuer weder eine Rueckmeldung noch einen Rueckweg -
 * verifiziert, `yuvomi:calendar:view` stand nach einem Tap auf `"day"` und
 * ueberlebte den Reload.
 *
 * `state.view` und `viewTabs.sync` wechseln die Ansicht fuer die Sitzung, und
 * genau das ist gemeint. Gespeichert wird die Ansicht nur dort, wo der Nutzer
 * sie WAEHLT: im `onChange` der Tablist.
 */
async function switchToDayView(date) {
  state.cursor = date;
  state.view = 'day';
  viewTabs?.sync('day');
  await reloadForView();
  updateLabel();
  renderView();
}

async function reloadForView() {
  const { from, to } = getRangeForView(state.view, state.cursor);
  // A navigation is a newer selection even when its range is already cached.
  // This invalidates an in-flight response for the range just left.
  calendarLoads.invalidate();

  if (from !== state.rangeFrom || to !== state.rangeTo) {
    await loadRange(from, to);
  }
}

// --------------------------------------------------------
// Ansicht-Dispatcher
// --------------------------------------------------------

// Dezenter Offline-Hinweis oberhalb der Toolbar: zeigt den letzten Cache-Stand,
// wenn der Kalender offline aus dem Service-Worker-Cache bedient wurde.
function updateOfflineNotice() {
  const page = _container?.querySelector('#calendar-page');
  if (!page) return;
  const existing = page.querySelector('#cal-offline-notice');

  if (!state.offlineSince) {
    existing?.remove();
    return;
  }

  const stamp = `${formatPreferredDate(state.offlineSince)} ${formatTime(state.offlineSince)}`.trim();
  const label = t('offline.staleData', { time: stamp });

  if (existing) {
    const span = existing.querySelector('.cal-offline-notice__text');
    if (span) span.textContent = label;
    return;
  }

  const toolbar = page.querySelector('#cal-toolbar');
  const html = `
    <div class="cal-offline-notice" id="cal-offline-notice" role="status">
      <i data-lucide="cloud-off" class="icon-sm" aria-hidden="true"></i>
      <span class="cal-offline-notice__text">${esc(label)}</span>
    </div>`;
  if (toolbar) toolbar.insertAdjacentHTML('beforebegin', html);
  else page.insertAdjacentHTML('afterbegin', html);
  if (window.lucide) lucide.createIcons({ el: page.querySelector('#cal-offline-notice') });
}

// --------------------------------------------------------
// Monatszellen-Kapazität (Audit P2)
// --------------------------------------------------------

// Render-Puffer je Zelle; wie viele Chips sichtbar bleiben, entscheidet
// fitMonthDayCells aus der realen Zellhöhe. Der Deckel begrenzt nur das DOM an
// extrem vollen Tagen (>14 Items) - "+N" zählt via data-total trotzdem korrekt.
const MONTH_DAY_MAX_CHIPS = 14;

/**
 * Den Deckel aus dem gelesenen Custom-Property-Wert bestimmen.
 *
 * Eigene Funktion, weil hier drei Werte dasselbe bedeuten muessen: der leere
 * String (Property nirgends gesetzt), '0' (Basiswert von .month-grid) und
 * alles Unlesbare - alle drei heissen "kein Deckel". Als Ausdruck inline stand
 * das dreimal nicht da, und `parseInt('') > 0` ist NaN > 0, also genau der
 * stille Fall, der ohne diese Funktion niemand pruefen kann.
 */
function monthDayVisibleCap(raw) {
  const n = parseInt(raw, 10);
  return n > 0 ? n : Infinity;
}

let _monthGridResizeObserver = null;
let _monthFitRaf = 0;

// Sichtbare Chip-Zahl je Monatszelle aus der REALEN Zellhöhe ableiten. Weil
// grid-auto-rows:1fr die Zellhöhe inhaltsunabhängig macht (per Grid verteilt,
// variiert mit dem Viewport), ist die Messung stabil: Chips zu verstecken ändert
// die Zellhöhe nicht. Der letzte Platz bleibt immer für die "+N"-Zeile reserviert,
// damit nie ein Chip mittig abschneidet (vorher: festes Budget=3 clippte still).
function fitMonthDayCells(grid) {
  if (!grid) return;

  // DREI PHASEN STATT EINER SCHLEIFE MIT LESE-/SCHREIB-WECHSEL. Vorher lief je
  // Zelle Schreiben → Messen → Schreiben → Messen, über bis zu 42 Zellen also
  // mehrere erzwungene Reflows pro Durchlauf (Audit 2026-08-31, der eine
  // Thrash-Kandidat der Codebase). Jetzt schreiben alle Zellen zuerst ihren
  // Messzustand, dann misst EIN Layoutlauf alles, dann fallen die
  // Entscheidungen. Die "+N"-Zeile darf dafür vorab sichtbar sein: sie steht
  // NACH den Chips und verschiebt deren Unterkanten nicht, und ihre Höhe ist
  // einzeilig textunabhängig - die Endzustände sind mit der alten Fassung
  // identisch (leer/fitsAll → Zeile versteckt und geleert).
  const cells = [];
  for (const cell of grid.querySelectorAll('.month-day')) {
    const chips   = [...cell.querySelectorAll('.month-day__holiday, .month-day__event, .cal-task-chip')];
    const moreRow = cell.querySelector('.month-day__more');
    if (!moreRow) continue;
    const total = Number(cell.dataset.total) || chips.length;

    // Reset auf vollständig sichtbar für eine stabile Messung.
    chips.forEach((c) => c.classList.remove('is-clipped'));
    moreRow.hidden = !chips.length;
    moreRow.textContent = chips.length ? t('calendar.moreEvents', { count: total }) : '';
    if (chips.length) cells.push({ cell, chips, moreRow, total });
  }

  // Der Deckel kommt aus dem Stylesheet, nicht aus einer zweiten Breitenabfrage
  // hier: in der Titelfassung stehen hoechstens vier Zeilen, sonst entscheidet
  // weiter allein die Zellhoehe (0/leer = kein Deckel). Wo die Grenze liegt,
  // weiss die Media Query, die auch die Zeilenhoehe setzt - ein zweites
  // `matchMedia` daneben waere dieselbe Zahl an einer zweiten Stelle. EIN
  // Lesezugriff fuers ganze Gitter, in der Messphase: er teilt sich den
  // erzwungenen Reflow mit den Zellmessungen darunter.
  const maxVisible = monthDayVisibleCap(getComputedStyle(grid).getPropertyValue('--month-day-max-visible'));

  // Messphase: der erste Zugriff erzwingt EINEN Reflow, der Rest liest mit.
  for (const item of cells) {
    const cs        = getComputedStyle(item.cell);
    item.cellBottom = item.cell.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom);
    item.reserved   = item.cellBottom - item.moreRow.getBoundingClientRect().height;
    item.bottoms    = item.chips.map((c) => c.getBoundingClientRect().bottom);
  }

  for (const { chips, moreRow, total, bottoms, cellBottom, reserved } of cells) {
    // Passt alles rein (inkl. evtl. nicht gerenderter Überzähliger) UND unter den
    // Deckel? Dann fertig. Ohne die zweite Frage traete der Fall "fuenf Termine,
    // Zelle hoch genug fuer fuenf" hier durch und zeigte fuenf Zeilen ohne "+N" -
    // der Deckel muss auf BEIDEN Wegen greifen, nicht nur im Klipp-Zweig.
    const fitsAll = total <= chips.length && total <= maxVisible
      && bottoms[bottoms.length - 1] <= cellBottom;
    if (fitsAll) {
      moreRow.hidden = true;
      moreRow.textContent = '';
      continue;
    }

    // Platz für die "+N"-Zeile freihalten (einzeilig, Höhe unabhängig von N).
    let visible = 0;
    for (const bottom of bottoms) {
      if (bottom <= reserved) visible += 1;
      else break;
    }
    visible = Math.max(1, Math.min(visible, maxVisible)); // nie ganz leer wirken lassen

    chips.forEach((chip, i) => chip.classList.toggle('is-clipped', i >= visible));
    const hiddenCount = total - visible;
    if (hiddenCount > 0) {
      moreRow.textContent = t('calendar.moreEvents', { count: hiddenCount });
    } else {
      moreRow.hidden = true;
      moreRow.textContent = '';
    }
  }
}

// Neurechnung per rAF drosseln: der ResizeObserver kann beim Fensterziehen
// mehrfach pro Frame feuern; ein fit pro Frame reicht.
function scheduleMonthFit(grid) {
  if (_monthFitRaf) return;
  _monthFitRaf = requestAnimationFrame(() => {
    _monthFitRaf = 0;
    fitMonthDayCells(grid);
  });
}

// --------------------------------------------------------
// Direct calendar manipulation
// --------------------------------------------------------

/*
 * Gesture handling is delegated from the document because renderView replaces
 * the grid on every preview frame and while period auto-navigation is loading.
 * The active gesture stores the source event and civil range, so DOM replacement
 * never changes what is being edited.
 */
function ensureCalendarGestureListeners() {
  if (_calendarGestureListeners) return;
  _calendarGestureListeners = true;

  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest?.('[data-session-complete], [data-session-reopen]')) return;
    const element = calendarEventElement(event.target);
    const source = eventFromElement(element);
    if (!element || !source || state.view === 'agenda') return;

    if (source.task_id && !canPlanTaskSessions()) return;
    const handle = event.target.closest?.('[data-resize-edge]');
    const action = handle ? 'resize' : 'move';
    const sourceRange = eventRange(source);
    if (!sourceRange) return;
    // Month cells expose horizontal handles for all-day spans. Timed events
    // have no meaningful month-grid edge to resize, so keep those handles
    // inert while allowing inclusive all-day date resizing.
    if (action === 'resize' && gestureViewForElement(element) === 'month' && !sourceRange.allDay) return;
    if (!isEditAllowed(source, action)) {
      showCalendarEditBlocked(source);
      return;
    }

    const allDaySpan = gestureIsAllDaySpan(element);
    const timeColumn = element.closest('.week-view__col, .day-view__col');
    const scrollElement = element.closest('.week-view__scroll, .day-view__scroll');
    _activeCalendarGesture = {
      pointerId: event.pointerId,
      source,
      sourceRange,
      element,
      action,
      edge: handle?.dataset.resizeEdge || null,
      allDaySpan,
      startX: event.clientX,
      startY: event.clientY,
      hourHeight: measuredHourHeight(timeColumn),
      scrollElement,
      startScrollTop: scrollElement?.scrollTop || 0,
      grabOffsetMinutes: gestureGrabOffset(event, element, sourceRange, allDaySpan),
      started: false,
      range: sourceRange,
      target: null,
      periodLoading: false,
    };
    element.setPointerCapture?.(event.pointerId);
  }, { capture: true });

  document.addEventListener('pointermove', (event) => {
    const gesture = _activeCalendarGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const moved = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= 4;
    if (!gesture.started && !moved) return;
    if (!gesture.started) {
      gesture.started = true;
      _suppressCalendarClickUntil = Date.now() + 500;
      gesture.element.classList.add('is-calendar-dragging');
      document.body.classList.add('is-calendar-gesture');
    }

    const target = calendarDropTarget(event);
    gesture.lastPointer = { clientX: event.clientX, clientY: event.clientY };
    updateGesturePreview(gesture, target, gesture.lastPointer);
    updateGestureEdge(event);
    updateGestureAutoScroll(event);
    event.preventDefault();
  }, { capture: true });

  document.addEventListener('pointerup', (event) => {
    const gesture = _activeCalendarGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    finishCalendarGesture(gesture);
  }, { capture: true });

  document.addEventListener('pointercancel', (event) => {
    const gesture = _activeCalendarGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    cancelCalendarGesture(gesture);
  }, { capture: true });

  document.addEventListener('click', (event) => {
    if (Date.now() >= _suppressCalendarClickUntil) return;
    // Suppress the click generated by a completed drag so the source event
    // does not open its detail sheet. A recurring drag opens its scope modal
    // on pointerup, though, and a fast Cancel must remain clickable.
    if (!event.target.closest?.('#calendar-page')
        || event.target.closest?.('.modal-overlay, [role="dialog"]')) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && _activeCalendarGesture) {
      event.preventDefault();
      cancelCalendarGesture(_activeCalendarGesture);
    }
  }, { capture: true });
}

function calendarEventElement(target) {
  return target?.closest?.('[data-calendar-direct-event], [data-task-session]') || null;
}

function eventFromElement(element) {
  const id = element?.dataset?.id;
  if (id == null) return null;
  return state.events.find((event) => String(event.id) === String(id)) || null;
}

function gestureViewForElement(element) {
  if (element?.closest('.month-view')) return 'month';
  if (element?.closest('.week-view')) return 'week';
  if (element?.closest('.day-view')) return 'day';
  return state.view;
}

function gestureIsAllDaySpan(element) {
  return Boolean(element?.closest('.month-day, .allday-cell'));
}

function showCalendarEditBlocked(event) {
  const reason = editBlockReason(event);
  window.yuvomi?.showToast(
    t('calendar.editReadOnly', { reason: reason || t('calendar.editReadOnlyReason') }),
    'warning',
  );
}

function gestureGrabOffset(event, element, range, allDaySpan) {
  if (allDaySpan) {
    const cell = element.closest('.month-day, .allday-cell');
    const cellDate = cell?.dataset?.date;
    return cellDate && range.startDate
      ? Math.max(0, dayDifference(range.startDate, cellDate)) * 24 * 60
      : 0;
  }
  const rect = element.getBoundingClientRect();
  const height = measuredHourHeight(element.closest('.week-view__col, .day-view__col') || element.parentElement);
  if (!height || !Number.isFinite(rect.top)) return 0;
  const minutes = ((event.clientY - rect.top) / height) * 60;
  return Math.max(0, Math.min(range.durationMinutes - CALENDAR_MIN_TIMED_MINUTES, minutes));
}

function calendarDropTarget(event) {
  if (!event) return null;
  const hovered = document.elementFromPoint(event.clientX, event.clientY);
  const monthDay = hovered?.closest?.('.month-day[data-date]');
  if (monthDay) return { kind: 'all-day', date: monthDay.dataset.date };

  const allDayCell = hovered?.closest?.('.allday-cell[data-date]');
  if (allDayCell) return { kind: 'all-day', date: allDayCell.dataset.date };

  const column = hovered?.closest?.('.week-view__col[data-date], .day-view__col[data-date]');
  if (!column) return null;
  const rect = column.getBoundingClientRect();
  const height = measuredHourHeight(column);
  if (!height) return null;
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const minutes = Math.min(
    24 * 60 - CALENDAR_SNAP_MINUTES,
    Math.max(0, Math.round((y / height) * 60 / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES),
  );
  const parts = civilParts(civilMinute(column.dataset.date, '00:00') + minutes);
  return { kind: 'grid', date: column.dataset.date, time: parts.time };
}

function updateGesturePreview(gesture, target = calendarDropTarget(gesture.lastPointer), pointer = gesture.lastPointer) {
  if (!gesture) return;
  gesture.target = target;
  const range = gestureRangeAtTarget(gesture, target, pointer);
  if (!range) return;
  gesture.range = range;
  state.dragPreview = { id: gesture.source.id, range };
  scheduleGestureRender();
}

function gestureRangeAtTarget(gesture, target, pointerEvent = null) {
  if (!target?.date) return null;
  if (gesture.action === 'resize') {
    let resizeTarget = target;
    if (!gesture.allDaySpan && target.kind === 'grid' && pointerEvent && gesture.hourHeight) {
      const currentScroll = _container?.querySelector('.week-view__scroll, .day-view__scroll');
      const scrollDelta = (currentScroll?.scrollTop || 0) - gesture.startScrollTop;
      const deltaMinutes = Math.round(
        (((pointerEvent.clientY - gesture.startY) + scrollDelta) / gesture.hourHeight) * 60 / CALENDAR_SNAP_MINUTES,
      ) * CALENDAR_SNAP_MINUTES;
      const anchor = gesture.edge === 'start'
        ? gesture.sourceRange.startMinute
        : gesture.sourceRange.endMinute;
      resizeTarget = { ...target, time: civilParts(anchor + deltaMinutes).time };
    }
    return resizeEventRange(gesture.source, gesture.edge, resizeTarget, { allDaySpan: gesture.allDaySpan });
  }
  const monthTimedMove = !gesture.sourceRange.allDay
    && (gesture.source.task_id || gestureViewForElement(gesture.element) === 'month')
    && target.kind === 'all-day';
  const moveTarget = monthTimedMove
    ? { ...target, kind: 'grid', time: gesture.sourceRange.startTime }
    : target;
  return moveEventRange(gesture.source, moveTarget, {
    // A timed event has no vertical month-grid coordinate, but a multi-day
    // timed event still has a meaningful horizontal segment offset. Keeping it
    // here makes a grabbed middle segment remain the segment under the pointer
    // after the month move while the original wall-clock time is preserved.
    grabOffsetMinutes: gesture.grabOffsetMinutes,
    targetKind: moveTarget.kind,
  });
}

function scheduleGestureRender() {
  if (_gestureRenderRaf) return;
  const renderFrame = () => {
    _gestureRenderRaf = 0;
    if (!_activeCalendarGesture || !state.dragPreview) return;
    renderView();
  };
  if (typeof requestAnimationFrame === 'function') {
    _gestureRenderRaf = requestAnimationFrame(renderFrame);
  } else {
    _gestureRenderRaf = setTimeout(renderFrame, 0);
  }
}

function clearGestureEdgeTimers() {
  if (_gestureEdgeTimer) clearTimeout(_gestureEdgeTimer);
  if (_gestureEdgeRepeat) clearInterval(_gestureEdgeRepeat);
  _gestureEdgeTimer = 0;
  _gestureEdgeRepeat = 0;
  _gestureEdgeDirection = 0;
}

function clearGestureScrollTimer() {
  if (_gestureScrollTimer) clearInterval(_gestureScrollTimer);
  _gestureScrollTimer = 0;
  _gestureScrollDirection = 0;
}

function clearGestureTimers() {
  clearGestureEdgeTimers();
  clearGestureScrollTimer();
}

function updateGestureEdge(event) {
  const page = _container?.querySelector('#calendar-page');
  if (!page || !_activeCalendarGesture?.started) return;
  const edge = 40;
  const rect = page.getBoundingClientRect();
  const direction = event.clientX <= rect.left + edge ? -1
    : event.clientX >= rect.right - edge ? 1
      : 0;
  if (direction === _gestureEdgeDirection) return;
  clearGestureEdgeTimers();
  if (!direction) {
    updateGestureNotice();
    return;
  }
  _gestureEdgeDirection = direction;
  _gestureEdgeTimer = setTimeout(() => {
    advanceGesturePeriod(direction);
    _gestureEdgeRepeat = setInterval(() => advanceGesturePeriod(direction), 700);
  }, 700);
  updateGestureNotice();
}

function updateGestureAutoScroll(event) {
  const scroll = _container?.querySelector('.week-view__scroll, .day-view__scroll');
  if (!scroll) {
    clearGestureScrollTimer();
    return;
  }
  const rect = scroll.getBoundingClientRect();
  const threshold = 48;
  const direction = event.clientY <= rect.top + threshold ? -1
    : event.clientY >= rect.bottom - threshold ? 1
      : 0;
  if (direction === _gestureScrollDirection) return;
  clearGestureScrollTimer();
  if (!direction) return;
  _gestureScrollDirection = direction;
  const scrollStep = () => {
    if (!_activeCalendarGesture?.started) return;
    scroll.scrollTop += direction * 18;
    const gesture = _activeCalendarGesture;
    if (gesture.lastPointer) updateGesturePreview(gesture);
  };
  scrollStep();
  _gestureScrollTimer = setInterval(scrollStep, 50);
}

async function advanceGesturePeriod(direction) {
  const gesture = _activeCalendarGesture;
  if (!gesture || gesture.periodLoading) return;
  gesture.periodLoading = true;
  if (state.view === 'month') state.cursor = addMonths(state.cursor, direction);
  else if (state.view === 'week') {
    const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    state.cursor = addDays(state.cursor, direction * (isMobile ? 3 : 7));
  } else if (state.view === 'day') state.cursor = addDays(state.cursor, direction);
  else {
    gesture.periodLoading = false;
    return;
  }
  try {
    await reloadForView();
    updateLabel();
    renderView();
    if (_activeCalendarGesture === gesture && gesture.lastPointer) {
      updateGesturePreview(gesture);
    }
  } finally {
    gesture.periodLoading = false;
  }
}

function updateGestureNotice() {
  const page = _container?.querySelector('#calendar-page');
  if (!page) return;
  let notice = page.querySelector('.calendar-drag-notice');
  if (!_activeCalendarGesture?.started || !_gestureEdgeDirection) {
    notice?.remove();
    return;
  }
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'calendar-drag-notice';
    notice.setAttribute('role', 'status');
    page.append(notice);
  }
  notice.textContent = _gestureEdgeDirection < 0
    ? t('calendar.dragNavigatePrevious')
    : t('calendar.dragNavigateNext');
}

function cancelCalendarGesture(gesture) {
  clearGestureTimers();
  gesture?.element?.classList.remove('is-calendar-dragging');
  document.body.classList.remove('is-calendar-gesture');
  state.dragPreview = null;
  _activeCalendarGesture = null;
  updateGestureNotice();
  if (gesture?.started) renderView();
}

async function finishCalendarGesture(gesture) {
  clearGestureTimers();
  gesture?.element?.classList.remove('is-calendar-dragging');
  document.body.classList.remove('is-calendar-gesture');
  _activeCalendarGesture = null;
  updateGestureNotice();
  if (!gesture?.started || !gesture.range || !gesture.target) {
    state.dragPreview = null;
    return;
  }
  state.dragPreview = null;
  renderView();

  const scope = isRecurringEvent(gesture.source)
    ? await recurringEditChoice(gesture.source)
    : 'series';
  if (!scope) return;
  await saveCalendarGesture(gesture, scope);
}

async function saveCalendarGesture(gesture, scope) {
  const body = directEditBody(gesture.source, gesture.range, { scope });
  if (!body) return;
  body.edit_action = gesture.action === 'move' ? 'move' : 'resize';
  try {
    const response = gesture.source.task_id
      ? await api.put(`/tasks/${gesture.source.task_id}/sessions/${gesture.source.id}`, { start_datetime: body.start_datetime, end_datetime: body.end_datetime, tzid: body.tzid, expected_revision: body.expected_revision })
      : await api.put('/calendar/' + gesture.source.id, body);
    const updated = responseEvent(response);
    if (updated) {
      const index = state.events.findIndex((event) => String(event.id) === String(updated.id));
      if (index !== -1) state.events[index] = updated;
    }
    let refreshError = null;
    try {
      await reloadCalendarEventsOnly({ throwOnError: true });
    } catch (error) {
      refreshError = error;
    }
    await refreshReminders();
    renderView();
    if (refreshError) {
      window.yuvomi?.showToast(t('calendar.loadError'), 'danger');
      return;
    }
    const sync = syncMetadata(updated || gesture.source);
    if (sync.state === 'error') {
      window.yuvomi?.showToast(t('calendar.syncError'), 'danger');
    } else if (sync.state === 'pending') {
      window.yuvomi?.showToast(t('calendar.syncPending'), 'warning');
    } else {
      window.yuvomi?.showToast(t('calendar.savedToast'), 'success');
    }
  } catch (error) {
    if (isConflictError(error)) {
      await handleCalendarConflict(gesture.source);
      return;
    }
    window.yuvomi?.showToast(error?.data?.error ?? t('calendar.saveError'), 'danger');
  }
}

async function handleCalendarConflict(event = null) {
  const retry = await confirmModal(t('calendar.editConflictTitle'), {
    detail: t('calendar.editConflictDetail'),
    confirmLabel: t('calendar.editConflictReload'),
  });
  if (retry) {
    const sync = syncMetadata(event);
    if (event?.id && sync.conflict && sync.operation_id) {
      await api.post('/calendar/' + event.id + '/reload-sync', {
        operation_id: sync.operation_id,
      });
    }
    await reloadCalendarEventsOnly();
    renderView();
  }
}

const RECOVERY_FIELD_LABELS = {
  title: 'calendar.titleLabel', description: 'calendar.descriptionLabel', location: 'calendar.locationLabel',
  start_datetime: 'calendar.startDateLabel', end_datetime: 'calendar.endDateLabel', all_day: 'calendar.allDay',
  recurrence_rule: 'rrule.labelRepeat',
  assigned_to: 'calendar.assignedLabel',
};

async function discardRecoveryChanges(event) {
  try {
    await api.post('/calendar/' + event.id + '/discard-recovery', {});
    await reloadCalendarEventsOnly({ throwOnError: true });
    renderView();
    window.yuvomi?.showToast(t('calendar.recoveryDiscarded'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(error?.data?.error ?? t('calendar.saveError'), 'danger');
  }
}

async function reviewRecoveryChanges(event) {
  try { event = responseEvent(await api.get('/calendar/' + event.id)) || event; } catch { /* retain the visible changes */ }
  const sync = syncMetadata(event);
  const recovery = sync.recovery || {};
  let original = null;
  if (recovery.parent_event_id) {
    try { original = responseEvent(await api.get('/calendar/' + recovery.parent_event_id)); } catch { /* deleted original remains reviewable as retained intent */ }
  }
  const entries = recovery.conflicts || [];
  const retained = Object.entries(recovery.retained_changes || {});
  const retainedAllDay = recovery.retained_changes?.all_day ?? event.all_day;
  const providerAllDay = recovery.authoritative?.all_day ?? original?.all_day ?? event.all_day;
  const value = (field, item, allDay) => {
    if (item === null || item === undefined || item === '') return t('calendar.recoveryEmpty');
    if (['start_datetime', 'end_datetime'].includes(field)) {
      return allDay ? formatDate(localDate(String(item))) : formatDateTime(String(item));
    }
    return String(item);
  };
  openSharedModal({
    title: t('calendar.recoveryReview'), size: 'sm',
    content: '<p>' + esc(entries.length ? t('calendar.recoveryConflict') : t('calendar.recoveryUnavailable')) + '</p>'
      + retained.map(([field, local]) => '<p><strong>' + esc(t(RECOVERY_FIELD_LABELS[field] || 'calendar.recoveryField'))
        + '</strong>: ' + esc(value(field, field === 'assigned_to' && Array.isArray(local)
          ? local.map((id) => state.users.find((user) => user.id === id)?.display_name || String(id)).join(', ') : local, retainedAllDay)) + '</p>').join('')
      + entries.map((entry, index) => '<fieldset class="form-group"><legend>'
        + esc(t(RECOVERY_FIELD_LABELS[entry.field] || 'calendar.recoveryField')) + '</legend>'
        + '<label><input type="radio" name="recovery-' + index + '" value="local"> '
        + esc(t('calendar.recoveryKeepLocal')) + ': ' + esc(value(entry.field, entry.local, retainedAllDay)) + '</label>'
        + '<label><input type="radio" name="recovery-' + index + '" value="provider"> '
        + esc(t('calendar.recoveryKeepProvider')) + ': ' + esc(value(entry.field, entry.provider, providerAllDay)) + '</label></fieldset>').join('')
      + '<p id="recovery-choice-error" role="alert"></p><div class="modal-actions modal-actions--stack">'
      + (entries.length ? '<button class="btn btn--primary" id="recovery-resolve">' + esc(t('common.save')) + '</button>' : '')
      + (original ? '<button class="btn btn--ghost" id="recovery-original">' + esc(t('calendar.recoveryOriginal')) + '</button>' : '')
      + '<button class="btn btn--danger" id="recovery-discard">' + esc(t('calendar.recoveryDiscard')) + '</button>'
      + '<button class="btn btn--ghost" id="recovery-cancel">' + esc(t('common.cancel')) + '</button></div>',
    onSave(panel) {
      panel.querySelector('#recovery-cancel')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('#recovery-original')?.addEventListener('click', async () => {
        await closeModal({ force: true }); await openEventDetail(original);
      });
      panel.querySelector('#recovery-discard')?.addEventListener('click', async () => {
        await closeModal({ force: true }); await discardRecoveryChanges(event);
      });
      panel.querySelector('#recovery-resolve')?.addEventListener('click', async () => {
        const choices = {};
        for (const [index, entry] of entries.entries()) {
          const choice = panel.querySelector('input[name="recovery-' + index + '"]:checked')?.value;
          if (choice) choices[entry.field] = choice;
        }
        if (!Object.keys(choices).length) { panel.querySelector('#recovery-choice-error').textContent = t('calendar.recoveryChoose'); return; }
        try {
          await api.post('/calendar/' + event.id + '/resolve-recovery', { operation_id: sync.operation_id,
            choices, expected_revision: recovery.authoritative_revision });
          await closeModal({ force: true }); await reloadCalendarEventsOnly({ throwOnError: true }); renderView();
        } catch (error) { panel.querySelector('#recovery-choice-error').textContent = error?.data?.error ?? t('calendar.saveError'); }
      });
    },
  });
}

function recurringEditChoice(event) {
  const occDateKey = localDate(event?.start_datetime) || '';
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    };
    openSharedModal({
      title: t('calendar.editScopeTitle'),
      size: 'sm',
      content: '<div>'
        + renderRecurringScopeChooserForEvent('gesture-edit', occDateKey, event)
        + '<div class="modal-actions modal-actions--stack">'
        + '<button type="button" class="btn btn--primary" id="gesture-edit-confirm">'
        + t('common.save')
        + '</button><button type="button" class="btn btn--ghost" id="gesture-edit-cancel">'
        + t('common.cancel')
        + '</button></div></div>',
      onClose: () => finish(null),
      onSave(panel) {
        bindRecurringScopeChooser(panel, 'gesture-edit', event);
        panel.querySelector('#gesture-edit-confirm')?.addEventListener('click', () => finish(getRecurringScope(panel, 'gesture-edit')));
        panel.querySelector('#gesture-edit-cancel')?.addEventListener('click', () => finish(null));
      },
    });
  });
}

function renderView() {
  const body = _container.querySelector('#cal-body');
  if (!body) return;
  renderTaskPanel();
  /* Das Lesemass der Seite folgt der ANSICHT, denn hier wechselt der Koerper
   * seine Natur: die Agenda ist eine Zeilenliste und will die Lesebahn, das
   * Monatsgitter ist eine Flaeche und will die ganze Content-Spalte. Ein
   * fester Modifier stimmte in genau einer der vier Ansichten - dieselbe
   * Kopplung wie auf /tasks (Liste gegen Kanban), und derselbe Guard prueft
   * sie (Critique 2026-08-13, zweite Runde).
   *
   * DER KOPF TOGGELT NICHT MEHR MIT (2026-08-27): er steht ueber vier
   * Koerpern, drei davon full-bleed, und seit die Ansichts-Umschalter in der
   * Bar-Zeile wohnen (Werkzeugzeilen-Regel) kann seine volle Titelzeile im
   * 720er-Deckel der Agenda nicht einzeilig wohnen (Sonde 19: zwei Zeilen
   * bei 1280px). EIN Kopf, EINE Breite - er haelt die Kante seines
   * breitesten Koerpers; die Agenda-LISTE behaelt ihre Lesebahn. Der
   * Kanten-Guard kennt diese Bauart (test-frontend-audit: Lesemass-Toggle
   * am Koerper ohne Kopf-Toggle). */
  _container.querySelector('#calendar-page')
    ?.classList.toggle('is-reading-measure', state.view === 'agenda');
  // Monats-Resize-Observer lösen, bevor das alte #month-grid detached wird;
  // nur die Monatsansicht setzt ihn danach wieder auf.
  _monthGridResizeObserver?.disconnect();
  _monthGridResizeObserver = null;
  const preservedGestureScrollTop = _activeCalendarGesture?.started
    ? _container.querySelector('.week-view__scroll, .day-view__scroll')?.scrollTop
    : null;
  body.replaceChildren();

  // Vor allen vier Ansichten: nach einem Ladefehler sind Termine, Aufgaben und
  // Feiertage ebenfalls leer. Das Gitter waere dann von einem leeren Monat
  // nicht zu unterscheiden, die Agenda zeigte ihren Leerzustand.
  if (state.loadError) {
    mountLoadError(body, {
      title: t('calendar.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => { await loadRange(state.rangeFrom, state.rangeTo); renderView(); },
    });
    updateOfflineNotice();
    return;
  }

  // Tages-Buckets einmal pro Render-Pass aufbauen; danach wieder deaktivieren,
  // damit spätere State-Mutationen (Modals etc.) keinen veralteten Index lesen.
  buildDayIndex();
  try {
    if (state.view === 'month')  renderMonthView(body);
    if (state.view === 'week')   renderWeekView(body);
    if (state.view === 'day')    renderDayView(body);
    if (state.view === 'agenda') renderAgendaView(body);
  } finally {
    _dayIndex.active = false;
  }
  bindSessionCompletion(body);
  if (window.lucide) lucide.createIcons({ el: body });
  updateOfflineNotice();
  if (Number.isFinite(preservedGestureScrollTop)) {
    const nextScroll = _container.querySelector('.week-view__scroll, .day-view__scroll');
    if (nextScroll) nextScroll.scrollTop = preservedGestureScrollTop;
  }
}

// --------------------------------------------------------
// Monatsansicht
// --------------------------------------------------------

function renderMonthView(container) {
  const d      = new Date(state.cursor + 'T00:00:00');
  const year   = d.getFullYear();
  const month  = d.getMonth();

  // Erster Tag des Monats
  const firstDay  = new Date(year, month, 1);
  // Bis zum gewählten Wochenstart zurückgehen.
  const startOffset = (firstDay.getDay() - state.weekStart + 7) % 7;

  // 42 Tage anzeigen (6 Wochen)
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startOffset);

  const days = Array.from({ length: 42 }, (_, i) => {
    const dt = new Date(startDate);
    dt.setDate(startDate.getDate() + i);
    return { date: isoDate(dt), inMonth: dt.getMonth() === month };
  });

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="${monthViewClasses(state.monthTitles)}">
      <div class="month-weekdays">
        ${weekdayOrder(state.weekStart).map((idx) => `<div class="month-weekday">${DAY_NAMES_SHORT()[idx]}</div>`).join('')}
      </div>
      <div class="month-grid page-scrollport" id="month-grid">
        ${days.map(({ date, inMonth }) => renderMonthDay(date, inMonth)).join('')}
      </div>
    </div>
  `);

  const grid = container.querySelector('#month-grid');
  grid.addEventListener('click', (e) => {
    const dayEl = e.target.closest('.month-day');
    if (!dayEl) return;

    // Mobil ist die ganze Zelle EIN Drill-in-Ziel, und das bleibt es auch mit
    // Titelzeilen. DER GRUND IST DIE TAP-GROESSE, nicht die Chip-Form: hier
    // stand "die Chips sind dort zu Punkten reduziert", was ab dem
    // Titel-Schalter nur noch die halbe Wahrheit waere - eine 13px hohe
    // Titelzeile ist genauso weit unter den 44px, die ein Ziel am Finger
    // braucht, wie es der 10px-Punkt war. Ein Tap darf nie in einem
    // Event-Popup enden statt in der handlungsfaehigen Tagesansicht (P1).
    // Desktop behält die feinere Interaktion: Chip -> Ziel, Zelle -> Tag.
    const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    if (!isMobile) {
      const taskChip = e.target.closest('.cal-task-chip');
      if (taskChip) {
        e.stopPropagation();
        openTaskFromCalendar(taskChip.dataset.taskId);
        return;
      }
      const evEl = e.target.closest('.month-day__event');
      if (evEl) {
        e.stopPropagation();
        const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
        if (ev) openEventDetail(ev, evEl);
        return;
      }
    }
    switchToDayView(dayEl.dataset.date);
  });

  // Tastatur-Aktivierung der Tageszelle (role="button"): Enter/Space -> Tag.
  // Nur wenn der Fokus auf der Zelle selbst liegt; innere Chips tragen desktop
  // ihre eigene Semantik und werden hier nicht abgefangen (Audit P1).
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const dayEl = e.target.closest('.month-day');
    if (!dayEl || e.target !== dayEl) return;
    e.preventDefault();
    switchToDayView(dayEl.dataset.date);
  });

  // Sichtbare Kapazität je Zelle aus der realen Höhe ableiten und bei Viewport-
  // Änderungen (Fenster-Resize, Sidebar-Toggle) neu rechnen (Audit P2). Der
  // ResizeObserver feuert nach observe() initial einmal -> erster fit nach Paint.
  _monthGridResizeObserver?.disconnect();
  _monthGridResizeObserver = new ResizeObserver(() => scheduleMonthFit(grid));
  _monthGridResizeObserver.observe(grid);
  bindTaskSessionDrops(container);
}

/**
 * Klassen einer Monatszelle - eigene Funktion, weil hier der Wochentag über den
 * Tag selbst entschieden wird und nicht über seine Spalte im Raster. Die
 * Wochenend-Tönung hing früher an `:nth-child(7n)`/`7n-1` im CSS, was nur bei
 * Wochenstart Montag Sa/So traf: bei Sonntag-Start färbte sie Fr/Sa (#780).
 */
/**
 * Klassen der Monatsflaeche. Eigene Funktion aus demselben Grund wie
 * `monthDayClasses` daneben: die Entscheidung ist damit ohne DOM pruefbar
 * (`__test`), statt nur als Teilstring einer Template-Zeile zu existieren.
 *
 * Die Modifier-Klasse steht auf ALLEN Breiten, wenn der Schalter an ist - was
 * sie bewirkt, entscheidet allein das Stylesheet, und dort wohnt sie in der
 * 639er-Query. Sie hier zusaetzlich an ein `matchMedia` zu haengen, hiesse die
 * Schwelle ein zweites Mal zu fuehren; beim naechsten Breakpoint-Umbau liefen
 * die beiden auseinander, und genau diese Doppelung hat der Kalender 2026-08
 * schon einmal bezahlt (siehe MOBILE_MEDIA_QUERY).
 */
function monthViewClasses(monthTitles) {
  return ['month-view', monthTitles ? 'month-view--titles' : ''].filter(Boolean).join(' ');
}

function monthDayClasses(date, inMonth, todayKey = state.today) {
  return [
    'month-day',
    !inMonth            ? 'month-day--outside' : '',
    date === todayKey   ? 'month-day--today'   : '',
    isWeekendKey(date)  ? 'month-day--weekend' : '',
  ].filter(Boolean).join(' ');
}

function renderMonthDay(date, inMonth) {
  const evs      = eventsOnDay(date);
  const dayTasks = tasksOnDay(date);
  const dayHols  = holidaysOnDay(date);
  const daySchedule = scheduleEntriesOnDay(date);
  const isToday  = date === state.today;
  const classes  = monthDayClasses(date, inMonth);

  // Alle Chips (Feiertagsband, Termine, Aufgaben) bis zu einem großzügigen Puffer
  // ins DOM rendern; welche sichtbar bleiben, entscheidet fitMonthDayCells aus der
  // REALEN Zellhöhe (grid-auto-rows:1fr -> variiert mit dem Viewport). Zuvor kappte
  // ein festes Budget=3 blind: bei niedriger Zellhöhe schnitt die Zelle den letzten
  // Chip mittig ab, ohne "+N" (Audit A1-04 / P2). data-total trägt die Gesamtzahl,
  // damit "+N" auch die nicht gerenderten Überzähligen mitzählt. Reihenfolge
  // Feiertag -> Termin -> Aufgabe.
  const total     = dayHols.length + daySchedule.length + evs.length + dayTasks.length;
  const holShown  = dayHols.slice(0, MONTH_DAY_MAX_CHIPS);
  const evShown   = evs.slice(0, Math.max(0, MONTH_DAY_MAX_CHIPS - holShown.length));
  const taskShown = dayTasks.slice(0, Math.max(0, MONTH_DAY_MAX_CHIPS - holShown.length - evShown.length));

  const holHtml = holShown.map((h) => `
    <div class="month-day__holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
      <span>${esc(h.name)}</span>
    </div>
  `).join('');

  const scheduleHtml = daySchedule.map((entry) => `<div class="month-day__holiday schedule-entry" style="--holi-color:${esc(entry.shift_type.color)}" title="${esc(scheduleEntryTitle(entry))}"><span>${esc(scheduleEntryLabel(entry))}</span></div>`).join("");

  // Monatsgrid-Kanon (Apple Kalender / Fantastical): flache getönte Bar mit nur
  // dem Titel. Icon und Avatar-Stack leben in der Tages-/Detailansicht; die
  // "Wer"-Information bleibt für Tooltip/Screenreader im title-Attribut erhalten.
  const evHtml = evShown.map((ev) => `
    <div class="month-day__event"
         data-id="${ev.id}"
         ${ev.task_id ? 'data-task-session' : 'data-calendar-direct-event'}
         style="${eventSurfaceStyle(ev)}"
         title="${esc(ev.title)}${ev.cal_name ? ' · ' + esc(ev.cal_name) : ''}${chipAssigneeTitleSuffix(ev)}"
    >${renderSessionCheckbox(ev)}${renderEventAssigneeBar(ev)}<span class="calendar-resize-handle calendar-resize-handle--start" data-resize-edge="start" aria-hidden="true"></span>${calendarRepeatIconHtml(ev)}<span>${esc(ev.title)}</span><span class="calendar-resize-handle calendar-resize-handle--end" data-resize-edge="end" aria-hidden="true"></span></div>
  `).join('');

  const taskHtml = taskShown.map((tk) => renderTaskChip(tk, { interactive: false, icon: false })).join('');

  return `
    <div class="${classes}" data-date="${date}" data-total="${total}"
         role="button" tabindex="0"
         aria-label="${esc(monthDayAriaLabel(date, total, evs))}"${isToday ? ' aria-current="date"' : ''}>
      <div class="month-day__number">${new Date(date + 'T00:00:00').getDate()}</div>
      ${holHtml}
      ${scheduleHtml}
      ${evHtml}
      ${taskHtml}
      <div class="month-day__more" hidden></div>
    </div>
  `;
}

/**
 * Schichtplan-Eintraege tragen eine einzelne `user_id` statt `assigned_users` -
 * dieser Adapter spiegelt sie in dieselbe Form, damit `passesPersonFilters()`
 * (Termine, Aufgaben) unveraendert wiederverwendet werden kann, statt eine
 * zweite Personen-Filter-Logik nur fuer den Schichtplan zu pflegen.
 */
function scheduleAsAssignable(entry) {
  return { assigned_users: entry.user_id == null ? [] : [{ id: entry.user_id }] };
}

function scheduleEntriesOnDay(date) {
  return state.layerSchedule
    ? state.scheduleEntries.filter(
        (entry) => entry.date_key === date && entry.shift_type && passesPersonFilters(scheduleAsAssignable(entry))
      )
    : [];
}

/**
 * Ist der Schichtplan im Haushalt ueberhaupt eingeschaltet?
 *
 * `disabled_modules` heisst "dieses Modul gibt es hier nicht". Der Routen-Guard
 * schuetzt `/schedule` - der Kalender ist aber eine MISCHSTELLE: sein Pfad nennt
 * ein Modul, sein Inhalt kommt aus mehreren. Ohne diese Frage laedt und zeigt er
 * die Schichten eines abgeschalteten Moduls weiter, samt Ebenen-Knopf. Dasselbe
 * Muster wie in dashboard.js und recipes.js.
 */
function scheduleEnabled() { return !window.yuvomi?.isModuleDisabled?.('schedule'); }

function scheduleHasTimes(entry) { return Boolean(entry.shift_type?.start_time && entry.shift_type?.end_time); }

function scheduleOwnerName(entry) {
  const owner = state.users.find((user) => Number(user.id) === Number(entry.user_id));
  return owner?.display_name || owner?.username || "";
}

function scheduleEntryLabel(entry) {
  const shift = entry.shift_type.short_code || entry.shift_type.name;
  const owner = scheduleOwnerName(entry);
  return owner ? shift + " · " + owner : shift;
}

// Note plus jedes ueberlagerungssichtbare eigene Feld mit einem Wert (Migration
// 181) - dieselbe Berechnung wie schedule.js' overlayMeta(), hier eigenstaendig
// nachgebaut statt importiert: diese Datei haelt schon fuer jede andere
// Schichtplan-Anzeigeformel (scheduleTimeLabel, scheduleEntryLabel, ...) eine
// eigene, unabhaengige Kopie statt schedule.js komplett zu importieren.
function scheduleOverlayMeta(entry) {
  const overlayFields = (entry.shift_type?.fields ?? []).filter((field) => field.show_in_overlay && entry.field_values?.[field.id]);
  return [entry.note, ...overlayFields.map((field) => `${field.name}: ${entry.field_values[field.id]}`)].filter(Boolean).join(" · ");
}

function scheduleEntryTitle(entry) {
  const owner = scheduleOwnerName(entry);
  const time = scheduleTimeLabel(entry.shift_type);
  const extra = entry.source === 'extra' ? " · " + t('schedule.extraBadgeLabel') : "";
  const overlay = scheduleOverlayMeta(entry);
  return entry.shift_type.name + (owner ? " · " + owner : "") + (time ? " · " + time : "") + extra + (overlay ? " · " + overlay : "");
}

function scheduleIsFullDayShift(entry) {
  const type = entry.shift_type;
  return Boolean(type?.start_time && type?.end_time && type.start_time === type.end_time);
}

function scheduleTimeLabel(type) {
  if (!type.start_time || !type.end_time) return "";
  const crossesDay = type.end_time <= type.start_time;
  const fullDay = type.end_time === type.start_time;
  return type.start_time + "–" + type.end_time + (crossesDay ? " +1" : "") + (fullDay ? " · 24 h" : "");
}

// Additiv zu Muster/Override, nie ein Ersatz (server/routes/schedule-extras.js)
// - dieselbe Kennzeichnung wie in schedule.js/dashboard.js, damit Bereitschaft
// neben einer regulaeren Schicht auch in der Kalender-Ueberlagerung als
// ZUSAETZLICH erkennbar bleibt.
function scheduleEntryExtraBadge(entry) {
  return entry.source === 'extra' ? `<i data-lucide="layers" class="schedule-entry__extra-badge" aria-label="${esc(t('schedule.extraBadgeLabel'))}"></i>` : '';
}

function renderScheduleChip(entry, className = 'allday-holiday') {
  const type = entry.shift_type;
  const label = scheduleEntryLabel(entry);
  const start = type.start_time ? '<small class="schedule-entry__start">' + esc(type.start_time) + '</small>' : '';
  return `<div class="${className} schedule-entry" style="--holi-color:${esc(type.color)}" title="${esc(scheduleEntryTitle(entry))}"><span>${esc(label)}</span>${scheduleEntryExtraBadge(entry)}${start}</div>`;
}
/**
 * Zeit-Fenster eines Schichtplan-Blocks in Minuten seit Mitternacht - dieselbe
 * Dauer-Arithmetik wie zuvor inline in renderScheduleTimeBlock() (Mindestlaenge
 * 30 Min., Ende-vor-Start heisst "geht ueber Mitternacht"), jetzt eigenstaendig,
 * damit layoutScheduleBlocks() dieselbe Zeitspanne fuer die Ueberlappungs-Logik
 * kennt wie die Darstellung selbst.
 */
function scheduleBlockTimeRange(entry) {
  const type = entry.shift_type;
  const start = timeToMinutes(type.start_time);
  const end = timeToMinutes(type.end_time);
  const duration = Math.max((end > start ? end : 24 * 60) - start, 30);
  return { start, end: start + duration };
}

/**
 * Spalten-Position eines gelegten Blocks in CSS umrechnen - dieselbe Formel wie
 * renderWeekEvent()/renderDayEvent() fuer gewoehnliche Termine, aber mit den
 * Schichtplan-eigenen Aussenraendern (Woche: 2px beidseitig; Tag: 4px links /
 * 10px rechts, damit die Stunden-/Jetzt-Linie hinter dem Balken sichtbar bleibt).
 * Ohne Layout (Fallback) ergibt sich exakt der alte volle Balken (1 von 1 Spalte).
 */
function scheduleLaneStyle(layout, gutter) {
  const cols = layout?.totalCols ?? 1;
  const idx = layout?.colIndex ?? 0;
  return {
    left: `calc(${(idx / cols) * 100}% + ${gutter.left}px)`,
    width: `calc(${100 / cols}% - ${gutter.total}px)`,
  };
}

function renderScheduleTimeBlock(entry, className, layout = null) {
  const type = entry.shift_type;
  const start = timeToMinutes(type.start_time);
  const end = timeToMinutes(type.end_time);
  const duration = Math.max((end > start ? end : 24 * 60) - start, 30);
  const gutter = className === 'week-event' ? { left: 2, total: 4 } : { left: 4, total: 14 };
  const { left, width } = scheduleLaneStyle(layout, gutter);
  // Sichtbar statt nur im title: .schedule-time-block traegt pointer-events:none
  // (es ist eine Hintergrundflaeche, echte Termine malen darueber, siehe die
  // Begruendung an der Klasse in calendar.css) - ein Hover erreicht dieses
  // Element in der Praxis kaum je, der title blieb also meist ungelesen. Eine
  // DRITTE Zeile war bei den ueblichen 30-60-min-Bloecken (Wochenansicht, schmale
  // Spalte) nie zu sehen: Titel+Uhrzeit fuellten den Block schon als
  // unvorhersehbar umgebrochener Fliesstext, bevor eine eigene Meta-Zeile
  // ueberhaupt Platz gehabt haette. Jetzt zwei FESTE einzeilige Zeilen (Titel,
  // Uhrzeit+Feldwert zusammen) statt Fliesstext - das Feld faehrt auf der
  // Uhrzeit-Zeile mit, statt eine eigene zu brauchen, und wird selbst dort per
  // Ellipse gekuerzt statt spurlos unter der Blockkante zu verschwinden.
  const overlay = scheduleOverlayMeta(entry);
  const time = esc(scheduleTimeLabel(type));
  const timeLine = overlay ? `${time} · ${esc(overlay)}` : time;
  return `<div class="${className} schedule-time-block" style="top:${hourOffset(start)};height:calc(${hourOffset(duration)} - 4px);left:${left};width:${width};--ev-color:${esc(type.color)}" title="${esc(scheduleEntryTitle(entry))}"><span class="schedule-time-block__title">${esc(scheduleEntryLabel(entry))}${scheduleEntryExtraBadge(entry)}</span><small class="schedule-time-block__time">${timeLine}</small></div>`;
}

// aria-label der Tageszelle: lokalisiertes Datum + (falls vorhanden) Zahl der
// Einträge und die Serieninformation, die das Label sonst an seinen als
// praesentational behandelten Kind-Chips verschlucken würde. Leere Tage tragen
// nur das Datum (die role sagt "Schaltfläche"). P1.
function monthDayAriaLabel(date, total, events = []) {
  const d = formatPreferredDate(date);
  const recurringTitles = events
    .filter((event) => event?.recurrence_rule || event?.is_recurring_instance)
    .map((event) => event.title)
    .filter(Boolean);
  return [
    d,
    total > 0 ? t('calendar.monthDayEntries', { count: total }) : '',
    ...recurringTitles.map((title) => `${t('calendar.recurringEvent')}: ${title}`),
  ].filter(Boolean).join(', ');
}

// --------------------------------------------------------
// Wochenansicht
// --------------------------------------------------------

function renderWeekView(container) {
  const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  // Auf Mobile: 3-Tage-Fenster zentriert um state.cursor statt vollem Mo–So
  const days = isMobile
    ? Array.from({ length: 3 }, (_, i) => addDays(state.cursor, i - 1))
    : (() => {
        const weekStart = startOfWeekOf(state.cursor);
        return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
      })();
  const colCount = days.length;

  const alldayEvs = days.map((d) =>
    eventsOnDay(d).filter(isAllDayLike)
  );
  const timedEvs = days.map((d) =>
    eventsOnDay(d).filter((e) => !isAllDayLike(e))
  );
  const layouts = timedEvs.map((events) => layoutOverlaps(events));
  const schedule = days.map((d) => scheduleEntriesOnDay(d));
  const scheduleChips = schedule.map((items) => state.scheduleDisplay === 'compact' ? items : items.filter((entry) => !scheduleHasTimes(entry) || scheduleIsFullDayShift(entry)));
  const scheduleBlocks = schedule.map((items) => state.scheduleDisplay === 'blocks' ? items.filter((entry) => scheduleHasTimes(entry) && !scheduleIsFullDayShift(entry)) : []);
  const scheduleLayouts = scheduleBlocks.map((items) => layoutScheduleBlocks(items));

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="week-view">
      <div class="week-view__header" id="week-header"
           style="display:grid;grid-template-columns:var(--cal-gutter-width) repeat(${colCount},1fr);">
        <div class="week-view__time-gutter"></div>
        ${days.map((d) => {
          const dt = new Date(d + 'T00:00:00');
          return `<div class="week-view__day-header" data-date="${d}">
            <div class="week-view__day-name">${DAY_NAMES_SHORT()[dt.getDay()]}</div>
            <div class="week-view__day-num ${d === state.today ? 'week-view__day-num--today' : ''}">${dt.getDate()}</div>
          </div>`;
        }).join('')}
      </div>
      <!-- Ganztägige Ereignisse -->
      <div class="allday-row" style="display:grid;grid-template-columns:var(--cal-gutter-width) repeat(${colCount},1fr);">
        <div class="calendar-all-day-label">${t('calendar.allDayShort')}</div>
        ${days.map((d, i) => `
          <div class="allday-cell" data-date="${d}">
            ${holidaysOnDay(d).map((h) => `
              <div class="allday-holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
                <span>${esc(h.name)}</span>
              </div>
            `).join('')}
            ${scheduleChips[i].map((entry) => renderScheduleChip(entry)).join('')}
            ${alldayEvs[i].map((ev) => `
              <div class="allday-event" data-id="${ev.id}" ${ev.task_id ? 'data-task-session' : 'data-calendar-direct-event'}
                   style="${eventSurfaceStyle(ev)}"
                   title="${esc(ev.title)}${ev.cal_name ? ' · ' + esc(ev.cal_name) : ''}${chipAssigneeTitleSuffix(ev)}">${renderSessionCheckbox(ev)}${renderEventAssigneeBar(ev)}<span class="calendar-resize-handle calendar-resize-handle--start" data-resize-edge="start" aria-hidden="true"></span>${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}${calendarRepeatIconHtml(ev)}<span>${esc(ev.title)}</span>${chipAssigneeStack(ev, { size: 16, maxVisible: 3 })}<span class="calendar-resize-handle calendar-resize-handle--end" data-resize-edge="end" aria-hidden="true"></span></div>
            `).join('')}
            ${tasksOnDay(d).map(renderTaskChip).join('')}
          </div>
        `).join('')}
      </div>
      <div class="week-view__scroll page-scrollport" id="week-scroll">
        <div class="week-view__body">
          <div class="week-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot">
                <span class="week-view__time-label">${h === 0 ? '' : formatTime(`${pad(h)}:00`)}</span>
              </div>
            `).join('')}
          </div>
          <div class="week-view__columns" id="week-cols"
               style="display:grid;grid-template-columns:repeat(${colCount},1fr);">
            ${days.map((d, i) => `
              <div class="week-view__col" data-date="${d}">
                ${Array.from({ length: 24 }, (_, h) => `
                  <div class="week-view__hour-line" style="top:${hourOffset(h * 60)};"></div>
                `).join('')}
                ${scheduleBlocks[i].map((entry) => renderScheduleTimeBlock(entry, 'week-event', scheduleLayouts[i].get(entry))).join('')}
                ${timedEvs[i].map((ev) => renderWeekEvent(ev, layouts[i].get(ev.id))).join('')}
                ${d === state.today ? `<div class="week-view__now-line" id="now-line" style="top:${hourOffset(nowMinutes())};"></div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `);

  // Event-Delegation
  container.querySelector('#week-header').addEventListener('click', (e) => {
    const header = e.target.closest('.week-view__day-header[data-date]');
    if (header) switchToDayView(header.dataset.date);
  });

  container.querySelector('#week-cols').addEventListener('click', (e) => {
    if (e.target.closest('.schedule-time-block')) return;
    const evEl = e.target.closest('.week-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
      return;
    }
    const col = e.target.closest('[data-date]');
    if (col) {
      const time = clickedTime(e, col);
      openEventModal({ mode: 'create', date: col.dataset.date, time });
    }
  });

  container.querySelector('.allday-row').addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      openTaskFromCalendar(taskChip.dataset.taskId);
      return;
    }
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
    }
  });

  bindTaskSessionDrops(container);
  // Scrollen zu aktueller Zeit
  scrollToHour(container.querySelector('#week-scroll'), container.querySelector('.week-view__body'));
}

/**
 * Setzt einen Zeitraster-Scroller auf die aktuelle Stunde, gemessen an der
 * Gesamthoehe des 24-Stunden-Koerpers statt an einer zweiten Stundenzahl in JS.
 */
function scrollToHour(scroll, body) {
  if (!scroll || !body) return;
  const hourHeight = body.getBoundingClientRect().height / 24;
  scroll.scrollTop = Math.max(0, nowFields().hour * hourHeight - 80);
}

function renderWeekEvent(ev, layout = null) {
  const { start, end } = timeRangeForEvent(ev);
  const duration = Math.max(end - start, 30);

  const top    = hourOffset(start);
  const height = `calc(${hourOffset(duration)} - 2px)`;
  const left = layout ? `calc(${(layout.colIndex / layout.totalCols) * 100}% + 2px)` : '2px';
  const width = layout ? `calc(${100 / layout.totalCols}% - 4px)` : 'auto';

  return `
    <div class="week-event" data-id="${ev.id}" ${ev.task_id ? 'data-task-session' : 'data-calendar-direct-event'}
         style="top:${top};height:${height};left:${left};width:${width};${eventSurfaceStyle(ev)}"
         title="${esc(ev.title)}${chipAssigneeTitleSuffix(ev)}">
      ${renderSessionCheckbox(ev)}${renderEventAssigneeBar(ev)}
      <span class="calendar-resize-handle calendar-resize-handle--start" data-resize-edge="start" aria-hidden="true"></span><div class="week-event__title">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}${calendarRepeatIconHtml(ev)}<span>${esc(ev.title)}</span>${chipAssigneeStack(ev, { size: 14, maxVisible: 2 })}</div>
      <div class="week-event__time">${formatTime(ev.start_datetime)}${ev.end_datetime ? '–' + formatTime(ev.end_datetime) : ''}</div>
      <span class="calendar-resize-handle calendar-resize-handle--end" data-resize-edge="end" aria-hidden="true"></span>
    </div>
  `;
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Addiert eine Minutendauer auf eine Datum/Zeit-Kombination und trägt den
 * Überlauf über Mitternacht auf das Datum über.
 * @returns {{ date: string, time: string }} lokaler Datums-Key (YYYY-MM-DD) + HH:MM
 */
function addDurationToDateTime(dateKey, timeStr, minutes) {
  const total    = timeToMinutes(timeStr) + Math.max(0, minutes);
  const dayShift = Math.floor(total / (24 * 60));
  const dayMins  = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    date: dayShift ? addDays(dateKey, dayShift) : dateKey,
    time: `${pad(Math.floor(dayMins / 60))}:${pad(dayMins % 60)}`,
  };
}

/** Minuten seit Mitternacht - der Bezug jeder Now-Linie. */
function nowMinutes() {
  // Die Uhr des Haushalts (#829 Teil 3): sonst steht die Jetzt-Linie auf einem
  // Geraet in einer anderen Zone um deren Offset daneben - im selben Raster, in
  // dem die Termine bereits der Haushaltszone folgen.
  const { hour, minute } = nowFields();
  return hour * 60 + minute;
}

/** Berechnet die geklickte Uhrzeit (auf 15-Minuten gerundet) aus einem Click-Event
 *  relativ zum übergebenen Spalten-Element. Die Stundenhöhe wird an der Spalte
 *  gemessen (sie ist immer 24 Stunden hoch), nicht aus einer Zahl in dieser Datei
 *  gelesen - so stimmt der Treffer auch in der dichteren Tagesansicht. */
function clickedTime(e, colEl) {
  const rect = colEl.getBoundingClientRect();
  const hourHeight = measuredHourHeight(colEl);
  if (!hourHeight) return '09:00';
  const yOffset = Math.max(0, e.clientY - rect.top);
  const totalMinutes = Math.round((yOffset / hourHeight) * 60 / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES;
  const clamped = Math.min(Math.max(totalMinutes, 0), 24 * 60 - CALENDAR_SNAP_MINUTES);
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

function timeRangeForEvent(ev) {
  const start = timeToMinutes(localTime(ev.start_datetime));
  const end = ev.end_datetime
    ? timeToMinutes(localTime(ev.end_datetime))
    : start + 60;
  return {
    start,
    end: Math.max(end, start + 30),
  };
}

// Gruppiert sich ueberlappende Eintraege (per `rangeFn` bestimmt) in Cluster,
// innerhalb derer sie sich Spalten teilen muessen - unabhaengig von der Frage,
// WAS ein Eintrag ist (Termin oder Schichtplan-Block). Haelfte-offen: ein
// Eintrag, der genau dort endet, wo der naechste beginnt, ueberlappt nicht.
function overlapGroups(items, rangeFn) {
  const groups = [];
  const sorted = [...items].sort((a, b) => {
    const aRange = rangeFn(a);
    const bRange = rangeFn(b);
    return aRange.start - bRange.start || aRange.end - bRange.end;
  });

  let current = [];
  let currentEnd = -1;
  for (const item of sorted) {
    const range = rangeFn(item);
    if (!current.length || range.start < currentEnd) {
      current.push(item);
      currentEnd = current.length === 1 ? range.end : Math.max(currentEnd, range.end);
    } else {
      groups.push(current);
      current = [item];
      currentEnd = range.end;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

// Weist jedem Eintrag innerhalb seiner Ueberlappungs-Gruppe eine Spalte zu.
// `keyFn` bestimmt den Map-Schluessel: Termine haben eine stabile `id`, aber
// Schichtplan-Eintraege nicht zwingend (Muster-Eintraege tragen nur
// pattern_id+position) - und zwei Eintraege koennen legitim denselben Schichttyp
// und dieselbe Zeit an einem Tag teilen (Muster + Extra-Schicht). Deshalb liefert
// layoutScheduleBlocks() unten das Eintrags-Objekt selbst als Schluessel: jede
// sichtbare Instanz bekommt ihren eigenen Platz, auch bei inhaltsgleichen Werten.
function assignLanes(items, rangeFn, keyFn) {
  const layout = new Map();
  for (const group of overlapGroups(items, rangeFn)) {
    const columns = [];
    const placements = [];
    for (const item of group) {
      const range = rangeFn(item);
      let colIndex = columns.findIndex((end) => end <= range.start);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(range.end);
      } else {
        columns[colIndex] = range.end;
      }
      placements.push({ item, colIndex });
    }
    const totalCols = Math.max(columns.length, 1);
    for (const placement of placements) {
      layout.set(keyFn(placement.item), {
        colIndex: placement.colIndex,
        totalCols,
      });
    }
  }
  return layout;
}

function layoutOverlaps(events) {
  return assignLanes(events, timeRangeForEvent, (ev) => ev.id);
}

// Schichtplan-Gegenstueck zu layoutOverlaps(): gleiche Spalten-Arithmetik, aber
// ueber scheduleBlockTimeRange() (Zeiten aus shift_type statt aus start/end_datetime)
// und mit dem Eintrags-Objekt selbst als Schluessel statt einer ID (siehe assignLanes).
function layoutScheduleBlocks(entries) {
  return assignLanes(entries, scheduleBlockTimeRange, (entry) => entry);
}

// --------------------------------------------------------
// Tagesansicht
// --------------------------------------------------------

function renderDayView(container) {
  const dt      = new Date(state.cursor + 'T00:00:00');
  const dayEvs  = eventsOnDay(state.cursor);
  const allday  = dayEvs.filter(isAllDayLike);
  const timed   = dayEvs.filter((e) => !isAllDayLike(e));
  const layout = layoutOverlaps(timed);
  const schedule = scheduleEntriesOnDay(state.cursor);
  const scheduleChips = state.scheduleDisplay === 'compact' ? schedule : schedule.filter((entry) => !scheduleHasTimes(entry) || scheduleIsFullDayShift(entry));
  const scheduleBlocks = state.scheduleDisplay === 'blocks' ? schedule.filter((entry) => scheduleHasTimes(entry) && !scheduleIsFullDayShift(entry)) : [];
  const scheduleLayout = layoutScheduleBlocks(scheduleBlocks);

  container.replaceChildren();
  // Kein eigener Datums-Header mehr: die Toolbar zeigt exakt dasselbe Datum
  // bereits als Ansichts-Label (Audit A1-18).
  container.insertAdjacentHTML('beforeend', `
    <div class="day-view">
      ${(allday.length || scheduleChips.length || tasksOnDay(state.cursor).length || holidaysOnDay(state.cursor).length) ? `
      <div class="allday-row" style="display:grid;grid-template-columns:var(--cal-gutter-width) 1fr;">
        <div class="calendar-all-day-label">${t('calendar.allDayShort')}</div>
        <div class="allday-cell" data-date="${state.cursor}">
          ${holidaysOnDay(state.cursor).map((h) => `
            <div class="allday-holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
              <span>${esc(h.name)}</span>
            </div>
          `).join('')}
          ${scheduleChips.map((entry) => renderScheduleChip(entry)).join('')}
          ${allday.map((ev) => `
            <div class="allday-event" data-id="${ev.id}" ${ev.task_id ? 'data-task-session' : 'data-calendar-direct-event'}
                 style="${eventSurfaceStyle(ev)}"
                 title="${esc(ev.title)}${ev.cal_name ? ' · ' + esc(ev.cal_name) : ''}${chipAssigneeTitleSuffix(ev)}">${renderSessionCheckbox(ev)}${renderEventAssigneeBar(ev)}<span class="calendar-resize-handle calendar-resize-handle--start" data-resize-edge="start" aria-hidden="true"></span>${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}${calendarRepeatIconHtml(ev)}<span>${esc(ev.title)}</span>${chipAssigneeStack(ev, { size: 16, maxVisible: 3 })}<span class="calendar-resize-handle calendar-resize-handle--end" data-resize-edge="end" aria-hidden="true"></span></div>`).join('')}
          ${tasksOnDay(state.cursor).map(renderTaskChip).join('')}
        </div>
      </div>` : ''}
      <div class="day-view__scroll page-scrollport" id="day-scroll">
        <div class="day-view__body">
          <div class="day-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot">
                <span class="week-view__time-label">${h === 0 ? '' : formatTime(`${pad(h)}:00`)}</span>
              </div>
            `).join('')}
          </div>
          <div class="day-view__col" data-date="${state.cursor}" id="day-col">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__hour-line" style="top:${hourOffset(h * 60)};"></div>
            `).join('')}
            ${scheduleBlocks.map((entry) => renderScheduleTimeBlock(entry, 'day-event', scheduleLayout.get(entry))).join('')}
            ${timed.map((ev) => renderDayEvent(ev, layout.get(ev.id))).join('')}
            ${dayEvs.length === 0 && schedule.length === 0 ? `<div class="day-view__empty-hint" style="top:calc(${hourOffset(state.cursor === state.today ? nowMinutes() : 9 * 60)} + 16px)">${t('calendar.dayEmptyHint')}</div>` : ''}
          </div>
          ${state.cursor === state.today ? `
            <div class="day-view__now-line" aria-hidden="true" style="top:${hourOffset(nowMinutes())};"></div>
            <div class="day-view__now-dot" aria-hidden="true" style="top:${hourOffset(nowMinutes())};"></div>
          ` : ''}
        </div>
      </div>
    </div>
  `);

  container.querySelector('.allday-row')?.addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      openTaskFromCalendar(taskChip.dataset.taskId);
      return;
    }
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
    }
  });

  container.querySelector('#day-col').addEventListener('click', (e) => {
    if (e.target.closest('.schedule-time-block')) return;
    const evEl = e.target.closest('.day-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
      return;
    }
    const time = clickedTime(e, e.currentTarget);
    openEventModal({ mode: 'create', date: state.cursor, time });
  });

  bindTaskSessionDrops(container);
  scrollToHour(container.querySelector('#day-scroll'), container.querySelector('.day-view__body'));
}

/**
 * Ein Termin im Tagesraster: flacher Tint-Balken mit Farbspine.
 *
 * DIE GRAMMATIK GILT FUER JEDEN TERMIN ODER FUER KEINEN. Im Mockup trug genau
 * ein Event weder Spine noch Toenung (Screenshot 05) - hier kann das nicht
 * passieren, weil beide aus derselben `--ev-color` fallen, die
 * `resolveEventColor()` immer beantwortet (Ebene, Kalender oder App-Akzent).
 *
 * Die Zeit-/Ortszeile erscheint erst ab einer Stunde Dauer: darunter bleibt im
 * 40px-Raster nur Platz fuer den Titel, und eine angeschnittene zweite Zeile
 * ist schlechter als keine.
 */
function renderDayEvent(ev, layout = null) {
  const { start, end } = timeRangeForEvent(ev);
  const duration = Math.max(end - start, 30);
  const roomy = duration >= 60;

  const top    = hourOffset(start);
  const height = `calc(${hourOffset(duration)} - 4px)`;
  const cols   = layout?.totalCols ?? 1;
  const idx    = layout?.colIndex ?? 0;
  // Links 4px, rechts 10px: der Balken laesst die Zeitachse an beiden Raendern
  // stehen, damit Stunden- und Now-Linie sichtbar hinter ihm weiterlaufen.
  const left  = `calc(${(idx / cols) * 100}% + 4px)`;
  const width = `calc(${100 / cols}% - 14px)`;

  const place = ev.location ? ` · ${esc(fmtLocation(ev.location))}` : '';
  const timeText = `${formatTime(ev.start_datetime)}${ev.end_datetime ? '–' + formatTime(ev.end_datetime) : ''}`;

  return `
    <div class="day-event${roomy ? '' : ' day-event--tight'}" data-id="${ev.id}" ${ev.task_id ? 'data-task-session' : 'data-calendar-direct-event'}
         style="top:${top};height:${height};left:${left};width:${width};${eventSurfaceStyle(ev)}"
         title="${esc(ev.title)}${ev.location ? ' · ' + esc(fmtLocation(ev.location)) : ''}${chipAssigneeTitleSuffix(ev)}">
      ${renderSessionCheckbox(ev)}${renderEventAssigneeBar(ev)}
      <span class="calendar-resize-handle calendar-resize-handle--start" data-resize-edge="start" aria-hidden="true"></span><span class="day-event__spine" aria-hidden="true"></span>
      <span class="day-event__text">
        <span class="day-event__title">${hasEventIcon(ev.icon) ? eventIconHtml(ev.icon, 'event-icon event-icon--compact') : ''}${calendarRepeatIconHtml(ev)}<span class="day-event__name">${esc(ev.title)}</span></span>
        ${roomy ? `<span class="day-event__meta">${timeText}${place}</span>` : ''}
      </span>
      ${roomy ? chipAssigneeStack(ev, { size: 20, maxVisible: 2 }) : ''}
      <span class="calendar-resize-handle calendar-resize-handle--end" data-resize-edge="end" aria-hidden="true"></span>
    </div>
  `;
}

// --------------------------------------------------------
// Agenda-Ansicht
// --------------------------------------------------------

function renderAgendaView(container) {
  const { from, to } = getAgendaRange(state.cursor);
  const days = Array.from({ length: 31 }, (_, i) => addDays(from, i));

  /* HEUTE WIRD NICHT STILL UEBERSPRUNGEN.
   *
   * Die Agenda listet nur Tage, an denen etwas steht - richtig fuer die
   * naechsten Wochen, falsch fuer den ersten. Der Kopf kuendigt „Ab
   * 28.08.2026" an, und die erste Zeile war der 29.: der Tag, nach dem
   * gefragt wird, fehlte genau dann, wenn die Antwort „nichts" lautet - und
   * ein fehlender Tag sieht aus wie ein Ladefehler, nicht wie ein freier Tag.
   * Die CSS-Regel `agenda-day__header--today` gab es laengst, sie konnte nur
   * nie feuern.
   *
   * NUR HEUTE, und nur wenn heute im Bereich liegt. Jeder leere Tag als Zeile
   * waere eine Liste aus Leere; „heute" ist der eine Tag, dessen Abwesenheit
   * eine Frage offen laesst. */
  const todayInRange = state.today >= from && state.today <= to;

  const groups = days
    .map((d) => ({ date: d, events: eventsOnDay(d), tasks: tasksOnDay(d), holidays: holidaysOnDay(d), schedule: scheduleEntriesOnDay(d) }))
    .filter((g) => g.events.length > 0 || g.tasks.length > 0 || g.holidays.length > 0 || g.schedule.length > 0
      || (todayInRange && g.date === state.today));

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="agenda-view page-scrollport" id="agenda-view">
      ${groups.length === 0
        ? emptyStateHTML({
          icon: 'calendar-plus',
          title: t('calendar.agendaEmpty'),
          action: { label: t('calendar.newEvent'), attrs: { id: 'agenda-empty-cta' } },
        })
        : groups.map(({ date, events, tasks, holidays, schedule }) => `
          <div class="agenda-day">
            <!-- Tageskopf als echte Ueberschrift (Critique 2026-08-10):
                 /calendar hatte genau EIN h-Element im ganzen Dokument. -->
            <h2 class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
              <span class="agenda-day__date">${formatDate(date)}</span>
              <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
            </h2>
            ${holidays.length ? `<div class="agenda-holidays">${holidays.map((h) => `
              <div class="agenda-holiday" style="--holi-color:${esc(h.color)}">
                <span class="agenda-holiday__dot"></span>
                <span>${esc(h.name)}</span>
              </div>`).join('')}</div>` : ''}
            ${schedule.length ? `<div class="agenda-holidays">${schedule.map((entry) => renderScheduleChip(entry, 'agenda-holiday')).join('')}</div>` : ''}
            ${events.length ? `<div class="list-rows">${events.map((ev) => renderAgendaEvent(ev, date)).join('')}</div>` : ''}
            ${tasks.length ? `<div class="agenda-tasks">${tasks.map(renderTaskChip).join('')}</div>` : ''}
            ${(!events.length && !tasks.length && !holidays.length && !schedule.length)
              ? `<p class="agenda-day__empty">${t('calendar.agendaDayEmpty')}</p>` : ''}
          </div>
        `).join('')
      }
    </div>
  `);

  stagger(container.querySelectorAll('.agenda-event'));

  container.querySelector('#agenda-view').addEventListener('click', (e) => {
    if (e.target.closest('#agenda-empty-cta')) {
      openEventModal({ mode: 'create', date: newEventDate() });
      return;
    }
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      openTaskFromCalendar(taskChip.dataset.taskId);
      return;
    }
    const evEl = e.target.closest('.agenda-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
    }
  });

  // Tastaturaktivierung der als role="button" ausgezeichneten Zeilen (Enter/Space).
  container.querySelector('#agenda-view').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const evEl = e.target.closest('.agenda-event');
    if (!evEl) return;
    e.preventDefault();
    const ev = state.events.find((x) => x.id === parseInt(evEl.dataset.id, 10));
    if (ev) openEventDetail(ev, evEl);
  });
}

// --------------------------------------------------------
// Termin-Suche (#471)
// Datumsunabhängiges Finden über den FTS-Index (Titel/Beschreibung/Ort).
// Eine Leiste unter der Toolbar; der Body zeigt eine chronologische Trefferliste
// (Vergangenheit + Zukunft) mit „Heute"-Anker. Klick öffnet den Termin im Kontext.
// --------------------------------------------------------

// --------------------------------------------------------
// Filter-Blatt
//
// DER ORT, AN DEM DIE EBENEN WOHNEN - und der Grund, warum sie umgezogen sind.
//
// Bis 2026-08-28 standen bis zu fuenf Ebenen-Schalter als Chips im Modulkopf.
// Gemessen kostete das eine eigene Kopfzeile (56px = 6,6% der Viewporthoehe
// auf 390px), und unter 640px verloren die Chips ihr Label: uebrig blieben
// 48px-Kreise, von denen einer nur einen 8px-Punkt enthielt. Ihr An/Aus-
// Zustand war eine Flaeche von 1,085:1 in Light - die `--active`-Regel, die
// ihn tragen sollte, setzte dieselbe Kante wie der Ruhezustand und war damit
// ein No-op. Vier der fuenf hatten kein `aria-pressed`; fuer einen
// Screenreader war die Ebene zustandslos.
//
// Ein Blatt loest alle drei Befunde mit einem Bauteil: die Schalter bekommen
// ihre Beschriftung zurueck, ihr Zustand ist eine echte Checkbox statt einer
// Waschung, und der Kopf gibt eine Zeile her.
//
// Source colors and assignee colors are independent; filtering keeps its
// existing layer and people controls.
// --------------------------------------------------------

/** Die Ebenen, die es im aktuellen Zustand ueberhaupt gibt. */
function availableLayers() {
  const hp = state.holidayPrefs ?? {};
  const rows = [];
  if (hp.holiday_show_public) {
    rows.push({
      key: 'holidays', label: t('calendar.toggleHolidays'),
      checked: state.layerHolidays, color: hp.holiday_public_color ?? HOLIDAY_PUBLIC_FALLBACK,
    });
  }
  if (hp.holiday_show_school) {
    rows.push({
      key: 'school', label: t('calendar.toggleSchool'),
      checked: state.layerSchool, color: hp.holiday_school_color ?? HOLIDAY_SCHOOL_FALLBACK,
    });
  }
  if (scheduleEnabled()) {
    rows.push({
      key: 'schedule', label: t('schedule.overlay'),
      checked: state.layerSchedule, color: null,
    });
  }
  // Der Geburtstags-Schalter braucht hier keine „gibt es welche?"-Bedingung
  // mehr: im Blatt kostet eine Zeile keine Kopfzeile, und ein Schalter, der
  // je nach Datenlage verschwindet, ist im Blatt schwerer zu finden als eine
  // Zeile, die immer an derselben Stelle steht.
  rows.push({
    key: 'birthdays', label: t('calendar.toggleBirthdays'),
    checked: state.layerBirthdays, color: null,
  });
  return rows;
}

/** Initialen einer Person - dieselbe Bildung wie im Avatar-Stack. */
function personInitials(name) {
  return String(name ?? '')
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function openCalendarFilters() {
  const layers = availableLayers();
  const people = state.users ?? [];

  const layerRows = layers.map((row) => toggleRowHtml({
    label: row.label,
    checked: row.checked,
    swatchColor: row.color,
    attrs: { 'data-filter-layer': row.key },
  })).join('');

  // Der Anzeigemodus des Schichtplans ist KEIN Filter - er nimmt nichts weg,
  // er zeigt dasselbe anders. Er steht trotzdem hier, weil er im Kopf als
  // Text-Chip neben den Ebenen hing und dort dieselbe Zeile kostete; im Blatt
  // hat er als beschrifteter Schalter zum ersten Mal einen Zustand, den man
  // ablesen kann statt ihn aus der Knopfbeschriftung zu erschliessen (der
  // Chip hiess „Volle Bloecke", wenn er sie NICHT zeigte).
  const scheduleDisplayRow = scheduleEnabled() ? toggleRowHtml({
    label: t('schedule.fullBlocks'),
    checked: state.scheduleDisplay === 'blocks',
    attrs: { 'data-filter-schedule-display': 'true' },
  }) : '';

  // NUR AM TELEFON, denn nur dort gibt es die zweite Fassung: ab 640px zeigt
  // die Monatszelle ohnehin Titel, und der Schalter waere ein Bedienelement
  // ohne Wirkung - die Zeile wuerde etwas versprechen, das die Ansicht schon
  // tut. Das Blatt wird beim Oeffnen gebaut, die Zeile richtet sich also nach
  // der Breite in diesem Moment; wer waehrend des offenen Blattes dreht,
  // sieht sie beim naechsten Oeffnen.
  const monthTitlesRow = window.matchMedia(MOBILE_MEDIA_QUERY).matches ? toggleRowHtml({
    label: t('calendar.toggleMonthTitles'),
    checked: state.monthTitles,
    attrs: { 'data-filter-month-titles': 'true' },
  }) : '';

  const meRow = (people.length > 1 && state.currentUserId != null)
    ? toggleRowHtml({
      label: t('calendar.assignedToMe'),
      checked: state.assignedToMe,
      attrs: { 'data-filter-mine': 'true' },
    })
    : '';

  const personRows = people.map((u) => toggleRowHtml({
    label: u.display_name ?? '',
    // Leeres Set heisst ALLE - die Haekchen stehen dann auf „an", weil genau
    // das der sichtbare Zustand ist. Wer das erste abwaehlt, waehlt damit die
    // uebrigen aus; das ist die Lesart, die Apple in derselben Liste hat.
    checked: state.people.size === 0 || state.people.has(u.id),
    // ZWEI NAMEN FUER DIESELBE FARBE, und das ist kein Tippfehler in einer
    // der beiden Quellen: `/auth/users` liefert die Spalte roh als
    // `avatar_color`, waehrend `assigned_users` sie im JSON auf `color`
    // umbenennt (services/calendar-events.js:17). Wer nur einen der beiden
    // Namen liest, bekommt an einer der beiden Stellen `undefined` - hier
    // stand zuerst `u.color` und die Scheiben blieben in jeder Zeile leer.
    swatchColor: u.avatar_color ?? u.color ?? null,
    swatchLabel: personInitials(u.display_name),
    attrs: { 'data-filter-person': String(u.id) },
  })).join('');

  const content = `
    <div class="cal-filters">
      ${layerRows ? `
        <section class="cal-filters__group">
          <h3 class="cal-filters__heading">${t('calendar.filtersLayers')}</h3>
          ${layerRows}
        </section>
      ` : ''}
      ${(meRow || personRows) ? `
        <section class="cal-filters__group">
          <h3 class="cal-filters__heading">${t('calendar.filtersPeople')}</h3>
          ${meRow}
          ${personRows}
        </section>
      ` : ''}
      ${(scheduleDisplayRow || monthTitlesRow) ? `
        <section class="cal-filters__group">
          <h3 class="cal-filters__heading">${t('calendar.filtersDisplay')}</h3>
          ${scheduleDisplayRow}
          ${monthTitlesRow}
        </section>
      ` : ''}
      <button type="button" class="btn btn--secondary cal-filters__reset" id="cal-filters-reset">
        ${t('calendar.filtersReset')}
      </button>
    </div>
  `;

  openSharedModal({ title: t('calendar.filters'), content, size: 'sm', initialFocus: 'none' });

  const panel = document.querySelector('#shared-modal-overlay .modal-panel');
  if (!panel) return;

  const LAYER_STATE = {
    holidays:  ['layerHolidays',  LAYER_HOLIDAYS_KEY],
    school:    ['layerSchool',    LAYER_SCHOOL_KEY],
    schedule:  ['layerSchedule',  LAYER_SCHEDULE_KEY],
    birthdays: ['layerBirthdays', LAYER_BIRTHDAYS_KEY],
  };

  panel.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;

    const layerKey = input.dataset.filterLayer;
    if (layerKey && LAYER_STATE[layerKey]) {
      const [field, storageKey] = LAYER_STATE[layerKey];
      state[field] = input.checked;
      try { localStorage.setItem(storageKey, input.checked ? 'true' : 'false'); } catch {}
    } else if (input.dataset.filterScheduleDisplay) {
      state.scheduleDisplay = input.checked ? 'blocks' : 'compact';
      try { localStorage.setItem(SCHEDULE_DISPLAY_KEY, state.scheduleDisplay); } catch {}
    } else if (input.dataset.filterMonthTitles) {
      state.monthTitles = input.checked;
      try { localStorage.setItem(MONTH_TITLES_KEY, input.checked ? 'true' : 'false'); } catch {}
    } else if (input.dataset.filterMine) {
      state.assignedToMe = input.checked;
      try { localStorage.setItem(ASSIGNED_TO_ME_KEY, input.checked ? '1' : '0'); } catch {}
    } else if (input.dataset.filterPerson) {
      const id = Number(input.dataset.filterPerson);
      // Der Sprung aus „alle" heraus: das erste Abwaehlen macht aus dem leeren
      // Set die Menge der UEBRIGEN. Ohne diesen Schritt haette ein Klick auf
      // ein Haekchen, das „alle" bedeutet, gar nichts getan.
      if (state.people.size === 0) {
        for (const u of state.users ?? []) state.people.add(u.id);
      }
      if (input.checked) state.people.add(id);
      else state.people.delete(id);
      // Wieder ALLE gewaehlt heisst wieder „kein Filter" - sonst bliebe ein
      // Filter aktiv, der nichts wegnimmt, und der Zaehler am Knopf loege.
      if (state.people.size === (state.users ?? []).length) state.people.clear();
      persistPeopleFilter();
    } else {
      return;
    }

    renderToolbar();
    renderView();
  });

  panel.querySelector('#cal-filters-reset')?.addEventListener('click', () => {
    state.layerHolidays = true;
    state.layerSchool = true;
    state.layerSchedule = true;
    state.layerBirthdays = true;
    state.assignedToMe = false;
    state.people.clear();
    try {
      localStorage.setItem(LAYER_HOLIDAYS_KEY, 'true');
      localStorage.setItem(LAYER_SCHOOL_KEY, 'true');
      localStorage.setItem(LAYER_SCHEDULE_KEY, 'true');
      localStorage.setItem(LAYER_BIRTHDAYS_KEY, 'true');
      localStorage.setItem(ASSIGNED_TO_ME_KEY, '0');
    } catch {}
    persistPeopleFilter();
    closeModal({ force: true });
    renderToolbar();
    renderView();
  });
}

/**
 * Der gespeicherte Personenfilter, GEGEN DEN HAUSHALT GEPRUEFT.
 *
 * Eine gespeicherte ID, die es nicht mehr gibt (Mitglied entfernt), waere ein
 * Filter, den kein Haekchen im Blatt mehr zurueckstellen kann: der Kalender
 * bliebe leer, das Blatt zeigte lauter aktive Haekchen, und der Zaehler am
 * Knopf naennte einen Filter ohne sichtbare Ursache. Deshalb faellt jede
 * unbekannte ID beim Laden weg - und wenn danach alle oder keine uebrig sind,
 * ist es wieder „alle", also gar kein Filter.
 */
function restorePeopleFilter(users) {
  const known = new Set((users ?? []).map((u) => u.id));
  let stored;
  try { stored = JSON.parse(localStorage.getItem(PEOPLE_FILTER_KEY) ?? '[]'); } catch { stored = []; }
  if (!Array.isArray(stored)) return new Set();
  const valid = stored.map(Number).filter((id) => known.has(id));
  if (valid.length === 0 || valid.length === known.size) return new Set();
  return new Set(valid);
}

function persistPeopleFilter() {
  try {
    if (state.people.size === 0) localStorage.removeItem(PEOPLE_FILTER_KEY);
    else localStorage.setItem(PEOPLE_FILTER_KEY, JSON.stringify([...state.people]));
  } catch {}
}

function openCalendarSearch() {
  if (searchActive) {
    _container.querySelector('#cal-search-input')?.focus();
    return;
  }
  const toolbar = _container.querySelector('#cal-toolbar');
  if (!toolbar) return;
  searchActive  = true;
  searchQuery   = '';
  searchResults = [];

  const toggle = _container.querySelector('#cal-search');
  toggle?.setAttribute('aria-expanded', 'true');
  // Erst jetzt gibt es ein Ziel, also erst jetzt der Verweis darauf.
  toggle?.setAttribute('aria-controls', 'cal-search-bar');
  toggle?.classList.add('cal-toolbar__search-btn--active');

  toolbar.insertAdjacentHTML('afterend', `
    <div class="cal-search" id="cal-search-bar" role="search">
      <i data-lucide="search" class="cal-search__icon" aria-hidden="true"></i>
      <input type="search" class="cal-search__input" id="cal-search-input"
             placeholder="${esc(t('calendar.searchPlaceholder'))}"
             aria-label="${esc(t('calendar.searchPlaceholder'))}"
             autocomplete="off" enterkeyhint="search" spellcheck="false">
      <button class="btn btn--icon cal-search__close" id="cal-search-close"
              aria-label="${esc(t('calendar.searchClose'))}" title="${esc(t('calendar.searchClose'))}">
        <i data-lucide="x" aria-hidden="true"></i>
      </button>
      <span id="cal-search-live" class="sr-only" role="status" aria-live="polite"></span>
    </div>
  `);

  const bar   = _container.querySelector('#cal-search-bar');
  const input = bar.querySelector('#cal-search-input');
  if (window.lucide) lucide.createIcons({ el: bar });

  renderCalendarSearchState('hint');

  let timer = null;
  input.addEventListener('input', () => {
    const q = input.value;
    clearTimeout(timer);
    timer = setTimeout(() => runCalendarSearch(q), 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeCalendarSearch(); }
  });
  bar.querySelector('#cal-search-close').addEventListener('click', () => closeCalendarSearch());

  input.focus();
}

function closeCalendarSearch({ restoreView = true } = {}) {
  if (!searchActive) return;
  searchActive  = false;
  searchQuery   = '';
  searchResults = [];
  _container.querySelector('#cal-search-bar')?.remove();

  const toggle = _container.querySelector('#cal-search');
  toggle?.setAttribute('aria-expanded', 'false');
  // Die Leiste ist gerade entfernt worden - der Verweis geht mit ihr.
  toggle?.removeAttribute('aria-controls');
  toggle?.classList.remove('cal-toolbar__search-btn--active');

  if (restoreView) renderView();
  toggle?.focus();
}

async function runCalendarSearch(raw) {
  if (!searchActive) return;
  const q = String(raw ?? '').trim();
  searchQuery = q;

  if (q.length < 2) {
    searchResults = [];
    searchTotal = 0;
    renderCalendarSearchState('hint');
    return;
  }

  renderCalendarSearchState('loading');
  try {
    const res = await api.get(`/calendar/search?q=${encodeURIComponent(q)}`);
    // Verworfen, wenn die Suche zwischenzeitlich geschlossen oder weitergetippt wurde.
    if (!searchActive || searchQuery !== q) return;
    searchResults = (res.data ?? []).map(localizeBirthdayEvent);
    searchTotal = Number.isFinite(res.total) ? res.total : searchResults.length;
    renderCalendarSearchState(searchResults.length ? 'results' : 'empty');
  } catch (err) {
    if (!searchActive || searchQuery !== q) return;
    console.warn('[Calendar] Suche fehlgeschlagen:', err);
    renderCalendarSearchState('error');
  }
}

// Aktualisiert die persistente sr-only-Live-Region in der Suchleiste. Bewusst
// getrennt von der sichtbaren Trefferliste, damit Screenreader Statuswechsel
// zuverlässig ansagen (ein bei jedem Render neu erzeugtes role=status wird oft
// nicht vorgelesen).
function setSearchLive(message) {
  const live = _container.querySelector('#cal-search-live');
  if (live) live.textContent = message;
}

function calendarSearchCountLabel() {
  return searchTotal > searchResults.length
    ? t('calendar.searchCountCapped', { shown: searchResults.length, total: searchTotal })
    : t('calendar.searchCount', { count: searchResults.length });
}

function renderCalendarSearchState(kind) {
  const body = _container.querySelector('#cal-body');
  if (!body) return;
  body.replaceChildren();

  if (kind === 'hint') {
    body.insertAdjacentHTML('beforeend', `
      <div class="cal-search-status">
        <i data-lucide="search" class="cal-search-status__icon" aria-hidden="true"></i>
        <p class="cal-search-status__text">${esc(t('calendar.searchHint'))}</p>
      </div>`);
    setSearchLive(t('calendar.searchHint'));
  } else if (kind === 'loading') {
    body.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 5, lines: 2 }));
    setSearchLive(t('common.loading'));
  } else if (kind === 'empty') {
    body.insertAdjacentHTML('beforeend', `
      <div class="cal-search-status">
        <i data-lucide="calendar-search" class="cal-search-status__icon" aria-hidden="true"></i>
        <p class="cal-search-status__text">${esc(t('calendar.searchEmpty', { query: searchQuery }))}</p>
        <button class="btn btn--secondary" id="cal-search-empty-cta">${esc(t('calendar.newEvent'))}</button>
      </div>`);
    // Bewusst ohne newEventDate(): die Trefferliste ersetzt die Ansicht, es steht
    // gerade kein Zeitraum auf dem Schirm, auf den ein Vorschlag sich beziehen könnte.
    body.querySelector('#cal-search-empty-cta')?.addEventListener('click', () => openEventModal({ mode: 'create' }));
    setSearchLive(t('calendar.searchEmpty', { query: searchQuery }));
  } else if (kind === 'error') {
    body.insertAdjacentHTML('beforeend', `
      <div class="cal-search-status">
        <i data-lucide="alert-triangle" class="cal-search-status__icon cal-search-status__icon--error" aria-hidden="true"></i>
        <p class="cal-search-status__text">${esc(t('calendar.searchError'))}</p>
        <button class="btn btn--secondary" id="cal-search-retry">${esc(t('common.retry'))}</button>
      </div>`);
    body.querySelector('#cal-search-retry')?.addEventListener('click', () => runCalendarSearch(searchQuery));
    setSearchLive(t('calendar.searchError'));
  } else if (kind === 'results') {
    renderCalendarSearchResults(body);
    setSearchLive(calendarSearchCountLabel());
  }

  bindSessionCompletion(body);
  if (window.lucide) lucide.createIcons({ el: body });
}

function renderCalendarSearchResults(body) {
  // Treffer nach Tag gruppieren; der Endpoint liefert bereits chronologisch sortiert.
  const groups = [];
  const byDate = new Map();
  for (const ev of searchResults) {
    const d = localDate(ev.start_datetime);
    if (!byDate.has(d)) {
      const g = { date: d, events: [] };
      byDate.set(d, g);
      groups.push(g);
    }
    byDate.get(d).events.push(ev);
  }

  body.insertAdjacentHTML('beforeend', `
    <div class="agenda-view page-scrollport cal-search-results" id="cal-search-results">
      <p class="cal-search-results__count" aria-hidden="true">${esc(calendarSearchCountLabel())}</p>
      ${groups.map(({ date, events }) => `
        <div class="agenda-day" data-date="${esc(date)}">
          <h2 class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
            <span class="agenda-day__date">${formatDate(date, { long: true })}</span>
            <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
          </h2>
          <div class="list-rows">${events.map((ev) => renderAgendaEvent(ev, date)).join('')}</div>
        </div>
      `).join('')}
    </div>
  `);

  const results = body.querySelector('#cal-search-results');
  bindSessionCompletion(results, searchResults);
  stagger(results.querySelectorAll('.agenda-event'));

  const activateResult = (evEl) => {
    const ev = searchResults.find((x) => String(x.id) === evEl.dataset.id);
    if (ev) openFoundEvent(ev);
  };
  results.addEventListener('click', (e) => {
    const evEl = e.target.closest('.agenda-event');
    if (evEl) activateResult(evEl);
  });
  results.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const evEl = e.target.closest('.agenda-event');
    if (!evEl) return;
    e.preventDefault();
    activateResult(evEl);
  });

  // Auf den nächsten kommenden Treffer scrollen — Vergangenes bleibt darüber
  // erreichbar, aber der Blick startet beim relevantesten (heute/zukünftig).
  const upcoming = groups.find((g) => g.date >= state.today);
  if (upcoming) {
    results.querySelector(`.agenda-day[data-date="${CSS.escape(upcoming.date)}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

// Öffnet einen gefundenen Termin im Kontext: springt in die Tagesansicht des
// Termindatums und zeigt das Detail-Popup (Fallback: Bearbeiten-Modal).
async function openFoundEvent(ev) {
  const date = localDate(ev.start_datetime);
  closeCalendarSearch({ restoreView: false });
  await switchToDayView(date);

  const full = state.events.find((e) => e.id === ev.id) || ev;
  const chip = _container.querySelector(`[data-id="${CSS.escape(String(ev.id))}"]`);
  if (chip) {
    chip.scrollIntoView({ block: 'center', behavior: 'instant' });
    openEventDetail(full, chip);
  } else {
    openEventDetail(full);
  }
}

export const __test = {
  fetchWindow,
  getWeekRange,
  getRangeForView,
  resolveEventColor,
  isVisibleLayer,
  normalizeCalendarView,
  defaultCalendarViewFromState,
  newEventDefaultDate,
  filterTasksForCalendar,
  tasksOnDay,
  eventsOnDay,
  passesPersonFilters,
  eventEndDate,
  isMultiDayEvent,
  isAllDayLike,
  agendaSegmentKind,
  deepLinkTargetDate,
  findDeepLinkedOccurrence,
  validDateParam,
  hasAttachment,
  attachmentUrls,
  agendaEventAriaLabel,
  calendarRepeatIconHtml,
  monthDayAriaLabel,
  clickedTime,
  hourOffset,
  monthDayClasses,
  monthViewClasses,
  monthDayVisibleCap,
  pickerColors,
  colorToSave,
  eventIconName,
  eventIconHtml,
  sameColor,
  EVENT_COLORS,
  renderScheduleChip,
  scheduleEntryTitle,
  scheduleEntriesOnDay,
  state,
  layoutOverlaps,
  layoutScheduleBlocks,
  scheduleBlockTimeRange,
  renderScheduleTimeBlock,
  renderWeekView,
  renderDayView,
};

function renderAgendaEvent(ev, dayStr) {
  const kind = agendaSegmentKind(ev, dayStr ?? localDate(ev.start_datetime));
  let timeStr;
  switch (kind) {
    case 'all-day':
    case 'middle':
      timeStr = t('calendar.allDay');
      break;
    case 'start':
      timeStr = t('calendar.spanFrom', { time: formatTime(ev.start_datetime) });
      break;
    case 'end':
      timeStr = t('calendar.spanUntil', { time: formatTime(ev.end_datetime) });
      break;
    default: // single
      timeStr = formatTime(ev.start_datetime)
        + (ev.end_datetime ? ` – ${formatTime(ev.end_datetime)} ${timeSuffix()}`.trimEnd() : ` ${timeSuffix()}`.trimEnd());
  }

  const displayBg     = resolveEventBackground(ev);
  const assignedUsers = ev.assigned_users ?? [];
  return `
    <div class="list-row agenda-event" data-id="${ev.id}" role="button" tabindex="0"
         aria-label="${esc(agendaEventAriaLabel(ev, timeStr))}">
      ${renderSessionCheckbox(ev)}${renderEventAssigneeBar(ev)}
      <div class="agenda-event__color" style="background:${esc(displayBg)};"></div>
      <div class="agenda-event__body">
        <div class="agenda-event__title">${eventIconHtml(ev.icon)}${calendarRepeatIconHtml(ev)}<span>${esc(ev.title)}</span></div>
        <div class="agenda-event__meta">
          <span class="calendar-meta-item calendar-meta-item--time">${calendarMetaIconHtml('clock')}<span>${esc(timeStr)}</span></span>
          ${ev.location ? `<span class="calendar-meta-item calendar-meta-item--place">${calendarMetaIconHtml('map-pin')}<span>${esc(fmtLocation(ev.location))}</span></span>` : ''}
          ${ev.cal_name ? `<span class="calendar-meta-item calendar-meta-item--cal">${calendarMetaIconHtml('calendar-days')}<span>${esc(ev.cal_name)}</span></span>` : ''}
          ${eventVisibilityMeta(ev.visibility)}
          ${assignedUsers.length ? `<span class="agenda-event__assigned">${renderAvatarStack(assignedUsers, { size: 20, maxVisible: 3 })}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function agendaEventAriaLabel(ev, timeStr) {
  return [
    (ev.recurrence_rule || ev.is_recurring_instance) ? t('calendar.recurringEvent') : '',
    ev.title,
    timeStr,
    ev.cal_name,
    chipAssigneeLabel(ev),
  ].filter(Boolean).join(', ');
}

// Sichtbarkeits-Indikator (#474): nur bei eingeschränkten Terminen ein dezentes
// Icon mit Label — „Alle" bleibt icon-los.
function eventVisibilityMeta(visibility) {
  if (!visibility || visibility === 'all') return '';
  const icon  = visibility === 'private' ? 'lock' : 'users';
  const label = visibility === 'private'
    ? t('common.visibility.private')
    : t('common.visibility.assignees');
  return `<span class="calendar-meta-item" title="${esc(label)}">${calendarMetaIconHtml(icon)}<span>${esc(label)}</span></span>`;
}

// --------------------------------------------------------
// Termin-Detailansicht (beim Antippen eines Termins)
// --------------------------------------------------------

/** Anhang als Bildvorschau oder Download-Link - beides als DOM, nie als Markup. */
function attachmentNode(ev) {
  if (!hasAttachment(ev)) return null;
  const name = ev.attachment_name || t('calendar.attachmentFallback');
  const urls = attachmentUrls(ev);

  if (isImageAttachment(ev.attachment_mime)) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-attachment detail-attachment--image';
    const img = document.createElement('img');
    img.src = urls.preview;
    img.alt = name;
    wrap.appendChild(img);
    return wrap;
  }

  const link = document.createElement('a');
  link.className = 'detail-attachment detail-attachment--file';
  link.href = urls.download;
  link.download = name;
  const icon = document.createElement('i');
  icon.dataset.lucide = 'paperclip';
  icon.className = 'icon-md';
  icon.setAttribute('aria-hidden', 'true');
  link.append(icon, document.createTextNode(name));
  return link;
}

/* Kalendername als farbiger Chip - in der DETAILFLÄCHE, seit die Agendazeile
 * ihn abgegeben hat: dort sagte er dasselbe wie die Farbspur an ihrer linken
 * Kante, und er tat es als drittes Element einer Metazeile, die deswegen
 * umbrach. Hier ist er die einzige Stelle, an der der Kalendername ausdrücklich
 * steht. */
function calendarChipNode(ev) {
  if (!ev.cal_name) return null;
  const chip = document.createElement('span');
  chip.className = 'event-cal-label';
  chip.style.setProperty('--cal-color', ev.cal_color || ev.color || resolveEventColor(ev));
  chip.textContent = ev.cal_name;
  return chip;
}

/** Erinnerungen im Klartext („1 Tag vorher"), statt sie ganz zu verschweigen. */
function reminderSummary(ev, reminders) {
  const list = Array.isArray(reminders) ? reminders : [];
  if (!list.length) return '';
  const labels = REMINDER_OFFSETS();
  return list
    .map((r) => {
      const value = reminderOffsetFromEvent(ev, r);
      const match = labels.find((o) => o.value === value && o.value !== '');
      // „Benutzerdefiniert…" ist als Auswahl-Label gedacht, nicht als Aussage -
      // in der Leseansicht steht stattdessen der tatsächliche Zeitpunkt.
      return value === 'custom' || !match
        ? formatDateTime(parseRemindAtAsUtc(r.remind_at))
        : match.label;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * Die Leseinformationen eines Termins.
 *
 * Wiederholung, Erinnerungen und Sichtbarkeit standen bisher nur im
 * Bearbeitungsformular - wer wissen wollte, ob ein Termin wöchentlich
 * wiederkehrt, musste ihn zum Bearbeiten öffnen.
 */
function renderEventDetail(ev, reminders = []) {
  const capabilities = editCapabilities(ev);
  const sync = syncMetadata(ev);
  const timeStr = ev.all_day
    ? `${formatPreferredDate(localDate(ev.start_datetime))} · ${t('calendar.allDay')}`
    : formatDateTime(ev.start_datetime)
      + (ev.end_datetime ? ` – ${formatTime(ev.end_datetime)} ${timeSuffix()}`.trimEnd() : '');

  return [
    { icon: 'calendar', label: t('calendar.detailCalendar'), node: calendarChipNode(ev) },
    { icon: 'clock', label: t('calendar.detailWhen'), value: timeStr },
    recurrenceRow(ev.recurrence_rule),
    { icon: 'map-pin', label: t('calendar.locationLabel'), value: ev.location ? fmtLocation(ev.location) : '' },
    assignedRow(ev.assigned_users, t('calendar.assignedLabel'), ev.assigned_name || ''),
    {
      icon: 'bell',
      label: reminders.length > 1 ? t('reminders.sectionTitlePlural') : t('reminders.sectionTitle'),
      value: reminderSummary(ev, reminders),
    },
    visibilityRow(ev.visibility),
    // Nur wenn markiert (#647): eine Zeile „Countdown: nein" an jedem Termin
    // wäre ein Feld, das die Leseansicht erklärt statt sie zu beantworten. Die
    // Detailansicht lässt leere Werte ohnehin weg.
    { icon: 'hourglass', label: t('dashboard.countdownTitle'), value: ev.countdown ? t('calendar.countdownDetail') : '' },
    {
      icon: 'align-left',
      label: t('calendar.descriptionLabel'),
      value: ev.description ? truncateDescription(ev.description, 500) : '',
      multiline: true,
    },
    { icon: 'paperclip', label: t('calendar.attachmentLabel'), node: attachmentNode(ev) },
    !isEditAllowed(ev, 'edit')
      ? {
          icon: 'lock',
          label: t('calendar.editReadOnly'),
          value: editBlockReason(ev) || capabilities.read_only_reason || t('calendar.editReadOnlyReason'),
        }
      : null,
    sync.state === 'pending'
      ? { icon: 'refresh-cw', label: t('calendar.syncStatusLabel'), value: t('calendar.syncPending') }
      : sync.state === 'error'
        ? { icon: 'alert-triangle', label: t('calendar.syncStatusLabel'), value: sync.recovery
          ? (sync.failure_kind === 'recovery_field_conflict' ? t('calendar.recoveryConflict') : t('calendar.recoveryUnavailable'))
          : t('calendar.syncError') }
        : null,
  ].filter(Boolean);
}

/**
 * Der einzige Einstieg in einen bestehenden Termin. Ohne Anker (Deep-Link,
 * Suchtreffer) wird daraus ein Sheet, mit Anker am Desktop ein Popover.
 */
async function openEventDetail(ev, anchor = null) {
  if (ev?.task_id) return openTaskFromCalendar(ev.task_id);
  // Haushaltshilfe-Besuche werden in ihrem eigenen Modul bearbeitet; der Umweg
  // über eine Detailansicht führte sonst ins Leere.
  if (ev?.housekeeping_visit_id) {
    window.yuvomi.navigate(`/housekeeping?editVisit=${ev.housekeeping_visit_id}`);
    return;
  }

  // Die Erinnerungen kosten einen eigenen Serveraufruf; alles andere steckt
  // schon im Termin. Früher wurde davor gewartet, und der Antipp-Moment - der
  // einzige, dessen ganzer Zweck Leichtigkeit ist - blieb einen Roundtrip lang
  // stumm. Jetzt läuft der Aufruf neben dem Öffnen her und die Zeile kommt
  // nach. Die Sync-Ziele braucht nur das Formular, die lädt erst dessen mount().
  let reminders = [];
  const remindersReady = loadReminderForEvent(ev.id).then((r) => { reminders = r; });

  const actions = [];
  if (isEditAllowed(ev, 'edit') && !syncMetadata(ev).recovery) {
    actions.push({
      id: 'detail-delete',
      label: t('common.delete'),
      variant: 'danger-ghost',
      icon: 'trash-2',
      align: 'start',
      // force + await: Löschen entscheidet über die Eingaben mit, eine
      // Verwerfen-Frage davor wäre die zweite Rückfrage für dieselbe
      // Entscheidung. Der await hält das Löschen zurück, bis der Overlay-Slot
      // wirklich frei ist - requestDeleteEvent öffnet bei Serien selbst einen
      // Dialog, und das Shared-Modal kennt kein Stacking.
      onClick: async ({ close }) => { await close({ force: true }); await requestDeleteEvent(ev); },
    });
  }

  // ICS-Abos: Ein lokal geänderter Termin lässt sich auf das Original
  // zurücksetzen. Die Aktion gehört zum Objekt, also in die Fußzeile.
  if (ev.external_source === 'ics' && ev.user_modified === 1) {
    actions.push({
      id: 'detail-ics-reset',
      label: t('calendar.ics.reset'),
      variant: 'ghost',
      icon: 'rotate-ccw',
      onClick: async ({ close }) => {
        try {
          await api.post(`/calendar/${ev.id}/reset`, {});
          // Der Schreibvorgang ist durch - ohne force fragte der Dirty-Guard
          // nach dem Verwerfen von Änderungen, die der Reset ohnehin
          // zurückgenommen hat (#625).
          await close({ force: true });
          await reloadForView();
          window.yuvomi?.showToast(t('calendar.ics.resetToast'), 'success');
        } catch (err) {
          // Server-Meldung bevorzugen (nutzerorientiert), sonst lokalisierter
          // Fallback — nie den rohen JS-/Netzwerk-Fehlertext zeigen.
          window.yuvomi?.showToast(err.data?.error ?? t('calendar.saveError'), 'danger');
        }
      },
    });
  }

  const sync = syncMetadata(ev);
  if (sync.recovery) {
    actions.push({ id: 'detail-recovery-review', label: t('calendar.recoveryReview'), icon: 'eye', variant: 'ghost',
      onClick: async ({ close }) => { await close({ force: true }); await reviewRecoveryChanges(ev); } });
    actions.push({ id: 'detail-recovery-discard', label: t('calendar.recoveryDiscard'), icon: 'trash-2', variant: 'danger-ghost',
      onClick: async ({ close }) => { await close({ force: true }); await discardRecoveryChanges(ev); } });
  }
  if (!sync.recovery && (sync.state === 'pending' || sync.state === 'error')) {
    actions.push({
      id: 'detail-sync-reload',
      label: t('common.reload'),
      variant: 'ghost',
      icon: 'refresh-cw',
      onClick: async ({ close }) => {
        try {
          if (sync.conflict && sync.operation_id) {
            await api.post('/calendar/' + ev.id + '/reload-sync', {
              operation_id: sync.operation_id,
            });
          }
          await reloadCalendarEventsOnly({ throwOnError: true });
          await close({ force: true });
          renderView();
        } catch (error) {
          window.yuvomi?.showToast(error?.data?.error ?? t('calendar.loadError'), 'danger');
        }
      },
    });
  }
  if (sync.state === 'error' && sync.retryable) {
    actions.push({
      id: 'detail-sync-retry',
      label: t('calendar.syncRetry'),
      variant: 'ghost',
      icon: 'refresh-cw',
      onClick: async ({ close }) => {
        try {
          const response = await api.post('/calendar/' + ev.id + '/retry-sync', {});
          const updated = responseEvent(response);
          await close({ force: true });
          if (updated) {
            const index = state.events.findIndex((item) => String(item.id) === String(updated.id));
            if (index !== -1) state.events[index] = updated;
          }
          await reloadCalendarEventsOnly({ throwOnError: true });
          renderView();
          const refreshed = updated
            || state.events.find((item) => String(item.id) === String(ev.id))
            || ev;
          const refreshedSync = syncMetadata(refreshed);
          if (refreshedSync.state === 'error') {
            window.yuvomi?.showToast(t('calendar.syncError'), 'danger');
          } else if (refreshedSync.state === 'pending') {
            window.yuvomi?.showToast(t('calendar.syncPending'), 'warning');
          } else {
            window.yuvomi?.showToast(t('calendar.syncRetrying'), 'success');
          }
        } catch (error) {
          window.yuvomi?.showToast(error?.data?.error ?? t('calendar.loadError'), 'danger');
        }
      },
    });
  }

  const view = openDetailView({
    title: ev.title,
    accentColor: resolveEventBackground(ev),
    anchor,
    sections: renderEventDetail(ev, reminders),
    actions,
    edit: isEditAllowed(ev, 'edit') && !sync.recovery ? {
      label: t('common.edit'),
      title: t('calendar.editEvent'),
      // Das Formular wartet auf die Erinnerungen, die Leseansicht nicht. Ohne
      // diese Sperre baute ein sofortiger Klick auf „Bearbeiten" das Formular
      // ohne Erinnerungszeilen auf - und saveEvent löscht die Erinnerungen des
      // Termins, wenn es keine Zeile findet.
      ready: remindersReady,
      mount: (panel, pane) => {
        pane.insertAdjacentHTML('beforeend', buildEventModalContent({ mode: 'edit', event: ev, reminder: reminders }));
        wireEventForm(panel, { mode: 'edit', event: ev, reminder: reminders });
      },
      // Am Desktop bleibt der gewohnte Weg: Popover zu, Formular auf.
      standalone: async () => {
        await remindersReady;
        openEventModal({ mode: 'edit', event: ev, reminder: reminders });
      },
    } : null,
  });

  // Die Erinnerungszeile nachtragen. Zeilen ohne Inhalt fallen ohnehin weg, ein
  // Termin ohne Erinnerung bewegt sich also gar nicht. `update` verwirft sich
  // selbst, wenn der Nutzer inzwischen etwas anderes geöffnet hat.
  await remindersReady;
  if (reminders.length) view.update(renderEventDetail(ev, reminders));
}

// --------------------------------------------------------
// Reminder-Helfer für Kalender-Events
// --------------------------------------------------------

async function loadReminderForEvent(eventId) {
  try {
    const data = await api.get(`/reminders/all?entity_type=event&entity_id=${eventId}`);
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

// Obergrenze für mehrere Erinnerungen je Termin — muss mit dem Server-Cap
// (MAX_REMINDERS_PER_ENTITY in server/routes/reminders.js) übereinstimmen.
const MAX_CALENDAR_REMINDERS = 5;

const REMINDER_OFFSETS = () => [
  { value: '',     label: t('reminders.offsetNone')   },
  { value: '0',    label: t('reminders.offsetAtTime') },
  { value: '15',   label: t('reminders.offset15min')  },
  { value: '60',   label: t('reminders.offset1hour')  },
  { value: '1440', label: t('reminders.offset1day')   },
  { value: '2880', label: t('reminders.offset2days')  },
  { value: '10080', label: t('reminders.offset1week') },
  { value: '20160', label: t('reminders.offset2weeks') },
  { value: 'custom', label: t('reminders.offsetCustom') },
];

function reminderOffsetFromEvent(event, reminder) {
  if (!reminder || !event?.start_datetime) return '';
  const remindMs = parseRemindAtAsUtc(reminder.remind_at).getTime();
  const startMs  = new Date(reminderStartValue(event.start_datetime)).getTime();
  const diffMin  = Math.round((startMs - remindMs) / 60000);
  const opts = [0, 15, 60, 1440, 2880, 10080, 20160];
  const match = opts.find((o) => o === diffMin);
  return match !== undefined ? String(match) : 'custom';
}

function customReminderFromEvent(event, reminder) {
  const fallback = { amount: 1, unit: 'days' };
  if (!reminder || !event?.start_datetime) return fallback;
  const diffMin = Math.max(0, Math.round(
    (new Date(reminderStartValue(event.start_datetime)).getTime() - parseRemindAtAsUtc(reminder.remind_at).getTime()) / 60000
  ));
  if (diffMin % 10080 === 0 && diffMin >= 10080) return { amount: diffMin / 10080, unit: 'weeks' };
  if (diffMin % 1440 === 0 && diffMin >= 1440) return { amount: diffMin / 1440, unit: 'days' };
  if (diffMin % 60 === 0 && diffMin >= 60) return { amount: diffMin / 60, unit: 'hours' };
  return { amount: Math.max(diffMin, 1), unit: 'minutes' };
}

function customReminderMinutes(amount, unit) {
  const value = Math.max(parseInt(amount, 10) || 1, 1);
  if (unit === 'weeks') return value * 10080;
  if (unit === 'days') return value * 1440;
  if (unit === 'hours') return value * 60;
  return value;
}

function reminderStartValue(startDatetime) {
  return startDatetime?.includes('T') ? startDatetime : `${startDatetime}T09:00`;
}

/**
 * Rendert eine einzelne Erinnerungs-Zeile (Offset-Select + Custom-Felder +
 * Entfernen-Button). Ohne Argument entsteht eine leere Standardzeile (#436).
 */
function reminderRowHtml({ offset = '0', amount = 1, unit = 'days' } = {}) {
  const isCustom = offset === 'custom';
  return `
    <div class="reminder-row" data-reminder-row>
      <div class="reminder-row__main">
        <select class="form-input js-reminder-offset" aria-label="${esc(t('reminders.offsetLabel'))}">
          ${REMINDER_OFFSETS().filter((o) => o.value !== '').map((o) =>
            `<option value="${o.value}" ${offset === o.value ? 'selected' : ''}>${esc(o.label)}</option>`
          ).join('')}
        </select>
        <button type="button" class="btn btn--ghost btn--icon js-reminder-remove" aria-label="${esc(t('reminders.removeReminder'))}">
          <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
      <div class="modal-grid modal-grid--2 reminder-custom js-reminder-custom" ${isCustom ? '' : 'hidden'}>
        <div class="form-group" style="margin:0">
          <label class="form-label">${t('reminders.customAmountLabel')}</label>
          <input class="form-input js-reminder-custom-amount" type="number" min="1" max="999" value="${amount}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">${t('reminders.customUnitLabel')}</label>
          <select class="form-input js-reminder-custom-unit">
            <option value="minutes" ${unit === 'minutes' ? 'selected' : ''}>${t('reminders.customMinutes')}</option>
            <option value="hours" ${unit === 'hours' ? 'selected' : ''}>${t('reminders.customHours')}</option>
            <option value="days" ${unit === 'days' ? 'selected' : ''}>${t('reminders.customDays')}</option>
            <option value="weeks" ${unit === 'weeks' ? 'selected' : ''}>${t('reminders.customWeeks')}</option>
          </select>
        </div>
      </div>
    </div>`;
}

function renderCalendarReminderSection(reminders = [], event = null, defaultOffsets = []) {
  const list = Array.isArray(reminders) ? reminders : (reminders ? [reminders] : []);
  let rows = list.map((rem) => ({
    offset: reminderOffsetFromEvent(event, rem) || '0',
    ...customReminderFromEvent(event, rem),
  }));
  // Neue Termine ohne bestehende Erinnerung: Standard-Erinnerungen vorbelegen (#497).
  // Die Default-Offsets decken sich mit den Preset-Werten des Offset-Selects.
  if (rows.length === 0 && Array.isArray(defaultOffsets) && defaultOffsets.length) {
    rows = defaultOffsets.map((min) => ({ offset: String(min), amount: 1, unit: 'days' }));
  }
  const enabled = rows.length > 0;
  const rowsHtml = (enabled ? rows : [{ offset: '0', amount: 1, unit: 'days' }])
    .map((r) => reminderRowHtml(r)).join('');
  /* NUR WER DEN TERMIN ANGELEGT HAT, TEILT SEINE ERINNERUNG (#921) - und nur
   * der bekommt den Hinweis. Fuer alle anderen waere er unwahr: wer sich an
   * einem fremden Termin einen Merker setzt, setzt ihn fuer sich, damit nicht
   * der halbe Haushalt eine Meldung bekommt, weil ein Einzelner sich etwas
   * notiert hat. Ein neuer Termin gehoert dem, der ihn gerade anlegt. */
  const sharesReminder = !event || event.created_by === state.currentUserId;
  return `
    <div class="reminder-section">
      <div class="reminder-section__header">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="modal-reminder-toggle" ${enabled ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span class="reminder-section__title">${t('reminders.enableLabel')}</span>
        </label>
      </div>
      <div id="modal-reminder-fields" class="reminder-fields" ${enabled ? '' : 'style="display:none"'}>
        <div class="reminder-rows" id="modal-reminder-rows">
          ${rowsHtml}
        </div>
        <button type="button" class="btn btn--secondary btn--sm" id="modal-reminder-add">
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>
          ${t('reminders.addReminder')}
        </button>
        ${sharesReminder ? `<p class="form-hint">${t('reminders.sharedWithAssignees')}</p>` : ''}
      </div>
    </div>`;
}

/**
 * Verdrahtet die Mehrfach-Erinnerungs-Liste im Event-Modal (#436):
 * Toggle, „Hinzufügen"/„Entfernen" und die Custom-Feld-Umschaltung je Zeile.
 */
function wireReminderRows(panel) {
  const toggle = panel.querySelector('#modal-reminder-toggle');
  const fields = panel.querySelector('#modal-reminder-fields');
  const rowsEl = panel.querySelector('#modal-reminder-rows');
  const addBtn = panel.querySelector('#modal-reminder-add');
  if (!rowsEl) return;

  const rowCount = () => rowsEl.querySelectorAll('[data-reminder-row]').length;
  const syncAddState = () => {
    if (addBtn) addBtn.disabled = rowCount() >= MAX_CALENDAR_REMINDERS;
  };

  const appendRow = () => {
    rowsEl.insertAdjacentHTML('beforeend', reminderRowHtml());
    const newRow = rowsEl.lastElementChild;
    if (window.lucide && newRow) lucide.createIcons({ el: newRow });
    syncAddState();
  };

  // Custom-Felder je Zeile ein-/ausblenden.
  rowsEl.addEventListener('change', (e) => {
    const sel = e.target.closest('.js-reminder-offset');
    if (!sel) return;
    const custom = sel.closest('[data-reminder-row]')?.querySelector('.js-reminder-custom');
    if (custom) custom.hidden = sel.value !== 'custom';
  });

  // Zeile entfernen.
  rowsEl.addEventListener('click', (e) => {
    const rm = e.target.closest('.js-reminder-remove');
    if (!rm) return;
    rm.closest('[data-reminder-row]')?.remove();
    syncAddState();
  });

  addBtn?.addEventListener('click', () => {
    if (rowCount() >= MAX_CALENDAR_REMINDERS) return;
    appendRow();
  });

  toggle?.addEventListener('change', () => {
    const on = toggle.checked;
    if (fields) fields.style.display = on ? '' : 'none';
    if (on && rowCount() === 0) appendRow();
  });

  syncAddState();
}

// --------------------------------------------------------
// CalDAV Target Helpers
// --------------------------------------------------------

async function loadSyncTargets(selectElement, currentEvent = null) {
  if (!selectElement) return;

  selectElement.replaceChildren();
  const localOption = document.createElement('option');
  localOption.value = '';
  localOption.textContent = t('calendar.syncTargetLocal');
  selectElement.appendChild(localOption);

  // Ziele über die gemeinsame Lese-Route holen (#618): die Verwaltungsrouten
  // sind admin-only und lieferten Familienmitgliedern nur 403 - übrig blieb
  // "Lokal speichern". /sync-targets liefert bereits gefiltert (aktiviert +
  // beschreibbar) und ohne Zugangsdaten.
  let targets = { google: [], caldav: [], outlook: [] };
  try {
    const res = await api.get('/calendar/sync-targets');
    targets = {
      google: res.data?.google || [],
      caldav: res.data?.caldav || [],
      outlook: res.data?.outlook || [],
    };
  } catch (err) {
    console.warn('Failed to load sync targets:', err);
  }

  if (targets.google.length) {
    const group = document.createElement('optgroup');
    group.className = 'js-google-targets';
    group.label = t('calendar.syncTargetGoogleGroup');
    for (const cal of targets.google) {
      const option = document.createElement('option');
      option.value = googleTargetValue(cal.id);
      option.textContent = cal.summary || cal.id;
      group.appendChild(option);
    }
    selectElement.appendChild(group);
  }

  // CalDAV-Kalender nach Konto gruppieren - die Route liefert sie kontoweise
  // sortiert, ein Wechsel der accountId beginnt die nächste optgroup.
  let caldavGroup = null;
  let caldavGroupAccountId = null;
  for (const cal of targets.caldav) {
    if (caldavGroupAccountId !== cal.accountId) {
      caldavGroup = document.createElement('optgroup');
      caldavGroup.label = `${t('calendar.syncTargetCaldavGroup')} · ${cal.accountName}`;
      caldavGroupAccountId = cal.accountId;
      selectElement.appendChild(caldavGroup);
    }
    const option = document.createElement('option');
    option.value = caldavTargetValue(cal.accountId, cal.calendarUrl);
    option.textContent = cal.calendarName || cal.calendarUrl;
    caldavGroup.appendChild(option);
  }

  // Outlook-Kalender nach Konto gruppieren (gleiche Grammatik wie CalDAV).
  let outlookGroup = null;
  let outlookGroupAccountId = null;
  for (const cal of targets.outlook) {
    if (outlookGroupAccountId !== cal.accountId) {
      outlookGroup = document.createElement('optgroup');
      outlookGroup.label = `${t('calendar.syncTargetOutlookGroup')} · ${cal.accountName}`;
      outlookGroupAccountId = cal.accountId;
      selectElement.appendChild(outlookGroup);
    }
    const option = document.createElement('option');
    option.value = outlookTargetValue(cal.accountId, cal.calendarId);
    option.textContent = cal.calendarName || cal.calendarId;
    outlookGroup.appendChild(option);
  }

  // Pre-select the editing event's existing target
  if (currentEvent?.target_google_calendar_id) {
    const value = googleTargetValue(currentEvent.target_google_calendar_id);
    // Zeigt das Event auf ein (jetzt) nur-lesbares Ziel, das nicht mehr in der
    // gefilterten Liste steht: Option nachtragen, damit Speichern das Ziel nicht
    // still auf "Lokal" zurücksetzt. Der Server-Guard fängt den Outbound-Fall ab.
    if (!Array.from(selectElement.options).some((o) => o.value === value)) {
      let group = selectElement.querySelector('optgroup.js-google-targets');
      if (!group) {
        group = document.createElement('optgroup');
        group.className = 'js-google-targets';
        group.label = t('calendar.syncTargetGoogleGroup');
        selectElement.appendChild(group);
      }
      const option = document.createElement('option');
      option.value = value;
      option.textContent = currentEvent.target_google_calendar_id;
      group.appendChild(option);
    }
    selectElement.value = value;
  } else if (currentEvent?.target_caldav_account_id && currentEvent?.target_caldav_calendar_url) {
    selectElement.value = caldavTargetValue(currentEvent.target_caldav_account_id, currentEvent.target_caldav_calendar_url);
  } else if (currentEvent?.target_outlook_account_id && currentEvent?.target_outlook_calendar_id) {
    selectElement.value = outlookTargetValue(currentEvent.target_outlook_account_id, currentEvent.target_outlook_calendar_id);
  } else if (!currentEvent) {
    // Nur für NEUE Termine (#620). Ein bestehender Termin behält sein Ziel, auch
    // wenn es "Lokal" ist - sonst würde das Öffnen und Speichern eines lokalen
    // Termins ihn stillschweigend in einen Kalender schieben.
    applyDefaultSyncTarget(selectElement);
  }
}

/**
 * Setzt das persönliche Standard-Sync-Ziel (#620) als Vorauswahl.
 *
 * Steht das gespeicherte Ziel nicht (mehr) in der Liste - Kalender deaktiviert,
 * gelöscht, auf nur-lesend gestellt oder Konto entfernt - bleibt es bei "Lokal
 * speichern". Die Alternative, die Option nachzutragen wie beim Bearbeiten eines
 * Termins, wäre hier falsch: dort rettet sie ein bereits gesetztes Ziel, hier
 * würde sie einen neuen Termin auf einen Kalender richten, der ihn nicht
 * annehmen kann.
 */
function applyDefaultSyncTarget(selectElement) {
  const target = state.defaultSyncTarget;
  if (!target) return;
  const available = Array.from(selectElement.options).some((o) => o.value === target);
  if (available) selectElement.value = target;
}

// --------------------------------------------------------
// Event-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

// Blendet einen Hinweis ein, wenn „Nur Zugewiesene" gewählt ist, aber niemand
// zugewiesen wurde — dann sieht faktisch nur der Ersteller den Termin (#474 Guard).
function wireVisibilityWarning(panel, selectSel, msName, warnSel) {
  const select = panel.querySelector(selectSel);
  const warn   = panel.querySelector(warnSel);
  if (!select || !warn) return;
  const ms = panel.querySelector(`.user-ms[data-ms-name="${msName}"]`);
  const update = () => {
    const count = getSelectedUserIds(panel, msName).length;
    warn.hidden = !(select.value === 'assignees' && count === 0);
  };
  select.addEventListener('change', update);
  ms?.addEventListener('click', () => setTimeout(update, 0));
  update();
}

function openEventModal({ mode, event = null, date = null, reminder = null, time = null }) {
  if (mode === 'edit' && event?.housekeeping_visit_id) {
    window.yuvomi.navigate(`/housekeeping?editVisit=${event.housekeeping_visit_id}`);
    return;
  }
  const isEdit = mode === 'edit';
  const content = buildEventModalContent({ mode, event, date, reminder, time });

  openSharedModal({
    title: isEdit ? t('calendar.editEvent') : t('calendar.newEvent'),
    content,
    size: 'md',
    // Ein neuer Termin startet weiterhin mit dem Fokus im Titelfeld: Hier ist
    // Tippen die Absicht, hier ist der Autofokus richtig.
    onSave(panel) { wireEventForm(panel, { mode, event, reminder }); },
  });
}

/**
 * Verdrahtet das Termin-Formular. Eigene Funktion, weil das Formular an zwei
 * Orten entsteht: als eigenes Modal (neuer Termin, Desktop-Bearbeiten) und als
 * zweites Pane der Detailansicht, das erst beim Wechsel gemountet wird.
 */
function wireEventForm(panel, { mode, event = null, reminder = null }) {
  const isEdit = mode === 'edit';
  // Der Wiederholungsbaustein kennt absichtlich keine Feld-IDs des Kalenders.
  // Der Kalender liefert ihm das aktive Startdatum ausdrücklich: bei einem
  // Zeit-Termin aus dem Zeitbereich, bei „ganztägig" aus dessen eigenem Feld.
  // So bleibt die Monatsletzten-Vorschau korrekt, ohne dass ein geteilter
  // Baustein in fremdem DOM nach einem geratenen Selektor sucht (#975).
  const recurrenceBinding = bindRRuleEvents(panel, 'event', {
    expandsFromStart: true,
    getStartDate: () => readDateInput(
      panel,
      panel.querySelector('#modal-allday')?.checked ? '#modal-allday-start' : '#modal-start-date',
    ),
  });
  bindRecurringScopeChooser(panel, 'modal-edit', event);
  bindUserMultiSelect(panel, 'cal_assigned');
  wireVisibilityWarning(panel, '#modal-visibility', 'cal_assigned', '#modal-visibility-warning');

  // Der Farbwaehler war bis v2.35.0 ausgegraut, sobald jemand zugewiesen war,
  // mit dem Hinweis, die Farbe der Person schlage sie ohnehin. Seit #815 steht
  // die Terminfarbe in resolveEventColor VORN, womit der Hinweis unwahr wurde -
  // die Sperre nahm dem Nutzer eine Wahl ab, um ein Versprechen zu halten, das
  // der Code nicht mehr gab (#856). Sie ist deshalb weg und bleibt weg.
  //
  // Seit #891 ist die Aussage von damals wieder erreichbar, nur als WAHL statt
  // als Sperre: der Erben-Swatch traegt sie, und wer stattdessen eine Farbe
  // waehlt, behaelt sie. Wer der Termin ist, sagt weiterhin der Avatar-Stack.

  // Leerstring = der Erben-Swatch. Ein neuer Termin startet dort, und ein
  // bestehender ohne eigene Farbe steht dort ebenfalls - beides ist seit #891
  // ein ausdrueckbarer Zustand und nicht mehr der Palettenerste als Notloesung.
  const selectedColor = isEdit ? (event?.color || COLOR_INHERIT) : COLOR_INHERIT;

  // Farb-Auswahl: Auswahl + ARIA + Keyboard (Roving Tabindex)
  function selectSwatch(target) {
    panel.querySelectorAll('.color-swatch').forEach((s) => {
      s.classList.remove('color-swatch--active');
      s.setAttribute('aria-checked', 'false');
      s.setAttribute('tabindex', '-1');
    });
    target.classList.add('color-swatch--active');
    target.setAttribute('aria-checked', 'true');
    target.setAttribute('tabindex', '0');
  }
  panel.querySelectorAll('.color-swatch').forEach((sw) => {
    if (sameColor(sw.dataset.color, selectedColor)) selectSwatch(sw);
    sw.addEventListener('click', () => { selectSwatch(sw); sw.focus(); });
    sw.addEventListener('keydown', (e) => {
      const swatches = [...panel.querySelectorAll('.color-swatch')];
      const idx = swatches.indexOf(sw);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = swatches[(idx + 1) % swatches.length];
        selectSwatch(next); next.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = swatches[(idx - 1 + swatches.length) % swatches.length];
        selectSwatch(prev); prev.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectSwatch(sw);
      }
    });
  });

  // Ganztägig-Toggle
  const alldayCheck = panel.querySelector('#modal-allday');
  const timeFields  = panel.querySelector('#time-fields');
  const alldayFields = panel.querySelector('#allday-fields');
  alldayCheck.addEventListener('change', () => {
    if (alldayCheck.checked) { timeFields.style.display = 'none'; alldayFields.style.display = ''; }
    else                      { timeFields.style.display = '';     alldayFields.style.display = 'none'; }
    recurrenceBinding.refreshMonthdayHint();
  });
  if (isEdit && event?.all_day) { timeFields.style.display = 'none'; alldayFields.style.display = ''; }

  const iconInput = panel.querySelector('#modal-icon');
  const iconTrigger = panel.querySelector('#modal-icon-trigger');
  const selectIcon = (icon) => {
    const nextIcon = eventIconName(icon);
    if (iconInput) iconInput.value = nextIcon;
    if (iconTrigger) {
      iconTrigger.dataset.icon = nextIcon;
      iconTrigger.replaceChildren(eventIconElement(nextIcon, 'event-icon-picker__trigger-icon'));
    }
    if (window.lucide) lucide.createIcons({ el: iconTrigger });
  };

  iconTrigger?.addEventListener('click', () => {
    iconTrigger.setAttribute('aria-expanded', 'true');
    openIconPickerDialog(iconInput?.value || 'calendar', (icon) => {
      selectIcon(icon);
      iconTrigger?.setAttribute('aria-expanded', 'false');
      iconTrigger?.focus();
    }, () => {
      iconTrigger?.setAttribute('aria-expanded', 'false');
      iconTrigger?.focus();
    });
  });

  const attachmentInput = panel.querySelector('#modal-attachment');
  const selectedAttachment = panel.querySelector('#modal-selected-attachment');
  const attachmentPreview = panel.querySelector('#modal-attachment-preview');
  const removeAttachment = panel.querySelector('#modal-remove-attachment');
  const attachmentState = {
    name: event?.attachment_name || null,
    mime: event?.attachment_mime || null,
    size: event?.attachment_size || null,
    changed: false,
    removed: false,
  };

  const syncSelectedAttachment = () => {
    if (!selectedAttachment) return;
    selectedAttachment.hidden = !attachmentState.name;
    selectedAttachment.textContent = attachmentState.name ? selectedAttachmentLabel(attachmentState.name) : '';
    if (removeAttachment) removeAttachment.hidden = !attachmentState.name;
  };

  const syncAttachmentSelection = () => {
    if (!selectedAttachment) return;
    const file = attachmentInput.files?.[0];
    if (file) {
      attachmentState.name = file.name;
      attachmentState.mime = file.type || 'application/octet-stream';
      attachmentState.size = file.size;
      attachmentState.changed = true;
      attachmentState.removed = false;
      selectedAttachment.hidden = false;
      selectedAttachment.textContent = selectedAttachmentLabel(file.name);
      if (removeAttachment) removeAttachment.hidden = false;
      if (attachmentPreview) {
        attachmentPreview.replaceChildren();
        attachmentPreview.hidden = true;
      }
      return;
    }
    syncSelectedAttachment();
  };

  attachmentInput?.addEventListener('change', syncAttachmentSelection);
  removeAttachment?.addEventListener('click', () => {
    if (attachmentInput) attachmentInput.value = '';
    attachmentState.name = null;
    attachmentState.mime = null;
    attachmentState.size = null;
    attachmentState.changed = true;
    attachmentState.removed = true;
    if (attachmentPreview) {
      attachmentPreview.replaceChildren();
      attachmentPreview.hidden = true;
    }
    syncSelectedAttachment();
  });

  const attachmentDropzone = panel.querySelector('#modal-attachment-dropzone');
  if (attachmentDropzone && attachmentInput) {
    ['dragenter', 'dragover'].forEach((eventName) => {
      attachmentDropzone.addEventListener(eventName, (dropEvent) => {
        dropEvent.preventDefault();
        attachmentDropzone.classList.add('document-dropzone--active');
      });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      attachmentDropzone.addEventListener(eventName, (dropEvent) => {
        dropEvent.preventDefault();
        attachmentDropzone.classList.remove('document-dropzone--active');
      });
    });
    attachmentDropzone.addEventListener('drop', (dropEvent) => {
      const file = dropEvent.dataTransfer?.files?.[0];
      if (!file) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      attachmentInput.files = transfer.files;
      syncAttachmentSelection();
    });
  }

  syncSelectedAttachment();

  // Erinnerungen: Toggle blendet die Zeilenliste ein/aus; „Hinzufügen" und
  // „Entfernen" verwalten mehrere Erinnerungen je Termin (#436).
  wireReminderRows(panel);

  // Load unified sync targets (Google + CalDAV)
  const syncTargetSelect = panel.querySelector('#event-sync-target');
  if (syncTargetSelect) {
    // Outlook ist der einzige One-way-Push: Aenderungen in Outlook werden beim
    // naechsten Sync ueberschrieben. Der Hinweis gehoert an die Stelle der
    // Zielwahl, nicht nur in die Sync-Einstellungen. Erst nach loadSyncTargets
    // pruefen - die Vorauswahl eines bestehenden Outlook-Ziels setzt das select
    // asynchron.
    const outlookHint = panel.querySelector('#event-sync-target-outlook-hint');
    const syncOutlookHint = () => {
      if (outlookHint) outlookHint.hidden = !syncTargetSelect.value.startsWith('outlook:');
    };
    syncTargetSelect.addEventListener('change', syncOutlookHint);
    loadSyncTargets(syncTargetSelect, event).then(syncOutlookHint);
  }

  // Enddatum dem Startdatum nachführen, damit das Verschieben des Starts
  // das Ende nicht davor zurücklässt (Dauer bleibt erhalten).
  const wireDateFollow = (startSel, endSel) => {
    const startEl = panel.querySelector(startSel);
    const endEl   = panel.querySelector(endSel);
    if (!startEl || !endEl) return;
    let prevStart = startEl.value;
    startEl.addEventListener('change', () => {
      if (isDateInputValid(startEl.value) && isDateInputValid(endEl.value)) {
        const oldKey = parseDateInput(prevStart);
        const newKey = parseDateInput(startEl.value);
        const endKey = parseDateInput(endEl.value);
        if (oldKey && newKey && endKey) {
          endEl.value = formatDateInput(shiftEndDateKey(oldKey, newKey, endKey));
        }
      }
      prevStart = startEl.value;
    });
  };
  wireDateFollow('#modal-start-date', '#modal-end-date');
  wireDateFollow('#modal-allday-start', '#modal-allday-end');
  panel.querySelector('#modal-start-date')?.addEventListener('change', recurrenceBinding.refreshMonthdayHint);
  panel.querySelector('#modal-allday-start')?.addEventListener('change', recurrenceBinding.refreshMonthdayHint);

  // Dynamische Termindauer (#441): das Ende folgt dem Start um die gemerkte
  // Dauer. Ändert der Nutzer das Ende, wird die neue Dauer übernommen und bei
  // der nächsten Start-Änderung angewendet. Nur für Zeit-Termine.
  wireDurationMemory(panel);

  panel.querySelector('#modal-cancel').addEventListener('click', closeModal);

  panel.querySelector('#modal-delete')?.addEventListener('click', async () => {
    closeModal({ force: true });
    await requestDeleteEvent(event);
    refocusAfterRender();
  });

  panel.querySelector('#modal-save').addEventListener('click', () => saveEvent(panel, mode, event, reminder, attachmentState));
  // Pflichtfelder melden sich beim Verlassen inline statt erst beim
  // Speichern als ortloser Toast (Critique P1).
  wireBlurValidation(panel);
  if (window.lucide) lucide.createIcons({ el: panel });
}

/**
 * Verdrahtet die dynamische Termindauer (#441) im Event-Modal.
 * - Start-Zeit ändern → Ende = Start + gemerkte Dauer (mit Datums-Übertrag).
 * - Ende-Zeit ändern → gemerkte Dauer = Ende − Start (nur wenn positiv).
 * Wirkt nur auf die Zeit-Felder; „Ganztägig" bleibt unberührt.
 */
function wireDurationMemory(panel) {
  const startDateEl = panel.querySelector('#modal-start-date');
  const startTimeEl = panel.querySelector('#modal-start-time');
  const endDateEl   = panel.querySelector('#modal-end-date');
  const endTimeEl   = panel.querySelector('#modal-end-time');
  if (!startDateEl || !startTimeEl || !endDateEl || !endTimeEl) return;

  const daysBetween = (fromKey, toKey) =>
    Math.round((new Date(toKey + 'T00:00:00') - new Date(fromKey + 'T00:00:00')) / 86400000);

  const readDuration = () => {
    const sd = parseDateInput(startDateEl.value);
    const st = parseTimeInput(startTimeEl.value);
    const ed = parseDateInput(endDateEl.value);
    const et = parseTimeInput(endTimeEl.value);
    if (!sd || !st || !ed || !et) return null;
    const diff = daysBetween(sd, ed) * 1440 + (timeToMinutes(et) - timeToMinutes(st));
    return diff > 0 ? diff : null;
  };

  // Init: bereits gesetzte Dauer übernehmen, sonst Präferenz-Default.
  let durationMin = readDuration() ?? (state.defaultDuration || 60);

  startTimeEl.addEventListener('change', () => {
    const sd = parseDateInput(startDateEl.value);
    const st = parseTimeInput(startTimeEl.value);
    if (!sd || !st) return;
    const next = addDurationToDateTime(sd, st, durationMin);
    endTimeEl.value = formatTimeInput(next.time);
    if (isDateInputValid(endDateEl.value)) endDateEl.value = formatDateInput(next.date);
  });

  endTimeEl.addEventListener('change', () => {
    const dur = readDuration();
    if (dur) durationMin = dur;
  });
}

// Neue Termine ohne explizite Uhrzeit starten heute im 15-Minuten-Raster
// Stunde: der starre 09:00-Default legte den Start nachmittags in die
// Vergangenheit (Audit A1-18). Andere Tage behalten 09:00 als neutralen
// Start; kippt die Rundung über Mitternacht, ebenfalls.
function defaultNewEventTime(dateStr) {
  if (dateStr !== state.today) return '09:00';
  // Auf die naechste Viertelstunde aufrunden - auf den Feldern der
  // Haushaltszone statt auf einem Date, damit der Vorschlag zu der Uhr passt,
  // die daneben im Raster steht. Kippt die Rundung ueber Mitternacht, bleibt
  // es bei 09:00.
  const { hour, minute } = nowFields();
  const total = Math.ceil((hour * 60 + minute) / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES;
  const rounded = { hour: Math.floor(total / 60), minute: total % 60 };
  if (rounded.hour > 23) return '09:00';
  return `${pad(rounded.hour)}:${pad(rounded.minute)}`;
}

function buildEventModalContent({ mode, event, date, reminder = null, time = null }) {
  const isEdit = mode === 'edit';
  const today  = date || state.today;

  const startDate = isEdit ? localDate(event.start_datetime) : today;
  const startTime = isEdit && event.start_datetime.length > 10
    ? localTime(event.start_datetime) : (time ?? defaultNewEventTime(today));
  // Standard-Termindauer aus den Präferenzen: neue Termine erhalten ein Ende,
  // das um die konfigurierte Dauer nach dem Start liegt (#441).
  const durationMin = Math.max(
    CALENDAR_MIN_TIMED_MINUTES,
    Math.round((state.defaultDuration || 60) / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES,
  );
  const derivedEnd  = addDurationToDateTime(startDate, startTime, durationMin);
  const endDate   = isEdit && event.end_datetime ? localDate(event.end_datetime) : derivedEnd.date;
  const endTime   = isEdit && event.end_datetime && event.end_datetime.length > 10
    ? localTime(event.end_datetime)
    : derivedEnd.time;
  const selectedIcon = eventIconName(isEdit ? event.icon : 'calendar');
  const recurrenceRuleForForm = isEdit && isDetachedEvent(event)
    ? recurrenceParent(event)?.recurrence_rule ?? null
    : (isEdit ? event.recurrence_rule : null);

  // Neue Termine: optional den aktuellen Nutzer vorbelegen (#498).
  const selectedUserIds = isEdit
    ? (event.assigned_users?.map((u) => u.id) ?? (event.assigned_to ? [event.assigned_to] : []))
    : (state.defaultAssignMe && state.currentUserId != null ? [state.currentUserId] : []);
  const visibility = (isEdit ? event.visibility : null) || 'all';

  // Sekundärfelder: wandern hinter „Weitere Einstellungen". Beim Bearbeiten
  // automatisch geöffnet, falls bereits Werte gesetzt sind. Der Ort steht als
  // Alltagsfeld im Hauptbereich (Audit A1-11), nicht mehr hier.
  const advancedFieldsOpen = isEdit
    && (!!event.description || hasAttachment(event));

  const advancedFieldsHtml = `
    <div class="form-group">
      <label class="form-label" id="event-color-label">${t('calendar.colorLabel')}</label>
      <div class="color-picker" id="event-color-picker" role="radiogroup" aria-labelledby="event-color-label">
        <!-- Steht vorn, weil er der Standard ist: ein Termin, fuer den niemand
             eine Farbe gewaehlt hat, traegt die der zugewiesenen Person (#891).
             Traegt bewusst KEIN Inline-background - seine Optik kommt aus
             calendar.css, weil sie eine Designentscheidung ist und keine
             Nutzereinstellung. -->
        <div class="color-swatch color-swatch--inherit" data-color=""
             role="radio"
             tabindex="0"
             aria-checked="false"
             aria-label="${esc(t('calendar.colorInherit'))}"
             title="${esc(t('calendar.colorInheritHint'))}"></div>
        ${pickerColors(isEdit ? event : null).map((c) => `
          <div class="color-swatch" data-color="${esc(c)}" style="background-color:${esc(c)};"
               role="radio"
               tabindex="-1"
               aria-checked="false"
               aria-label="${esc(EVENT_COLOR_NAMES()[c] ?? t('calendar.colorCurrent'))}"></div>
        `).join('')}
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="event-sync-target">${t('calendar.syncTargetLabel')}</label>
      <select class="form-input" id="event-sync-target">
        <option value="">${t('calendar.syncTargetLocal')}</option>
      </select>
      <small class="form-hint">${t('calendar.syncTargetHint')}</small>
      <small class="form-hint" id="event-sync-target-outlook-hint" hidden>${t('settings.outlookPushHint')}</small>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-description">${t('calendar.descriptionLabel')}</label>
      <textarea class="form-input" id="modal-description" rows="2"
                placeholder="${t('calendar.descriptionPlaceholder')}">${esc(isEdit && event.description ? event.description : '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-attachment">${t('calendar.attachmentLabel')}</label>
      <p class="document-storage-target">
        <i data-lucide="${state.documentUploadBackend === 'webdav' ? 'cloud' : state.documentUploadBackend === 'local_folder' ? 'folder' : 'database'}" aria-hidden="true"></i>
        <span>${t('documents.activeUploadTarget', {
          target: state.documentUploadBackend === 'webdav'
            ? t('documents.storageWebdav')
            : state.documentUploadBackend === 'local_folder'
              ? t('documents.storageLocalFolder')
              : t('documents.storageLocal'),
        })}</span>
      </p>
      <label class="document-dropzone" id="modal-attachment-dropzone" for="modal-attachment">
        <input class="sr-only" id="modal-attachment" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <span class="document-dropzone__icon">
          <i data-lucide="file-up" aria-hidden="true"></i>
        </span>
        <span class="document-dropzone__title">${t('documents.dropzoneTitle')}</span>
        <span class="document-dropzone__hint">${t('documents.dropzoneHint')}</span>
        <span class="document-dropzone__file" id="modal-selected-attachment" ${isEdit && event.attachment_name ? '' : 'hidden'}>
          ${isEdit && event.attachment_name ? esc(selectedAttachmentLabel(event.attachment_name)) : ''}
        </span>
      </label>
      <div class="form-help">${t('calendar.attachmentHint')}</div>
      <div class="event-attachment-preview" id="modal-attachment-preview" ${isEdit && hasAttachment(event) ? '' : 'hidden'}>
        ${isEdit && hasAttachment(event) ? attachmentPreviewHtml(event) : ''}
      </div>
      <button class="btn btn--secondary" id="modal-remove-attachment" type="button"
              ${isEdit && hasAttachment(event) ? '' : 'hidden'}>${t('calendar.attachmentRemove')}</button>
    </div>`;

  return `
    <div class="event-title-picker">
      <div class="form-group event-icon-picker">
        <label class="form-label" for="modal-icon-trigger">${t('calendar.iconLabel')}</label>
        <input type="hidden" id="modal-icon" value="${selectedIcon}">
        <button type="button"
                class="event-icon-picker__trigger"
                id="modal-icon-trigger"
                data-icon="${selectedIcon}"
                aria-haspopup="true"
                aria-expanded="false"
                aria-label="${t('calendar.iconLabel')}">
          ${eventIconHtml(selectedIcon, 'event-icon-picker__trigger-icon')}
        </button>
      </div>
      <div class="form-group event-title-picker__title">
        <label class="form-label" for="modal-title">${t('calendar.titleLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
        <input type="text" class="form-input" id="modal-title" required
               placeholder="${t('calendar.titlePlaceholder')}" value="${esc(isEdit ? event.title : '')}">
      </div>
    </div>
    <div class="form-group">
      <label class="toggle">
        <input type="checkbox" id="modal-allday" ${isEdit && event.all_day ? 'checked' : ''}>
        <span class="toggle__track"></span>
        <span>${t('calendar.allDayToggle')}</span>
      </label>
    </div>

    <div id="time-fields">
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-start-date">${t('calendar.startDateLabel')}</label>
          <yuvomi-datepicker type="date" id="modal-start-date" value="${esc(formatDateInput(startDate))}" label="${esc(t('calendar.startDateLabel'))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-start-time">${t('calendar.startTimeLabel')}</label>
          <yuvomi-datepicker type="time" id="modal-start-time" value="${esc(formatTimeInput(startTime))}" label="${esc(t('calendar.startTimeLabel'))}"></yuvomi-datepicker>
        </div>
      </div>
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-end-date">${t('calendar.endDateLabel')}</label>
          <yuvomi-datepicker type="date" id="modal-end-date" value="${esc(formatDateInput(endDate))}" label="${esc(t('calendar.endDateLabel'))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-end-time">${t('calendar.endTimeLabel')}</label>
          <yuvomi-datepicker type="time" id="modal-end-time" value="${esc(formatTimeInput(endTime))}" label="${esc(t('calendar.endTimeLabel'))}"></yuvomi-datepicker>
        </div>
      </div>
    </div>

    <div id="allday-fields" style="display:none;">
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-allday-start">${t('calendar.fromLabel')}</label>
          <yuvomi-datepicker type="date" id="modal-allday-start" value="${esc(formatDateInput(startDate))}" label="${esc(t('calendar.fromLabel'))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-allday-end">${t('calendar.toLabel')}</label>
          <yuvomi-datepicker type="date" id="modal-allday-end" value="${esc(formatDateInput(endDate))}" label="${esc(t('calendar.toLabel'))}"></yuvomi-datepicker>
        </div>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-location">${t('calendar.locationLabel')}</label>
      <input type="text" class="form-input" id="modal-location"
             placeholder="${t('calendar.locationPlaceholder')}" value="${esc(isEdit && event.location ? event.location : '')}">
    </div>

    <div class="form-group">
      ${renderUserMultiSelect(state.users, selectedUserIds, 'cal_assigned', 'calendar.assignedLabel')}
    </div>

    ${state.users.length > 1 ? `
    <div class="form-group">
      <label class="form-label" for="modal-visibility">${t('common.visibility.label')}</label>
      <select class="input" id="modal-visibility" name="visibility">
        <option value="all"       ${visibility === 'all'       ? 'selected' : ''}>${t('common.visibility.all')}</option>
        <option value="assignees" ${visibility === 'assignees' ? 'selected' : ''}>${t('common.visibility.assignees')}</option>
        <option value="private"   ${visibility === 'private'   ? 'selected' : ''}>${t('common.visibility.private')}</option>
      </select>
      <p class="form-hint">${t('common.visibility.hint')}</p>
      <p class="form-hint field-hint--warn" id="modal-visibility-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('common.visibility.assigneesNobodyHint')}</span></p>
    </div>` : ''}

    <!-- #647: der Schalter, den @Kyrodan beschrieben hat - „einen Termin als
         Countdown markieren" statt eines zweiten Systems daneben. Er steht im
         Hauptbereich und nicht hinter „Weitere Einstellungen", weil er der
         einzige Weg zu diesem Feature ist: hinter dem Aufklapper gaebe es die
         Kachel fuer niemanden, der nicht danach sucht. -->
    <div class="form-group">
      <label class="toggle">
        <input type="checkbox" id="modal-countdown" aria-describedby="modal-countdown-hint"
               ${isEdit && event.countdown ? 'checked' : ''}>
        <span class="toggle__track"></span>
        <span>${t('calendar.countdownToggle')}</span>
      </label>
      <!-- cal-field-hint UND NICHT form-hint: die Regel fuer form-hint steht in
           settings.css, und der Router laedt genau ein Page-CSS pro Seite - auf
           /calendar ist sie schlicht nicht geladen. Der Hinweis rendert dort in
           16px voller Primaertinte und war damit lauter als der Schalter, zu dem
           er gehoert (gemessen 4 Zeilen / 94px).
           Die uebrigen fuenf form-hint dieses Dialogs haben dasselbe Problem und
           app-weit noch 34 weitere in elf Modulen - das ist ein eigener Umzug
           und keine Beifang-Aenderung dieses Features. -->
      <p class="cal-field-hint" id="modal-countdown-hint">${t('calendar.countdownHint')}</p>
    </div>

    ${advancedSection(advancedFieldsHtml, { open: advancedFieldsOpen })}

    ${renderRRuleFields('event', recurrenceRuleForForm, {
      allowCount: true,
      expandsFromStart: true,
      // Kanonischer Datums-Key aus dem Kalenderzustand. Das Widget formatiert
      // ihn nur; es kennt weder die Zeit- noch die Ganztags-Feldnamen.
      startDate,
    })}

    ${isEdit && isRecurringEvent(event) ? renderRecurringScopeChooserForEvent('modal-edit', localDate(event.start_datetime), event) : ''}

    ${renderCalendarReminderSection(reminder, event, isEdit ? [] : state.defaultReminders)}

    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit ? `<button class="btn btn--danger-outline" id="modal-delete">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}
      </button>` : '<div></div>'}
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--ghost" id="modal-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="modal-save">${isEdit ? t('common.save') : t('common.create')}</button>
      </div>
    </div>`;
}

async function saveEvent(overlay, mode, event, existingReminder = null, attachmentState = null) {
  const eventId = event?.id;
  const saveBtn = overlay.querySelector('#modal-save');
  const title   = overlay.querySelector('#modal-title').value.trim();

  if (!title) {
    // Fehler am Ort des Geschehens statt als Toast unten links (Critique P1):
    // Meldung unterm Feld, Fehler-Rahmen, Fokus + Scroll aufs Feld.
    reportFieldError(overlay.querySelector('#modal-title'), t('calendar.titleRequired'));
    return;
  }

  const allday  = overlay.querySelector('#modal-allday').checked;
  const color   = colorToSave(overlay.querySelector('.color-swatch--active')?.dataset.color, event);
  const icon    = eventIconName(overlay.querySelector('#modal-icon')?.value);
  const location    = overlay.querySelector('#modal-location').value.trim() || null;
  const assigned_to = getSelectedUserIds(overlay, 'cal_assigned');
  const description = overlay.querySelector('#modal-description').value.trim() || null;

  let start_datetime, end_datetime;

  if (allday) {
    start_datetime = readDateInput(overlay, '#modal-allday-start')
                   || readDateInput(overlay, '#modal-start-date');
    end_datetime   = readDateInput(overlay, '#modal-allday-end')
                   || readDateInput(overlay, '#modal-end-date');
    end_datetime   = end_datetime || null;
  } else {
    const sd = readDateInput(overlay, '#modal-start-date');
    const stRaw = overlay.querySelector('#modal-start-time').value;
    const st = parseTimeInput(stRaw);
    const ed = readDateInput(overlay, '#modal-end-date');
    const etRaw = overlay.querySelector('#modal-end-time').value;
    const et = parseTimeInput(etRaw);
    if ((stRaw && !st) || (etRaw && !et)) {
      reportFieldError(
        overlay.querySelector(stRaw && !st ? '#modal-start-time' : '#modal-end-time'),
        t('calendar.invalidDate')
      );
      return;
    }
    start_datetime = st ? `${sd}T${st}` : sd;
    end_datetime   = ed ? (et ? `${ed}T${et}` : ed) : null;
  }

  const visibleDateFields = allday
    ? ['#modal-allday-start', '#modal-allday-end']
    : ['#modal-start-date', '#modal-end-date'];
  const invalidDateField = visibleDateFields.find((selector) => !isDateInputValid(overlay.querySelector(selector)?.value));
  if (!start_datetime || invalidDateField) {
    reportFieldError(
      overlay.querySelector(invalidDateField ?? visibleDateFields[0]),
      t('calendar.invalidDate')
    );
    return;
  }
  if (isEndBeforeStart(start_datetime, end_datetime)) {
    // Der Fehler klebt am Feld, das ihn verursacht: liegt schon das Enddatum
    // vor dem Startdatum, am Datums-Feld; sonst (gleicher Tag, Zeit davor)
    // an der Endzeit.
    const endsOnEarlierDay = String(end_datetime).slice(0, 10) < String(start_datetime).slice(0, 10);
    const endField = (allday ? overlay.querySelector('#modal-allday-end') : null)
      ?? (endsOnEarlierDay ? overlay.querySelector('#modal-end-date') : null)
      ?? (overlay.querySelector('#modal-end-time')?.value ? overlay.querySelector('#modal-end-time') : null)
      ?? overlay.querySelector('#modal-end-date');
    reportFieldError(endField, t('calendar.endBeforeStart'));
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const rrule = getRRuleValues(overlay, 'event');
    if (!rrule.valid_until) {
      reportFieldError(overlay.querySelector('#event-rrule-until'), t('calendar.invalidDate'));
      saveBtn.disabled    = false;
      saveBtn.textContent = mode === 'edit' ? t('common.save') : t('common.create');
      return;
    }
    const attachmentFile = overlay.querySelector('#modal-attachment')?.files?.[0];
    let attachmentPayload = null;
    if (attachmentFile) {
      if (attachmentFile.size > maxUploadBytes()) throw new Error(t('calendar.attachmentTooLarge', { size: maxUploadMb() }));
      attachmentPayload = {
        name: attachmentFile.name,
        mime: attachmentFile.type || 'application/octet-stream',
        size: attachmentFile.size,
        data: await readFileAsDataUrl(attachmentFile),
      };
    }

    // Extract sync target (unified Google + CalDAV + Outlook picker)
    const syncTargetValue = overlay.querySelector('#event-sync-target')?.value || '';
    let target_google_calendar_id = null;
    let target_caldav_account_id = null;
    let target_caldav_calendar_url = null;
    let target_outlook_account_id = null;
    let target_outlook_calendar_id = null;

    if (syncTargetValue.startsWith('google:')) {
      target_google_calendar_id = syncTargetValue.slice('google:'.length);
    } else if (syncTargetValue.startsWith('caldav:')) {
      const [accountId, calendarUrl] = syncTargetValue.slice('caldav:'.length).split('|');
      if (accountId && calendarUrl) {
        target_caldav_account_id = parseInt(accountId, 10);
        target_caldav_calendar_url = calendarUrl;
      }
    } else if (syncTargetValue.startsWith('outlook:')) {
      const [accountId, calendarId] = syncTargetValue.slice('outlook:'.length).split('|');
      if (accountId && calendarId) {
        target_outlook_account_id = parseInt(accountId, 10);
        target_outlook_calendar_id = calendarId;
      }
    }

    const body = {
      title, description, start_datetime, end_datetime,
      all_day: allday ? 1 : 0,
      location, color, icon, assigned_to,
      visibility: overlay.querySelector('#modal-visibility')?.value || 'all',
      countdown: overlay.querySelector('#modal-countdown')?.checked ? 1 : 0,
      recurrence_rule: rrule.recurrence_rule,
      target_google_calendar_id,
      target_caldav_account_id,
      target_caldav_calendar_url,
      target_outlook_account_id,
      target_outlook_calendar_id,
    };
    if (attachmentPayload) {
      Object.assign(body, {
        attachment_name: attachmentPayload.name,
        attachment_mime: attachmentPayload.mime,
        attachment_size: attachmentPayload.size,
        attachment_data: attachmentPayload.data,
        document_folder_name: t('documents.calendarItemsFolder'),
        document_name: t('calendar.attachmentDocumentName', { title, name: attachmentPayload.name }),
        document_description: t('calendar.attachmentDocumentDescription', { title }),
      });
    } else if (attachmentState?.changed && attachmentState.removed) {
      body.remove_attachment = true;
    }

    let savedEventId = eventId;
    // Start, an dem die Erinnerungs-Offsets ausgerichtet werden. Für „ganze Serie"
    // wird das auf den (evtl. verschobenen) Master-Start umgestellt (#532).
    let reminderBaseStart = start_datetime;
    // Serien-Scopes ändern die Expansion (Split/EXDATE): danach den sichtbaren
    // Bereich neu laden, damit der Server korrekt expandiert (#532).
    let reloadAfter = false;
    let savedResponseEvent = null;

    if (mode === 'create') {
      const res = await api.post('/calendar', body);
      const created = responseEvent(res) || res.data;
      state.events.push(created);
      savedEventId = created?.id;
      savedResponseEvent = created;
    } else if (mode === 'edit') {
      const recurring = isRecurringEvent(event);
      const capabilities = editCapabilities(event);
      const scopedProvider = capabilities.scope_reason !== 'provider_scope_unsupported';
      // Apple and other legacy providers keep their ordinary single-event PUT
      // path.  Existing recurrence rules remain readable and ordinary field
      // edits stay usable; only an attempted rule change on an existing series
      // is blocked because this provider has no validated scope adapter.
      const scope = recurring
        ? getRecurringScope(overlay, 'modal-edit')
        : 'series';
      // The form may display an inherited parent rule for a detached
      // occurrence while the detached row itself intentionally has no rule.
      // Compare with the widget's original source value so a title-only save
      // keeps the least-destructive default scope (`this`) instead of asking
      // for a series decision the user never made.
      const initialRecurrenceRule = overlay.querySelector('#event-rrule-source')?.value || '';
      const recurrenceChanged = String(rrule.recurrence_rule || '')
        !== String(initialRecurrenceRule);
      if (!scopedProvider && recurring && recurrenceChanged) {
        const error = new Error(t('calendar.editScopeUnsupported'));
        error.calendarMessage = t('calendar.editScopeUnsupported');
        throw error;
      }
      if (scopedProvider && recurring && recurrenceChanged && scope === 'this') {
        reportFieldError(
          overlay.querySelector('#modal-edit-scope'),
          t('calendar.editScopeRecurrenceChoose'),
        );
        saveBtn.disabled = false;
        saveBtn.textContent = t('common.save');
        return;
      }
      if (!scopedProvider) {
        const legacyBody = { ...body };
        // A detached row displays its parent's rule, but the row itself owns no
        // recurrence rule. Preserve that storage shape on an ordinary legacy
        // save so a title edit cannot turn the detached occurrence into a new
        // series.
        if (isDetachedEvent(event) && !recurrenceChanged) {
          legacyBody.recurrence_rule = event.recurrence_rule ?? null;
        }
        const res = await api.put('/calendar/' + eventId, {
          ...legacyBody,
          expected_revision: eventRevision(event) ?? '',
        });
        const updated = responseEvent(res);
        savedEventId = updated?.id ?? eventId;
        reminderBaseStart = updated?.start_datetime ?? start_datetime;
        savedResponseEvent = updated;
        const idx = state.events.findIndex((item) => String(item.id) === String(eventId));
        if (idx !== -1 && updated) state.events[idx] = updated;
        reloadAfter = false;
      } else {
        const editBody = {
          ...body,
          edit_scope: scope,
          occurrence_start: eventOccurrenceStart(event) ?? start_datetime,
          expected_revision: eventRevision(event) ?? '',
        };
        Object.assign(editBody, scopedRecurrencePayload(event, rrule.recurrence_rule, scope));
        const parentRevision = recurrenceParentRevision(event);
        if (scope !== 'this' && parentRevision !== null && parentRevision !== undefined) {
          editBody.expected_parent_revision = parentRevision;
        }
        const res = await api.put('/calendar/' + eventId, editBody);
        const updated = responseEvent(res);
        savedEventId = updated?.id ?? eventId;
        reminderBaseStart = updated?.start_datetime ?? start_datetime;
        reloadAfter = isRecurringEvent(event);
        savedResponseEvent = updated;
        const idx = state.events.findIndex((item) => String(item.id) === String(eventId));
        if (idx !== -1 && updated) state.events[idx] = updated;
      }
    }
    // Erinnerungen speichern oder löschen (mehrere je Termin möglich, #436).
    if (savedEventId) {
      const reminderOn = overlay.querySelector('#modal-reminder-toggle')?.checked;
      const rowsEl     = overlay.querySelector('#modal-reminder-rows');
      const startMs    = new Date(reminderStartValue(reminderBaseStart)).getTime();
      let remindAts = [];

      if (reminderOn && rowsEl) {
        for (const row of rowsEl.querySelectorAll('[data-reminder-row]')) {
          const offsetVal = row.querySelector('.js-reminder-offset')?.value;
          if (offsetVal == null || offsetVal === '') continue;
          const offsetMinutes = offsetVal === 'custom'
            ? customReminderMinutes(
                row.querySelector('.js-reminder-custom-amount')?.value,
                row.querySelector('.js-reminder-custom-unit')?.value
              )
            : parseInt(offsetVal, 10);
          remindAts.push(new Date(startMs - offsetMinutes * 60000).toISOString().slice(0, 19));
        }
        remindAts = [...new Set(remindAts)].slice(0, MAX_CALENDAR_REMINDERS);
      }

      if (remindAts.length) {
        await api.put(`/reminders?entity_type=event&entity_id=${savedEventId}`, { remind_ats: remindAts });
      } else {
        await api.delete(`/reminders?entity_type=event&entity_id=${savedEventId}`).catch(() => {});
      }
      refreshReminders();
    }

    let refreshError = null;
    if (reloadAfter) {
      try {
        await reloadCalendarEventsOnly({ throwOnError: true });
      } catch (error) {
        refreshError = error;
      }
    }

    closeModal({ force: true });
    renderView();
    const sync = syncMetadata(savedResponseEvent || event);
    if (refreshError) {
      window.yuvomi?.showToast(t('calendar.loadError'), 'danger');
    } else if (sync.state === 'error') {
      window.yuvomi?.showToast(t('calendar.syncError'), 'danger');
    } else if (sync.state === 'pending') {
      window.yuvomi?.showToast(t('calendar.syncPending'), 'warning');
    } else {
      window.yuvomi?.showToast(mode === 'create' ? t('calendar.createdToast') : t('calendar.savedToast'), 'success');
    }
  } catch (err) {
    // Server-Validierungsmeldung bevorzugen, sonst lokalisierter Fallback; der
    // rohe err.message-Text (Netzwerk/JS) wird nie gezeigt. Das Modal bleibt offen
    // und der Button reaktiviert — die Eingaben des Nutzers bleiben erhalten.
    if (isConflictError(err)) {
      await handleCalendarConflict(event);
    } else {
      window.yuvomi?.showToast(err.calendarMessage ?? err.data?.error ?? t('calendar.saveError'), 'danger');
    }
    saveBtn.disabled    = false;
    saveBtn.textContent = mode === 'edit' ? t('common.save') : t('common.create');
  }
}

async function deleteEvent(id) {
  scheduleCalendarDeleteWithUndo({
    state,
    deleteScope: { eventId: id, scope: 'all' },
    message: t('calendar.deletedToast'),
    schedule: scheduleUndoableDelete,
    requestDelete: async ({ keepalive }) => {
      await api.delete(`/calendar/${id}`, { keepalive });
      api.delete(`/reminders?entity_type=event&entity_id=${id}`, { keepalive }).catch(() => {});
      if (!keepalive) refreshReminders();
    },
    isViewActive: () => Boolean(_container?.isConnected),
    reloadEvents: reloadCalendarRangeAfterDelete,
    handleError: (err) => window.yuvomi?.showToast(
      err.data?.error ?? t('calendar.deleteError'),
      'danger',
    ),
    render: renderView,
  });
}

/**
 * Gemeinsame Scope-Auswahl für Serientermine (#532): identisches Control für
 * „Bearbeiten" und „Löschen". Select (App-weites Formular-Vokabular) mit Default
 * „Nur diesen Termin" (least-destructive) plus dynamischem Reichweiten-Hinweis,
 * der das konkrete Vorkommensdatum nennt. `prefix` → Element-ID `${prefix}-scope`.
 */
function renderRecurringScopeChooserForEvent(prefix, occDateKey, event = null) {
  const capabilities = editCapabilities(event);
  const scopes = capabilities.scopes || {};
  const detached = isDetachedEvent(event);
  const parent = recurrenceParent(event);
  const parentReady = !detached
    || Boolean(parent?.id && parent?.revision !== undefined && parent?.revision !== null
      && String(parent.revision).trim() !== '');
  const allowed = (scope) => scopes[scope] !== false
    && (scope === 'this' || (capabilities.can_change_scope && parentReady));
  const defaultScope = allowed('this') ? 'this'
    : allowed('following') ? 'following'
      : allowed('series') ? 'series' : 'this';
  const summary = exceptionSummary(event);
  const exceptionList = summary?.known
    ? (summary.items || []).map((item) => '<li>'
      + esc(t('calendar.editScopeExceptionItem', {
        original: item.original_start || '',
        current: item.current_start || '',
        state: item.state || '',
      }))
      + '</li>').join('')
    : '';
  const exceptionMarkup = summary
    ? '<details class="calendar-exception-summary">'
      + '<summary>' + t('calendar.editScopeExceptions', { count: summary.count }) + '</summary>'
      + (summary.known
        ? '<ul>' + exceptionList + '</ul>'
          + (summary.truncated
            ? '<p class="form-hint">' + t('calendar.editScopeExceptionsTruncated') + '</p>'
            : '')
        : '<p class="form-hint">' + t('calendar.editScopeExceptionsUnknown') + '</p>')
      + '</details>'
    : '';
  const parentMarkup = detached && !parentReady
    ? '<p class="form-hint field-hint--warn" role="status">'
      + '<i data-lucide="lock" aria-hidden="true"></i>'
      + '<span>' + t('calendar.editScopeParentUnavailable') + '</span>'
      + '</p>'
    : '';
  const overlapMarkup = '<p class="form-hint field-hint--warn" id="' + prefix
    + '-scope-overlap" role="alert" hidden>'
    + '<i data-lucide="alert-triangle" aria-hidden="true"></i><span></span></p>';
  return [
    '<div class="form-group">',
    '<label class="form-label" for="' + prefix + '-scope">'
      + t('calendar.recurringScopeLabel') + '</label>',
    '<select class="input" id="' + prefix + '-scope" name="' + prefix + '-scope" data-occ-date="'
      + esc(occDateKey) + '">',
    '<option value="this" ' + (defaultScope === 'this' ? 'selected' : '')
      + (allowed('this') ? '' : ' disabled') + '>'
      + t('calendar.recurringScopeThis') + '</option>',
    '<option value="following" ' + (defaultScope === 'following' ? 'selected' : '')
      + (allowed('following') ? '' : ' disabled') + '>'
      + t('calendar.recurringScopeFollowing') + '</option>',
    '<option value="series" ' + (defaultScope === 'series' ? 'selected' : '')
      + (allowed('series') ? '' : ' disabled') + '>'
      + t('calendar.recurringScopeSeries') + '</option>',
    '</select>',
    '<p class="form-hint" id="' + prefix + '-scope-hint" role="status"></p>',
    parentMarkup,
    overlapMarkup,
    exceptionMarkup,
    '</div>',
  ].join('');
}

function renderRecurringScopeChooser(prefix, occDateKey) {
  return `
    <div class="form-group">
      <label class="form-label" for="${prefix}-scope">${t('calendar.recurringScopeLabel')}</label>
      <select class="input" id="${prefix}-scope" name="${prefix}-scope" data-occ-date="${esc(occDateKey)}">
        <option value="this" selected>${t('calendar.recurringScopeThis')}</option>
        <option value="following">${t('calendar.recurringScopeFollowing')}</option>
        <option value="series">${t('calendar.recurringScopeSeries')}</option>
      </select>
      <p class="form-hint" id="${prefix}-scope-hint" role="status"></p>
    </div>`;
}

/** Reichweiten-Hinweistext für den gewählten Scope (mit formatiertem Datum). */
function recurringScopeHint(value, occDateKey) {
  if (value === 'series') return t('calendar.recurringScopeHintSeries');
  const date = formatPreferredDate(occDateKey);
  return value === 'following'
    ? t('calendar.recurringScopeHintFollowing', { date })
    : t('calendar.recurringScopeHintThis', { date });
}

/** Verdrahtet den dynamischen Hinweis der Scope-Auswahl. No-op ohne Chooser. */
function bindRecurringScopeChooser(root, prefix, event = null) {
  const sel  = root.querySelector(`#${prefix}-scope`);
  const hint = root.querySelector(`#${prefix}-scope-hint`);
  const overlap = root.querySelector(`#${prefix}-scope-overlap`);
  if (!sel || !hint) return;
  const summary = exceptionSummary(event);
  const update = () => {
    hint.textContent = recurringScopeHint(sel.value, sel.dataset.occDate);
    if (!overlap) return;
    if (sel.value === 'this' || !summary || (summary.known && summary.count < 1)) {
      overlap.hidden = true;
      return;
    }
    const message = summary.known
      ? t('calendar.editScopeOverlap', { count: summary.count })
      : t('calendar.editScopeOverlapUnknown');
    const text = overlap.querySelector('span');
    if (text) text.textContent = message;
    overlap.hidden = false;
  };
  sel.addEventListener('change', update);
  update();
}

/** Liest den gewählten Scope; Default „this" (least-destructive). */
function getRecurringScope(root, prefix) {
  return root.querySelector(`#${prefix}-scope`)?.value || 'this';
}

/**
 * Einstiegspunkt für das Löschen (#489/#532). Lokale Serien fragen „nur dieser
 * Termin" / „dieser und folgende" / „ganze Serie"; Einzeltermine werden direkt
 * gelöscht (der Undo-Toast trägt die Rücknahme).
 *
 * Externe Serien können die Auswahl nicht anbieten: Yuvomi kann eine Serie, die
 * einem anderen Kalender gehört, nicht lokal aufteilen - ein ausgenommenes
 * Vorkommen käme beim nächsten Sync zurück. Gelöscht wird deshalb die ganze
 * Serie. Das ist richtig, aber es wortlos zu tun war es nicht: wer im Monat auf
 * einen Termin tippt und löscht, sieht ohne Vorwarnung alle Vorkommen
 * verschwinden (#880). Die Rückfrage benennt die Reichweite, statt sie
 * anzubieten - ein Dialog mit nur einer wählbaren Antwort wäre eine Attrappe.
 */
/**
 * Die Rückfrage für eine Serie, die einem anderen Kalender gehört (#880).
 *
 * Drei Fälle, drei verschiedene Wahrheiten - und eine Zusage, die nicht hält,
 * ist schlimmer als gar keine, denn sie ist der einzige Grund, überhaupt zu
 * fragen:
 *
 * - Ein Geburtstagstermin ist das Abbild seines Geburtstags, nicht sein
 *   Original: `syncBirthdayCalendarEvent` legt ihn beim nächsten Abgleich neu
 *   an und lädt ihn wieder hoch (server/services/birthdays.js).
 * - Ein Termin aus einem ICS-Abo ist doppelt unlöschbar: `OUTBOUND_SOURCES`
 *   kennt kein `ics`, es wird also nichts an der Quelle gelöscht, und der
 *   nächste Aboabruf legt ihn wieder an (kein Tombstone in ics-subscription.js).
 * - Bei Google, CalDAV und Apple greift die Löschung meistens bis zur Quelle
 *   durch - aber eben nur meistens: `acceptsOutbound` verlangt eine schreibende
 *   Verbindung, und ein Google-Konto im Nur-Lesen-Modus oder ein entferntes
 *   CalDAV-Konto hat keine. Der Dialog sagt deshalb NICHT mehr, dass die Serie
 *   auch im Quellkalender fällt; er sagt, was Yuvomi garantieren kann - dass
 *   alle Vorkommen fallen, nicht nur das angetippte. Das ist die Warnung, um
 *   die es hier geht. Alles Weitere wüsste erst der Server, und dafür eine
 *   Auskunft durch die Leseroute zu ziehen, wäre für eine Textnuance ein zu
 *   hoher Preis (heisser Pfad, expandierte Serien).
 *
 * Die drei Aufrufe stehen ausgeschrieben statt über einen zusammengesetzten
 * Schlüssel: `jeder als gefaehrlich markierte Dialog nennt seine Folgen`
 * (test-frontend-audit.js) liest den Schlüssel aus dem Aufruf und wäre an einem
 * `t(`${prefix}Detail`)` erblindet - bei einem Dialog, dessen ganzer Zweck es
 * ist, seine Folgen zu benennen, ist das der falsche Handel.
 *
 * `birthday_name` ist der etablierte Marker; die Leseroute hängt ihn nur an
 * Termine, die zu einem Geburtstag gehören.
 */
function confirmExternalSeriesDelete(event) {
  const title = event.title;
  if (event.birthday_name && event.birthday_event_kind === 'name_day') {
    return confirmModal(t('calendar.deleteNameDayEventTitle'), {
      detail:       t('calendar.deleteNameDayEventDetail', { title }),
      confirmLabel: t('calendar.deleteNameDayEventConfirm'),
      danger:       true,
    });
  }
  if (event.birthday_name) {
    return confirmModal(t('calendar.deleteBirthdayEventTitle'), {
      detail:       t('calendar.deleteBirthdayEventDetail', { title }),
      confirmLabel: t('calendar.deleteBirthdayEventConfirm'),
      danger:       true,
    });
  }
  if (event.subscription_id) {
    return confirmModal(t('calendar.deleteSubscribedSeriesTitle'), {
      detail:       t('calendar.deleteSubscribedSeriesDetail', { title }),
      confirmLabel: t('calendar.deleteSubscribedSeriesConfirm'),
      danger:       true,
    });
  }
  return confirmModal(t('calendar.deleteExternalSeriesTitle'), {
    detail:       t('calendar.deleteExternalSeriesDetail', { title }),
    confirmLabel: t('calendar.deleteExternalSeriesConfirm'),
    danger:       true,
  });
}

async function requestDeleteEvent(event) {
  if (syncMetadata(event).recovery) { await discardRecoveryChanges(event); return; }
  if (isExternalRecurringSeries(event)) {
    if (await confirmExternalSeriesDelete(event)) await deleteEvent(event.id);
    return;
  }
  if (!isLocalRecurringSeries(event)) {
    await deleteEvent(event.id);
    return;
  }
  const choice = await recurringDeleteChoice(event);
  if (choice === 'series') await deleteEvent(event.id);
  else if (choice === 'following') await deleteThisAndFollowing(event);
  else if (choice === 'this') await deleteSingleOccurrence(event);
  // null → abgebrochen, nichts tun
}

/**
 * Auswahl-Dialog für das Löschen wiederkehrender Termine (#532). Nutzt dieselbe
 * Scope-Komponente wie das Bearbeiten-Modal (Konsistenz) plus einen destruktiven
 * „Löschen"-Bestätiger. Löst zu 'this' | 'following' | 'series' | null.
 */
function recurringDeleteChoice(event) {
  const occDateKey = event.start_datetime.slice(0, 10);
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    };
    openSharedModal({
      title: t('calendar.deleteRecurringTitle'),
      size: 'sm',
      content: `
        ${renderRecurringScopeChooser('rds', occDateKey)}
        <div class="modal-actions modal-actions--stack">
          <button type="button" class="btn btn--danger" id="rds-confirm">${t('common.delete')}</button>
          <button type="button" class="btn btn--ghost" id="rds-cancel">${t('common.cancel')}</button>
        </div>`,
      onClose: () => finish(null),
      onSave(panel) {
        bindRecurringScopeChooser(panel, 'rds');
        panel.querySelector('#rds-confirm')?.addEventListener('click', () => finish(getRecurringScope(panel, 'rds')));
        panel.querySelector('#rds-cancel')?.addEventListener('click', () => finish(null));
      },
    });
  });
}

/**
 * Löscht dieses und alle folgenden Vorkommen einer lokalen Serie (#532), indem die
 * RRULE per UNTIL auf den Vortag gekürzt wird. Ist das geöffnete Vorkommen bereits
 * das erste der Serie, verschwindet sie ganz. Optimistisch + Undo.
 */
async function deleteThisAndFollowing(event) {
  // Am Anfang der Serie ist "dieser und folgende" die ganze Serie - warum das
  // nicht an `is_recurring_instance` allein haengt, steht bei der Funktion.
  if (followingMeansWholeSeries(event)) {
    await deleteEvent(event.id);
    return;
  }
  const fromKey = event.start_datetime.slice(0, 10);
  const newRule = truncateRuleBefore(event.recurrence_rule, fromKey);
  if (!newRule) { await deleteEvent(event.id); return; }

  scheduleCalendarDeleteWithUndo({
    state,
    deleteScope: { eventId: event.id, scope: 'following', occurrenceDate: fromKey },
    message: t('calendar.deletedToast'),
    schedule: scheduleUndoableDelete,
    requestDelete: async ({ keepalive }) => {
      await api.put(`/calendar/${event.id}`, { recurrence_rule: newRule }, { keepalive });
      // The former client-side loop patched recurrence_rule on the remaining
      // expanded rows. The authoritative range reload below now obtains the
      // truncated rule from the server instead of guessing that response.
    },
    isViewActive: () => Boolean(_container?.isConnected),
    reloadEvents: reloadCalendarRangeAfterDelete,
    handleError: (err) => window.yuvomi?.showToast(
      err.data?.error ?? t('calendar.deleteError'),
      'danger',
    ),
    render: renderView,
  });
}

/**
 * Nimmt genau ein Vorkommen einer lokalen Serie aus (#489), mit optimistischer
 * Entfernung und Undo-Toast wie beim regulären Löschen.
 */
async function deleteSingleOccurrence(event) {
  const date = event.start_datetime.slice(0, 10);
  scheduleCalendarDeleteWithUndo({
    state,
    deleteScope: { eventId: event.id, scope: 'this', occurrenceDate: date },
    message: t('calendar.deletedToast'),
    schedule: scheduleUndoableDelete,
    requestDelete: ({ keepalive }) => (
      api.post(`/calendar/${event.id}/exceptions`, { date }, { keepalive })
    ),
    isViewActive: () => Boolean(_container?.isConnected),
    reloadEvents: reloadCalendarRangeAfterDelete,
    handleError: (err) => window.yuvomi?.showToast(
      err.data?.error ?? t('calendar.deleteError'),
      'danger',
    ),
    render: renderView,
  });
}


const TASK_PANEL_SIZE = { min: 160, max: 480, initial: 280 };

function taskPanelStorageKey(userId) {
  return `yuvomi:calendar:task-panel:${userId}`;
}

function taskPanelPath(assignee) {
  return `/tasks/plannable${assignee ? `?assigned_to=${encodeURIComponent(assignee)}` : ''}`;
}

/** Panel discovery uses the permission-filtered public planning list. */
function renderTaskPanel() {
  const panel = _container.querySelector('#calendar-task-panel');
  if (!panel) return;
  panel.hidden = moduleAccess('tasks') !== 'write' || moduleAccess('calendar') !== 'write';
  if (panel.hidden) return;
  const workspace = panel.parentElement;
  workspace.dataset.taskPlacement = state.panelPlacement;
  panel.classList.toggle('is-collapsed', state.panelCollapsed);
  panel.style.setProperty('--task-panel-size', `${state.panelSize}px`);
  const save = () => {
    try { localStorage.setItem(taskPanelStorageKey(state.currentUserId), JSON.stringify({ placement: state.panelPlacement, collapsed: state.panelCollapsed, size: state.panelSize, duration: state.panelDuration })); } catch { /* Storage may be unavailable. */ }
  };
  const tasks = state.panelTasks.filter(task => task.title.toLocaleLowerCase().includes(state.panelSearch.toLocaleLowerCase())
    && (state.panelAllocation === 'all' || !task.session_count));
  panel.replaceChildren();
  panel.insertAdjacentHTML('beforeend', `<div class="calendar-task-panel__header"><h2 class="calendar-task-panel__title">${esc(t('calendar.taskPanel'))}</h2>
    <button type="button" id="task-panel-collapse" aria-expanded="${!state.panelCollapsed}">${esc(t(state.panelCollapsed ? 'calendar.panelExpand' : 'calendar.panelCollapse'))}</button></div>
    <div class="calendar-task-panel__content" ${state.panelCollapsed ? 'hidden' : ''}>
    <label>${esc(t('calendar.panelPlacement'))}<select id="task-panel-placement"><option value="beside">${esc(t('calendar.panelBeside'))}</option><option value="below">${esc(t('calendar.panelBelow'))}</option></select></label>
    <label>${esc(t('calendar.panelSize'))}<input id="task-panel-size" type="range" min="${TASK_PANEL_SIZE.min}" max="${TASK_PANEL_SIZE.max}" value="${state.panelSize}"></label>
    <label>${esc(t('calendar.sessionDuration'))}<input id="task-panel-duration" type="number" min="15" step="15" required value="${state.panelDuration}"></label>
    <label>${esc(t('calendar.panelSearch'))}<input id="task-panel-search" type="search" value="${esc(state.panelSearch)}"></label>
    <label>${esc(t('calendar.panelAssignee'))}<select id="task-panel-assignee"><option value="">${esc(t('calendar.panelMine'))}</option>${state.users.filter(u => u.id !== state.currentUserId).map(u => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('')}</select></label>
    <label>${esc(t('calendar.panelAllocations'))}<select id="task-panel-allocation"><option value="all">${esc(t('calendar.panelAll'))}</option><option value="unscheduled">${esc(t('calendar.panelUnscheduled'))}</option></select></label>
    <p class="calendar-task-panel__hint">${esc(t('calendar.taskDragHint'))}</p>
    <div class="calendar-task-panel__cards">${tasks.map(task => `<button type="button" class="calendar-task-card" draggable="true" data-plannable-task-id="${task.id}"><i data-lucide="check-square" class="icon-sm" aria-hidden="true"></i><span>${esc(task.title)}</span></button>`).join('') || `<p class="calendar-task-panel__hint">${esc(t('tasks.emptyTitle'))}</p>`}</div></div>`);
  panel.querySelector('#task-panel-collapse').onclick = () => { state.panelCollapsed = !state.panelCollapsed; save(); renderTaskPanel(); };
  panel.querySelector('#task-panel-placement').value = state.panelPlacement;
  panel.querySelector('#task-panel-placement').onchange = event => { state.panelPlacement = event.target.value; save(); renderTaskPanel(); };
  panel.querySelector('#task-panel-size').oninput = event => { state.panelSize = Number(event.target.value); panel.style.setProperty('--task-panel-size', `${state.panelSize}px`); save(); };
  panel.querySelector('#task-panel-duration').onchange = event => { if (event.target.checkValidity()) { state.panelDuration = Number(event.target.value); save(); } else event.target.value = state.panelDuration; };
  panel.querySelector('#task-panel-search').oninput = event => {
    const position = event.target.selectionStart;
    state.panelSearch = event.target.value; renderTaskPanel();
    const input = panel.querySelector('#task-panel-search'); input.focus(); input.setSelectionRange(position, position);
  };
  panel.querySelector('#task-panel-allocation').value = state.panelAllocation;
  panel.querySelector('#task-panel-allocation').onchange = event => { state.panelAllocation = event.target.value; renderTaskPanel(); };
  panel.querySelector('#task-panel-assignee').value = state.panelAssignee;
  panel.querySelector('#task-panel-assignee').onchange = async event => {
    const assignee = state.panelAssignee = event.target.value;
    const request = ++state.panelRequest;
    try {
      const res = await api.get(taskPanelPath(assignee));
      if (state.panelRequest === request && panel.isConnected) { state.panelTasks = res.data; renderTaskPanel(); }
    } catch (error) { window.yuvomi?.showToast(error.message, 'danger'); }
  };
  panel.ondragstart = event => {
    const card = event.target.closest('[data-plannable-task-id]');
    if (!card || !window.matchMedia('(min-width: 1024px)').matches) { event.preventDefault(); return; }
    event.dataTransfer.setData('application/x-yuvomi-task', card.dataset.plannableTaskId);
    event.dataTransfer.effectAllowed = 'copy';
  };
  for (const card of panel.querySelectorAll('[data-plannable-task-id]')) card.onclick = () => openTaskFromCalendar(card.dataset.plannableTaskId);
}

function renderSessionCheckbox(event) {
  if (!event.task_id) return '';
  const disabled = event.session_status === 'completed' || moduleAccess('tasks') !== 'write' || moduleAccess('calendar') !== 'write';
  return `<input type="checkbox" data-session-complete="${event.id}" aria-label="${esc(t('calendar.sessionComplete'))}" ${event.session_status === 'completed' ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${event.session_status === 'completed' && moduleAccess('tasks') === 'write' && moduleAccess('calendar') === 'write' ? `<button type="button" class="btn btn--secondary" data-session-reopen="${event.id}">${esc(t('calendar.sessionReopen'))}</button>` : ''}`;
}

function bindSessionCompletion(container, events = state.events) {
  for (const button of container.querySelectorAll('[data-session-reopen]')) {
    button.onkeydown = event => event.stopPropagation();
    button.onclick = async event => {
      event.stopPropagation();
      const session = events.find(item => String(item.id) === button.dataset.sessionReopen);
      if (!session || button.disabled) return;
      button.disabled = true;
      try {
        await api.post(`/tasks/${session.task_id}/sessions/${session.id}/reopen`, {});
        await loadRange(state.rangeFrom, state.rangeTo); renderView();
      } catch (error) { button.disabled = false; window.yuvomi?.showToast(error.data?.error || t('calendar.saveError'), 'danger'); }
    };
  }

  for (const checkbox of container.querySelectorAll('[data-session-complete]')) {
    checkbox.onclick = event => event.stopPropagation();
    checkbox.onkeydown = event => event.stopPropagation();
    checkbox.onchange = async () => {
      const session = events.find(event => String(event.id) === checkbox.dataset.sessionComplete);
      if (!session) return;
      checkbox.disabled = true;
      try {
        const { data: completed } = await api.post(`/tasks/${session.task_id}/sessions/${session.id}/complete`, {});
        Object.assign(session, completed);
        await loadRange(state.rangeFrom, state.rangeTo); renderView();
      } catch (error) { checkbox.checked = false; checkbox.disabled = false; window.yuvomi?.showToast(error.data?.error || t('calendar.saveError'), 'danger'); }
    };
  }
}

function bindTaskSessionDrops(container) {
  for (const col of container.querySelectorAll('.week-view__col, .day-view__col, .month-day[data-date], .allday-cell[data-date]')) {
    col.addEventListener('dragover', event => {
      if (!event.dataTransfer.types.includes('application/x-yuvomi-task') || !window.matchMedia('(min-width: 1024px)').matches) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
      col.classList.add('is-task-drop-target');
    });
    col.addEventListener('dragleave', () => col.classList.remove('is-task-drop-target'));
    col.addEventListener('drop', async event => {
      col.classList.remove('is-task-drop-target');
      const taskId = event.dataTransfer.getData('application/x-yuvomi-task');
      if (!/^\d+$/.test(taskId) || !window.matchMedia('(min-width: 1024px)').matches) return;
      event.preventDefault(); event.stopPropagation();
      const refresh = async () => { await loadRange(state.rangeFrom, state.rangeTo); renderView(); };
      if (col.matches('.month-day, .allday-cell')) {
        openTaskSessionEditor({ taskId, date: col.dataset.date, duration: state.panelDuration, onChanged: refresh });
        return;
      }
      try {
        const { data: targets } = await api.get(`/tasks/${taskId}/session-targets`);
        if (targets.explicit_required) {
          openTaskSessionEditor({ taskId, date: col.dataset.date, time: clickedTime(event, col), duration: state.panelDuration, onChanged: refresh });
          return;
        }
        await api.post(`/tasks/${taskId}/sessions`, {
          start_datetime: `${col.dataset.date}T${clickedTime(event, col)}`,
          duration_minutes: state.panelDuration,
          tzid: displayTimeZone() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        });
        await loadRange(state.rangeFrom, state.rangeTo);
        renderView();
      } catch (error) { window.yuvomi?.showToast(error.data?.error || error.message, 'danger'); }
    });
  }
}
