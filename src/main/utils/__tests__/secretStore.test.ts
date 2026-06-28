import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted: the vi.mock factory below is hoisted above module init, so the mock object
// it references must be created in a hoisted block too (otherwise: access-before-init).
const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`ENC<${s}>`, 'utf-8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8').replace(/^ENC<([\s\S]*)>$/, '$1'))
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

import { decryptSecret, encryptSecret, isEncryptedSecret, isEncryptionAvailable } from '../secretStore'

beforeEach(() => {
  // Reset to the available-and-working baseline before each case (avoids mock leak).
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

describe('secretStore', () => {
  it('round-trips a secret through encrypt/decrypt without leaking the plaintext', () => {
    const enc = encryptSecret('super-secret-token')
    expect(enc).not.toContain('super-secret-token')
    expect(isEncryptedSecret(enc)).toBe(true)
    expect(decryptSecret(enc)).toBe('super-secret-token')
  })

  it('emits an enc:v1: envelope', () => {
    expect(encryptSecret('x')).toMatch(/^enc:v1:/)
  })

  it('passes legacy plaintext through on decrypt (transparent migration)', () => {
    expect(isEncryptedSecret('{"plain":true}')).toBe(false)
    expect(decryptSecret('{"plain":true}')).toBe('{"plain":true}')
  })

  it('falls back to plaintext when the OS keychain is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const out = encryptSecret('still-works')
    expect(out).toBe('still-works')
    expect(isEncryptedSecret(out)).toBe(false)
    expect(isEncryptionAvailable()).toBe(false)
  })

  it('treats isEncryptionAvailable throwing as unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('no keychain')
    })
    expect(isEncryptionAvailable()).toBe(false)
    expect(encryptSecret('v')).toBe('v')
  })
})
