# Calendar sync follow-up

Created: 2026-09-22

## Purpose and current state

Continue the calendar drag-and-resize feature by resolving the six remaining specification blockers below. The interaction implementation is present, but the full feature is **not ready for release**. Standards review passed; specification review remained blocked.

The previous `implement-reviewed` invocation stopped after its two permitted correction cycles. This document preserves the remaining work for a later, separately requested implementation stage. No further fixes, commits, or deployment are authorized merely by creating this handoff.

Read these durable documents first:

- [Approved calendar behavior](calendar-direct-manipulation.md)
- [Implementation checkpoint and validation history](calendar-implementation-status.md)
- [Fork preferences](fork-preferences.md)

This handoff contains the essential findings and regression scenarios itself. Local evidence under `.cache/calendar-reviewed/` is supplementary and may not survive a fresh checkout.

## Preserve the accepted behavior

- Mouse dragging in month/week/day views and conventional event resizing.
- A 15-minute grid, minimum durations, duration preservation, grabbed-segment offsets, all-day conversion, and navigation while dragging.
- Recurring edits offer this occurrence, this and following, or the whole series; default to this occurrence and never silently broaden an edit. Recurrence-rule changes require an explicit valid scope before saving.
- Local, Google, and mailbox.org CalDAV support; read-only calendars remain protected.
- Preserve existing exceptions, reminder offsets, timezone/DST behavior, and the existing API save path.
- Distinguish local persistence from provider acceptance and expose meaningful conflict/retry recovery.
- German and English translations are required. Other locales may use English where matching keys are needed; preserve existing translations.

## Open findings and required regression coverage

Line references identify the reviewed snapshot and may move. Locate the current symbols before editing. Each item remains open until its failure scenario is demonstrated and the correction is independently reviewed.

### 1. SPEC003: Google occurrence revision on repeated edits

**Severity: high.** A second edit to an individually edited Google occurrence can send the parent series ETag instead of the occurrence ETag, causing a false HTTP 412 conflict.

The route constructs the provider payload from the recurrence parent. The adapter adds the occurrence ID but retains the parent ETag. `findGoogleOccurrence()` skips fetching the occurrence when an ETag is already present, and the PATCH then uses that incorrect value as `If-Match`.

Relevant locations:

- `server/services/calendar-edit.js`: reviewed lines 940 and 1136-1145
- `server/services/google-calendar.js`: `operationProvider()`, `findGoogleOccurrence()`, occurrence PATCH; reviewed lines 467-502, 593-613, 900-925
- `test/test-calendar-provider-lifecycle.js`: reviewed lines 259-281

Required proof:

- [ ] Create both edits through the real calendar route, rather than constructing a provider payload by hand.
- [ ] Give the parent and occurrence distinct ETags.
- [ ] Return `"occurrence-v2"` from the first occurrence update.
- [ ] Require the second PATCH to use that occurrence ETag and reject the parent ETag in the mock.
- [ ] Preserve genuine conflict detection if the occurrence changes externally.

The existing test checked the second PATCH event ID but omitted its conditional header.

### 2. SPEC005: Reload after a failed following-series split

**Severity: critical.** Reload can leave an orphan local continuation pending beside the original provider series.

A following edit creates a local continuation and queues it as `event_id`, with the original series in `parent_event_id`. If the first provider write conflicts, the remote series is still unsplit. Resolution/readback tracks only the continuation, while the incoming remote master maps to the parent row. The two-row optimistic split does not converge back to provider truth.

Relevant locations:

- `server/services/calendar-edit.js`: reviewed lines 1015-1040 and 1118-1155
- `server/services/calendar-edit-operations.js`: `resolveCalendarEditConflict()` and readback handling; reviewed lines 538-602
- `server/routes/calendar/edit.js`: `POST /:id/reload-sync`, reviewed lines 201-233
- `test/test-calendar-scoped-edits.js`: existing series-only conflict coverage, reviewed lines 658-715

Required proof:

- [ ] Submit a following edit through the route and force a 412 on the first old-master write.
- [ ] Invoke the explicit Reload action for that operation.
- [ ] Deliver the authoritative unsplit master through normal inbound synchronization.
- [ ] Reconcile or roll back the optimistic split: no orphan continuation, no duplicate events, and no permanently pending row.
- [ ] Preserve unrelated edits, exceptions, and active sibling operations; do not blindly delete a continuation that may already exist remotely.

