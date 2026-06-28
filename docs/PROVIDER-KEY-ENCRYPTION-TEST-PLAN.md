# Provider API-Key Encryption (#9b) — Build-Test Plan

Branch: `harden/provider-key-encryption` (off `harden/security-baseline`)
Encrypts provider API keys at rest, reusing the shipped `secretStore` (Electron `safeStorage`).

> Unlike the window-security branch, **this one is fully unit + DB-test verified here**
> (`@libsql/client` runs on this box). Your build-test confirms the real-keychain ciphertext.

---

## What changed

| File | Change |
|---|---|
| `src/main/data/db/schemas/_customTypes.ts` (new) | `encryptedApiKeys` Drizzle `customType` + exported `encodeApiKeys`/`decodeApiKeys`. Encrypts each `ApiKeyEntry.key` on write, decrypts on read. |
| `src/main/data/db/schemas/userProvider.ts` | `apiKeys` column: `text({mode:'json'})` → `encryptedApiKeys()` (same derived column name, same `TEXT` DDL). |
| `__tests__/_customTypes.test.ts` (new) | 5 codec cases. |

**How it works (transparent at the DB boundary):**
- **Write:** `ProviderService` still passes plaintext `ApiKeyEntry[]`; the codec encrypts each `.key`
  to an `enc:v1:<base64>` envelope before SQLite stores it. id/label/isEnabled stay plaintext.
- **Read:** the codec decrypts each `.key` back to plaintext; `ProviderService` is unchanged.
- **Legacy migration (automatic):** old plaintext keys have no `enc:v1:` envelope → they pass
  through unchanged on read, and re-encrypt on the next write. **No schema migration needed** —
  the column stays `TEXT`; only the stored values change. Existing databases just work.
- **No keychain (headless Linux, etc.):** `safeStorage` unavailable → stores plaintext (fail-open),
  app keeps working.
- **Undecryptable key (OS keychain changed):** that one key degrades to `""` (re-enter it) rather
  than failing the whole provider read.

**Scope note:** This covers `user_provider.apiKeys`. The `authConfig` column (provider OAuth
access/refresh tokens) is a parallel secret that the *same* `customType` pattern can wrap — left as
a follow-up to keep this diff focused. (MCP OAuth tokens were already encrypted in `#9a`.)

---

## Verified here (pre-build)
- `_customTypes.test.ts` — encrypts `.key` (no plaintext in serialized column), round-trips,
  reads legacy plaintext, falls back without keychain, degrades undecryptable keys.
- **No regression**: `ProviderService.apiKeys` / `.update` / `.delete` + `ProviderModelMigrator`
  (real `@libsql` SQLite DB) — 61 tests pass.
- `typecheck:node` clean.

## Build & confirm at-rest ciphertext (your part)

```bash
git checkout harden/provider-key-encryption
pnpm install --frozen-lockfile
pnpm build:win:x64        # or your OS
```

Then, in the built app:
1. Add/enter a provider **API key** in Settings, and confirm the provider works (send a chat) —
   proves encrypt-on-write + decrypt-on-read round-trips with the *real* OS keychain.
2. **Confirm it's encrypted at rest:** open the app's SQLite DB (under your `userData` dir) and read
   the `user_provider` table's `apiKeys` column — the `key` values should be `enc:v1:…`, **not** your
   plaintext key. (e.g. `sqlite3 <userData>/<db>.db "select api_keys/apiKeys from user_provider;"`)
3. **Legacy check (optional):** start from a pre-change DB that has a plaintext key → confirm the
   provider still works (passthrough), then edit the key and re-check the column is now `enc:v1:…`.

## If you regenerate migrations
`drizzle-kit generate` should produce **no new migration** (the column DDL is unchanged `TEXT`).
If you run it, confirm there's no diff for `user_provider.apiKeys`. The `customType` only adds
runtime (de)serialization; it does not alter the table shape.

## Optional follow-up I can add on request
- A one-time bulk migrator (`migration/v2/migrators/`) that eagerly encrypts every existing
  plaintext key (instead of lazy re-encrypt-on-write).
- Extend the same `customType` to `authConfig` (provider OAuth tokens).
