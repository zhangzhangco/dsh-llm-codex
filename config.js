/**
 * Config schema and defaults for the Codex route.
 * @module dsh-llm-codex/config
 */
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Default provider route name this plugin registers. */
export const DEFAULT_PROVIDER = 'codex-local';
/** Environment variable that overrides Codex CLI discovery. */
export const COMMAND_ENV = 'CODEX_COMMAND';
/**
 * Known Codex CLI locations, tried in order after `$CODEX_COMMAND` and `PATH`.
 * The ChatGPT desktop app bundles the CLI; a standalone install may add its own
 * binary to `PATH`, which is why that lookup comes first.
 */
export const COMMAND_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  join(process.env.HOME ?? '', '.local', 'bin', 'codex'),
  join(process.env.HOME ?? '', '.codex', 'bin', 'codex'),
];
/** Codex reasoning levels this adapter forwards, in display order. */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Whether a path names an executable file.
 * @param path - candidate path.
 * @returns true when the path exists and is executable.
 */
function isExecutable(path) {
  if (path === '') return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the first executable `codex` on `PATH`.
 * @returns the absolute path, or undefined.
 */
function commandOnPath() {
  const entries = (process.env.PATH ?? '').split(':').filter((entry) => entry !== '');
  for (const entry of entries) {
    const candidate = join(entry, 'codex');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the Codex CLI to run, so the plugin works on a machine that does not
 * match the one it was written on. Order: the configured `command`, then
 * `$CODEX_COMMAND`, then `PATH`, then the known install locations. A configured
 * value is returned as-is (even when missing), so an explicit misconfiguration
 * fails loudly at spawn instead of being silently replaced.
 * @param configured - the `command` config value.
 * @returns the command to run, or an empty string when none was found.
 */
export function resolveCommand(configured = '') {
  if (configured !== '') return configured;
  const fromEnv = process.env[COMMAND_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return commandOnPath() ?? COMMAND_CANDIDATES.find(isExecutable) ?? '';
}

/**
 * One OpenAI-compatible fallback endpoint. An empty `baseURL` disables the
 * fallback; the CLI route is then the only path.
 */
export const FallbackSchema = z.object({
  baseURL: z.string().default(''),
  apiKeyEnv: z.string().default('CODEX_FALLBACK_API_KEY'),
  model: z.string().default(''),
  headers: z.dict(z.string()).default({}),
  timeoutMs: z.natural().default(300000),
});

/** Plugin config. */
export const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  /** Codex CLI to run; empty discovers it from `$CODEX_COMMAND`, `PATH`, then known installs. */
  command: z.string().default(''),
  /** Extra argv passed to `codex exec` before the prompt. */
  args: z.array(z.string()).default([]),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  sandbox: z.union([z.const('read-only'), z.const('workspace-write'), z.const('danger-full-access')]).default('read-only'),
  /** Working root handed to `codex exec -C`; empty means the session workspace. */
  cwd: z.string().default(''),
  /** Run Codex threads without persisting them under `$CODEX_HOME`. */
  ephemeral: z.boolean().default(true),
  /** Wall-clock budget for one `codex exec` invocation. */
  timeoutMs: z.natural().default(600000),
  /** `$CODEX_HOME` for the spawned CLI; empty inherits the process environment. */
  codexHome: z.string().default(''),
  /** Codex model catalog cache used for context windows and reasoning levels. */
  modelsCachePath: z.string().default(''),
  /** Exact model ids advertised when no catalog can be read. */
  models: z.array(z.string()).default([]),
  /** Default capacity fallback for a model without an exact catalog value. */
  defaultContextWindow: z.natural().default(272000),
  /** Route text-only requests through the fallback endpoint instead of the CLI. */
  transport: z.union([z.const('auto'), z.const('cli'), z.const('api')]).default('auto'),
  fallback: FallbackSchema,
});

/**
 * Whether the CLI route is reachable for one config.
 * @param config - resolved plugin config.
 * @returns true when `transport` admits the CLI.
 */
export function cliEnabled(config) {
  return config.transport !== 'api';
}

/**
 * Whether the fallback endpoint is reachable for one config.
 * @param config - resolved plugin config.
 * @returns true when `transport` admits the API and a base URL is set.
 */
export function apiEnabled(config) {
  return config.transport !== 'cli' && config.fallback.baseURL !== '';
}
