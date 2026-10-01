# Calendar implementation checkpoint

Recorded 2026-09-22 after the final independent review. This is a status record, not a change to the approved requirements.

The full calendar drag-and-resize implementation is present, but the feature is **not complete or ready for release**. Standards review passed; specification review has six blocking findings. The invoked implement-reviewed workflow permits two correction cycles, both now used. Further implementation was stopped at that checkpoint.

## Implemented and exercised

Mouse movement and resizing, the 15-minute grid, all-day conversion, duration and grabbed-segment handling, recurring scope selection, exception display, read-only controls, revision checks, reminder offsets, and timezone handling are implemented. The existing calendar API now coordinates scoped changes and provider work. Google and CalDAV adapters, queue recovery, migrations 194/195, API documentation, translations, and regression tests were added or extended.

The principal changed areas are `public/pages/calendar.js`, `public/utils/calendar-edit.js`, `public/styles/calendar.css`, `public/utils/timezone.js`, the calendar route modules, `server/services/calendar-edit*.js`, the Google/CalDAV/Apple provider services, database schema/migrations, OpenAPI, and calendar/provider tests. The exact reviewed inventory is in `.cache/calendar-reviewed/review-v3/inventory.txt`.

## Unresolved specification findings

- **SPEC003, high:** A repeated edit to a detached Google occurrence can send the parent series ETag instead of the occurrence ETag, causing a false conditional-write conflict.
- **SPEC005, critical:** Reload after a failed following-series split does not reconcile the parent and local continuation together. An orphan continuation can remain pending beside the original provider series.
- **SPEC010-A, critical:** A CalDAV following split can omit future EXDATE-only exceptions, causing canceled occurrences to reappear.
- **SPEC010-B, high:** If CalDAV accepts truncating the old series but its response is lost, retry does not recognize that accepted change and can become a permanent conflict.
- **SPEC011, critical:** Inbound matching does not include checkpointed continuation identities. Partial provider success can therefore import a duplicate local continuation before retry completes.
- **SPEC012, high:** Queue completion and provider-identity reconciliation are not one transaction. A crash after marking an operation completed can leave identities unreconciled with no retry path.

The final detailed specification report, including exact locations and suggested tests, is `.cache/calendar-reviewed/review-spec-v3.md`. These findings remain open; passing mocks do not supersede them.

## Validation and independent review

Implementation agents were configured as Luna with maximum reasoning. The independent standards reviewer used Sol with medium reasoning; the independent specification reviewer used Sol with extra-high reasoning. These are tool configuration records, not claims of separate runtime verification.

- Standards: **no blocking findings**, all six prior standards findings resolved.
- Specification: **blocking findings**, the six cases above remain.
- Full runner: `node .cache/calendar-reviewed/run-checks.mjs cycle2-full all`, exit 1; **284 of 307 command groups passed**. Twenty-one failures match the untouched baseline. A calendar route-table failure was corrected afterward and its focused structure and OpenAPI checks each passed 5/5. One additional recipe layer-boundary failure belongs to concurrent work and remains unresolved outside this calendar stage.
- Focused provider preflight: six command groups passed, including scoped route and provider lifecycle tests.
- Browser/API checks: mouse gestures 7/7, detached parent rule editing 4/4, normal recurrence add/change/remove 3/3, explicit scope decision 2/2, reopened detached title-only editing 3/3, API recurrence/reminder/DST checks 8/8, and conflict Reload UI 1/1. The last check uses a mocked API; provider readback has separate fixture coverage.
- Retained evidence for unchanged behavior: recurring chooser/cancel/edge navigation 3/3, all-day resize/rollback 2/2, German light/dark inspection 2/2.
- JavaScript syntax: 40/40 changed files passed, including concurrently present non-calendar files. Diff whitespace checks passed.
- Live Google and mailbox.org accounts were not tested. Baseline failures have not been accepted as exceptions by the user.

Raw commands, logs, browser probes, and comparison records are under `.cache/calendar-reviewed/`. The final reviewed snapshot is `review-v3/manifest.json`, identity:

`e3051d9361b2f500137f3063965b7c0044fb5f57cd1c588681fc2b343b7258ea`

The starting commit was `b8ce81bf9ced01c9b8545432a30872fdc5982b50`. Unrelated Bring/recipe work and the original `idea.md` were preserved, including shared-file hunks. Nothing was staged, committed, pushed, or deployed by this task.

## User comments

Only German and English translations are required for this fork. Other locales may receive English text when matching keys are necessary; existing translations should be preserved. This preference is recorded separately in `docs/fork-preferences.md`.

The comment in `test/test-calendar-structure.js` was already German at the starting upstream commit. This work updated its route count and expected route table; it did not introduce the German prose.
