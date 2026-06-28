# Window Security Hardening — Build-Test Plan

Branch: `harden/window-security` (off `harden/security-baseline`)
Addresses audit findings **#1 / #2 / #3** (`webSecurity` / `sandbox` / CSP).

> ⚠️ **These changes affect the live Electron renderer and cannot be verified headlessly.**
> This branch is isolated from `harden/security-baseline` precisely so you can build-test it
> without risking the verified-clean branch. Build it, run the checklist, report what breaks.

---

## What this diff changes (evidence-backed, scoped)

| Change | Where | Risk | Rationale |
|---|---|---|---|
| **`sandbox: false` → `sandbox: true`** on all 6 windows | `windowRegistry.ts` (Main, Settings, SubWindow, +1, 2 devtools windows) + `MigrationWindowManager.ts` | **Low** | Both preloads (`src/preload/index.ts`, `simplest.ts`) use **only** Electron APIs (`contextBridge`/`ipcRenderer`/`shell`/`webUtils`) — no Node built-ins → survive sandboxing. MiniApps render in separate `<webview>` WebContents (own `persist:webview` partition, IPC-gated by `validateSender`), so they're unaffected. |
| **Remove `allowRunningInsecureContent: true`** | `windowRegistry.ts` Main window | **None (now)** | The flag only takes effect when `webSecurity: true`. While `webSecurity` stays `false` it's a no-op + a latent footgun; removing it changes no current behavior. |

**Net security gain:** OS-level renderer sandboxing (seccomp-bpf / AppContainer / setuid sandbox).
Even if the renderer is compromised (malicious MiniApp content, XSS in rendered markdown), it can no
longer directly reach Node/OS syscalls — the blast radius drops to IPC messages, which are already
sender-validated.

---

## What this diff deliberately does NOT change (and why)

- **`webSecurity: false` — KEPT.** The renderer makes *direct* cross-origin `fetch()` calls
  (Yuque integration, MCP provider discovery, model-list lookups) from Settings pages. Re-enabling
  `webSecurity` would CORS-block those. The correct fix is to move those renderer fetches behind IPC
  (main-process proxy) — a multi-file refactor, tracked separately, not bundled here.
- **CSP / `X-Frame-Options` deletion — KEPT.** The header strip in `MainWindowService.ts` is scoped
  to the **host window's session** (not `defaultSession`); OAuth popups (`persist:webview`) and
  MiniApp `<webview>`s use separate partitions. It is intentional, enabling MiniApps to embed remote
  sites that send `X-Frame-Options: DENY`. Removing it risks breaking MiniApp embedding for marginal
  gain. Left as-is.

---

## Build & run

```bash
git checkout harden/window-security
corepack use pnpm@11.8.0
pnpm install --frozen-lockfile
pnpm build:win:x64        # or build:mac / build:linux for your OS
# then launch the built app from dist/
# (or, for a faster dev loop:)  pnpm dev
```

## Verification checklist — the change is GOOD only if ALL pass

1. **App launches** and the main window renders (no white screen, no preload error in the console).
2. **IPC works** — basic actions that round-trip to the main process: open Settings, switch
   theme, send a chat message to a configured provider (this exercises `window.api`/`ipcRenderer`
   through the now-sandboxed preload).
3. **Streaming responses** render live (SubWindow/Main host streaming LLM output) — no freeze.
4. **MiniApps load** — open a MiniApp; the embedded remote site renders inside its `<webview>`
   (this is the main thing the relaxed flags historically protected; confirm it still works).
5. **Settings integrations that fetch remote APIs still validate** — e.g. Yuque token check,
   MCP provider discovery (these are the renderer cross-origin calls; they rely on `webSecurity:false`,
   which we KEPT — so they should still work, but confirm).
6. **OAuth flow** (if you use an MCP/provider OAuth) opens and completes in its popup window.
7. **The migration window** (v2 data migration, if triggered) opens and functions.

## If something breaks

Each change is isolated. To bisect:
- **App won't start / preload error** → most likely `sandbox: true`. Revert a single window by
  setting `sandbox: false` back on its `webPreferences` in `windowRegistry.ts` and rebuild to
  confirm which window is the culprit; report it and we'll investigate that preload path.
- **A remote image / HTTP resource stopped loading** → possibly the `allowRunningInsecureContent`
  removal (only if a MiniApp loaded HTTP content on an HTTPS page). Re-add it on the Main window.

Report back which checklist items fail (and any console errors) and I'll adjust the scope.

---

## Verified here (pre-build)
- `windowRegistry.test.ts` security-posture guard added (fails if `sandbox:false` or
  `allowRunningInsecureContent` is ever reintroduced).
- Window test suite green: `windowRegistry` + `WindowManager` + `MainWindowService` — 151 pass.
- `typecheck:node` clean.

What this CANNOT verify (your build-test does): live renderer behavior under `sandbox:true`,
MiniApp rendering, and the integration fetches above.
