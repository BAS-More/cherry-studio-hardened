import { loggerService } from '@logger'
import { decryptSecret, encryptSecret } from '@main/utils/secretStore'
import type { ApiKeyEntry } from '@shared/data/types/provider'
import { customType } from 'drizzle-orm/sqlite-core'

const logger = loggerService.withContext('DbCustomTypes')

/**
 * Serialize `ApiKeyEntry[]` for storage, encrypting each `.key` secret at rest via Electron
 * `safeStorage` (see secretStore). Non-secret fields (id/label/isEnabled) stay plaintext so
 * they remain readable for display/indexing. Exported for unit testing.
 */
export function encodeApiKeys(entries: ApiKeyEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({ ...entry, key: encryptSecret(entry.key) })))
}

/**
 * Parse a stored `ApiKeyEntry[]`, decrypting each `.key`. Legacy plaintext keys (no `enc:v1:`
 * envelope) pass through unchanged, so pre-existing databases keep working and re-encrypt on
 * their next write (transparent migration). A key that fails to decrypt (e.g. the OS keychain
 * changed) degrades to an empty string the user can re-enter, rather than failing the whole
 * provider read. Exported for unit testing.
 */
export function decodeApiKeys(value: string): ApiKeyEntry[] {
  const entries = JSON.parse(value) as ApiKeyEntry[]
  return entries.map((entry) => {
    try {
      return { ...entry, key: decryptSecret(entry.key) }
    } catch (error) {
      logger.error('Failed to decrypt a stored API key; returning empty key for re-entry', error as Error)
      return { ...entry, key: '' }
    }
  })
}

/**
 * Drizzle SQLite JSON column of `ApiKeyEntry[]` whose `.key` secret is encrypted at rest.
 * Transparent to callers: `ProviderService` reads and writes plaintext `ApiKeyEntry[]` on both
 * sides. Drop-in replacement for `text({ mode: 'json' }).$type<ApiKeyEntry[]>()` — call with no
 * name argument to preserve the derived column name.
 */
export const encryptedApiKeys = customType<{ data: ApiKeyEntry[]; driverData: string }>({
  dataType() {
    return 'text'
  },
  toDriver(entries: ApiKeyEntry[]): string {
    return encodeApiKeys(entries)
  },
  fromDriver(value: string): ApiKeyEntry[] {
    return decodeApiKeys(value)
  }
})
