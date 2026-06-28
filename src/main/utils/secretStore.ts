import { loggerService } from '@logger'
import { safeStorage } from 'electron'

const logger = loggerService.withContext('SecretStore')

/**
 * Envelope prefix marking a value encrypted by {@link encryptSecret}. Values WITHOUT
 * this prefix are treated as legacy plaintext and passed through unchanged on read, so
 * pre-existing on-disk secrets keep working and are encrypted on their next write
 * (transparent migration).
 */
const ENVELOPE_PREFIX = 'enc:v1:'

/** Whether OS-backed secret encryption (DPAPI / Keychain / libsecret) is usable right now. */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** True if `stored` was produced by {@link encryptSecret} (vs legacy plaintext). */
export function isEncryptedSecret(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(ENVELOPE_PREFIX)
}

/**
 * Encrypt a secret string for at-rest storage via Electron `safeStorage` (OS keychain
 * backed). Returns an `enc:v1:<base64>` envelope.
 *
 * Fail-open: if the OS keychain is unavailable (e.g. headless Linux without a secret
 * service), logs and returns the plaintext unchanged so the app keeps functioning. The
 * result is therefore opaque, NOT guaranteed-encrypted — callers must not assume it is.
 */
export function encryptSecret(plaintext: string): string {
  if (!isEncryptionAvailable()) {
    logger.warn('OS secret encryption unavailable; persisting value without at-rest encryption')
    return plaintext
  }
  const encrypted = safeStorage.encryptString(plaintext)
  return ENVELOPE_PREFIX + encrypted.toString('base64')
}

/**
 * Decrypt a value produced by {@link encryptSecret}. A value without the envelope prefix
 * is legacy plaintext and returned unchanged (transparent migration).
 *
 * @throws if an enveloped value cannot be decrypted (e.g. the OS keychain changed).
 */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) {
    return stored
  }
  const payload = Buffer.from(stored.slice(ENVELOPE_PREFIX.length), 'base64')
  return safeStorage.decryptString(payload)
}
