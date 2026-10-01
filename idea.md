Respect Yuvomi's Existing Frontend Architecture
Yuvomi intentionally uses a relatively lightweight frontend architecture based around:
- plain JavaScript,
- ES modules,
- Web Components,
- CSS,
- existing Yuvomi components and APIs.
Do not introduce React, Vue, Angular, or another large frontend framework merely to implement individual features.
For changes that may eventually be proposed upstream, follow the existing project conventions closely.
Re-use existing patterns already present in Yuvomi wherever possible.
In particular, inspect existing drag-and-drop behavior in features such as the meal planner before implementing a separate drag system for the calendar.
Fork and Git Strategy
Configure the repository with:
origin   -> my fork
upstream -> official Yuvomi repository
Example:
git clone git@github.com:<my-user>/yuvomi.git
cd yuvomi

git remote add upstream https://github.com/ulsklyc/yuvomi.git

git remote -v
Recommended branch model:
upstream/main
     │
     ▼
main
     │
     ├── feature/calendar-drag-drop
     ├── feature/recipe-import
     └── feature/bring-migration
Keep main close to upstream.
Do development in feature branches rather than accumulating unrelated modifications directly on main.
Periodically update with:
git fetch upstream
git checkout main
git rebase upstream/main
git push origin main
Then rebase active feature branches onto the updated main branch.
Core Changes vs Modules
Before changing Yuvomi core, determine whether the feature belongs in:
1. Yuvomi core,
2. a Yuvomi third-party module,
3. a companion service.
Good candidates for core changes
Examples:
- calendar drag-and-drop,
- calendar event resizing,
- recurring-event UX improvements,
- generic recipe-import UI improvements.
These change existing Yuvomi behavior directly and are potentially useful to upstream users.
Good candidates for third-party modules
Examples:
- specialized household dashboards,
- personal workflow pages,
- custom integrations that can operate through Yuvomi's REST API,
- niche external-service integrations.
Good candidates for companion services
Examples:
- Bring! migration/import helper,
- synchronization bridges,
- heavy recipe scraping/parsing services,
- integrations requiring unusual dependencies.
Prefer this architecture:
Yuvomi
   │
   ├── native APIs
   │
   ▼
small external integration service
rather than inserting unrelated dependencies deep into the Yuvomi server.
Docker and Deployment
Development should still produce a normal Docker image.
For local development, use either:
services:
  yuvomi:
    build: .
or build manually:
docker build -t yuvomi-custom .
Longer term, configure CI to build:
ghcr.io/<my-user>/yuvomi:<tag>
Production deployment should then consume the custom image instead of the official one.
Example:
services:
  yuvomi:
    image: ghcr.io/<my-user>/yuvomi:latest
    restart: unless-stopped
Do not make production depend on uncommitted local source trees.
Keeping the Fork Maintainable
Each customization should ideally be:
- small,
- well-scoped,
- independently testable,
- committed separately,
- documented,
- easy to disable or remove.
Avoid combining unrelated work such as:
calendar redesign
+ recipe migration
+ dependency upgrades
+ database cleanup
in one large change.
Prefer:
commit A: calendar drag plumbing
commit B: event drop UI
commit C: recurring-event protection
commit D: tests
This makes upstream rebases and debugging much easier.
Upstreamability
For every change, ask:
Could this reasonably be useful to normal Yuvomi users?

