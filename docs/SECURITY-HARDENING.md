# Cherry Studio — Security Hardening Branch

Branch: `harden/security-baseline` · Fork base: `CherryHQ/cherry-studio` @ `b06aa99` (v2.0.0-dev)
Toolchain: Node 24.14.0 · pnpm 11.8.0 · Windows 11

This branch hardens specific security weaknesses found in a source-level audit, **one verified
commit at a time**, each gated by a real test run. This doc is the audit-of-record: what was
found, what is fixed-and-verified, and exactly what remains (with risk and recommended approach).

> Status legend: ✅ done+verified · 🟡 recommended follow-up (decision/feature-coupled/large) · ⏳ not started

---

## 1. Baseline (captured BEFORE any change, on this Windows box)

| Check | Result |
|---|---|
| `test:renderer` | ✅ 538 files pass |
| `test:aicore` | ✅ 16 pass |
| `test:shared` | ✅ 54 pass |
| `test:provider-registry` | ✅ 2 pass |
| `typecheck` (`tsgo`) | ✅ clean |
| **Target harness** (the 6 files covering the audited code) | ✅ 124 pass / 8 skip |
| `test:main` (full project) | ⚠️ **not completable on Windows** — `better-sqlite3` native access-violation (0xC0000005) in `Knowledge*Store` tests + `EPERM` temp-file locking. Non-deterministic location, consistent occurrence. Pre-existing/upstream. |
| `test:scripts` | ⚠️ 1 pre-existing fail (Windows path-separator assertion) |
| `test:lint` | ⚠️ pre-existing fail (oxlint/eslint warnings-as-errors) |
| native `canvas@2.11.2` | ⚠️ did not compile (no Cairo headers); pnpm tolerated (exit 0) |

**Every ⚠️ predates this branch.** Because the full `test:main` project can't run to completion
here, the verification harness for `src/main` changes is the exact-file subset below.

### Verification harness (re-runnable)
```
pnpm exec vitest run --project main --reporter=dot \
  src/main/utils/__tests__/envSecurity.test.ts \
  src/main/utils/__tests__/secretStore.test.ts \
  src/main/ai/mcp/oauth/__tests__/storage.test.ts \
  src/main/core/window/__tests__/windowRegistry.test.ts \
  src/main/services/__tests__/MainWindowService.test.ts \
  src/main/services/codeCli/__tests__/CodeCliService.test.ts \
  src/main/services/codeCli/__tests__/codeCliService.helpers.test.ts \
  src/main/ai/mcp/__tests__/McpPackageService.test.ts \
  src/main/ai/runtime/claudeCode/__tests__/settingsBuilder.test.ts
pnpm typecheck:node
```

---

## 2. Dependency audit baseline (`pnpm audit`)

| Scope | Total | critical | high | moderate | low |
|---|---|---|---|---|---|
| Runtime (`--prod`) | 111 | 0 | **40** | 65 | 6 |
| Full (incl. dev) | 185 | 6 | 73 | 96 | 10 |

All 6 criticals are **dev-only** (absent from `--prod`).

**✅ Done (`b7f037d`).** Keyed-range overrides in `pnpm-workspace.yaml` floor the HIGH runtime
advisories (13 distinct packages), scoped to vulnerable ranges to preserve major-line APIs:

| Scope | high (before → after) | total (before → after) |
|---|---|---|
| Runtime (`--prod`) | **40 → 0** | 111 → 31 |

Floored: axios, @xmldom/xmldom, tar, hono, fast-uri, @hono/node-server, express-rate-limit,
path-to-regexp, lodash-es, underscore, ws, form-data, minimatch (9.0.6→9.0.7), and the deep
`tar@6.2.1` holdout (via `canvas → @mapbox/node-pre-gyp`; no fixed 6.x release exists → overridden
to `7.5.19`, `f84b7b8`). Runtime **high + critical advisories are now 0** (27 moderate + 4 low
remain). *Gotcha hit & fixed:* an advisory's `patched_versions` floor is not always a real published
release (`lodash-es@4.17.24` does not exist → pin verified-existing versions, else `pnpm install`
fails and half-writes the lockfile, breaking the pre-run deps check for every script).

---

## 3. Findings & status (re-grounded against `b06aa99`)

| # | Finding | Location | Severity | Status |
|---|---|---|---|---|
| 6 | CLI-tool env injection (NODE_OPTIONS/LD_PRELOAD/DYLD_* → `spawn`) | `CodeCliService.ts:861` → `:1237` | HIGH | ✅ **fixed** (`bc0d522`) |
| 1 | `webSecurity:false` | `windowRegistry.ts:88,128,200,261`; `MigrationWindowManager.ts:92` | HIGH | 🟡 MiniApp-coupled |
| 2 | `sandbox:false` | `windowRegistry.ts:87,127,199,260,350,406`; `MigrationWindowManager.ts:91` | HIGH | 🟡 MiniApp-coupled |
| 3 | CSP / X-Frame-Options stripped for `*://*/*` | `MainWindowService.ts:389-403` | CRITICAL | 🟡 MiniApp-coupled |
| 9a | OAuth tokens / client secrets / PKCE verifiers stored plaintext | `mcp/oauth/storage.ts` | CRITICAL | ✅ **fixed** (`77877eb`) |
| 9b | Provider API keys stored plaintext | `userProvider.ts` schema; `ProviderService` | CRITICAL | 🟡 DB-test-blocked here |
| — | High-severity runtime dep CVEs (Phase 1) | `pnpm audit --prod` | HIGH×40 | ✅ **40→0** (`b7f037d`,`f84b7b8`) |
| 5 | `verifyUpdateCodeSignature:false` | `electron-builder.yml:92` | HIGH | 🟡 decision-dependent |
| 4 | `shell:true` for non-`.exe` Windows commands | `process.ts:493-500` | MEDIUM (args are arrays; cmd validated upstream) | 🟡 follow-up |
| 8 | Pyodide loaded from CDN without SRI (version *is* pinned `v0.28.0`) | `pyodide.worker.ts:18-19` | MEDIUM | 🟡 follow-up |
| — | (`new Function()` worker from prior audit) | — | — | ❎ **not present** in this checkout |