The current green test covers a one-row whole-series conflict, not a following split.

### 3. SPEC010-A: Preserve CalDAV EXDATE-only exceptions

**Severity: critical.** Previously canceled future occurrences can reappear in the continuation after a following split.

The real route represents an exclusion without a detached row as a `delete` entry in `split.exception_operations`. It does not provide `exception_components`. The continuation builder removes EXDATE properties, the component splitter transfers detached VEVENTs only, and the later operation loop returns identity metadata without restoring those exclusions.

Relevant locations:

- `server/services/calendar-edit.js`: exception operation generation, reviewed lines 436-508 and 1121-1134
- `server/services/caldav-outbound.js`: `componentFromMaster()`, `splitFollowingExceptions()`, continuation construction; reviewed lines 713-727, 747-771, 1006-1027, 1109-1128
- `test/test-caldav-outbound.js`: reviewed lines 1350-1359 contain manually supplied exception components

Required proof:

- [ ] Create a route-level following split with a future EXDATE and no detached event row.
- [ ] Inspect the actual generated continuation resource, not a hand-authored payload.
- [ ] Preserve the exclusion in the correct date or timezone form, including any rebasing required by moving the series.
- [ ] Expand/read back the continuation and confirm the canceled occurrence does not reappear.
- [ ] Retain the fixed rule that every CalDAV resource contains components sharing one UID.

### 4. SPEC010-B: Recover a remotely accepted CalDAV write with a lost response

**Severity: high.** A successful old-master truncation can become a permanent conflict if its response is lost.

Progress is checkpointed only after `updateCalendarObject()` returns. If the provider accepts the request but the response is lost, the checkpoint still says incomplete. Retry fetches the changed ETag and rejects it against the queued old ETag instead of recognizing the already-applied desired state.

Relevant locations:

- `server/services/caldav-outbound.js`: reviewed lines 977-981 and 1052-1068
- `test/test-caldav-outbound.js`: retry coverage around reviewed line 1413 starts after a successful checkpoint

Required proof:

- [ ] Make a strict mock apply the old-resource PUT, update its body/ETag, then throw a transport error before returning the response.
- [ ] Retry using the resulting remote body/ETag with no successful local checkpoint for that write.
- [ ] Recognize the accepted truncation and continue without duplicating the continuation or entering a false conflict.
- [ ] Still reject a genuinely different external edit; do not solve this by dropping conditional-write protection.

### 5. SPEC011: Use checkpointed identities during inbound synchronization

**Severity: critical.** Partial provider success can cause an incoming sync to import a duplicate continuation before retry completes.

Adapters record accepted continuation IDs in `progress_json`, but generic and provider-specific active-operation identity matching reads payload/provider/local-row identities only. Before completion, the local continuation can lack its external ID. Incoming synchronization then fails to recognize the newly created remote series.

Relevant locations:

- `server/services/calendar-edit-operations.js`: active-operation identity handling, reviewed lines 147-170
- `server/services/google-calendar.js`: reviewed lines 505-514, 997-1006, 1630-1632, 1754-1758
- `server/services/caldav-outbound.js`: reviewed lines 1032-1106
- `server/services/caldav-sync.js`: reviewed lines 697-710 and 1028-1033

Required proof, separately for Google and CalDAV:

- [ ] Create a continuation remotely and record the accepted identity in durable progress.
- [ ] Fail a later step before operation completion.
- [ ] Run inbound synchronization **before retry**.
- [ ] Match/protect the existing local continuation using the checkpointed identity; exactly one local continuation must remain.
- [ ] Retry and complete without a second remote insertion or duplicate local row.
- [ ] Cover uncertain create responses/readback as well as ordinary failures after a successful checkpoint.

### 6. SPEC012: Make completion and identity reconciliation atomic

**Severity: high.** A crash can leave an operation permanently completed while its provider identities are still missing locally.

`completeCalendarEditOperation()` updates the completed status before separately storing the provider result, event/exception identities, and sync state. Those writes are not one transaction. An exception or process failure after the first write leaves completed work that will never be retried. Existing claim fencing prevents stale workers from winning but does not close this crash window.

