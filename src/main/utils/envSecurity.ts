import { loggerService } from '@logger'

const logger = loggerService.withContext('EnvSecurity')

/**
 * Environment variables that change how a freshly spawned process loads code —
 * preloading shared libraries or injecting Node flags. If any of these is allowed
 * to flow from a less-trusted source (IPC payloads, MCP package manifests, per-tool
 * CLI configs) into a child process's environment, it becomes an arbitrary-code-execution
 * vector despite command/argument validation.
 *
 * Single source of truth: {@link McpPackageService} (fail-closed, throws) and
 * {@link CodeCliService} (fail-open, drops + warns) both consume this list via
 * {@link isDangerousChildEnvKey}. Keep additions here, not in either caller.
 */
export const DANGEROUS_CHILD_ENV_KEYS: readonly string[] = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH']

/**
 * True when an environment variable name is process-affecting and unsafe to accept
 * from an untrusted source: an exact (case-insensitive) denylist match, or any macOS
 * dynamic-linker `DYLD_*` variable.
 */
export function isDangerousChildEnvKey(key: string): boolean {
  const canonical = key.toUpperCase()
  return DANGEROUS_CHILD_ENV_KEYS.includes(canonical) || canonical.startsWith('DYLD_')
}

export interface SanitizeChildEnvOptions {
  /**
   * What to do when a dangerous key is encountered.
   * - `'drop'` (default): strip the offending key and continue (logs a warning).
   * - `'throw'`: reject the entire environment.
   */
  onDangerous?: 'drop' | 'throw'
}

/**
 * Return a NEW environment map safe to merge into a child process's environment.
 *
 * - Null bytes in any key or value are ALWAYS rejected (they can truncate strings at
 *   the OS boundary), regardless of `onDangerous`.
 * - Process-affecting variables ({@link isDangerousChildEnvKey}) are dropped (default)
 *   or cause a throw, per `options.onDangerous`.
 *
 * Never mutates the input.
 *
 * @throws Error on a null byte, or on a dangerous key when `onDangerous === 'throw'`.
 */
export function sanitizeChildEnv(
  env: Record<string, string>,
  options: SanitizeChildEnvOptions = {}
): Record<string, string> {
  const onDangerous = options.onDangerous ?? 'drop'
  const safe: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (key.includes('\0')) {
      throw new Error('Invalid child env: null byte detected in environment variable name')
    }
    if (typeof value === 'string' && value.includes('\0')) {
      throw new Error(`Invalid child env: null byte detected in value of environment variable "${key}"`)
    }

    if (isDangerousChildEnvKey(key)) {
      if (onDangerous === 'throw') {
        throw new Error(`Invalid child env: environment variable "${key}" is not allowed`)
      }
      logger.warn(`Dropping process-affecting environment variable from child env: ${key}`)
      continue
    }

    safe[key] = value
  }

  return safe
}
