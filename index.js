/**
 * The Codex route: stream a conversation through the locally installed Codex
 * CLI, with an OpenAI-compatible endpoint as an opt-in fallback.
 *
 * The CLI owns its own agent loop (shell, patch, approvals), so this route is
 * a text-generation route: it forwards conversation text and returns the
 * model's answer. Harness tool calls are not executed by Codex, and Codex's
 * own tool use is not reported back as harness tool calls.
 * @module dsh-llm-codex
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { Config, apiEnabled, cliEnabled, resolveCommand } from './config.js';
import { defaultModelsCachePath, readCatalog, readConfiguredModel } from './catalog.js';
import { streamFallback } from './fallback.js';

/** Plugin identity used in diagnostics. */
export const name = 'dsh-llm-codex';
/** Services this plugin needs before it activates. */
export const inject = ['llm'];
/** Config schema, re-exported so a composition can validate it. */
export { Config };/** Chance a provider model id is one the Codex CLI understands. */
const CODEX_MODEL_HINT = /^(gpt|o[1-9]|codex)/u;

/**
 * Whether an id belongs to the Codex family rather than an OpenAI-compatible
 * fallback endpoint.
 * @param model - exact model id.
 * @returns true for Codex-family ids.
 */
function isCodexModel(model) {
  return model !== '' && CODEX_MODEL_HINT.test(model);
}

/** The Codex route adapter. */
class CodexAdapter extends LlmAdapter {
  /**
   * @param config - this activation's resolved config.
   * @param resolveApiKey - resolves the fallback endpoint credential.
   * @param command - the resolved Codex CLI path.
   */
  constructor(config, resolveApiKey, command) {
    super();
    this.config = config;
    this.resolveApiKey = resolveApiKey;
    this.command = command;
    this.catalog = [];
    this.catalogLoaded = false;
    this.catalogPath = '';
    this.configuredModel = '';
  }

  /** The catalog cache path for this config. */
  cachePath() {
    return this.config.modelsCachePath === '' ? defaultModelsCachePath() : this.config.modelsCachePath;
  }

  /** Codex's own configured model, read lazily from `$CODEX_HOME/config.toml`. */
  codexHome() {
    if (this.config.codexHome !== '') return this.config.codexHome;
    if (process.env.CODEX_HOME !== undefined && process.env.CODEX_HOME !== '') return process.env.CODEX_HOME;
    return join(process.env.HOME ?? '', '.codex');
  }

  /** Load and cache the Codex model catalog. */
  loadCatalog() {
    if (this.catalogLoaded) return;
    this.catalogLoaded = true;
    this.catalogPath = this.cachePath();
    this.catalog = readCatalog(this.catalogPath);
    this.configuredModel =
      this.config.model !== '' ? this.config.model : readConfiguredModel(join(this.codexHome(), 'config.toml')) ?? '';
    if (this.catalog.length === 0 && this.config.models.length === 0 && this.configuredModel === '') {
      process.stderr.write(
        `${name}: no model catalog at ${this.catalogPath} and no models configured; the picker stays empty\n`,
      );
    }
  }

  /** The exact model id a request with no explicit model resolves to. */
  defaultModel() {
    this.loadCatalog();
    if (this.config.model !== '') return this.config.model;
    if (this.configuredModel !== '') return this.configuredModel;
    return this.catalog[0]?.id ?? '';
  }

  /** Catalog entry for one model id, when Codex's cache knows it. */
  catalogEntry(model) {
    this.loadCatalog();
    return this.catalog.find((entry) => entry.id === model);
  }

  /** Effort ids advertised for one model. */
  effortsFor(model) {
    const configured = this.config.reasoningEffort;
    const entry = this.catalogEntry(model);
    const efforts = entry !== undefined && entry.efforts.length > 0 ? entry.efforts : ['low', 'medium', 'high'];
    return { efforts, defaultEffort: configured !== '' ? configured : entry?.defaultEffort };
  }

  /** {@inheritDoc} */
  providerInfo(provider) {
    return { id: provider, name: 'Codex (local)' };
  }

