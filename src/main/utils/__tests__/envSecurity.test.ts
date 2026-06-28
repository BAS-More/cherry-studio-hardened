import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  }
}))

import { DANGEROUS_CHILD_ENV_KEYS, isDangerousChildEnvKey, sanitizeChildEnv } from '../envSecurity'

describe('isDangerousChildEnvKey', () => {
  it('flags every exact denylist member, case-insensitively', () => {
    for (const key of DANGEROUS_CHILD_ENV_KEYS) {
      expect(isDangerousChildEnvKey(key)).toBe(true)
      expect(isDangerousChildEnvKey(key.toLowerCase())).toBe(true)
    }
  })

  it('flags any macOS DYLD_* dynamic-linker variable', () => {
    expect(isDangerousChildEnvKey('DYLD_INSERT_LIBRARIES')).toBe(true)
    expect(isDangerousChildEnvKey('dyld_library_path')).toBe(true)
  })

  it('allows ordinary variables', () => {
    expect(isDangerousChildEnvKey('PATH')).toBe(false)
    expect(isDangerousChildEnvKey('HOME')).toBe(false)
    expect(isDangerousChildEnvKey('MY_API_KEY')).toBe(false)
  })
})

describe('sanitizeChildEnv', () => {
  it('drops process-affecting keys by default and keeps safe ones', () => {
    const out = sanitizeChildEnv({
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require /tmp/evil.js',
      LD_PRELOAD: '/tmp/x.so',
      DYLD_INSERT_LIBRARIES: '/tmp/y.dylib',
      HOME: '/home/u'
    })
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/u' })
  })

  it('is case-insensitive when dropping dangerous keys', () => {
    const out = sanitizeChildEnv({ node_options: '--x', Path: '/bin' })
    expect(out).toEqual({ Path: '/bin' })
  })

  it('never mutates the input object', () => {
    const input = { NODE_OPTIONS: '--x', PATH: '/bin' }
    sanitizeChildEnv(input)
    expect(input).toEqual({ NODE_OPTIONS: '--x', PATH: '/bin' })
  })

  it('rejects the whole env when onDangerous="throw"', () => {
    expect(() => sanitizeChildEnv({ NODE_OPTIONS: '--x' }, { onDangerous: 'throw' })).toThrow(/not allowed/)
  })

  it('always rejects null bytes in keys, regardless of policy', () => {
    expect(() => sanitizeChildEnv({ ['FO\0O']: 'bar' })).toThrow(/null byte/)
  })

  it('always rejects null bytes in values, regardless of policy', () => {
    expect(() => sanitizeChildEnv({ FOO: 'ba\0r' })).toThrow(/null byte/)
  })
})