If yes:
- follow upstream coding conventions,
- avoid personal assumptions,
- add appropriate tests,
- keep configuration generic,
- consider submitting it upstream.
Examples likely suitable for upstream:
- draggable calendar events,
- improved recurring-event editing,
- generic recipe URL importing.
Examples likely better kept private:
- Bring!-specific migration tooling,
- household-specific automation,
- personal service integrations.
The ideal long-term outcome is that generic improvements are accepted upstream, reducing the amount of private fork maintenance.
Testing Expectations
Do not consider a feature complete merely because it works visually.
For every change:
1. Identify existing relevant tests.
2. Add tests where practical.
3. Run the project's existing checks.
4. Test the affected workflow manually.
5. Check related integration behavior.
For calendar changes specifically, test at least:
- local Yuvomi event,
- all-day event,
- timed event,
- event moved within same day,
- event moved to another day,
- recurring event,
- read-only external event,
- CalDAV event,
- Google Calendar event if available,
- failed update/API response,
- page refresh after move.
The state after refreshing the page must match the result shown immediately after dragging.
Calendar Drag-and-Drop: First Implementation Stage
The first development task should be narrowly scoped to moving ordinary editable events.
Do not initially implement every possible calendar interaction.
Stage 1 Acceptance Criteria
Implement drag-and-drop for a normal, editable, non-recurring calendar event.
Required behavior:
- User can begin dragging an event.
- Calendar gives visible feedback during the drag.
- Valid target dates/slots can receive the event.
- Dropping calculates the new event start/end.
- Existing event duration is preserved.
- The existing Yuvomi event-update mechanism is used.
- The UI reflects the updated event.
- Reloading the page shows the event in its new location.
- Failed server updates restore the previous state or otherwise fail cleanly.
- Read-only events cannot be dragged.
- Existing event editing continues to work.
- No unrelated calendar functionality regresses.
Out of scope for Stage 1:
- recurring-event instance editing,
- drag resizing,
- moving between calendars,
- complicated timezone changes,
- touch-specific optimization beyond existing browser behavior.
Calendar Drag Implementation Investigation
Before writing code, inspect the repository and determine:
1. Which files render the calendar.
2. Which component renders an individual event.
3. How calendar slots/days are represented.
4. Which API route updates an event.
5. How external synchronized events are updated.
6. How read-only status is represented.
7. How recurring events are represented.
8. Whether existing drag/drop utilities already exist elsewhere in Yuvomi.
Do not invent a parallel event-update path if an existing one already exists.
Produce a short implementation plan after inspection before making substantial code changes.
Recurring Events
Recurring events require separate treatment.
Dragging an occurrence may mean:
move this occurrence only
move this and following occurrences
move entire series
Do not guess which behavior the user intends.
Until recurring-event semantics are explicitly implemented, recurring events should preferably be excluded from drag-and-drop rather than silently modifying the wrong scope.
Later implementation should reuse whatever recurring-event edit semantics Yuvomi already exposes.
Calendar Synchronization
Calendar changes must continue to use Yuvomi's normal synchronization pipeline.
Expected model:
drag event
    ↓
Yuvomi event update
    ↓
Yuvomi persistence
    ↓
existing sync mechanism
    ↓
Google Calendar / CalDAV
Do not:
drag
  ↓
directly modify SQLite
or independently call external calendar services from frontend code.
The server should remain authoritative.
Recipe Work: Later Stages
After calendar drag-and-drop is stable, investigate recipe functionality separately.
Suggested order:
Stage 1
Calendar drag-and-drop

Stage 2
Recipe model/import capability assessment

Stage 3
Generic recipe URL importer

Stage 4
Bring! migration prototype

Stage 5
Bulk Bring! recipe migration

Stage 6
Additional personal UX/integrations
Do not mix recipe migration work into the initial calendar change.
Recipe Import Design
Prefer standard structured recipe metadata first.
Investigate:
- Schema.org Recipe,
- JSON-LD,
- recipeIngredient,
- recipeInstructions,
- prepTime,
- cookTime,
- totalTime,
- recipeYield,
- image,
- source URL.
Potential pipeline:
recipe URL
   ↓
fetch page
   ↓
extract JSON-LD
   ↓
validate Recipe object
   ↓
normalize fields
   ↓
preview
   ↓
create Yuvomi recipe
Do not write website-specific scrapers unless required.
If parsing complexity grows substantially, consider a separate importer service instead of bloating Yuvomi core.
Bring! Migration Design
Treat Bring! support primarily as migration tooling.
The migration should ideally be idempotent or at least avoid obvious duplicates.
Track enough metadata to identify previously imported recipes, for example:
original URL
source = bring
source identifier, if available
Do not delete anything from Bring! automatically during initial migration.
Recommended migration workflow:
discover
   ↓
preview
   ↓
import
   ↓
validate
   ↓
user verifies data
   ↓
optional Bring! retirement
Codex Working Instructions
Use this repository as a normal software-maintenance project rather than immediately implementing broad requested behavior.
For each stage:
1. Inspect the relevant repository code.
2. Describe the existing architecture.
3. Identify the smallest appropriate change.
4. State the proposed implementation before large edits.
5. Implement only the approved stage.
6. Add or update tests.
7. Run relevant validation.
8. Report exactly what changed.
9. Report any remaining edge cases or risks.
10. Stop before beginning the next major feature.
Avoid opportunistic refactors unless required for correctness.
Prefer localized modifications over architectural rewrites.
Do not add large dependencies without first demonstrating that they are necessary.
Preserve compatibility with upstream Yuvomi wherever practical.
First Codex Task
Start with calendar drag-and-drop investigation only.
Inspect the current Yuvomi repository and report:
- the calendar-related frontend files/components,
- how events are rendered,
- how event updates are sent to the server,
- the relevant backend routes,
- how external/read-only/recurring events are represented,
- any existing drag-and-drop implementation elsewhere in the repository that could be reused,
- the smallest proposed implementation for dragging an ordinary editable event.
Then propose a staged implementation plan and list the files likely to change.
Do not begin recipe work yet.
Do not introduce a frontend framework.
Do not redesign the calendar.
Do not implement recurring-event drag semantics in the first stage.
The immediate objective is a clean, minimal, maintainable implementation of:
Drag an ordinary editable Yuvomi calendar event to another date/time and persist the change correctly.