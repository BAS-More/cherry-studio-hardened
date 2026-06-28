import type { ApiKeyEntry } from '@shared/data/types/provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`ENC<${s}>`, 'utf-8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8').replace(/^ENC<([\s\S]*)>$/, '$1'))
}))
vi.mock('electron', () => ({ safeStorage: safeStorageMock }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

import { decodeApiKeys, encodeApiKeys } from '../_customTypes'

const sample: ApiKeyEntry[] = [
  { id: 'a', key: 'sk-secret-1', label: 'one', isEnabled: true },
  { id: 'b', key: 'sk-secret-2', isEnabled: false }
]

beforeEach(() => {
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  safeStorageMock.decryptString.mockImplementation((b: Buffer) => b.toString('utf-8').replace(/^ENC<([\s\S]*)>$/, '$1'))
})

describe('encryptedApiKeys codec', () => {
  it('encrypts each .key at rest — no plaintext secret in the serialized column', () => {
    const stored = encodeApiKeys(sample)
    expect(stored).not.toContain('sk-secret-1')
    expect(stored).not.toContain('sk-secret-2')
    expect(stored).toContain('enc:v1:')
    // non-secret fields stay plaintext for display/indexing
    expect(stored).toContain('"label":"one"')
  })

  it('round-trips back to the original plaintext entries', () => {
    expect(decodeApiKeys(encodeApiKeys(sample))).toEqual(sample)
  })

  it('reads legacy plaintext rows unchanged (transparent migration)', () => {
    const legacy = JSON.stringify(sample) // no enc:v1: envelope
    expect(decodeApiKeys(legacy)).toEqual(sample)
  })

  it('falls back to plaintext storage when the OS keychain is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const stored = encodeApiKeys(sample)
    expect(stored).toContain('sk-secret-1') // not encrypted, but still round-trips
    expect(decodeApiKeys(stored)).toEqual(sample)
  })

  it('degrades an undecryptable key to empty rather than throwing', () => {
    const stored = encodeApiKeys(sample) // valid enc:v1: envelopes
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('keychain changed')
    })
    const out = decodeApiKeys(stored)
    expect(out[0].key).toBe('')
    expect(out[0].id).toBe('a')
    expect(out[1].key).toBe('')
  })
})
