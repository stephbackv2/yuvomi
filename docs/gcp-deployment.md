# GCP deployment - 2 October 2026

Yuvomi is live at **https://self-host.mattiss4you.de** with the calendar, recipe-import and Bring! work requested by the user. The cutover finished at **06:43 UTC / 08:43 Europe/Berlin**. Public HTTPS verification passed at 07:00 UTC. Both Yuvomi and the existing Vaultwarden service are healthy.

## Release and source

| Item | Value |
|---|---|
| GCP project | `self-hosted-yuvomi` |
| VM / zone | `yuvomi` / `us-east1-c` |
| Instance ID | `6553131111779862529` |
| Application version | `2.65.1` |
| Deployment commit | `619911292e961dd8cb5f8b54e6cf62ba708f3a99` |
| Deployment snapshot branch | `codex/gcp-calendar-recipes-20261001` |
| Image tag | `yuvomi-personal:calendar-recipes-619911292e96` |
| Image ID | `sha256:5d0906449e504c76c0b86ad82e27a503e08e228707365dc8011546c8e4e31e15` |
| VM release directory | `/opt/yuvomi/releases/619911292e96` |
| Server receipt | `/opt/yuvomi/releases/619911292e96/deployment-receipt.json` |

The managed source worktree is `C:/Users/st3ph/.codex/worktrees/gcp-calendar-recipes/yuvomi`. Its commit includes all 84 previously modified or untracked source paths requested for deployment. At deployment, no commit had been pushed and `origin` named upstream `ulsklyc/yuvomi`. The deployment snapshot worktree and branch remain available.

The original workspace is `E:/self hosted/yuvomi/yuvomi`. During deployment, its source contents, original HEAD (`b8ce81bf9ced01c9b8545432a30872fdc5982b50`) and staged changes were preserved. This deployment note is outside the deployed application commit.

The uploaded runtime/test archive has SHA256 `913a62d6f123c1439dbd926798b5a3518a58e09c2051e5444a9f786d5e1de317`. The complete Git archive has SHA256 `1da17cd435416f347d9579c53519643e1a694648153bc823e8aeba9267b5e72f`. Local receipts and archives are in `.cache/yuvomi-gcp-deploy/`; they contain no deployment credentials.

## Deployed scope and acceptance limits

- Calendar mouse dragging and classic resizing, the 15-minute grid/minimum, recurring-occurrence/series/future choices, provider persistence and recovery work are included. The approved behavior remains documented in [calendar-direct-manipulation.md](calendar-direct-manipulation.md) and [calendar-sync-recovery-correction.md](calendar-sync-recovery-correction.md).
- Recipe-import server and browser changes are included.
- Bring! export/import helpers are retained on the VM at `/opt/yuvomi/releases/619911292e96/source/tools/bring/`. They are companion tools; the runtime image excludes the `tools` directory. **The household's Bring! recipe migration has not been run.**
- Google and mailbox.org connectivity was verified, but an authenticated live provider edit/readback and manual production drag/resize/recurrence acceptance were not performed. Recipe-source connectivity checks did not create a household recipe.
- The earlier full repository run still has 22 unchanged, unaccepted baseline failures. Those and the unverified broader release guards remain recorded in [calendar-sync-recovery-checkpoint.md](calendar-sync-recovery-checkpoint.md). Deployment checks do not establish that the entire repository gate passes. That checkpoint describes the earlier implementation invocation; this later deployment was separately authorized by the user.

## Validation and household data

The final built Linux image passed **236/236** feature checks with `TZ=Europe/Berlin`, matching production. Test containers used isolated databases and no provider network access.

| Suite | Passed |
|---|---:|
| Calendar provider lifecycle | 129 |
| Scoped calendar edits | 24 |
| Calendar browser-module contracts | 10 |
| Recipe routes and import | 60 |
| Bring! export and import | 13 |

Logs are `/opt/yuvomi/releases/619911292e96/test-{calendar-lifecycle,calendar-scoped,calendar-browser,recipes,bring}.log`. Earlier fixture runs under UTC exposed their Berlin timestamp assumption; the final registered cases all ran without skips under the actual production timezone.

A separate encrypted household-data clone was upgraded before cutover. A fresh cold backup was then taken with the original app stopped. Both the rehearsal and actual upgrade passed SQLite integrity and foreign-key checks. The actual upgrade changed schema **173 → 195**, with these household row counts preserved:

| Data | Before | After |
|---|---:|---:|
| Users | 2 | 2 |
| Calendar events | 691 | 691 |
| Calendar exceptions | 34 | 34 |
| Recipes | 1 | 1 |
| Recipe ingredients | 4 | 4 |
| Shopping lists | 1 | 1 |
| Shopping items | 0 | 0 |