Relevant locations:

- `server/services/calendar-edit-operations.js`: `completeCalendarEditOperation()`, reviewed lines 459-494
- Provider follow-up reconciliation in `server/services/google-calendar.js`: reviewed lines 1085-1091
- Provider follow-up reconciliation in `server/services/caldav-sync.js`: reviewed lines 782-791

Required proof:

- [ ] Treat the fenced status change, accepted provider result, local identities, exception identities, and sync state as one atomic database transition, or provide an explicitly recoverable equivalent.
- [ ] Inject failure immediately after the completed-status update and restart/reopen the database.
- [ ] Show that the operation remains retryable or reliably recovers the accepted identities.
- [ ] Run inbound synchronization afterward and confirm no duplicates.
- [ ] Retain claim-token/generation checks: stale completion, failure, and progress must remain no-ops.

## Suggested continuation order

1. Inspect the current working tree and preserve all existing work. Reproduce the failures before changing assertions.
2. Address atomic completion and checkpoint identity matching (SPEC012/SPEC011), since the other recovery paths depend on them.
3. Fix split conflict resolution and the CalDAV exclusion/lost-response cases (SPEC005/SPEC010-A/SPEC010-B).
4. Fix Google occurrence ETag selection (SPEC003); this can be handled independently with non-overlapping ownership.
5. Run focused regressions, then the relevant existing browser and broader checks. Have both independent reviewers assess the final substantive snapshot.

This ordering is a suggestion, not a replacement for inspecting dependencies in the current code.

## Tests and evidence

Important existing suites:

```text
test/test-calendar-scoped-edits.js
test/test-calendar-provider-lifecycle.js
test/test-google-outbound.js
test/test-caldav-outbound.js
test/test-caldav-sync.js
test/test-calendar-direct-manipulation.js
test/test-calendar-structure.js
test/test-openapi-structure.js
test/test-schema-mirror.js
test/test-migrations-append-only.js
```

Use the repository's current package scripts and disposable database setup. Tests must exercise route-generated payloads, strict conditional headers, real lifecycle ordering, and remote-success/local-failure sequences. Do not make mocks accept invalid data to obtain green results.

Previous environment: Windows PowerShell, Node 24.18.0, installed Microsoft Edge with the existing Puppeteer harness `test/document-guards-harness.js`. Some package scripts use POSIX environment prefixes and need an equivalent Windows invocation. No dependency versions were changed. No live Google or mailbox.org account was used.

Previous results, **not a guarantee about a later checkout**:

- Standards review: no blocking findings; specification review: six blockers above.
- Full run: 284/307 command groups passed. Twenty-one failures matched the original baseline. One calendar route-table failure subsequently passed focused checks; one recipe layer-boundary failure belonged to concurrent work.
- Mouse, scope-editor, exception-editor, reminder/DST, and conflict-UI probes passed, but did not cover the six provider failure sequences adequately.
- Baseline failures were not accepted as exceptions. Do not declare a later combined workspace green by reusing this baseline label without checking the actual failures.

If still available, `.cache/calendar-reviewed/` contains the final review reports, baseline and final logs, browser scripts, shared contracts, and `review-v3/manifest.json`. Cache loss must not erase the open findings in this document.

## Workspace and review checkpoint

Original implementation base commit:

`b8ce81bf9ced01c9b8545432a30872fdc5982b50`

Final reviewed snapshot identity:

`e3051d9361b2f500137f3063965b7c0044fb5f57cd1c588681fc2b343b7258ea`

That snapshot covered 61 files. The implementation was uncommitted and the index empty at the checkpoint. A commit ID alone therefore does not contain the feature. Check the current state before resuming; do not reset, clean, stash, or overwrite the working tree to recreate this checkpoint.

Concurrent Bring and recipe-import work must be preserved. Shared files include package scripts, locales, service-worker entries, and translation baselines; distinguish calendar changes from recipe changes. The original `idea.md` also remains separate from this follow-up.

The previous requested team was Luna/max for implementation, Sol/medium for standards review, and Sol/xhigh for specification review. The user requested checking implementation agents no more often than every five minutes, except when they return with an actual question. Retain these preferences unless later instructions change them.

