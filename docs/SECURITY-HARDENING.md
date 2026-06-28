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

All 6 criticals are **dev-only** (absent from `--prod`). Remediation plan: floor reachable
transitive CVEs via root `pnpm.overrides`, re-run `pnpm install --frozen-lockfile=false` +
the harness, then `pnpm audit --prod --audit-level high` as the gate. **Not yet applied** (⏳) —
overrides can introduce peer conflicts and must be verified against a full build, which is the
next sized piece of work.

---

## 3. Findings & status (re-grounded against `b06aa99`)

| # | Finding | Location | Severity | Status |
|---|---|---|---|---|
| 6 | CLI-tool env injection (NODE_OPTIONS/LD_PRELOAD/DYLD_* → `spawn`) | `CodeCliService.ts:861` → `:1237` | HIGH | ✅ **fixed** (`bc0d522`) |
| 1 | `webSecurity:false` | `windowRegistry.ts:88,128,200,261`; `MigrationWindowManager.ts:92` | HIGH | 🟡 MiniApp-coupled |
| 2 | `sandbox:false` | `windowRegistry.ts:87,127,199,260,350,406`; `MigrationWindowManager.ts:91` | HIGH | 🟡 MiniApp-coupled |
| 3 | CSP / X-Frame-Options stripped for `*://*/*` | `MainWindowService.ts:389-403` | CRITICAL | 🟡 MiniApp-coupled |
| 9 | API keys + OAuth tokens stored plaintext | `userProvider.ts` schema; `ProviderService.getRotatedApiKey`; `mcp/oauth/storage.ts` | CRITICAL | 🟡 migration |
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

**#9 — plaintext secrets → `safeStorage`.**
Encrypt `user_provider.apiKeys` and `mcp/oauth/storage.ts` tokens at rest with Electron
`safeStorage.encryptString`, plus a one-time migration of existing plaintext values + a fallback
when the OS keychain is unavailable. This is a feature-sized change with a data-migration path.

**#5 — update signature.** If releases are signed (`scripts/win-sign.js` + a real cert): set
`verifyUpdateCodeSignature: true`. If builds are unsigned (typical local fork): **disable the
auto-updater** instead of shipping an unverified update channel. Pick per your signing setup.

**#4 — `crossPlatformSpawn`.** If hardened, add a shell-metacharacter guard on `command`/`args`
on the `shell:true` branch only; verify it doesn't reject legitimate `.cmd` paths.

**#8 — Pyodide.** Bundle Pyodide locally (≈10 MB) or add SRI/`connect-src` restriction via the
(future) renderer CSP.

**Phase 1 overrides.** Apply `pnpm.overrides` for the 40 high runtime advisories, then re-verify
against a full `pnpm build` + harness.