The rehearsal had 682 calendar events. The original app resumed inbound sync after network access was restored, increasing this to 691 **before** the cold backup; this was not a migration discrepancy.

Public checks verified valid HTTPS, the home page and health endpoint, the service worker's full deployment revision and `no-store` policy, all four changed calendar/recipe JavaScript assets, and HTTP 401 for unauthenticated calendar/recipe API access. Public asset bytes match the verified uploaded archive exactly; comparison with Git blobs also confirmed identical text after accounting for Windows CRLF export line endings. No application change was needed for that verification difference. Evidence is `.cache/yuvomi-gcp-deploy/public-verification.json`.

## Network and ongoing operation

The VM originally had external IPv6 but no external IPv4. Direct IPv4 connections failed on the host, and the original Docker network had only IPv4. This prevented calendar synchronization and recipe importing from reaching some providers.

The user explicitly approved adding external IPv4. An ephemeral external IPv4 address was enabled on `nic0` with the Premium network tier. Google's published in-use IPv4 rate is **US$0.005/hour**, approximately **US$3.65 per 730-hour month**, plus traffic charges: [Google Cloud VPC pricing](https://cloud.google.com/vpc/network-pricing).

Yuvomi also uses the private dual-stack Docker network `yuvomi-egress-619911292e96`, with MTU 1460. Container checks reached Google APIs, mailbox.org DAV (the expected unauthenticated 401 response), Chefkoch and Emmi. No firewall, DNS or Vaultwarden application settings were changed.

`/opt/yuvomi/docker-compose.override.yml` pins the personal image, sets its build revision, adds the egress network and uses `pull_policy: never`. The app remains exposed only at **127.0.0.1:3000**, behind the existing Caddy HTTPS service. Existing credentials, timezone and persistent data/backups/documents/modules mounts were preserved.

For a restart of this already installed release, explicitly include both Compose files:

```sh
cd /opt/yuvomi
sudo docker compose -f docker-compose.yml -f docker-compose.override.yml \
  up -d --no-deps --no-build --pull never --wait --wait-timeout 120 yuvomi
```

For a later upgrade, build and validate a new image from a new personal commit, take another full backup, then update the override deliberately. Pulling or using only the upstream base Compose file is not the maintenance path for this fork. Do not prune the retained rollback image or deployment backup before deciding their retention policy.

## Backup and rollback

The full cold backup is outside the app's ordinary backup mount:

`/opt/yuvomi/deployment-backups/pre-calendar-recipes-20261002T064221Z-619911292e96`

Its `full-state.tar.gz` contains the original data, documents, modules, base Compose file and `.env`. It is protected by a root-only directory and must be treated as sensitive. The SHA256 is **`efc5225de123092915c7ac00b980740e8e284ebb9e94b5a279ba9a3e351a1dc0`**, recorded alongside the archive. Before/after database receipts and the rollback override are retained in that directory.

The previous image is retained as `yuvomi-personal:rollback-pre-619911292e96` (ID `sha256:61292e0c5d045dcc6844680ddd89578b005705206ed22bac13d477e92b18c344`, version `2.64.1`). A guarded rollback script is prepared; it was not needed during this successful deployment:

```sh
sudo bash /opt/yuvomi/releases/619911292e96/rollback.sh \
  /opt/yuvomi/deployment-backups/pre-calendar-recipes-20261002T064221Z-619911292e96
```

Rollback restores the **old image and its matching household snapshot together**. It rewinds household changes made after 06:42:21 UTC on 2 October. Current failed-upgrade data is moved into `/opt/yuvomi/failed-upgrades/` for recovery. Do not switch to the old image alone against schema 195. The restored old-image override is in the backup directory; after rollback, review its Compose configuration before another restart.

Disposable test containers were removed, connectivity prototypes were archived in the release's `diagnostics/` directory, and the temporary rehearsal credential copy was removed. The local temporary deployment SSH key files were removed after final VM verification; the corresponding project metadata entry expires automatically. Normal user SSH keys were untouched.

## Fork publication - 3 October 2026

The personal fork is [stephbackv2/yuvomi](https://github.com/stephbackv2/yuvomi). The customization branch is `codex/household-customizations`, containing the unchanged deployment commit followed by a separate deployment-documentation commit.

The original workspace now uses the personal fork as `origin` and `https://github.com/ulsklyc/yuvomi.git` as `upstream`. The feature source matches the deployed version, including calendar, recipes and Bring! work; the running VM continues to use commit `619911292e961dd8cb5f8b54e6cf62ba708f3a99`.

Continue development on the customization branch and push it to `origin`. Fetch `upstream` when deliberately preparing an upstream update; reconcile and validate it before deploying another image. The repository's upstream `main` branch is retained separately from the personal customization branch.
