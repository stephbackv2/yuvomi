# Calendar direct manipulation specification

This document records the agreed behavior for calendar moving, resizing, and
recurring editing. Implementation readiness is established separately by tests
and review; this specification alone does not certify provider compatibility.

## Moving and resizing

Mouse users can move events in month, week, and day views. Timed events have
start/end resize handles in week and day views. All-day spans have start/end
handles in month and week views. Agenda remains an editing list; touch users
continue to use the existing editor.

Creation, movement, and resizing use a 15-minute grid. Timed events cannot be
resized below 15 minutes; all-day events cannot be shorter than one date. Moving
preserves duration, including the position grabbed within a multi-day event:
Monday-Wednesday grabbed on Tuesday and dropped on Friday becomes Thursday-Saturday.
Resizing one edge leaves the other edge fixed. Timed events may cross midnight.

Dropping a timed event into the all-day area preserves the number of dates it
occupies. Dropping an all-day event into the time grid creates a one-hour event.
Only moving the body converts the event type; resizing never does. The preview
shows the resulting dates and times.

Dragging near the time-grid boundary scrolls it. Holding near a calendar's left
or right edge for 700 ms navigates to the adjacent period, with a visible
indicator and repeated navigation while held. Both moving and resizing survive
the navigation. Escape, cancellation, or an invalid drop saves nothing.

## Recurring events

After every actual recurring change, including title/location edits in the
ordinary editor, the user chooses:

- Only this occurrence (the default).
- This occurrence and all following occurrences.
- The entire series.

Cancelling the choice saves nothing. Series moves apply the time/date shift to
the ordinary schedule; series resizing adjusts the selected edge. Individually
edited exceptions remain unchanged. The dialog shows an exception count and an
expandable list of original and current occurrence dates/times. An incomplete
list must be identified as incomplete. Overlaps are permitted with a warning.
An existing exception can edit its parent series only when that parent can be
identified reliably; otherwise only the individual occurrence is offered with
an explanation.

Local calendars, Google Calendar, and mailbox.org CalDAV are in scope. A separate
Morgen integration is not required. Unsupported provider behavior must never
silently substitute an entire-series edit for a narrower selection.

## Saving and synchronization

The server remains authoritative. The frontend uses the existing Yuvomi event
update API and its provider synchronization infrastructure. Ordinary edits save
without confirmation. Read-only remote calendars reject normal editing as well
as moving/resizing, with an explanation rather than an implicit local override.

An event's reminder offsets remain relative to its start. Moving only the end
leaves reminders unchanged. Time interpretation uses the calendar/display
timezone; recurring wall-clock times remain stable over daylight-saving changes,
while ordinary timed moves preserve elapsed duration.

Local persistence and remote acceptance are distinct. A saved event remains in
place while synchronization is pending. Failures remain visible and offer retry.
An API save failure clears the preview and retains the prior state. Concurrent
changes are detected before overwriting and require reload/retry. There is no
Undo action in this feature.

Provider acceptance includes the returned master and detached occurrence identities.
A following split can resume after partial success or a lost response without
creating another continuation. Inbound synchronization protects unfinished work
using its durable provider checkpoints. Reload after a rejected first split write
restores the original series and its exceptions; it preserves any continuation
already accepted remotely and any newer active edits. Accepted identities and the
completed sync state become durable together. If a newer series edit exists on a
continuation whose first provider write was rejected, Reload retains that newer
intent and its local identity. After authoritative parent readback, the server
regenerates only the chosen following range using the refreshed provider revision;
earlier occurrences retain the authoritative parent data. Accepted detached
exception identities are adopted during Reload before inbound protection is
released, preserving local assignments, reminders, and newer exception edits.

Newer detached-occurrence and nested following edits also wait for the refreshed
parent. Recovery rebuilds their selected range, explicit changed fields, and split
snapshots through the ordinary scoped edit service. It does not replay a rejected
shift or title from the discarded split. Dependent writes remain fenced until the
recovered parent is accepted. A recovery at the parent's first remaining occurrence
keeps the authoritative parent row, assignments, reminders, and audit references.
Recovery compares deliberate changes with the selected occurrence before the
newer edit. An ordinary editor submission containing every field has the same
effect as a minimal patch: unchanged fields, recurrence counts and assignments
keep refreshed authoritative values. Independent provider changes merge. A
genuine incompatible change to the same field pauses recovery and shows both
values in Review changes; the user chooses which value to keep. Cancellation
keeps the unsaved changes, and stale choices require another review. The rollback
of the discarded earlier edit alone never creates a conflict.

