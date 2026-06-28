import type { OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the real at-rest encryption path with a deterministic safeStorage stub.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`ENC<${s}>`, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf-8').replace(/^ENC<([\s\S]*)>$/, '$1'))
  }
}))

import { JsonFileStorage } from '../storage'

describe('JsonFileStorage round-trip', () => {
  let configDir: string
  const serverUrlHash = 'abc123hash'

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-storage-test-'))
  })

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true })
  })

  it('writes the file under <serverUrlHash>_oauth.json in the config dir', async () => {
    const storage = new JsonFileStorage(serverUrlHash, configDir)

    await storage.saveCodeVerifier('verifier-xyz')

    const filePath = path.join(configDir, `${serverUrlHash}_oauth.json`)
    await expect(fs.access(filePath)).resolves.toBeUndefined()
  })

  it('round-trips tokens through a fresh instance (no in-memory cache)', async () => {
    const tokens: OAuthTokens = {
      access_token: 'access-token-value',
      token_type: 'Bearer',
      refresh_token: 'refresh-token-value',
      expires_in: 3600
    }

    const writer = new JsonFileStorage(serverUrlHash, configDir)
    await writer.saveTokens(tokens)

    // A new instance has an empty cache, so this read comes from disk.
    const reader = new JsonFileStorage(serverUrlHash, configDir)
    await expect(reader.getTokens()).resolves.toEqual(tokens)
  })

  it('encrypts the on-disk payload at rest (no plaintext secret on disk)', async () => {
    const storage = new JsonFileStorage(serverUrlHash, configDir)
    await storage.saveTokens({ access_token: 'secret-abc', token_type: 'Bearer' })

    const onDisk = await fs.readFile(path.join(configDir, `${serverUrlHash}_oauth.json`), 'utf-8')
    expect(onDisk).toMatch(/^enc:v1:/)
    expect(onDisk).not.toContain('secret-abc')

    const reader = new JsonFileStorage(serverUrlHash, configDir)
    await expect(reader.getTokens()).resolves.toMatchObject({ access_token: 'secret-abc' })
  })

  it('reads a legacy plaintext file and re-encrypts it on the next write', async () => {
    const filePath = path.join(configDir, `${serverUrlHash}_oauth.json`)
    await fs.writeFile(
      filePath,
      JSON.stringify({ tokens: { access_token: 'legacy', token_type: 'Bearer' }, lastUpdated: 1 })
    )

    const storage = new JsonFileStorage(serverUrlHash, configDir)
    await expect(storage.getTokens()).resolves.toMatchObject({ access_token: 'legacy' })

    await storage.saveCodeVerifier('verifier') // any write
    const onDisk = await fs.readFile(filePath, 'utf-8')
    expect(onDisk).toMatch(/^enc:v1:/)
  })

  it('round-trips client information', async () => {
    const clientInfo: OAuthClientInformation = {
      client_id: 'client-id-123',
      client_secret: 'client-secret-456'
    }

    const writer = new JsonFileStorage(serverUrlHash, configDir)
    await writer.saveClientInformation(clientInfo)

    const reader = new JsonFileStorage(serverUrlHash, configDir)
    await expect(reader.getClientInformation()).resolves.toEqual(clientInfo)
  })

  it('round-trips the code verifier', async () => {
    const writer = new JsonFileStorage(serverUrlHash, configDir)
    await writer.saveCodeVerifier('the-code-verifier')

    const reader = new JsonFileStorage(serverUrlHash, configDir)
    await expect(reader.getCodeVerifier()).resolves.toBe('the-code-verifier')
  })

  it('preserves earlier fields when a later field is saved', async () => {
    const storage = new JsonFileStorage(serverUrlHash, configDir)
    await storage.saveCodeVerifier('verifier-1')
    await storage.saveTokens({ access_token: 'tok', token_type: 'Bearer' })

    const reader = new JsonFileStorage(serverUrlHash, configDir)
    await expect(reader.getCodeVerifier()).resolves.toBe('verifier-1')
    await expect(reader.getTokens()).resolves.toEqual({ access_token: 'tok', token_type: 'Bearer' })
  })

  it('clear() removes stored data so a fresh instance reads empty state', async () => {
    const storage = new JsonFileStorage(serverUrlHash, configDir)
    await storage.saveTokens({ access_token: 'tok', token_type: 'Bearer' })

    await storage.clear()

    const reader = new JsonFileStorage(serverUrlHash, configDir)
    await expect(reader.getTokens()).resolves.toBeUndefined()
  })
})
