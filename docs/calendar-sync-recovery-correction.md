# Approved calendar recovery correction (2026-10-01)

This specification is approved. The user confirmed the complete decisions and
authorized implementation as a new implement-reviewed stage. It supersedes the
three unresolved SPEC005-R3 findings in
[the prior checkpoint](calendar-sync-follow-up-checkpoint.md); that historical
checkpoint remains evidence of an unsuccessful earlier invocation.

## Starting evidence and team

Starting HEAD: `b8ce81bf9ced01c9b8545432a30872fdc5982b50`, already dirty.
Exact 116-file baseline: `.cache/calendar-reviewed/recovery-20261001/start/manifest.json`,
identity `740e10c6dddd0cdd6f4b576b9dfaf358630679f993d036dcd2d74e75807f2090`.
The index is empty. Fourteen unrelated recipe/Bring/idea/tool files are fenced by
their recorded hashes. Full baseline: 284/307 groups passed, 23 failed; the
historical 22 failures recur, plus a task-tags bad-port failure whose isolated
confirmation passed 50 cases. Both records are preserved in the baseline summary.
None of the baseline failures are silently accepted by this specification.

Configured team: sole implementation owner GPT-6.1 Sol/high; independent
specification reviewer GPT-6-Astra/high; independent standards reviewer
GPT-6.1 Sol/medium. Root coordinates the frozen packet, reviews and final status.
These are configured settings, not independent runtime attestation.

## Acceptance criteria

- REC01: Derive genuine changes from the selected occurrence before editing.
  Minimal patches and full editor forms recover equivalently. Normalize
  null/empty strings, local civil times, inclusive all-day boundaries and
  selected occurrence/master rule differences. Unchanged fields, assignments,
  recurrence rules and counts do not overwrite refreshed authoritative values.
- REC02: Merge independent user/provider changes. If both change the same field
  incompatibly, visibly ask which value to keep. Preserve cancellation and
  unsaved intent. Compare against the original confirmed provider base before
  the discarded edit: rollback of 09->11 followed by 11->12 means 12 without a
  conflict, and A->B followed by B->C with authoritative A means C. Ordinary
successful edits retain their existing no-extra-confirmation behavior.
- REC03: New deliberate move and manual time targets are absolute. 11->12
  after Reload restores 09 means 12. A drag preserves the entire latest preview
  interval, including source duration: failed resize 09-10->09-11 followed by
  drag 12-14 recovers 12-14. Genuine incompatible external duration changes
  follow REC02. Existing elapsed duration and recurrence civil clocks remain.
- REC04: Resize keeps its absolute changed boundary and refreshed untouched
  boundary. Failed move 11-12, end resized to 13, authoritative 09-10 means
  09-13. Genuine same-boundary conflicts follow REC02. Invalid recovered ranges
  (timed minimum 15 minutes, positive all-day interval) retain intent with a
  visible nonretryable error; never silently clamp. Ordinary snapping/minima stay.
- REC05: Keep this/following/series scope, original occurrence identity and
  cutoff/range separate from chosen target dates. Series edits on failed
  continuations stay in their original tail; nested following keeps its later
  cutoff. Translate selected absolute targets through the normal master schedule
  transform. Preserve unchanged authoritative recurrence/counts and explicit
  newer rule choices within the chosen range. Never replay discarded move/title.
  Preserve exceptions, assignments and reminder offsets/IDs.
- REC06: Removed/shortened recurrence or remote deletion making the selected
  target unavailable retains newer intent with a clear actionable nonretryable
  message and Review changes / Discard unsaved changes actions. Never leave
  forever-pending work, recreate or retarget automatically. Review can inspect
  retained values and the original when available; fresh edits use ordinary UI.
- REC07: A successful complete authoritative CalDAV listing proving an uncertain
  continuation absent removes its optimistic local copy automatically if no
  newer intent remains after Reload. Failed, partial, incremental or insufficient
  listings prove nothing. With newer intent, use REC06. Present identity adoption
  and uncertain-create protection remain atomic, idempotent and fenced.
- REC08: Discard is local only, durable and repeatable. Retire/fence relevant
  queued operations and claims; remove only retained local changes. Never delete
  provider parent/resource/series. Guard ordinary Delete on unresolved recovery
  rows, including detached UID::date rows sharing a CalDAV parent URL. Fault,
  reopen and stale-worker cases must not revive/replay discarded work.
- REC09: German and English text required. Matching keys in other locales may
  use English; preserve all existing translations and follow fork-preferences.md.
- REC10: Preserve all approved behavior in calendar-direct-manipulation.md:
  mouse/browser only; 15-minute creation/move/resize/minimum; month/week/day move;
  classic edges; all-day conversion; navigation; recurrence chooser default this
  for drag/manual edits; permissions/Google/mailbox.org CalDAV; civil TZ/DST and
  reminders; no Undo.

## Bounded scope and verification

Production, registered calendar tests, UI/API recovery choices and behavioral
documentation are in scope. Recipes/Bring, hosting/deployment/Morgen/mobile,
new features, dependencies, major harness/refactors and secret/live-provider data
are excluded. Preserve pre-existing hunks and untracked files; no staging,
commit, push, reset, clean, stash or deployment.

Promote the four previous supplemental reproductions into the registered direct
authenticated route/provider fixture and strengthen both providers/full-form,
absolute move/manual/resize/duration, genuine conflict choices/cancel, recurrence
removal, absence with/without newer intent, repeated inbound, fault/reopen and
stale claims, and local discard without provider DELETE or parent loss. Run exact
new test bytes against frozen starting production and the candidate for red/green
evidence. Reuse existing runners and browser drivers, retaining earlier focused,
lifecycle and browser coverage. Required gates include route/API/OpenAPI, i18n,
service worker, syntax, whitespace and fresh full-repository failure comparison.
Finalize code/tests/behavioral docs before root freezes and validates the packet;
both independent reviews assess that identical candidate. Full release document
guards and live Google/mailbox.org acceptance are external/unverified unless
explicitly exercised. Green tests alone do not establish readiness or release
authorization.

## Correction-cycle verification scope

The first review's three blocking findings are addressed within correction cycle
1: CalDAV absence requires positive complete DAV response provenance, recovery
inspection and partial choices span all relevant unresolved operations, and
retained/conflicting time boundaries use established calendar presentation.
Protocol regressions exercise the installed client's query and multiget response
paths, including malformed/truncated XML, failed properties and valid empty DAV.
Route regressions retain independent later edits and the latest same-field intent
across partial choices. A local choice is bound to the provider field value shown
when selected; a subsequent incompatible change becomes actionable again, while
unchanged values and provider choices continue without an unnecessary question.
Browser checks inspect actual route-captured metadata and verify timed/all-day
display without changing underlying values, operation identities or revisions.
These checks supplement the historical evidence; final validation and both
independent re-reviews remain the coordinator's responsibility.

Correction cycle 2 addresses obsolete conflict metadata after a genuine provider
refresh and the installed XML parser's ES-module loading. Both-provider route
regressions first establish two conflicts, refresh the title to its local value
or original confirmed base, and verify that only the location remains actionable.
They reject old decisions without mutation, preserve intent through repeated
readback, and complete both local/provider location choices. A new browser variant
uses those actual route responses and waits for modal animation before capture.
The parser remains lazy and uses the same installed engine through ES import;
strict complete-response and shared-client compatibility checks remain required.
