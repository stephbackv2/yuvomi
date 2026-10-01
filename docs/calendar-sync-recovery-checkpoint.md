# Calendar sync recovery checkpoint — 1 October 2026

The approved REC01–REC10 recovery correction is implemented. Both final independent reviewers report **no blocking findings** in the frozen stage delta. All five review findings are resolved. Overall readiness remains blocked: the full repository gate has 22 unchanged, unaccepted baseline failures. Live Google/mailbox.org acceptance and full release document-guards remain unverified.

This is a coordinator status record written after both reviews. It changes no behavior, requirements or baseline exceptions and is separate from the frozen substantive review inputs. No staging, commit, push, merge, deployment or next stage occurred.

## Authority and team

The user confirmed the recovery decisions and said “confirm and start the implementation.” Authority is [calendar-sync-recovery-correction.md](calendar-sync-recovery-correction.md), preserving [calendar-direct-manipulation.md](calendar-direct-manipulation.md). Apply `CONTRIBUTING.md`, `DESIGN.md` and the user's [translation preference](fork-preferences.md): German and English translations are required; matching new keys in the other 22 locales may use English, while existing translations remain intact.

| Role | Requested/configured setting | Final outcome |
|---|---|---|
| Sole implementation owner | GPT-6.1 Sol/high | Stopped all substantive edits before final validation |
| Specification review | GPT-6-Astra/high | No blocking findings |
| Standards review | GPT-6.1 Sol/medium | No blocking findings |

Independent runtime model attestation is unavailable. Both reviewers inspected the same source and evidence independently and remained read-only. This invocation used the two permitted correction/re-review cycles; final review was round 3. No further correction cycle belongs to this invocation.

## Implemented behavior and finding resolution

- REC01–REC05: actual field intent is compared with the confirmed base, independent edits merge, genuine conflicts ask which value to retain, moves/manual edits preserve absolute target ranges, resizing changes only the selected boundary, and recurrence identity/scope, assignments, exceptions and reminder offsets remain intact.
- REC06–REC08: unavailable targets retain actionable Review/Discard recovery, only complete successful authoritative readback proves absence, recovery identity changes and local discard are atomic, and stale queued workers cannot recreate discarded work. Discard removes local retained changes, not the provider's original resource.
- REC09–REC10: English/German text and compatibility keys are present; prior browser/mouse drag, classic resize, 15-minute creation/snap/minimum, recurring choices, read-only and timezone behavior remain covered.

| Finding | Final resolution |
|---|---|
| REC-SPEC-01, P1 | Strict DAV provenance and XML/resource/status/component validation prevent insufficient or failed replies from proving absence. |
| REC-SPEC-02, P1 | Independent retained operations and conflicts stay visible; partial/combined choices and newer independent intent are preserved. Incompatible changes to a previously chosen LOCAL value ask again. |
| REC-SPEC-03, P1 | Every dependent is reconciled after authoritative refresh. Disappeared conflicts lose obsolete metadata; remaining conflicts use the current revision. Intent, approved choices and outbound dependency fencing remain intact. |
| REC-STD-01, P2 | Recovery values use the established calendar date/time presentation, including separate local/provider all-day contexts. |
| REC-STD-02, P2 | The existing SAX parser loads lazily through ES-module import. `createRequire` only resolves dependency paths; no dependency change was made. |

The final correction changed six substantive paths: `CHANGELOG.md`, both calendar behavior specifications, `server/services/calendar-edit.js`, `server/utils/caldav-client.js`, and `test/test-calendar-provider-lifecycle.js`.

The complete stage has **41 changed paths** against its recorded starting contents: those six, `docs/fork-preferences.md`, all 24 locale files, `public/pages/calendar.js`, calendar OpenAPI paths/schemas, calendar CRUD/edit routes, CalDAV sync, calendar operation handling, Google Calendar sync, calendar structure tests and the translated-key guard. The exact inventory and complete patch are retained with the packet below. This checkpoint is an additional status-only document outside that 41-path substantive inventory.

All fourteen protected unrelated recipe/Bring/idea files, the existing HEAD and the empty index remain unchanged. Pre-existing dirty work was preserved without stashing, resetting or cleaning. No package/lockfile/migration changes were introduced by this stage.

## Final validation

All paths below are relative to `E:/self hosted/yuvomi/yuvomi`.

| Check | Exact outcome | Evidence |
|---|---|---|
| Final focused 25 groups | Exit1; 24/25 pass. Only baseline `caldav-object-urls` fails. | `.cache/calendar-reviewed/recovery-round3-focused/results.json` |
| Final full 307 groups | Exit1; 285/307 pass, 22 fail. All22 signatures match baseline; no new failed group. | `.cache/calendar-reviewed/recovery-round3-full/results.json` |
| Registered lifecycle fixture | 129/129 pass | Focused/full lifecycle logs and exact comparisons |
| Syntax and stage whitespace | Exit0; 13/13 syntax, 41/41 whitespace | `round3-final/syntax-whitespace.json` |
| Same final fixture against original production | Production exit1; 55/129 pass, 74 behavioral failures | `red-green-round3-final/start-final/` |
| Same fixture against reviewed round2 production | Production exit1; 121/129 pass, eight genuine disappearing-conflict failures | `red-green-round2-defect-round3-final/round2-defect/` |
| Final candidate in both comparisons | Production exit0; 129/129 pass in each | The corresponding `candidate-final/` directories |
| Final browser scenarios | 46/46 pass, all ten drivers exit0 | `round3-final/browser-summary.json` and `browser-runner-results.json` |
| Source/clone/input/preservation checks | Exit0; no mismatches | `round3-final/snapshot-verification-final.json` |