Review includes deliberate changes from all unresolved newer operations on the
retained event. A later independent edit cannot hide an earlier conflict. Choices
use the latest deliberate value for each field; superseded values are not replayed.
If one conflict has been resolved while another remains, the remaining choice
stays visible and the resolved choice and independent changes remain retained.
Each authoritative refresh also clears a conflict that has disappeared, while
keeping its deliberate local intent. The remaining conflicts use the current
revision, so an obsolete field decision cannot block another actionable choice.
A local choice applies to the provider field value displayed during that review.
If a later readback changes that field incompatibly again, Review asks again;
an unchanged value does not invalidate the choice. Choosing the provider value
continues to use refreshed authority. Dates and time boundaries in retained
changes and conflict alternatives use the calendar's date and 24-hour time
presentation; all-day boundaries show dates only, using each alternative's
all-day context. Presentation does not change stored values or choice payloads.

Newer moves and manual time edits retain their absolute chosen interval, including
the latest dragged duration. Resizing retains the absolute changed edge and uses
the refreshed untouched edge. Recovery never shifts a newer target by the old
discarded move. Scope and original occurrence identity remain separate from the
new date: series edits stay within the original continuation and nested following
edits keep their later cutoff. Invalid recovered intervals remain visible with
an error rather than being silently adjusted.

If recurrence removal, shortening or remote deletion removes the selected target,
the newer local changes remain visible with a nonretryable recovery error. Review
changes displays retained fields and changed assignments and can open the original
event when available. The user may choose an existing occurrence for a fresh
ordinary edit; recovery never recreates or retargets the event automatically.
Discard unsaved changes retires and fences the local queued work without deleting
the authoritative provider resource or parent series. Ordinary Delete is guarded
on unresolved recovery entries. Discard survives repeated requests, reopening and
stale workers.

An uncertain CalDAV continuation that later changes remotely remains a conflict.
After explicit Reload, authoritative resource readback adopts only the master and
detached identities actually present in that resource. Adoption happens atomically
before inbound protection and pruning are released. A failed adoption retains the
original local rows and metadata for another readback; it never records an
attempted write as accepted.

A successful complete authoritative CalDAV collection fetch proving an uncertain
continuation absent removes the leftover optimistic local copy after Reload when
no newer intent exists. Failed, partial, incremental or insufficient fetches cannot
prove absence. When newer changes exist, the same absence produces the retained
recovery error and Review/Discard actions instead.

Completeness requires successful, well-formed DAV multistatus responses and all
queried resources returned by the object fetch. An HTTP-success gateway page,
malformed or truncated XML, failed properties, or an incomplete multiget cannot
prove absence. The installed client retains that response provenance before
flattening its result into calendar objects; a plain empty array is insufficient.

When a following edit converts between timed and all-day, transferred CalDAV
cancellations use the continuation's DTSTART value type. Compatible DATE, TZID,
and UTC forms retain their timezone behavior across rebasing and daylight-saving
changes. DATE-to-timed cancellations use the same civil-date shift in provider
EXDATEs and route exception metadata, preserving one canceled occurrence at morning
or afternoon times and after repeated inbound. Local all-day endpoints remain inclusive and provider DATE endpoints
remain exclusive.

## Verification requirements

Tests cover local and provider-backed saves; recurring scopes and exceptions;
read-only and concurrent updates; reminders; timezones and daylight-saving
boundaries; duration, conversions, snapping, and cancellation. Browser checks
exercise real mouse gestures, edge navigation, ordinary editing, and persistence
after reloading. Provider tests use isolated mocks rather than household accounts.
Live Google/mailbox.org acceptance, when not exercised, must be reported as an
external verification requirement rather than a completed check.