  /** {@inheritDoc} */
  async listModels(provider) {
    this.loadCatalog();
    const seen = new Set();
    const entries = [];
    const push = (id, displayName, description) => {
      if (id === '' || seen.has(id)) return;
      seen.add(id);
      entries.push({
        provider,
        id,
        name: displayName ?? id,
        ...(description === undefined ? {} : { description }),
        ...(this.inputModalities(id).length === 0 ? {} : { inputModalities: this.inputModalities(id) }),
      });
    };
    for (const id of this.config.models) push(id, this.catalogEntry(id)?.name);
    for (const entry of this.catalog) push(entry.id, entry.name, entry.description);
    if (this.configuredModel !== '') push(this.configuredModel, this.catalogEntry(this.configuredModel)?.name);
    return entries;
  }

  /** Request modalities a model accepts. */
  inputModalities(model) {
    const modality = this.catalogEntry(model)?.inputModalities ?? [];
    return modality.filter((value) => value === 'text' || value === 'image');
  }

  /** {@inheritDoc} */
  async resolveModel(provider, model) {
    const { efforts, defaultEffort } = this.effortsFor(model);
    return {
      provider,
      id: model,
      name: this.catalogEntry(model)?.name ?? model,
      context: { contextWindow: this.catalogEntry(model)?.contextWindow ?? this.config.defaultContextWindow },
      reasoning: {
        efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
        ...(defaultEffort === undefined || defaultEffort === '' ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
      },
      inputModalities: this.inputModalities(model),
    };
  }

  /** {@inheritDoc} */
  async *stream(options) {
    this.loadCatalog();
    const requested = options.model === '' ? this.defaultModel() : options.model;
    if (requested === '') {
      throw new LlmError(`${name}: no model resolved; set \`model\` or provide a readable Codex model catalog`, 'INVALID_REQUEST');
    }
    const effort = typeof options.reasoningEffort === 'string' && options.reasoningEffort !== ''
      ? String(options.reasoningEffort)
      : this.config.reasoningEffort;

    const cliAllowed = cliEnabled(this.config) && isCodexModel(requested);
    const apiAllowed = apiEnabled(this.config);
    if (!cliAllowed && !apiAllowed) {
      throw new LlmError(
        `${name}: model ${JSON.stringify(requested)} needs the fallback endpoint, but \`fallback.baseURL\` is empty`,
        'INVALID_REQUEST',
      );
    }

    if (!cliAllowed) {
      yield* streamFallback(options, this.config.fallback, requested, this.resolveApiKey);
      return;
    }

    const attempt = { produced: false };
    try {
      yield* this.streamCli(options, requested, effort, attempt);
      return;
    } catch (error) {
      if (attempt.produced || options.signal?.aborted === true) throw error;
      if (!apiAllowed || !(error instanceof LlmError) || !CLI_FALLBACK_CODES.has(error.code)) throw error;
      process.stderr.write(`${name}: Codex CLI route failed (${error.code}: ${error.message}); retrying on ${this.config.fallback.baseURL}\n`);
    }
    yield* streamFallback(
      options,
      this.config.fallback,
      this.config.fallback.model === '' ? requested : this.config.fallback.model,
      this.resolveApiKey,
    );
  }

  /**
   * Stream one turn through `codex exec`.
   * @param options - the assembled harness request.
   * @param model - exact model id.
   * @param effort - reasoning effort, or an empty string.
   * @param attempt - shared record of whether any chunk was emitted.
   * @yields harness stream chunks.
   */
  async *streamCli(options, model, effort, attempt) {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (this.config.ephemeral) args.push('--ephemeral');
    args.push('-s', this.config.sandbox, '-m', model);
    const cwd = this.config.cwd === '' ? process.cwd() : this.config.cwd;
    args.push('-C', cwd);
    if (effort !== '') args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(...this.config.args, '-');
    const prompt = buildPrompt(options, this.inputModalities(model).includes('image'));

    const child = spawn(this.command, args, {
      cwd,
      env: this.config.codexHome === '' ? process.env : { ...process.env, CODEX_HOME: this.config.codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A failed spawn (missing or non-executable command) arrives as an `error`
    // event, never as a rejected promise; capture it so the failure becomes an
    // LlmError that can still route to the fallback endpoint instead of
    // crashing the process on an unhandled 'error' event.
    let spawnFailure;
    const spawned = new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (error) => {
        spawnFailure = error;
        resolve(false);
      });
    });
    const abort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(abort, this.config.timeoutMs);
    const stderrChunks = [];
    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 32) stderrChunks.push(chunk);
    });
    child.stdin.on('error', () => {
      // A child that exits before reading stdin reports EPIPE here; its own
      // exit status is the diagnostic that matters.
    });
    child.stdin.end(prompt, 'utf8');

    let textIndex;
    let reasoningIndex;
    let textSeen = false;
    let failure;
    let usage;
    let stderrText = '';

    try {
      if (!(await spawned)) {
        const code = spawnFailure?.code === 'ENOENT' ? 'MISSING_CREDENTIAL' : 'TRANSPORT';
        throw new LlmError(
          `${name}: cannot run ${JSON.stringify(this.command)} (${spawnFailure?.code ?? 'spawn failed'}: ${spawnFailure?.message ?? 'unknown'})`,
          code,
          spawnFailure === undefined ? undefined : { cause: spawnFailure },
        );
      }
      for await (const line of readLines(child.stdout)) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          process.stderr.write(`${name}: ignoring non-JSON line from codex exec: ${trimmed.slice(0, 200)}\n`);
          continue;
        }
        if (event.type === 'item.completed') {
          const item = event.item ?? {};
          if (item.type === 'agent_message' && typeof item.text === 'string' && item.text !== '') {
            if (textIndex === undefined) {
              textIndex = 0;
              attempt.produced = true;
              yield { type: 'block-start', index: textIndex, blockType: 'text' };
            }
            textSeen = true;
            yield { type: 'text-delta', index: textIndex, text: item.text };
          } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text !== '') {
            if (reasoningIndex === undefined) {
              reasoningIndex = textIndex === undefined ? 0 : 1;
              attempt.produced = true;
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
            }
            yield { type: 'reasoning-delta', index: reasoningIndex, text: item.text };
          } else if (item.type === 'error' && typeof item.message === 'string') {
            failure ??= item.message;
          }
        } else if (event.type === 'turn.completed' && event.usage !== undefined) {
          usage = event.usage;
        } else if (event.type === 'error' && typeof event.message === 'string') {
          failure ??= event.message;
        }
      }
      const exit = await waitForExit(child);
      stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (options.signal?.aborted === true) throw new LlmError(`${name}: request aborted`, 'ABORTED');
      if (exit.code !== 0) {
        throw new LlmError(
          `${name}: codex exec exited ${exit.code ?? exit.signal}: ${(stderrText || failure || 'no diagnostic').slice(0, 500)}`,
          classifyCliFailure(`${stderrText} ${failure ?? ''}`),
        );
      }
      if (!textSeen && failure !== undefined) {
        throw new LlmError(`${name}: codex exec reported ${failure.slice(0, 500)}`, classifyCliFailure(failure));
      }
      if (!textSeen && reasoningIndex === undefined) {
        throw new LlmError(`${name}: codex exec produced no assistant message`, EMPTY_RESPONSE_CODE);
      }
      if (usage !== undefined) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            ...(Number.isFinite(usage.cached_input_tokens) && usage.cached_input_tokens > 0
              ? { cacheReadTokens: usage.cached_input_tokens }
              : {}),
            ...(Number.isFinite(usage.cache_write_input_tokens) && usage.cache_write_input_tokens > 0
              ? { cacheWriteTokens: usage.cache_write_input_tokens }
              : {}),
            ...(Number.isFinite(usage.reasoning_output_tokens) && usage.reasoning_output_tokens > 0
              ? { reasoningTokens: usage.reasoning_output_tokens }
              : {}),
          },
        };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

