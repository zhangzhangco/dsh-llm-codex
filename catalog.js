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