---

## 4. Completed

### ✅ #6 — Denylist process-affecting env vars before child spawn (`bc0d522`)
`CodeCliService.run()` forwarded the IPC-supplied `env` straight into `spawn()`, so a caller
could set `NODE_OPTIONS=--require <evil>` / `LD_PRELOAD` / `DYLD_*` and gain code execution in
the launched CLI tool's process.

- **New** `src/main/utils/envSecurity.ts` — single source of truth: `DANGEROUS_CHILD_ENV_KEYS`,
  `isDangerousChildEnvKey()`, `sanitizeChildEnv()` (drop-and-warn or throw; always rejects null bytes).
- `CodeCliService.ts:861` now `sanitizeChildEnv(env)` before merge → spawn (drop-and-warn: a stray
  var doesn't block a launch, but the injection vector is closed).
- `McpPackageService.buildResolvedEnv` refactored to consume `isDangerousChildEnvKey` instead of
  its own inline `DXT_ENV_DENYLIST` (de-duplicated the security control).
- **Tests:** new `envSecurity.test.ts` (9 cases) + existing `McpPackageService`/`CodeCliService`
  suites still green. **Verified:** harness 133 pass / 8 skip, `typecheck:node` clean.

### ✅ Phase 1 — Floor high-severity runtime CVEs (`b7f037d`)
13 packages drove the 40 high runtime advisories. Surgical keyed-range overrides floor them to
verified-existing secure versions. **40 → 0 high** — including the deep `tar@6.2.1` holdout under
`canvas → @mapbox/node-pre-gyp` (no fixed 6.x; overridden to 7.5.19, `f84b7b8`). Runtime now
0 high / 0 critical (27 moderate + 4 low remain). Verified: clean `pnpm install`, harness green,
`typecheck:node` clean.

### ✅ #9a — Encrypt MCP OAuth tokens at rest (`77877eb`)
OAuth access/refresh tokens, client secrets, and PKCE verifiers were plaintext JSON on disk.
- **New** `src/main/utils/secretStore.ts` — `encryptSecret`/`decryptSecret` over Electron
  `safeStorage` (OS keychain), `enc:v1:` envelope, fail-open when no keychain, legacy-plaintext
  passthrough (transparent migration).
- `JsonFileStorage` (`mcp/oauth/storage.ts`) encrypts on write, decrypts on read.
- **Tests:** `secretStore.test.ts` + new `storage.test.ts` cases assert ciphertext-on-disk,
  round-trip, and legacy-file migration. Verified: harness 146 pass/8 skip, `typecheck:node` clean.

---

## 5. Remaining — recommended approach (NOT done blind)

**#1/#2/#3 — webSecurity / sandbox / CSP (the MiniApp-coupled trio).**
`validateSender.ts:67-68` documents that `webviewTag:true + webSecurity:false` exists so MiniApps
can render arbitrary remote URLs. Recommended *safe* approach: **scope, don't blanket-flip** —
keep the relaxed prefs ONLY on the dedicated MiniApp `<webview>` partition; set
`sandbox/webSecurity:true` on the main app + settings windows; replace the blanket CSP/X-Frame
*deletion* with a deletion narrowed to MiniApp sessions + a restrictive CSP served to the main
window. **Requires running the actual app** to confirm MiniApps still load and the main window
isn't white-screened — cannot be verified in this headless environment.

**#9b — provider API keys → `safeStorage`.** OAuth tokens are now encrypted (`77877eb`). The
remaining piece is `user_provider.apiKeys` (DB-backed). Cleanest design: a Drizzle `customType`
wrapping the `apiKeys` column — `toDriver` encrypts the JSON, `fromDriver` decrypts (legacy
plaintext passes through, re-encrypted on next write) — a single choke point covering every
read/write site in `ProviderService`, reusing the shipped `secretStore` util. **Not done here**:
its verifying tests use the SQLite native layer that segfaults on this Windows box (§1), so it
must be implemented where DB tests run (Linux/macOS CI).

**#5 — update signature.** If releases are signed (`scripts/win-sign.js` + a real cert): set
`verifyUpdateCodeSignature: true`. If builds are unsigned (typical local fork): **disable the
auto-updater** instead of shipping an unverified update channel. Pick per your signing setup.

**#4 — `crossPlatformSpawn`.** If hardened, add a shell-metacharacter guard on `command`/`args`
on the `shell:true` branch only; verify it doesn't reject legitimate `.cmd` paths.

**#8 — Pyodide.** Bundle Pyodide locally (≈10 MB) or add SRI/`connect-src` restriction via the
(future) renderer CSP.

**~~Residual `tar` highs~~ → DONE (`f84b7b8`).** The 6 were `tar@6.2.1` via
`canvas → @mapbox/node-pre-gyp` — no fixed 6.x release exists, so overridden to `7.5.19`
(node-pre-gyp's tar usage is 7-compatible; install clean). Runtime high + critical now 0.

**Moderate/low runtime advisories (27 + 4).** Lower urgency. Floorable with the same keyed-override
method if desired, but each adds dependency churn for marginal severity — recommend leaving unless a
specific moderate is reachable in a sensitive path.
