# PHP security assessment — 28 October 2026

Checked against primary sources on 28 October 2026 (Europe/Berlin). “Last week” means 19–25 October 2026.

**Initial finding:** Yuvomi has no identified dependency on the PHP runtime, so the PHP2Shell runtime CVEs do not apply to its standard stack. However, the separate Brotli vulnerability **CVE-2026-111497** applies to the initially observed local Node version and Docker pin. Both inbound request parsing and outbound HTTP responses reach the Brotli decoder. This checkout now contains the remediation described at the end of this report; production runtime patch status has not been verified.

## PHP runtime advisories

The 21 October emergency release addresses two critical, unauthenticated remote-code-execution vulnerabilities. The affected component is the PHP runtime (`php-src`), including installations embedded in other products. PHP web-serving configurations include PHP-FPM, Apache `mod_php`, CGI, FrankenPHP and LiteSpeed. PHP identifies `mod_php` as the highest-risk setup. [PHP advisory](https://www.php.net/archive/2026.php), [CERT-EU advisory 2026-018](https://cert.europa.eu/publications/security-advisories/2026-018/).

| Vulnerability | Mechanism and relevant conditions | Primary source |
| --- | --- | --- |
| CVE-2026-109618 | Out-of-memory handling can interrupt initialization, leaving invalid request data for cleanup. RCE was demonstrated with Apache `mod_php` before application code executes. FPM susceptibility depends on application execution paths; the advisory does not demonstrate a complete FPM exploit for this CVE. | [PHP GHSA-w8hw-w9fx-j79w](https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w) |
| CVE-2026-109619 | Request-owned state can remain referenced after its memory is freed; a later request in the same worker consumes it before initialization. Confirmed paths involve early configuration diagnostics and session upload progress. RCE was validated with `mod_php` and, for an application-dependent session lifecycle path, FPM. | [PHP GHSA-6wmf-4rv5-p3rp](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp) |

The fixed supported versions are **8.2.35, 8.3.36, 8.4.27 and 8.5.12**. Earlier patch releases on these branches are affected. PHP 8.1 and older require vendor backports or an upgrade; minimal source backports were also published for 7.4, 8.0 and 8.1. Configuration workarounds do not completely fix the two CVEs. [CERT-EU remediation and affected products](https://cert.europa.eu/publications/security-advisories/2026-018/).

## Follow-up notices

On **23 October**, PHP described **CVE-2026-115560**, an additional session-upload-progress RCE vector under unusual conditions: configuration initially selects `php_binary` or `php_serialize`, application code switches to `php` with `ini_set()` before `session_start()`, and upload progress remains enabled. PHP recommends `session.upload_progress.enabled=0` pending the next regular bugfix release. Applications that never switch the serialization handler at runtime do not need that workaround. [PHP informational advisory](https://www.php.net/archive/2026.php).

On **26 October**, PHP issued Windows package rebuilds **8.2.35-1, 8.3.36-1, 8.4.27-1 and 8.5.12-1**, bundling **Brotli 1.2.1**. The PHP runtime source versions did not change. The affected Brotli decoder is reachable through PHP's cURL extension when automatic response decompression is enabled. [PHP Windows build notice](https://www.php.net/archive/2026.php).

Brotli's own **21 October** release identifies **CVE-2026-111497**, an out-of-bounds write permitting RCE, as fixed in 1.2.1. This is a separate shared-library vulnerability, so a non-PHP runtime may need its own Brotli assessment. Absence of PHP establishes no conclusion about a bundled Brotli version or decoder reachability. [Google Brotli 1.2.1 release](https://github.com/google/brotli/releases/tag/v1.2.1).

## Shared Brotli vulnerability in Node.js

Node.js's **21 October** security advisory independently confirms **CVE-2026-111497** in its bundled Brotli decoder, affecting Node 22.x, 24.x and 26.x. Malformed Brotli supplied to `node:zlib` decompression can overflow decoder memory, potentially causing a crash, memory disclosure or RCE. Exposure therefore requires a reachable path that decompresses attacker-controlled Brotli data. The security releases are **22.23.4, 24.22.1 and 26.12.1**. [Node.js October 2026 advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

Node 24.22.1 explicitly includes the fix as a Brotli commit cherry-pick (`0ed4268a4401abcb44720963`). Its bundled Brotli version string alone therefore does not establish patch status; use the Node release or verified patch provenance. [Node.js 24.22.1 release](https://nodejs.org/en/blog/release/v24.22.1/).

## Repository assessment

### PHP runtime: no identified exposure in the standard stack

- `package.json` starts `server/index.js` with Node.js and requires Node >=22. Dependencies include Express 5.2.1; there is no Composer manifest or tracked PHP source file.
- Inspected all **242** dependency entries in `package-lock.json`, including optional dependencies and development dependencies: **185** entries without the development-only flag and **57** development-only entries. No PHP or Composer package metadata was found. The two packages declaring install scripts are bcrypt and Puppeteer.
- `Dockerfile:4` and `Dockerfile:26` both use the same pinned official Node slim image. The runtime stage installs `gosu`; the build stage installs Python, make and g++. The application starts with `node server/index.js`. There is no PHP installation or PHP web server in the declared build.
- Standard Docker/Podman and platform deployment descriptors do not declare a PHP service. Nextcloud/ownCloud/Baikal references describe optional remote CalDAV, CardDAV or WebDAV integrations. Their own PHP installations require a separate check; a connection to one does not embed PHP inside Yuvomi.

These findings rule out the identified PHP runtime CVEs for the declared stack, not arbitrary custom modules, host software or independently deployed services.

### Shared Brotli: affected runtime and reachable code paths

At initial assessment, the shell resolved Node to `C:\nvm4w\nodejs\node.exe`. A read-only runtime query returned:

```json
{"node":"v24.18.0","brotli":"1.2.0","undici":"7.28.0"}
```

Node **24.18.0** predates the **24.22.1** security fix. At initial assessment the Dockerfile comment recorded its pinned digest as **Node 24.20.0-slim, dated 4 September 2026**, which also predates the fix. The old image's actual Node binary was not independently inspected: the local Docker daemon was not running, and no production container was accessed.

The relevant dependency chain is:

```text
Unauthenticated HTTP request
  -> server/index.js:159-160 express.json / express.urlencoded
  -> Express 5.2.1 -> body-parser 2.3.0
  -> node_modules/body-parser/lib/read.js:224 createBrotliDecompress
  -> Node's bundled Brotli decoder
```

Both parsers run before `sessionMiddleware` (`server/index.js:176`) and route authentication. They leave body-parser's default `inflate: true` enabled. Installed body-parser 2.3.0 matches the lockfile and handles `Content-Encoding: br` using Node's streaming Brotli decoder. Therefore attacker-controlled compressed bodies can reach the vulnerable component before application authentication, subject to any independently configured upstream access controls. This establishes decoder reachability, not a demonstrated RCE exploit.

There is also an outbound path: `server/utils/http.js:120` advertises `Accept-Encoding: gzip, deflate, br`, and `server/utils/http.js:141` decompresses Brotli responses. Callers include ICS subscriptions, recipe imports/providers and WebDAV document storage. A malicious or compromised remote endpoint can supply the compressed response; destination-address SSRF restrictions do not validate the compression stream.

### Verification and action

- Confirmed normal Brotli handling with an in-memory `PassThrough` request containing **valid** Brotli-compressed JSON, passed directly to `express.json()`. The callback returned `{"assessmentProbe":true}` on Node 24.18.0. No network listener, real application, database or exploit payload was used.
- Fix the runtime by upgrading to **Node 24.22.1 or a later supported patched release** (or the corresponding fixed 22.x/26.x release above). Update both Docker base-image digest references, rebuild and redeploy; update bare-metal/local Node installations separately. Verify the running application's `process.version` after restart. An npm dependency update alone does not replace Node's bundled decoder.
- If a runtime update cannot be deployed immediately, rejecting compressed inbound request bodies and disabling Brotli decoding in all outbound clients can reduce exposure. Changing only `Accept-Encoding` is insufficient while a decoder still accepts `Content-Encoding: br`. Runtime replacement remains the recommended fix.
- Verify PHP-backed integrations such as Nextcloud separately against their PHP/vendor package advisories.

Scope: source, manifests, lockfile, installed parser source and local runtime were inspected. No container was started or pulled, no production deployment was scanned, and no application or dependency configuration was changed as part of this assessment. This report is not a full vulnerability audit.

## Remediation in this checkout

- Both Docker stages now pin the official multi-architecture `node:24.22.1-slim` index, SHA-256 `be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c`. Verified using `docker buildx imagetools inspect`; image configurations identify Node 24.22.1 for amd64, arm64 and ppc64le. `.scratch/` is excluded from the Docker build context.
- `package.json` and the root lockfile metadata require `^22.23.4 || ^24.22.1 || >=26.12.1`; `.nvmrc` selects 24.22.1. The first import of both the server and setup CLI enforces this policy before database initialization. An old bare-metal runtime now fails with an upgrade instruction instead of serving vulnerable request parsing.
- Brotli request and response support stays enabled because the fix replaces the vulnerable runtime decoder. No PHP dependency changes are necessary.
- A task-local Node 24.22.1 binary was downloaded for verification first. Its SHA-256 `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5` matches the [official checksum file](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt), and Windows verifies its OpenJS Foundation Authenticode signature. The HTML release page displayed a different checksum, so that cached value was not used to approve execution. The patched binary still reports Brotli 1.2.0, consistent with Node's backported fix.
- Installed Node 24.22.1 through the existing NVM for Windows installation and selected it using `nvm use 24.22.1`. The ordinary `node` command now reports v24.22.1. Other separately installed runtimes and deployment hosts were not changed.
- **Validation:** all **81** targeted tests passed on Node 24.22.1, covering runtime boundaries and rejection before database access, normal Brotli request/response decoding, server setup/startup, Docker pins/signing, README consistency, suite registration and database isolation. Relevant text checks now normalize CRLF; the database-isolation fixture stays on the repository's drive so its relative-import probes work on Windows. The full `npm test` suite was not run.
- Deployment and runtime verification commands are in [the installation guide](installation.md#node-runtime-security-update-28-october-2026). These source changes do not patch already-running containers. A Docker build and production redeployment remain to be performed because the local Docker daemon is stopped.

## Development follow-up — 15 November 2026

The WSL development environment now has Node **24.22.3**, and `.nvmrc` selects it.
This is the newer [11 November security release](https://nodejs.org/en/blog/release/v24.22.3).
The engine range and startup guard above retain their original scope: enforcing
the October Brotli fix. The Docker digest still selects the October Node 24.22.1
image; updating it to the November release requires a separately verified image
digest before a new deployment.

On Linux Node 24.22.3, **152 focused checks passed**, covering the database,
encryption, schema reconciliation and mirror, migration rules, database isolation,
shopping, service-worker reloads, Docker configuration, README consistency and
suite registration. The four runtime-policy/metadata/Brotli unit checks also pass.
Separate entry-point probes confirm both server startup and setup reject an
unpatched version before opening the database.

The sandbox attempt stopped in the runtime suite because it denies child-process
probes with `spawnSync EPERM`; local-server tests also encounter `listen EPERM`.
The user then ran validation from a regular WSL terminal. All six runtime checks
passed, including both startup rejection probes. The complete independent run
exercised **311 registered command groups: 308 passed and three failed** because
of outdated test assumptions about calendar CSS subjects, bound session-publication
state, and the meals endpoint's week query.

Those three test assumptions are corrected. Focused reruns passed **166 calendar
checks** and **19 recipe-provider-sync checks**, so every registered group now has
a passing result across the complete run and the correction reruns. An uninterrupted
`npm test` has not been repeated after these test-only corrections. No baseline
exceptions were accepted. The separate browser/release guards and live-provider
acceptance remain outside this validation record. Logs are local under
`.scratch/repo-readiness-20261115/`. Production runtime and deployment state have
not been rechecked in this development pass.
