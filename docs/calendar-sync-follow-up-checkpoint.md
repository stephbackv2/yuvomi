# Calendar sync follow-up checkpoint — 2026-10-01

**Status: partial implementation; not ready for approval or release.** Final
standards review is clear. Final specification review has three blocking findings
in recurring conflict recovery. Both permitted correction/re-review cycles are
exhausted. Production, tests and behavioral documentation remain frozen; this file
records the outcome and continuation work only.

The approved stage is the six findings in
[calendar-sync-follow-up.md](<E:/self hosted/yuvomi/yuvomi/docs/calendar-sync-follow-up.md>),
preserving the previously accepted drag, resize and recurring-scope behavior in
[calendar-direct-manipulation.md](<E:/self hosted/yuvomi/yuvomi/docs/calendar-direct-manipulation.md>).
Candidate sections in those documents describe historical snapshots; this
checkpoint is the final status for the current invocation.

## Remaining specification findings

All three are **high severity, blocking**. Four isolated probes reproduced them
against the exact reviewed production, without altering live production or tests.

### SPEC005-R3-1 — Full editor submissions corrupt a recovered later tail

The real editor submits every form field. Recovery captures all supplied fields
as explicit intent, even when the user changed only the title. After a failed
following split and Reload, a newer full-form edit can overwrite refreshed
description/location and recurrence settings. Its temporal normalization also
changes the intended civil time.

Reproduction: authoritative readback has 09:00 Berlin, new description/location
and a shortened series with COUNT4. The title-only later-tail edit produces
07:00 Berlin, loses the remote description/location, and COUNT3 instead of COUNT1.
The existing minimal-patch regression passes; the actual full-form shape fails.

Code: [intent capture](<E:/self hosted/yuvomi/yuvomi/server/services/calendar-edit.js:1154>),
[recovery rebasing](<E:/self hosted/yuvomi/yuvomi/server/services/calendar-edit.js:1219>),
[editor payload](<E:/self hosted/yuvomi/yuvomi/public/pages/calendar.js:5248>).

Next correction: derive actual changed fields against the selected occurrence
before the edit; preserve authoritative unchanged fields and occurrence counts;
normalize dates/times consistently. Cover full forms and minimal patches for both
providers, with genuine time/rule changes tested separately.

### SPEC005-R3-2 — Removing recurrence remotely leaves an edit pending forever

Google and CalDAV inbound call recovery only if the fetched parent still has a
recurrence rule. When that series becomes a single event, the selected future
occurrence no longer exists, but recovery never reports that fact.

Separate provider probes deliver the nonrecurring parent twice after
split/conflict/newer edit/Reload. Both retain a pending, retryable sibling with
zero eligible operations. The recurrence-shortening case already passes; complete
recurrence removal does not.

Code: [Google recovery guard](<E:/self hosted/yuvomi/yuvomi/server/services/google-calendar.js:1809>),
[CalDAV recovery guard](<E:/self hosted/yuvomi/yuvomi/server/services/caldav-sync.js:1075>).

Next correction: run the missing-occurrence decision after authoritative
recurrence removal too. Preserve retained intent, IDs, reminders and assignments;
show an actionable nonretryable outcome. Verify repeated inbound and stale claims.

### SPEC005-R3-3 — A remotely deleted uncertain CalDAV continuation never resolves

Reload of an uncertain create waits for authoritative resource readback. Identity
adoption handles resources present in the results, but a successfully fetched
complete listing that omits the continuation has no absence-handling path.
Pruning continues to protect the unresolved rows.

Reproduction: create accepted with response lost, genuine external change detected,
Reload, then remote deletion before two successful complete listings. Three local
rows remain; the continuation is pending and retryable, has no operation ID, and
still says it is waiting for authoritative refresh. reload_readback_pending stays
true. Readback/adoption when the resource remains present already passes.

Code: [Reload pending state](<E:/self hosted/yuvomi/yuvomi/server/services/calendar-edit-operations.js:679>),
[resource reconciliation](<E:/self hosted/yuvomi/yuvomi/server/services/caldav-sync.js:976>),
[pruning protection](<E:/self hosted/yuvomi/yuvomi/server/services/caldav-sync.js:1098>).

