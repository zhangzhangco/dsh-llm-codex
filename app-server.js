/** One isolated app-server process and thread per request. No shared conversation state. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { LlmError, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm';

// Reported to the server as clientInfo.version. Derived rather than hardcoded so
// a version bump cannot leave telemetry claiming the previous release.
const { version: PLUGIN_VERSION } = createRequire(import.meta.url)('./package.json');

export async function* streamAppServer({ command, config, prompt, model, effort, signal, attempt }) {
  if (signal?.aborted) throw new LlmError('Codex request aborted', 'ABORTED');
  const cwd = config.cwd || process.cwd();
  const child = spawn(command, ['app-server', ...config.appServerArgs], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: config.codexHome ? { ...process.env, CODEX_HOME: config.codexHome } : process.env,
  });
  let seq = 0, failure, wake, closed = false, threadId, turnId, reported = 0;
  const pending = new Map(), queue = [];
  const fail = (error) => {
    failure ??= error;
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
    wake?.();
  };
  const send = (message) => {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
  });
  const stop = (code, message) => {
    // Best effort interrupt, then bounded process termination even if the server is unresponsive.
    if (threadId && turnId && !failure) {
      try { send({ id: ++seq, method: 'turn/interrupt', params: { threadId, turnId } }); } catch {}
    }
    fail(new LlmError(message, code));
    child.kill('SIGTERM');
  };
  const abort = () => stop('ABORTED', 'Codex request aborted');
  const timer = setTimeout(() => stop('TIMEOUT', 'Codex app-server request timed out'), config.timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.on('error', (error) => fail(new LlmError(`Cannot start Codex app-server: ${error.message}`, error.code === 'ENOENT' ? 'MISSING_CREDENTIAL' : 'TRANSPORT')));
  child.stdin.on('error', () => fail(new LlmError('Codex app-server input closed', 'TRANSPORT')));
  // Drain stderr without retaining prompts, credentials, or unlimited diagnostics.
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); wake?.();
    if (pending.size) fail(new LlmError('Codex app-server exited during RPC', 'TRANSPORT'));
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let event;
    try { event = JSON.parse(line); } catch { fail(new LlmError('Invalid app-server JSON', 'TRANSPORT')); return; }
    if (event.id !== undefined && !event.method) {
      const p = pending.get(event.id);
      if (!p) return;
      pending.delete(event.id);
      if (event.error) p.reject(new LlmError(event.error.message || 'App-server RPC failed', 'INVALID_REQUEST'));
      else p.resolve(event.result);
    } else if (event.id !== undefined) {
      // This adapter has no approval UI. Never silently approve a server request.
      try { send({ id: event.id, error: { code: -32601, message: 'Interactive requests are not supported by this adapter' } }); } catch {}
      fail(new LlmError(`Unsupported interactive request: ${event.method}`, 'INVALID_REQUEST'));
    } else { queue.push(event); wake?.(); }
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'dsh_llm_codex', version: PLUGIN_VERSION } });
    send({ method: 'initialized', params: {} });
    const thread = await rpc('thread/start', {
      model, cwd, sandbox: config.sandbox, approvalPolicy: 'never', ephemeral: config.ephemeral,
    });
    threadId = thread.thread.id;
    const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }], ...(effort ? { effort } : {}) });
    turnId = turn.turn.id;
    const blocks = new Map();
    let textSeen = false, usage;
    function* delta(key, type, text) {
      if (!text) return;
      let block = blocks.get(key);
      if (!block) {
        block = { index: blocks.size, text: '' };
        blocks.set(key, block);
        yield { type: 'block-start', index: block.index, blockType: type };
      }
      block.text += text;
      attempt.produced = true;
      if (type === 'text') textSeen = true;
      yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text };
    }
    while (true) {
      if (failure) throw failure;
      if (!queue.length) {
        if (closed) throw new LlmError('Codex app-server exited before turn completion', 'TRANSPORT');
        await new Promise((resolve) => { wake = resolve; });
        wake = undefined;
        continue;
      }
      const { method, params: p = {} } = queue.shift();
      if (p.threadId && p.threadId !== threadId) continue;
      if (p.turnId && p.turnId !== turnId) continue;
      if (method === 'item/agentMessage/delta') yield* delta(p.itemId, 'text', p.delta);
      else if (method === 'item/reasoning/summaryTextDelta') yield* delta(`${p.itemId}:summary:${p.summaryIndex}`, 'reasoning', p.delta);
      else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
        const previous = blocks.get(p.item.id)?.text || '';
        const full = p.item.text || '';
        if (!full.startsWith(previous)) throw new LlmError('Codex final text differs from streamed text', 'TRANSPORT');
        yield* delta(p.item.id, 'text', full.slice(previous.length));
      } else if (method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.last;
      else if (method === 'error') {
        // Not fatal by design: `willRetry` errors are the transport retries
        // (WebSocket → HTTPS) that make the first token take minutes, and the
        // verdict still arrives through `turn/completed`. Surfacing a bounded,
        // truncated copy to stderr is what makes such a slow turn explainable
        // in the harness log instead of looking like a silent stall. The
        // message is a transport diagnostic, never prompt content.
        if (reported < 3) {
          reported += 1;
          // `codexErrorInfo` is a string enum OR a single-key struct variant
          // (e.g. `{ responseStreamDisconnected: { httpStatusCode: null } }`),
          // and a real quota-blocked turn reported exactly the object form.
          // Render the variant name rather than `[object Object]`.
          const raw = p.error?.codexErrorInfo;
          const info = typeof raw === 'string'
            ? raw
            : raw !== null && typeof raw === 'object'
              ? String(Object.keys(raw)[0] ?? 'error')
              : 'error';
          process.stderr.write(`dsh-llm-codex: Codex app-server reported ${info}${p.willRetry === true ? ' (retrying)' : ''}: ${String(p.error?.message ?? '').slice(0, 200)}\n`);
        }
      } else if (method === 'thread/closed') {
        // The protocol has no top-level error notification: a fatal server-side
        // problem that ends the thread without a `turn/completed` would otherwise
        // leave the request waiting for the (10-minute default) timeout.
        throw new LlmError('Codex app-server closed the thread before the turn completed', 'TRANSPORT');
      } else if (method === 'turn/completed') {
        if (p.turn?.id !== turnId) continue;
        if (p.turn.status !== 'completed') {
          const info = p.turn.error?.codexErrorInfo;
          const code = p.turn.status === 'interrupted' ? 'ABORTED' : info === 'usageLimitExceeded' ? 'QUOTA' : info === 'contextWindowExceeded' ? 'CONTEXT_WINDOW_EXCEEDED' : info === 'unauthorized' ? 'AUTH' : 'TRANSPORT';
          throw new LlmError(p.turn.error?.message || `Codex turn ${p.turn.status}`, code);
        }
        if (!textSeen) throw new LlmError('Codex produced no assistant text', EMPTY_RESPONSE_CODE);
        // Same chunk shape as the exec backend: the optional counters are only
        // attached when they carry a number, so downstream accounting sees one
        // contract regardless of which backend served the turn.
        if (usage) {
          const positive = (value) => Number.isFinite(value) && value > 0;
          yield {
            type: 'usage',
            usage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              ...(positive(usage.cachedInputTokens) ? { cacheReadTokens: usage.cachedInputTokens } : {}),
              ...(positive(usage.cacheWriteInputTokens) ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {}),
              ...(positive(usage.reasoningOutputTokens) ? { reasoningTokens: usage.reasoningOutputTokens } : {}),
            },
          };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    lines.close();
    fail(new LlmError('Codex app-server connection closed', 'ABORTED'));
    if (!closed) {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      await exited;
      clearTimeout(kill);
    }
  }
}