For abbreviated phase paths in this table, the prefix is `.cache/calendar-reviewed/recovery-20261001/`.

Commands:

```text
node .cache/calendar-reviewed/run-checks.mjs recovery-round3-focused <25 registered groups from validation-plan-cycle1.json>
node .cache/calendar-reviewed/run-checks.mjs recovery-round3-full all
node .cache/calendar-reviewed/recovery-syntax-cycle1.mjs round3-final
node .cache/calendar-reviewed/recovery-red-proof-cycle1.mjs round3-final
node .cache/calendar-reviewed/recovery-cycle2-tools.mjs defect round3-final
node .cache/calendar-reviewed/recovery-cycle2-tools.mjs failures round3-final
node .cache/calendar-reviewed/recovery-cycle2-tools.mjs verify round3-final snapshot-verification-final .cache/calendar-reviewed/recovery-controls-cycle2-final2-browser.mjs .cache/calendar-reviewed/recovery-refresh-metadata-cycle2-final2.json
```

The final fixture SHA256 is `ee48b41393f49aac8ab465747d7fe659604353c7d65312874471f6f779e350f6`. Identical registered test bytes ran against exactly restored starting, reviewed-round2 and candidate production. No import or missing-column errors explain the final red results. The eight new cases cover both providers, conflict disappearance when title equals local or confirmed base, both remaining location choices, stale nonmutating rejection, repeated readback, independent intent and completed outbound work.

Browser scenarios comprise existing gesture/API/recurrence/editor checks28, original recovery controls6, multi-operation/date-presentation controls8 and refreshed-conflict controls4. Recovery browser responses use authenticated fixture metadata with simulated responses; actual route/provider behavior is tested separately. The final metadata's parent and recovery revisions come from the same readback. Both new location-only screenshots were inspected and are clear. Older animation-time screenshots and adapted all-day display inputs do not establish a comprehensive visual-release audit.

Installed Edge used the unchanged disposable harness and owned-profile launch adapter. The adapter only connects to its own local browser profile and closes/removes its owned resources; it does not use the household's browser or provider accounts. Historical failed attempts and all original packets remain preserved. No build/lint/typecheck scripts are configured.

## Remaining gate failures and external checks

The immutable starting full run remains **284/307 pass,23 fail**, exit1. A separate starting task-tags confirmation passed50/50; task-tags also passed the final full run. This does not rewrite the original baseline.

The 22 remaining groups are:

```text
test:db-isolation
test:tasks-routes
direct-28 (shopping)
test:detail-view
test:wall-timer
test:modules
test:openapi-coverage
test:household-timezone
test:settings-admin-gate
test:mobile-scroll-layout
test:frontend-audit
test:layer-boundary
test:docker-publish
test:claude-review-workflow
test:workflow-timeouts
test:backup-scheduler
test:caldav-object-urls
test:installer-env-write
test:installer-i18n
test:installer-prereq
test:docs-landing
test:readme-consistency
```

No baseline exception has been accepted. The supplied `failure-comparison.json` retains matching raw failure signatures, including the same three starting Windows path-guard failures in `caldav-object-urls`. Do not present the focused/full gates as green or fix unrelated failures under this completed calendar invocation.

Live household Google and mailbox.org/CalDAV acceptance, full release document-guards and comprehensive visual-release validation remain unverified. Mobile/touch, Morgen, recipes/Bring, dependency modernization and cloud deployment are outside this stage. No deployment approval is implied by the two clear stage reviews.

## Frozen handoff

Evidence root: `.cache/calendar-reviewed/recovery-20261001/`.

- Final packet: `round3-final/packet.md`; complete delta: `round3-final/stage.patch`; inventory: `round3-final/inventory.txt`.
- Final source identity,118 files: `b3e0bcf6a290a6268e38f85316519dc6706f953b89b450a853c7796418fe4bb3`.
- Final review-manifest identity,789 evidence files: `b813f96f05d0f615f0b0cb6b8a437c0367e075c190afff98eadc24df3b2d546f`.
- Original source identity: `740e10c6dddd0cdd6f4b576b9dfaf358630679f993d036dcd2d74e75807f2090`, plus the two pre-edit clean-file baselines identified in the packet.
- Starting/current HEAD: `b8ce81bf9ced01c9b8545432a30872fdc5982b50`.
- Empty-index hash: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Final reports: `reviews/round3-spec.md` and `reviews/round3-standards.md`.

Root and both reviewers independently verified the current/frozen source and all packet evidence without mismatches. Final review reports and this pure status checkpoint were saved afterward; they are not self-referential inputs to that packet.

To continue, verify the source identity and preserve all existing dirty work. Establish a separately authorized scope for remaining repository failures or explicit baseline acceptance, then run the appropriate release/live-provider checks before considering deployment. A later behavior change requires fresh affected validation and independent review. Do not silently extend this invocation past its two correction cycles.

## Native edit-approval prompts

The supplied screenshot shows Codex's native file-edit approval for the “Recovery implementation” subagent, naming `test/test-calendar-provider-lifecycle.js` inside the workspace. The visible session permits workspace writes and the repository is configured as trusted. The implementer used normal `apply_patch`; no escalation or read-only override was requested. The exact runtime policy causing repeated prompts remains undetermined. No global permission setting was changed and no approval mechanism was bypassed.

“Allow once” authorizes the individual edit. Codex's documented file-change approval choices also include session acceptance; use that only if the app's dropdown offers it. Reference: [file-change approvals](https://learn.chatgpt.com/docs/app-server#file-change-approvals). All implementation edits have stopped, so additional implementation write prompts are not expected from this stage.