Next correction: use proven absence from successful complete listings to converge
safely or show an actionable nonretryable retained-intent error. Preserve active
siblings and metadata; a failed or partial fetch is not absence proof.

## What the final review supports

| Original category | Final result |
| --- | --- |
| SPEC003 | Repeated Google occurrence edits use the correct instance identity/ETag; genuine conflicts remain conflicts. |
| SPEC005 | Earlier split/Reload, sibling, first-occurrence, detached identity and missing-occurrence-shortening cases were repaired. The three findings above remain. |
| SPEC010-A | CalDAV future EXDATE-only cancellation transfer, DATE/TZID/UTC, DST, conversions and morning/afternoon DAILY cardinality are supported. |
| SPEC010-B | Lost old-resource PUT responses recover through strict desired-state readback; external differences remain conflicts. |
| SPEC011 | Durable/uncertain-create identities protect both providers from inbound-before-retry duplicates. |
| SPEC012 | Completion status/result/identities/sync are atomic and fenced, including fault, reopen and stale-worker checks. |

All five exact previous specification-review failures were repaired in correction2
and have strengthened regressions. Standards finding STDF001 remains resolved:
the lifecycle fixture directly invokes authenticated route stacks, observes
refresh with a scoped built-in module mock, and separately exercises real inbound.

## Validation

| Check | Actual result |
| --- | --- |
| Registered final lifecycle suite | Exit0, 38/38 pass. |
| Ten focused groups | All exit0, 299 test cases pass. |
| Seven existing browser probes | All exit0, 28 scenarios pass. |
| Identical final lifecycle tests against exact previous candidate | Exit1, 28 pass / 10 fail. |
| Identical final lifecycle tests against exact dirty-stage start | Exit1, 4 pass / 34 fail. |
| Final supplemental recovery probes | Nested Node exit1, 0 pass / 4 fail; three findings above. The diagnostic wrapper exits0 to retain logs. |
| Final syntax / dirty-start whitespace | Exit0, eight JS checks / twelve changed-file guards pass, including untracked files. |
| Full repository baseline and final run | Both exit1, 285/307 groups pass, the same 22 groups fail; all 22 recorded diagnostic signatures match. No exceptions accepted. |
| Preservation | All 114 reviewed source hashes and twelve inventoried unrelated files match. HEAD/index preserved; index empty. |

Focused counts: lifecycle 38, scoped 24, Google outbound 78, CalDAV outbound 78,
CalDAV sync 56, manipulation 10, route structure 5, OpenAPI structure 5, schema 3,
append-only migrations 2. Browser counts: gestures 7, API 8, chooser/cancel/edge 3,
editor 3, detached rule 4, explicit rule scope 2, mocked conflict-Reload 1.

The full-suite failures are: db-isolation, tasks-routes, direct-28/shopping,
detail-view, wall-timer, modules, openapi-coverage, household-timezone,
settings-admin-gate, mobile-scroll-layout, frontend-audit, layer-boundary,
docker-publish, claude-review-workflow, workflow-timeouts, backup-scheduler,
caldav-object-urls, installer-env-write, installer-i18n, installer-prereq,
docs-landing and readme-consistency. They were present before this stage;
some involve Windows paths/newlines, others unrelated work or existing behavior.
They have not been repaired or waived.

Live household Google/mailbox.org acceptance and full release document guards
remain unverified. No build/lint/typecheck scripts exist; the project has no build
step. Provider cases use strict isolated fixtures and real inbound seams.

## Review and reproducible evidence

| Role | Configured model / reasoning | Final disposition |
| --- | --- | --- |
| Implementation | GPT-6.1 Sol / high | Frozen candidate and evidence delivered. |
| Specification | GPT-6-Astra / high | Blocking findings: SPEC005-R3-1/2/3. |
| Standards | GPT-6.1 Sol / medium | No blocking findings; STDF001 resolved. |

