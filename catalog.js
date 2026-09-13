/**
 * Codex model catalog: read the CLI's model cache so the picker shows real
 * context windows, reasoning levels, and input modalities.
 * @module dsh-llm-codex/catalog
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$CODEX_HOME/models_cache.json`, the CLI's own catalog cache. */
export function defaultModelsCachePath() {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME !== ''
    ? process.env.CODEX_HOME
    : join(homedir(), '.codex');
  return join(home, 'models_cache.json');
}

/**
 * Read Codex's cached model catalog.
 * @param path - cache file path.
 * @returns parsed entries; empty when the file is missing or malformed.
 */
export function readCatalog(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const models = raw && Array.isArray(raw.models) ? raw.models : [];
  const entries = [];
  for (const model of models) {
    if (!model || typeof model.slug !== 'string' || model.slug === '') continue;
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
        .map((level) => (level && typeof level.effort === 'string' ? level.effort : undefined))
        .filter((effort) => typeof effort === 'string' && effort !== '')
      : [];
    entries.push({
      id: model.slug,
      name: typeof model.display_name === 'string' && model.display_name !== '' ? model.display_name : model.slug,
      description: typeof model.description === 'string' ? model.description : undefined,
      contextWindow: Number.isFinite(model.context_window) ? model.context_window : undefined,
      efforts,
      defaultEffort: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : undefined,
      inputModalities: Array.isArray(model.input_modalities)
        ? model.input_modalities.filter((modality) => typeof modality === 'string')
        : [],
    });
  }
  return entries;
}

/**
 * Read the model id from a Codex `config.toml`.
 * @param path - config file path.
 * @returns the configured model id, or undefined.
 */
export function readConfiguredModel(path) {
  try {
    const match = /^\s*model\s*=\s*"([^"]+)"/mu.exec(readFileSync(path, 'utf8'));
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** How long one endpoint model listing stays fresh. */
const ENDPOINT_CACHE_MS = 60000;

/**
 * Discover the models an OpenAI-compatible endpoint serves.
 *
 * The endpoint owns this list, so an `api`-transport route can advertise the
 * models it actually answers with instead of the Codex catalog. An
 * unreachable or malformed endpoint yields an empty list: discovery is
 * advisory, and the caller keeps whatever it already had.
 * @param baseURL - the endpoint base, with or without a `/v1` suffix.
 * @param apiKey - credential value; empty sends no `Authorization` header.
 * @param timeoutMs - request budget.
 * @returns discovered ids with any capacity the endpoint reports.
 */
export async function listEndpointModels(baseURL, apiKey, timeoutMs = 4000) {
  const base = baseURL.replace(/\/+$/u, '');
  const url = /\/v\d+$/u.test(base) ? `${base}/models` : `${base}/v1/models`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const models = [];
  for (const entry of entries) {
    const id = entry?.id ?? entry?.name ?? entry?.model;
    if (typeof id !== 'string' || id === '') continue;
    // llama.cpp reports the served context as `meta.n_ctx`; other servers omit it.
    const contextWindow = Number.isFinite(entry?.meta?.n_ctx) && entry.meta.n_ctx > 0 ? entry.meta.n_ctx : undefined;
    models.push({ id, contextWindow });
  }
  return models;
}

/**
 * One cached endpoint listing, refreshed on demand.
 */
export class EndpointModelCache {
  /**
   * @param baseURL - endpoint base URL.
   * @param resolveApiKey - resolves the endpoint credential per request.
   */
  constructor(baseURL, resolveApiKey) {
    this.baseURL = baseURL;
    this.resolveApiKey = resolveApiKey;
    this.models = [];
    this.fetchedAt = 0;
    this.pending = undefined;
  }

  /**
   * Current models, refreshing at most once per {@link ENDPOINT_CACHE_MS}. A
   * failed refresh keeps the previous list so a blip cannot empty the picker.
   * @returns discovered models.
   */
  async current() {
    if (Date.now() - this.fetchedAt < ENDPOINT_CACHE_MS) return this.models;
    this.pending ??= (async () => {
      try {
        const discovered = await listEndpointModels(this.baseURL, await this.resolveApiKey());
        if (discovered.length > 0) {
          this.models = discovered;
          this.fetchedAt = Date.now();
        }
      } finally {
        this.pending = undefined;
      }
      return this.models;
    })();
    return this.pending;
  }
}
