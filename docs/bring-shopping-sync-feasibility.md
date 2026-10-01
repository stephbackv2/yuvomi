# Bring! shopping-list sync feasibility

_Investigated 2026-09-22._

## Decision

The requested flow is technically possible: Bring!'s app backend can list a user's
shopping lists, read active and recently completed items, and add, complete, restore,
update, or remove items.

It is not a supported public integration, however. The available list-management
interface is Bring!'s undocumented/private mobile API. The established community client
describes itself as unofficial and uses an API key copied from the Android client. Bring!
may change the endpoints, payloads, authentication, or client key without notice.

For Yuvomi, this should therefore be an **optional sidecar plus third-party module**, not a
provider-specific integration in core. That follows the existing project boundary in
[`SCOPE.md`](SCOPE.md#2-integrations-with-other-peoples-services) and the sidecar contract in
[`MODULES.md`](../MODULES.md#modules-with-a-backend-service). A reliable sidecar still needs
one missing core capability: a generic shopping-item change feed or outbound webhook that
includes deletions. Polling Yuvomi's current state cannot discover a row after it has been
deleted.

## What the private Bring! API can do

The maintained community client [`miaucl/bring-api`](https://github.com/miaucl/bring-api)
and the current Home Assistant integration provide working source-level evidence for the
following operations:

| Requirement | Private operation | Result/meaning |
| --- | --- | --- |
| Sign in | `POST /rest/v2/bringauth` | Email/password login; returns user UUIDs, access token, refresh token, token type, and expiry. |
| Refresh authentication | `POST /rest/v2/bringauth/token` | Exchanges the refresh token for replacement tokens. |
| List shopping lists | `GET /rest/bringusers/{userUuid}/lists` | Returns `listUuid`, name, and theme for every available list. |
| Read one list | `GET /rest/v2/bringlists/{listUuid}` | Returns `items.purchase[]` and `items.recently[]`. Each item includes `uuid`, `itemId`, `specification`, and attributes. |
| Add or restore an item | `PUT /rest/v2/bringlists/{listUuid}/items` | Batch change with operation `TO_PURCHASE`. |
| Mark an item bought | Same `PUT` endpoint | Batch change with operation `TO_RECENTLY`. |
| Hard-remove an item | Same `PUT` endpoint | Batch change with operation `REMOVE`. |

The client source shows the
[login and bearer-token setup](https://github.com/miaucl/bring-api/blob/main/bring_api/bring.py#L196-L289),
[list reads](https://github.com/miaucl/bring-api/blob/main/bring_api/bring.py#L313-L386), and
[batch mutation payload](https://github.com/miaucl/bring-api/blob/main/bring_api/bring.py#L1061-L1118).
Its [response types](https://github.com/miaucl/bring-api/blob/main/bring_api/types.py#L78-L170)
document the fields above. Authenticated calls include the bearer token, private/public user
UUID headers, client/application/country headers, and the mobile client's embedded API key;
the [constants are public in the community client](https://github.com/miaucl/bring-api/blob/main/bring_api/const.py#L4-L13).

This is not the similarly named Posten Bring shipping API. Bring! Labs' public developer
surface exposes a [recipe-import widget](https://www.getbring.com/en/integration-check), not
a documented general shopping-list API or third-party OAuth flow. The community package
explicitly labels itself [unofficial and unaffiliated](https://github.com/miaucl/bring-api#bring-shopping-lists-api).

### Google/Gmail sign-in accounts

A Gmail address is not a different API login type, but an account created with **Google
Sign-in may initially have no Bring-local password**. Bring's first-party apps do support
Google Sign-in, but no reusable Google-token exchange, client registration, or delegated
OAuth flow is documented for third parties. The inspected `/rest/v2/bringauth` path accepts
only `email` and `password`; it cannot be given a Google password, Google ID token, OAuth
authorization code, or browser session. The maintained client exposes only that form login
and Bring refresh tokens, while Home Assistant's current integration likewise collects only
email and password and calls the same client login. See the client
[constructor and login](https://github.com/miaucl/bring-api/blob/main/bring_api/bring.py#L64-L89),
[login request](https://github.com/miaucl/bring-api/blob/main/bring_api/bring.py#L196-L289),
and Home Assistant's [current configuration flow](https://github.com/home-assistant/core/blob/dev/homeassistant/components/bring/config_flow.py#L26-L40).

For a Google-created account, the supported workaround is to add a password to the existing
Bring account, then authenticate the exporter with the email shown in the Bring profile and
that **Bring password**. Bring's official help specifically says that Google/Facebook users
can set a password in the mobile app and then log in with the email associated with the
Google account. It also documents changing a password in the app and using “Forgot your
password?” to receive a reset by email. Home Assistant documents the same flow for Apple,
Google, and Facebook accounts and says social sign-in continues to work afterward. See
Bring's [Google/Facebook device-login instructions](https://www.getbring.com/help-center-main-categories/if-nothing-else-helps),
[password help](https://www.getbring.com/help-center-main-categories/profile-settings), and
Home Assistant's [Bring prerequisites](https://www.home-assistant.io/integrations/bring#prerequisites).

The exporter should therefore keep one authentication path: `BRING_EMAIL` plus
`BRING_PASSWORD`, where the latter is a separately chosen Bring password. It must never ask
for the user's Google password or for pasted Google tokens/cookies, and it should not automate
the Google login UI. Use a unique Bring password, supply it only to the exporter process,
clear the environment variable after the run, and continue excluding credentials and Bring
tokens from the export. If email/password login fails for a social-login account, direct the
user to set/reset the Bring password rather than attempting an undocumented OAuth exchange.
No live Google-created test account was used for this investigation, so this conclusion rests
on current first-party help plus the production Home Assistant/client implementation.

Home Assistant currently uses this client as a cloud-polling integration, pinned to
`bring-api`, and polls list data every 90 seconds. Its implementation is useful prior art:
it maps Bring UUIDs to to-do item IDs and implements create, update, complete, and delete.
See the current [manifest](https://github.com/home-assistant/core/blob/dev/homeassistant/components/bring/manifest.json),
[coordinator](https://github.com/home-assistant/core/blob/dev/homeassistant/components/bring/coordinator.py),
and [to-do adapter](https://github.com/home-assistant/core/blob/dev/homeassistant/components/bring/todo.py).

## Recipes, Inspiration, and My Recipes

The private API also exposes Bring's Inspiration stream and the user's **My Recipes**
collection. In the current community client, `get_inspirations()` defaults to the `mine`
filter. Bring's own documentation indicates that this personal collection can contain
favorited Bring recipes, recipes imported from compatible websites, and the user's own
recipes or templates. It should therefore be treated as a saved collection, not as proof
that every returned recipe was authored by the current user.

| Capability | Private operation | Support in current client |
| --- | --- | --- |
| Read My Recipes/templates | `GET /rest/v2/bringusers/{userUuid}/inspirations?filterTags=mine&offset=0&limit=...` | `get_inspirations("mine")` |
| Read other Inspiration feeds | Same endpoint with another `filterTags` value | Known tags include `all`, `bring_trending_recipes`, and `chefkoch.de`. |
| Discover current filters | `GET /rest/v2/bringusers/{userUuid}/inspirationstreamfilters` | `get_inspiration_filters()`; preferable to hardcoding seasonal/promotional filters. |
| Parse a compatible recipe URL | `GET /rest/bringrecipes/parser?url={url}` | `parse_recipe()` returns a template-shaped recipe but does not persist it. |
| Create a recipe or list template | `POST /rest/v2/bringtemplates` | `create_template()` with type `RECIPE` or `TEMPLATE`. |
| Delete a recipe or list template | `DELETE /rest/v2/bringtemplates/{templateUuid}` | `delete_template()`. Test ownership/favorite behavior before enabling this. |
| Fetch or update one template | No separate method exposed | Unsupported/unknown in the current client. Do not assume create is an upsert. |

The implementations are in the client's
[recipe and Inspiration methods](https://github.com/miaucl/bring-api/blob/main/bring_api/bring.py#L1267-L1452).
An Inspiration response contains `entries[]`, each with a `type` and embedded `content`.
Types include `RECIPE`, `TEMPLATE`, and `POST`; `POST` entries can be editorial or promoted
content and must not be imported as recipes. The embedded template model can contain:

- IDs and versioning: `uuid`, `contentUuid`, `contentVersion`, and `type`;
- source/display data: name/title, author, source URL, image, attribution, and tags;
- recipe data: ingredients, yield, base quantity, preparation time, and quantity-scaling flag;
- list-template data: items.

Each ingredient or item includes an `itemId`, `stock`, and optionally `spec`, `altIcon`, and
`altSection`. See the client's
[template and Inspiration models](https://github.com/miaucl/bring-api/blob/main/bring_api/types.py#L343-L428).
This is enough for a read-only My Recipes importer in Yuvomi, but the exact meaning of
`stock`, scaling behavior, and whether `uuid` or `contentUuid` is the stable external key
must be confirmed against captured responses from a test account.

There is no recipe-specific "add ingredients to shopping list" operation in the current
client. Yuvomi could implement that workflow by reading `ingredients`/`items`, allowing the
user to choose what is needed, and sending those choices through the normal Bring batch
list operation as `TO_PURCHASE`. Quantity scaling should not be inferred until it is tested
with live payloads. Bring's official [My Recipes guide](https://getbring.com/blog-posts/meal-planning-for-the-week-with-bring),
[Inspiration help](https://www.getbring.com/help-center-main-categories/inspirations-suggestions),
and [recipe integration checker](https://www.getbring.com/en/integration-check) describe the
corresponding first-party UI behavior and compatible structured recipe pages, but do not
constitute a supported public API contract.

### Standalone recipe export

[`tools/bring/export-recipes.mjs`](../tools/bring/export-recipes.mjs) provides a reusable
`exportBringRecipes()` function and a small CLI. It logs in, paginates the complete `mine`
collection, follows each trusted `contentSrcUrl` to hydrate the card with its ingredient data,
excludes templates and `POST`/advertising entries by default, and preserves each recipe's
original response shape so newly introduced Bring fields are not lost.

```powershell
$env:BRING_EMAIL = 'you@example.com'
$env:BRING_PASSWORD = 'your-password'
node tools/bring/export-recipes.mjs --output bring-recipes.json
```

Bring currently returns user-created recipes as `TEMPLATE`, so use `--include-templates` for
the **My Recipes** collection. `--summaries-only` skips the detail requests, but that output
usually lacks ingredients and is unsuitable for import. Without `--output`, JSON is written
to standard output. The file writer refuses to overwrite an existing export, exported files
are ignored by Git, and neither credentials nor access tokens are included in the output.

### Importing the export into Yuvomi

[`tools/bring/import-recipes.mjs`](../tools/bring/import-recipes.mjs) converts hydrated Bring
recipes to Yuvomi's normal native-recipe shape and calls `POST /api/v1/recipes`. It does not
write SQLite directly. Create a Yuvomi API token in **Settings → Administration → API tokens**
with the `meals:write` scope, then make a fresh hydrated export:

```powershell
$env:BRING_EMAIL = 'you@example.com'
$env:BRING_PASSWORD = 'your-bring-password'
node tools/bring/export-recipes.mjs --include-templates --output bring-recipes-hydrated.json
```

Configure the Yuvomi endpoint and run the importer without `--apply` first. This is a dry run:

```powershell
$env:YUVOMI_URL = 'http://localhost:3000'
$env:YUVOMI_API_TOKEN = 'the-token-shown-once-by-yuvomi'
node tools/bring/import-recipes.mjs --input bring-recipes-hydrated.json
```

If the counts look correct, perform the writes explicitly:

```powershell
node tools/bring/import-recipes.mjs --input bring-recipes-hydrated.json --apply
```

The importer maps Bring `itemId` to ingredient name and `spec` to quantity, categorizes each
ingredient with Yuvomi's existing categorizer, and carries over notes and a source URL when
available. It creates editable native Yuvomi recipes. Existing case-insensitive title matches
and duplicate Bring entries are skipped, so rerunning the same one-time import does not create
obvious duplicates. Images are not imported, and Yuvomi's normal default meal types apply.
For a trusted LAN installation served over plain HTTP, setting
`YUVOMI_ALLOW_INSECURE_HTTP=true` is required because otherwise the importer refuses to send
the API token without transport encryption.

## Semantic mapping

Bring item names are not identities. The persistent sync key must be the Bring item `uuid`.
Generate a UUID before pushing a new Yuvomi item and reuse it for retries. This also permits
two items with the same name but different specifications. Name-only calls are ambiguous.

| Yuvomi | Bring! | Notes |
| --- | --- | --- |
| Shopping list ID | `listUuid` | An admin explicitly maps one Yuvomi list to one Bring list. Do not match permanently by display name. |
| Item ID | item `uuid` | Persist this relationship in the bridge database. |
| `name` | `itemId` | A rename is safest as one batch containing `REMOVE` for the old UUID and `TO_PURCHASE`/`TO_RECENTLY` for a new UUID. Bring has legacy name-matching behavior. |
| `quantity` | `specification` / outbound `spec` | Reasonable MVP mapping. Bring has one free-form specification, while Yuvomi has additional local fields. |
| `is_checked = 0` | `purchase` / `TO_PURCHASE` | Item still needed. |
| `is_checked = 1` | `recently` / `TO_RECENTLY` | Bought/completed, not hard-deleted. |
| Delete row | `REMOVE` | Removes it rather than putting it in Recently Used. |
| Category, notes, URL, price, store, tags, order | local-only initially | Bring's representation does not map cleanly. Imported items should use a configured/default Yuvomi category. |

Bring itself distinguishes tapping an item (move it to Recently Used) from completely
deleting it. See Bring!'s official [Items & Lists help](https://www.getbring.com/help-center-main-categories/items-lists).
The UI and sync code must preserve that distinction: **check = complete**, **delete = remove**.

On first import, copy only `purchase` items. Do not import the whole `recently` history as
checked Yuvomi rows. For an item already linked by UUID, appearing in `recently` does mean it
was completed remotely and its Yuvomi row can be checked.

## Recommended flow

### Opening or switching to a linked Yuvomi list

1. The module calls its same-origin sidecar endpoint, for example
   `POST /api/extensions/bring-sync/lists/{yuvomiListId}/sync`.
2. The sidecar authenticates server-side, fetches the mapped Bring list, and validates the
   whole response before changing Yuvomi.
3. Reconcile by Bring UUID, not by name:
   - Bring-only `purchase` item: create it in Yuvomi and save the two IDs.
   - Linked item in `purchase`: update name/specification when Bring is the changed side.
   - Linked item in `recently`: set `is_checked = 1` in Yuvomi.
   - Linked item moved back to `purchase`: set `is_checked = 0` in Yuvomi.
   - Previously active linked UUID absent from both collections: treat as a remote hard
     removal only after a successful, complete response and subject to pending local work.
4. Return the refreshed Yuvomi list. Coalesce simultaneous page-open requests and apply a
   short freshness window so page rerenders do not repeatedly hit Bring.

The reconciler should use a stored last-synced snapshot for a three-way comparison. Bring's
item response does not expose a usable per-item modification timestamp. Recommended conflict
rule: a queued local intent wins until acknowledged; otherwise, if only one side differs from
the snapshot, that side wins. If both differ, report a conflict instead of silently destroying
one edit.

### Mutations made in Yuvomi

Do not make Yuvomi's CRUD response depend on Bring being online. Record a durable outbound
operation, commit the Yuvomi mutation, then flush asynchronously:

- add: generate Bring UUID, enqueue `TO_PURCHASE`;
- edit quantity/specification: enqueue `TO_PURCHASE` with the same UUID;
- check: enqueue `TO_RECENTLY`;
- uncheck: enqueue `TO_PURCHASE`;
- delete: retain a tombstone containing list UUID, Bring UUID, and old name, then enqueue
  `REMOVE`;
- rename: enqueue a single Bring batch containing remove-old plus add-new.

Retry with exponential backoff and the same UUID. Expose `pending`, `last_sync`, and
`last_error` in the module UI. A failed provider write must remain visible/retryable rather
than rolling back a successfully committed local action or being forgotten.

## Fit with the current Yuvomi code

The native shopping page currently reads the list only after loading the local list metadata:
[`public/pages/shopping.js`](../public/pages/shopping.js) (`render`, `loadItems`, and
`switchList`). Its mutations call the core shopping routes directly. The server already has
all required local operations in [`server/routes/shopping.js`](../server/routes/shopping.js):
list/read, item/create, item/patch, and item/delete.

The existing CalDAV VTODO sync is valuable design precedent. Shopping items already carry
external-linkage and durable outbound fields for that integration, and its route handlers
mark or queue outbound work before/after local mutations. Reusing the **pattern** is sensible;
reusing the CalDAV-specific columns or service is not. A generic change event/outbox should
describe the Yuvomi action independently of any provider, and a sidecar should consume it via
the supported API rather than write `yuvomi.db`.

There are two implementation options:

1. **Recommended: generic core change feed/webhooks, then a Bring sidecar.** Add durable,
   cursor-based shopping events for create/update/check/uncheck/delete, with tombstone data
   for deletes. The sidecar consumes those events with a narrowly scoped Yuvomi API token and
   performs Bring writes. This closes the existing gap documented in
   [`SCOPE.md`](SCOPE.md#the-shape-that-works-yuvomi-stays-the-server-the-bridge-is-a-client)
   and benefits integrations other than Bring.
2. **Prototype only: module-owned shopping page.** A replacement page can send every action
   through the sidecar and sync on open immediately. It will miss mutations performed through
   Yuvomi's native shopping page, dashboard, meal-plan/pantry transfers, MCP, or other API
   clients, so it is not complete bidirectional sync.

Adding Bring-specific calls directly to `server/routes/shopping.js` would satisfy the narrow
flow, but conflicts with the repository's explicit provider-boundary decision and makes every
local write path depend on an unsupported private cloud API.

## Security and operational constraints

- The browser must never receive the Bring password, access token, refresh token, mobile API
  key, or user UUID headers. All Bring traffic belongs in the sidecar backend.
- There is no exposed delegated OAuth flow. Accounts created through Google, Apple, or
  Facebook must use the Bring-local-password flow described under
  [Google/Gmail sign-in accounts](#googlegmail-sign-in-accounts).
- Store credentials encrypted with a sidecar-specific key, make them write-only in the API,
  redact request/response authentication data, and never put secrets in `module.json`, Compose,
  browser storage, or logs.
- Bring publishes no rate limit or SLA for this private interface. Use conservative polling,
  ETags when available, bounded retries for transient 5xx/429 responses, jittered backoff, and
  a circuit breaker/manual retry.
- Treat unknown JSON attributes as opaque and ignore what the bridge does not need. A current
  Home Assistant issue demonstrates a real schema change where a new `RETAIL_PRODUCT`
  attribute broke strict response parsing:
  [home-assistant/core#167545](https://github.com/home-assistant/core/issues/167545).
- Clearly label the integration unofficial/experimental. Bring!'s terms describe availability
  as best effort and reserve the ability to change or discontinue features:
  [Bring! Terms of Use](https://www.getbring.com/en/terms-of-use).

## Minimum acceptance tests

Before calling the bridge usable, automate these cases against a fake Bring adapter and run a
small opt-in live contract test separately:

- initial import ignores `recently` history;
- remote add, complete, restore, edit-specification, and hard-remove;
- local add, check, uncheck, delete, and rename;
- two same-name items remain distinct by UUID;
- retrying a timed-out add does not create a duplicate;
- a failed/partial/empty provider response never mass-deletes Yuvomi items;
- a pending local delete cannot be resurrected by a page-open pull;
- two page opens and an in-flight local mutation cannot apply stale responses out of order;
- expired access token refreshes once and invalid credentials surface as reauthentication;
- unsupported Bring attributes do not fail the full list parse;
- credentials and tokens never appear in logs or API responses.

## Bottom line

The private API supports the desired behavior, including list reads, add, complete, restore,
and hard-remove. The hard parts are identity, conflicts, deletion delivery, and reliability,
not the HTTP calls. Build the generic Yuvomi change feed first, then keep Bring in an
experimental sidecar/module. Without the change feed, the proposed page-open pull can sync
Bring into Yuvomi, but it cannot guarantee that all Yuvomi-originated deletes reach Bring.