These are configured launch settings. Independent runtime attestation is
unavailable. Both reviewers inspected the same frozen source/evidence packet;
neither edited files or ran tests. The coordinator executed the requested probes.

- Starting HEAD: b8ce81bf9ced01c9b8545432a30872fdc5982b50; already dirty.
- Dirty-start identity: 0d4505f729023b83a502cc6a8293aca0009bc0aea68e928b0505ff2e3b42e775.
- Final source identity: 1a9741b06e673fcea34e743105b9649dbe7456d64805a2322ba35304c1d17027.
- Reviewed source/evidence identity: cbf61b3f4c5181ce80a0f182d495fdb70d747f3b8a11faf84f03d9d62030f02f.
- Final lifecycle SHA256: f0283fc12782f6336e123031e90f15bfc50387ea0b378bcc729d88169ce630c5.

[Final review packet](<E:/self hosted/yuvomi/yuvomi/.cache/calendar-reviewed/followup-20261001/round3/packet.md>)
contains the complete twelve-file stage diff, eight-file correction diff, source
copies, raw validation paths and 740 evidence hashes.
[Specification report](<E:/self hosted/yuvomi/yuvomi/.cache/calendar-reviewed/followup-20261001/round3/review-spec.md>),
[standards report](<E:/self hosted/yuvomi/yuvomi/.cache/calendar-reviewed/followup-20261001/round3/review-standards.md>),
[finding map](<E:/self hosted/yuvomi/yuvomi/.cache/calendar-reviewed/followup-20261001/correction2/finding-map.md>)
and [supplemental raw log](<E:/self hosted/yuvomi/yuvomi/.cache/calendar-reviewed/followup-20261001/supplemental-round3/raw.log>)
retain the detailed evidence. These caches are local and ignored by Git; preserve
them for comparison. If they are absent, record that limitation and capture a
fresh baseline for the next invocation. The prior dirty-start bytes cannot be
reconstructed from HEAD alone.

Registered checks can be repeated with the existing runner; choose fresh output
names so the preserved evidence is not overwritten:

```text
node .cache/calendar-reviewed/run-checks.mjs <fresh-full-phase> all
node .cache/calendar-reviewed/run-checks.mjs <fresh-focused-phase> test:calendar-provider-lifecycle test:calendar-scoped-edits test:google-outbound test:caldav-outbound test:caldav test:calendar-direct-manipulation test:calendar-structure test:openapi-structure test:schema-mirror test:migrations-append-only
node .cache/calendar-reviewed/followup-browser.mjs <fresh-browser-phase> gesture api recurrence editor detached-rule rule-default conflict-reload
```

The four supplemental definitions are in
[supplemental-tests.js](<E:/self hosted/yuvomi/yuvomi/.cache/calendar-reviewed/followup-20261001/round3/supplemental-tests.js>).
They reuse the existing direct fixture in an isolated clone. Promote them to
registered tests in a separately authorized correction, adding the broader
validation described for each finding. Do not rerun the immutable supplemental
runner at its existing destination without adapting it to a new output path.

## Workspace and continuation boundary

The twelve substantive stage paths are CHANGELOG.md, the two calendar behavior/
follow-up documents, package.json, server/routes/calendar/edit.js,
server/services/caldav-outbound.js, caldav-sync.js, calendar-edit-operations.js,
calendar-edit.js, calendar-prune.js, google-calendar.js, and
test/test-calendar-provider-lifecycle.js. Only eight changed during correction2.
This checkpoint is separate final status bookkeeping and changes no behavior.

Existing recipe/Bring/idea work, shared-file prior hunks, migrations194/195 and the
empty index were preserved. No runtime dependencies, lockfile, translations or
frontend changes were introduced in this follow-up. Changes remain local and
uncommitted; deployment and hosting are separate work.

The invoked [implement-reviewed skill](C:/Users/st3ph/.agents/skills/implement-reviewed/SKILL.md)
requires: “Allow at most two fix-and-re-review cycles for actual findings or
substantive changes; stop with unresolved findings after that.” Both cycles were
used. Continue the three findings only under a new explicit correction request;
do not treat this checkpoint as stage approval or release authorization.