/** Failure codes that justify retrying the same turn on the fallback endpoint. */
const CLI_FALLBACK_CODES = new Set(['AUTH', 'MISSING_CREDENTIAL', 'TRANSPORT', 'TIMEOUT', 'INVALID_REQUEST', EMPTY_RESPONSE_CODE]);

/**
 * Classify a Codex CLI failure into a harness error code.
 * @param detail - stderr and event text.
 * @returns the harness error code.
 */
function classifyCliFailure(detail) {
  const text = detail.toLowerCase();
  if (/not logged in|unauthorized|401|403|authentication|no api key|api key/.test(text)) return 'AUTH';
  if (/timed out|timeout|reconnecting/.test(text)) return 'TRANSPORT';
  if (/enoent|no such file/.test(text)) return 'MISSING_CREDENTIAL';
  return 'INVALID_REQUEST';
}

/**
 * Render the harness conversation as the single prompt `codex exec` receives.
 * @param options - the assembled harness request.
 * @param imageCapable - whether the resolved model accepts images.
 * @returns prompt text.
 */
function buildPrompt(options, imageCapable) {
  const system = typeof options.system === 'string' ? options.system.trim() : '';
  const conversation = renderConversation(options.messages, imageCapable);
  if (system === '') return conversation;
  return [
    system,
    '',
    'Continue the conversation below and answer the final message.',
    '',
    conversation,
  ].join('\n');
}