## Completion criteria for the follow-up

- [ ] All six findings have failure-reproducing regression coverage and verified fixes.
- [ ] Previously accepted calendar interactions and provider/read-only behavior still work.
- [ ] Both independent reviews cover the final snapshot and have no unresolved blockers.
- [ ] Baseline failures, unrelated failures, and unverified live-provider behavior are reported separately and honestly.
- [ ] Unrelated work and the index are preserved.
- [ ] Commit, push, and deployment remain separate from this implementation handoff.

## Round-1 follow-up candidate (2026-10-01)

The initial separately authorized follow-up was frozen for independent round-1
specification and standards review. The historical findings, checklists, and
previous validation results above remain the handoff baseline. They are not a
claim that the current combined workspace is ready for release.

| Finding | Candidate behavior | Regression evidence |
| --- | --- | --- |
| SPEC003 | Route payloads capture the detached Google occurrence revision independently from the parent revision. Later inbound metadata cannot rebase the queued conditional write. | Strict second occurrence PATCH, plus a genuine external occurrence conflict. |
| SPEC005 | Reload rolls back an unaccepted local continuation, restores its moved exceptions, and associates readback with the surviving parent. Newer operations and accepted provider continuations are protected. | First Google old-master 412, explicit route Reload and normal inbound; active parent sibling and unrelated exception preservation; accepted continuation Reload; CalDAV unsplit readback. |
| SPEC010-A | CalDAV splits transfer future EXDATE exclusions in DATE, TZID, or UTC form and retain a single UID per resource. | Route-generated delete exception operations; actual continuation resource parsing and local expansion after inbound; UTC exclusion rebasing across DST. |
| SPEC010-B | A durable attempted-body checkpoint recognizes an accepted old-resource PUT after its response is lost. Different remote bodies still conflict. | Strict mock changes the remote body/ETag then throws; retry succeeds without another old PUT; different external changes remain conflicts. |
| SPEC011 | Inbound matches durable checkpoint identities, uncertain Google insert markers, and intended CalDAV continuation IDs. Active local rows also survive CalDAV pruning. | Google and CalDAV inbound before retry, for successful checkpoints and lost create responses; exactly one continuation and one remote insert. |
| SPEC012 | A fenced SQLite savepoint makes completion status, provider result, local and exception identities, and sync state atomic. | Failure immediately after the status write, database close/reopen, inbound without duplicates, replacement claim recovery, and stale completion/failure/progress rejection. |

These cases live in `test/test-calendar-provider-lifecycle.js` and use the actual
calendar routes and existing provider injection seams. That frozen 18-test suite
passes; rerunning it in a disposable source copy with the captured stage-start
production files yields 14 failures, reproducing the six blocker categories.
The existing scoped-edit, Google outbound, CalDAV outbound, and CalDAV sync suites
also pass the focused checks. Broad validation and independent review remain
required. Live Google/mailbox.org acceptance has not been exercised.

## Correction-1 candidate (2026-10-01): independent review pending

Both round-1 reviews completed. Standards found STDF001: the lifecycle fixture
started a server instead of invoking route handlers directly. Specification
found three additional failure sequences within SPEC005 and SPEC010-A. Their
original reports and evidence remain preserved; this correction has not yet
received independent approval.

| Round-1 finding | Correction behavior and regression |
| --- | --- |
| STDF001 | The lifecycle suite invokes the actual route stacks with authentication context. A Node module mock records the route's refresh request without launching background network work. Actual inbound runs through the existing provider seams. Only this suite's package command gains `--experimental-test-module-mocks`. |
| SPEC005-R1-1 | A newer child-series edit waits for concrete authoritative unsplit parent readback. The standard edit orchestration regenerates the selected tail using the fresh revision, preserves its local ID, assignments and reminders, and replaces the unsendable operation with an auditable recovery operation. Google and CalDAV regressions complete the new provider operation and preserve earlier parent occurrences. |
| SPEC005-R1-2 | Reload adopts accepted continuation and detached-exception identities atomically. Google partial transfer followed by a second exception conflict cannot duplicate the accepted row on repeated inbound; newer exception intent can complete against the new occurrence ID and its own accepted ETag. CalDAV accepted resources containing detached VEVENTs reuse their original local rows; an identity-adoption fault rolls the whole Reload transaction back. |
| SPEC010-A-R1-1 | Transferred EXDATE values match the continuation DTSTART type when converting timed/all-day. Both conversion directions, rebasing, TZID/UTC exclusions, DST, single-UID resources, repeated inbound, cancellation expansion, and inclusive-local/exclusive-provider all-day endpoints are covered. |

