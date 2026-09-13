/**
 * OpenAI-compatible chat-completions fallback: used when the local Codex CLI
 * is absent, unauthenticated, or fails before producing any output.
 * @module dsh-llm-codex/fallback
 */
import {
  EMPTY_RESPONSE_CODE,
  LlmError,
  ToolCallId,
  userAgent,
} from '@deepseek-ai/dsh-llm';

/** Status codes that name a credential problem rather than a request problem. */
const AUTH_STATUS = new Set([401, 403]);

/**
 * Flatten harness messages into OpenAI chat messages.
 * @param messages - harness conversation messages.
 * @param system - separate system prompt, when the caller sent one.
 * @returns wire messages.
 */
export function toApiMessages(messages, system) {
  const wire = [];
  if (typeof system === 'string' && system !== '') wire.push({ role: 'system', content: system });
  for (const message of messages) {
    const texts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of message.content ?? []) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'image') texts.push(`[inline image omitted: ${block.attachment?.id ?? 'unknown'}]`);
      else if (block.type === 'tool-call') {
        toolCalls.push({
          id: String(block.id),
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        });
      } else if (block.type === 'tool-result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: String(block.toolCallId),
          content: (block.content ?? []).map((inner) => (inner.type === 'text' ? inner.text : '')).join(''),
        });
      }
    }
    if (message.role === 'system') {
      if (texts.length > 0) wire.push({ role: 'system', content: texts.join('\n') });
      continue;
    }
    wire.push(...toolResults);
    if (toolCalls.length > 0) {
      wire.push({ role: 'assistant', content: texts.join('\n'), tool_calls: toolCalls });
    } else if (texts.length > 0 || message.role === 'user') {
      wire.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: texts.join('\n') });
    }
  }
  return wire;
}

/**
 * Stream one OpenAI-compatible chat-completions request as harness chunks.
 * @param options - the assembled harness request.
 * @param fallback - resolved fallback config.
 * @param model - model id to send on the wire.
 * @param resolveApiKey - resolves the fallback credential for this request.
 * @returns async iterable of harness stream chunks.
 */
export async function* streamFallback(options, fallback, model, resolveApiKey) {
  const apiKey = await resolveApiKey();
  const url = `${fallback.baseURL.replace(/\/+$/u, '')}/chat/completions`;
  const body = {
    model,
    messages: toApiMessages(options.messages, options.system),
    stream: true,
    stream_options: { include_usage: true },
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.tools === undefined || options.tools.length === 0
      ? {}
      : {
        tools: options.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      }),
    ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop }),
  };

  const timeout = AbortSignal.timeout(fallback.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': userAgent(),
        accept: 'text/event-stream',
        ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
        ...fallback.headers,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw new LlmError('codex fallback request aborted', 'ABORTED');
    throw new LlmError(
      `codex fallback request failed: ${error instanceof Error ? error.message : String(error)}`,
      'TRANSPORT',
      { cause: error },
    );
  }
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '');
    throw new LlmError(
      `codex fallback endpoint ${response.status}: ${detail.slice(0, 500)}`,
      AUTH_STATUS.has(response.status) ? 'AUTH' : 'INVALID_REQUEST',
    );
  }

  const pending = [];
  let nextIndex = 0;
  let textIndex;
  let reasoningIndex;
  let contentSeen = false;
  let toolsSeen = false;
  let finishReason = null;
  let usage;
  const toolBlocks = new Map();

  for await (const event of readSseEvents(response.body, options.signal)) {
    const choice = event.choices?.[0];
    if (choice !== undefined) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIndex === undefined) {
          textIndex = nextIndex++;
          pending.push({ type: 'block-start', index: textIndex, blockType: 'text' });
        }
        contentSeen = true;
        pending.push({ type: 'text-delta', index: textIndex, text: delta.content });
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex++;
          pending.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' });
        }
        pending.push({ type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const key = call.index ?? 0;
          if (!toolBlocks.has(key)) {
            const block = { index: nextIndex++, id: call.id ?? `codex-fallback-${key}`, name: call.function?.name ?? '' };
            toolBlocks.set(key, block);
            pending.push({ type: 'block-start', index: block.index, blockType: 'tool-call' });
          }
          const block = toolBlocks.get(key);
          if (call.id !== undefined) block.id = call.id;
          if (call.function?.name !== undefined && call.function.name !== '') block.name = call.function.name;
          toolsSeen = true;
          pending.push({
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(String(block.id)),
            ...(call.function?.name === undefined || call.function.name === '' ? {} : { name: call.function.name }),
            argumentsDelta: call.function?.arguments ?? '',
          });
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finishReason = choice.finish_reason;
    }
    if (event.usage !== undefined && event.usage !== null) usage = event.usage;
    while (pending.length > 0) yield pending.shift();
  }

  if (usage !== undefined) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        ...(Number.isFinite(usage.total_tokens) ? { totalTokens: usage.total_tokens } : {}),
        ...(Number.isFinite(usage.prompt_tokens_details?.cached_tokens)
          ? { cacheReadTokens: usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)
          ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
          : {}),
      },
    };
  }
  if (!contentSeen && !toolsSeen) {
    throw new LlmError('codex fallback endpoint returned no content', EMPTY_RESPONSE_CODE);
  }
  if (toolsSeen) yield { type: 'finish', reason: { kind: 'tool-calls' } };
  else yield { type: 'finish', reason: finishReason === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' } };
}

/**
 * Decode an SSE byte stream into JSON event payloads.
 * @param body - the response body stream.
 * @param signal - caller cancellation, honored between events.
 * @returns async iterable of parsed JSON events.
 */
async function* readSseEvents(body, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    if (signal?.aborted === true) return;
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // A malformed frame is skipped rather than failing the stream.
      }
    }
  }
}