/**
 * Render every message but the last as labelled history and the last as the
 * instruction to answer.
 * @param messages - ordered conversation messages.
 * @param imageCapable - whether the resolved model accepts images.
 * @returns rendered conversation text.
 */
function renderConversation(messages, imageCapable) {
  const rendered = messages
    .map((message) => renderMessage(message, imageCapable))
    .filter((text) => text !== '');
  if (rendered.length === 0) return '';
  if (rendered.length === 1) return rendered[0].text;
  const history = rendered.slice(0, -1).map((entry) => `### ${entry.role}\n${entry.text}`);
  const last = rendered[rendered.length - 1];
  return [
    'Conversation so far:',
    ...history,
    '',
    `### ${last.role} (answer this)`,
    last.text,
  ].join('\n');
}

/**
 * Render one message as a label and body.
 * @param message - harness message.
 * @param imageCapable - whether the resolved model accepts images.
 * @returns the rendered entry.
 */
function renderMessage(message, imageCapable) {
  const parts = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') {
      parts.push(imageCapable ? `[image attachment ${block.attachment?.id ?? 'unknown'}]` : '[image omitted: model is text-only]');
    } else if (block.type === 'tool-call') {
      parts.push(`[tool call ${block.name} ${block.arguments}]`);
    } else if (block.type === 'tool-result') {
      const text = (block.content ?? []).map((inner) => (inner.type === 'text' ? inner.text : '')).join('');
      parts.push(`[tool result${block.isError === true ? ' (error)' : ''}: ${text}]`);
    }
  }
  const body = parts.join('\n').trim();
  if (body === '') return null;
  return { role: message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User', text: body };
}

/**
 * Yield one line at a time from a byte stream.
 * @param stream - readable byte stream.
 * @yields decoded lines without their terminator.
 */
async function* readLines(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      yield buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf('\n');
    }
  }
  if (buffer !== '') yield buffer;
}

/**
 * Wait for a child process to settle.
 * @param child - the spawned child.
 * @returns its exit code and signal.
 */
function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/** Register the Codex route. */
export function apply(ctx, rawConfig) {
  const config = Config(rawConfig ?? {});
  if (!cliEnabled(config) && !apiEnabled(config)) {
    throw new Error(`${name}: transport ${JSON.stringify(config.transport)} has no usable route; set \`command\` or \`fallback.baseURL\``);
  }
  // The fallback key resolves through the credentials seam when that service is
  // mounted, so a key written on the Models page reaches the next request with
  // no restart; the process environment stays the fallback for compositions
  // that do not run the seam. The declaration is fixed at apply time; `inject`
  // must list a service to reach it at all, so it is added only when the
  // service is already mounted.
  const credentialsMounted = ctx.get('credentials') !== undefined;
  const command = resolveCommand(config.command);
  if (cliEnabled(config) && command === '') {
    process.stderr.write(
      `${name}: no Codex CLI found; set \`command\` or $CODEX_COMMAND, or install Codex. The route registers but CLI calls fail until then.\n`,
    );
  }
  const resolveApiKey = async () => {
    if (credentialsMounted) {
      try {
        const resolved = await ctx.credentials.resolve(credentialRef(config.fallback.apiKeyEnv));
        return resolved === undefined ? process.env[config.fallback.apiKeyEnv] ?? '' : resolved.value;
      } catch (error) {
        process.stderr.write(`${name}: credential ${config.fallback.apiKeyEnv} did not resolve: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return process.env[config.fallback.apiKeyEnv] ?? '';
  };
  const adapter = new CodexAdapter(config, resolveApiKey, command);
  const inject = credentialsMounted ? ['llm', 'credentials'] : ['llm'];
  const registration = ctx.inject(inject, (pluginCtx) => pluginCtx.llm.registerAdapter([config.provider], adapter));
  process.stderr.write(
    `${name}: route ${config.provider} ready (transport=${config.transport}${command === '' ? '' : `, command=${command}`})\n`,
  );
  return () => registration();
}