The final direct-handler lifecycle suite contains 28 cases. The correction
candidate passes all 28; the same tests with exact captured round-1 production
pass 18 and fail 10, and with exact captured stage-start production pass 4 and
fail 24. The captured provider and route files are restored byte-for-byte only
inside disposable cache source copies; the live workspace is never reset.
The six original blocker regressions remain in the suite. Existing scoped-edit,
Google outbound, CalDAV outbound, CalDAV sync, direct-manipulation, route/OpenAPI
structure, schema-mirror and append-only migration checks pass the focused run.

Fresh correction evidence is under
`.cache/calendar-reviewed/followup-20261001/correction1/`: the finding map,
command metadata, raw red/green logs and changed-path inventory are separate from
the immutable round-1 packet. Broad validation and both independent re-reviews
remain required. Live household provider acceptance remains unverified.

## Correction-2 candidate (2026-10-01): independent review pending

Both correction-1 reviews completed against the exact round2-final snapshot.
Standards were clear. Specification reproduced five further recovery and conversion
sequences. The historical reports, source snapshots, red/green logs and candidate
statements above remain intact. This final permitted correction cycle is a new
candidate awaiting independent review; it does not establish release readiness.

| Finding | Candidate behavior and regression |
| --- | --- |
| SPEC005-R2-1 | Waiting detached edits protect their own rows without blocking the original parent's authoritative inbound refresh. Their route-generated operations are rebuilt and held behind the recovered parent acceptance. Google and CalDAV complete both writes, retain local IDs/assignments/reminders on repeated inbound, and reject stale claims after Reload. |
| SPEC005-R2-2 | Explicit edit intent is captured separately from optimistic snapshots. Recovery uses the normal scoped service to regenerate the newer nested following edit, including before/after and split snapshots, against authoritative data. Earlier segments keep the remote title and clock; only the selected tail gets the newer intent and its fresh conditional revision. |
| SPEC005-R2-3 | A first-occurrence recovery keeps the existing authoritative row instead of deleting it as a generated temporary row. Parent assignments/reminders and audit references survive; the provider uses a conditional series update without another insert. Google and CalDAV also expose a nonretryable, actionable error when the selected occurrence no longer exists, retaining the newer local intent. |
| SPEC005-R2-4 | Explicit Reload of an uncertain CalDAV create retains identity protection until the actual resource is fetched. The fetched master and present detached component identities are reconciled atomically before pruning. External changes still conflict and an attempted create remains unaccepted. An adoption fault and repeated inbound preserve the original exception IDs, assignments and reminders. |
| SPEC010-A-R2-1 | DATE exclusions and route exception operations use the same civil-date shift during timed conversion. Completion stores the resulting local exclusion identities together with provider identities. Morning and afternoon DAILY cases each preserve exactly one canceled occurrence through provider parsing, repeated inbound and local expansion. |

The direct-handler lifecycle suite now contains 38 cases and retains all six
original blocker regressions and the correction-1 coverage. The candidate passes all 38. The same final tests against exact captured
round2-final production pass 28 and fail 10; against exact captured dirty-stage
start production, they pass 4 and fail 34. The ten focused check groups pass.
The initial cycle-2 red run reproduced all five reviewer sequences
against exact captured round2-final production before the fixes. Final identical
tests, disposable red source copies, command metadata, hashes, whitespace evidence
and the finding map are recorded separately under
`.cache/calendar-reviewed/followup-20261001/correction2/`.

The route fixture still asserts the requested refresh without launching background
provider work; actual inbound runs through the provider seams. No dependencies,
lockfiles, migrations, translations, commits or deployment were changed by this
cycle. Broad validation, both independent final reviews and live household provider
acceptance remain separate requirements. The previously recorded baseline failures
have not been accepted or repaired within this calendar follow-up.
