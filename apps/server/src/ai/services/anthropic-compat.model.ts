// We pull the V2 types from a deep-relative import into the
// pnpm store. At runtime only `APICallError` is loaded as a value
// — and we get that from the hoisted `@ai-sdk/provider` (V4),
// whose constructor is structurally compatible for our purposes.
// Importing the V2 types ensures our model passes AI SDK 6's
// `streamText` typecheck (which uses V2 internally).
import type * as V2 from '../../../../../node_modules/.pnpm/@ai-sdk+provider@3.0.8/node_modules/@ai-sdk/provider/dist/index.d.ts';
import { APICallError } from '@ai-sdk/provider';

type LanguageModelV2 = V2.LanguageModelV2;
type LanguageModelV2CallOptions = V2.LanguageModelV2CallOptions;
type LanguageModelV2Content = V2.LanguageModelV2Content;
type LanguageModelV2FinishReason = V2.LanguageModelV2FinishReason;
type LanguageModelV2Message = V2.LanguageModelV2Message;
type LanguageModelV2Prompt = V2.LanguageModelV2Prompt;
type LanguageModelV2StreamPart = V2.LanguageModelV2StreamPart;
type LanguageModelV2Usage = V2.LanguageModelV2Usage;
type SharedV2ProviderMetadata = V2.SharedV2ProviderMetadata;

/**
 * Anthropic-Messages-compatible language model, implementing
 * `LanguageModelV2` so the Vercel AI SDK 5 `streamText` /
 * `generateText` accept it.
 *
 * Vercel's `@ai-sdk/anthropic` v4 returns `LanguageModelV4`, but
 * AI SDK 5 (`ai` v6) only accepts V2. Rather than pin a V2-version
 * of the upstream package, we just talk the wire protocol directly
 * — the Messages API is small enough to translate.
 *
 * Supported: `system` prompt, `messages` with text + tool-result
 * parts, `tools` with input_schema, streaming text deltas, tool
 * use blocks, and a single `stop_reason` mapped to a finish reason.
 */
export interface AnthropicCompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  // The AI SDK UI message parts stream protocol encodes these
  // as `data: {json}\n\n` SSE events. We emit them so `useChat`
  // on the client can render streaming text and tool calls.
  providerName?: string;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
}

type AnthropicContent =
  | string
  | Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock>;

interface AnthropicMessagesRequest {
  model: string;
  system?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock>;
  }>;
  max_tokens: number;
  stream: boolean;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: unknown;
  }>;
  temperature?: number;
}

export class AnthropicCompatModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider: string;
  readonly modelId: string;

  // We don't fetch remote URLs in prompts — but the V2 spec
  // requires this to be defined. Return empty.
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(private readonly config: AnthropicCompatConfig) {
    this.provider = config.providerName ?? 'anthropic-compat';
    this.modelId = config.model;
  }

  private get url(): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`;
  }

  private get headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      'accept': 'text/event-stream',
    };
  }

  async doGenerate(
    options: LanguageModelV2CallOptions,
  ): Promise<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    warnings: Array<any>;
  }> {
    const body = this.buildRequest(options, false);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await this.asApiError(response);
    }
    const json = (await response.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const content: LanguageModelV2Content[] = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text' && block.text != null) {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        content.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return {
      content,
      finishReason: mapStopReason(json.stop_reason),
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        totalTokens:
          (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      },
      warnings: [],
    };
  }

  async doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
  }> {
    const body = this.buildRequest(options, true);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await this.asApiError(response);
    }
    if (!response.body) {
      throw new Error('Anthropic-compatible endpoint returned no body');
    }
    return {
      stream: parseSseStream(response.body, this.provider, this.modelId),
    };
  }

  private buildRequest(
    options: LanguageModelV2CallOptions,
    stream: boolean,
  ): AnthropicMessagesRequest {
    const { prompt, maxOutputTokens, temperature, tools } = options;
    const { system, messages } = toAnthropic(prompt);
    const anthropicTools = tools
      ?.filter((t): t is Extract<typeof t, { type: 'function' }> => t.type === 'function')
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
    const req: AnthropicMessagesRequest = {
      model: this.modelId,
      max_tokens: maxOutputTokens ?? 4096,
      stream,
      messages,
    };
    if (system) req.system = system;
    if (temperature != null) req.temperature = temperature;
    if (anthropicTools?.length) req.tools = anthropicTools;
    return req;
  }

  private async asApiError(response: Response): Promise<APICallError> {
    const body = await response.text().catch(() => '');
    return new APICallError({
      message: `Anthropic-compat call failed: ${response.status} ${response.statusText}`,
      url: this.url,
      requestBodyValues: {},
      responseBody: body,
      statusCode: response.status,
    });
  }
}

function mapStopReason(s?: string): LanguageModelV2FinishReason {
  switch (s) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    case 'refusal':
      return 'content-filter';
    default:
      return 'unknown';
  }
}

function toAnthropic(prompt: LanguageModelV2Prompt): {
  system: string;
  messages: AnthropicMessagesRequest['messages'];
} {
  const systemParts: string[] = [];
  const messages: AnthropicMessagesRequest['messages'] = [];
  for (const m of prompt) {
    if (m.role === 'system') {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === 'user') {
      const parts = m.content
        .map((p) => userPartToAnthropic(p))
        .filter(Boolean) as Array<AnthropicTextBlock | AnthropicToolResultBlock>;
      messages.push({ role: 'user', content: parts });
      continue;
    }
    if (m.role === 'assistant') {
      const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
      for (const p of m.content) {
        if (p.type === 'text') {
          content.push({ type: 'text', text: p.text });
        } else if (p.type === 'tool-call') {
          let input: unknown = {};
          if (typeof p.input === 'string' && p.input) {
            try {
              input = JSON.parse(p.input);
            } catch {
              input = {};
            }
          } else if (p.input) {
            input = p.input;
          }
          content.push({ type: 'tool_use', id: p.toolCallId, name: p.toolName, input });
        }
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      // Merge consecutive tool results into one user message — the
      // Anthropic wire format requires tool_result blocks to be
      // wrapped in a user message.
      const blocks: AnthropicToolResultBlock[] = m.content.map((p) => ({
        type: 'tool_result',
        tool_use_id: p.toolCallId,
        content: p.output
          ? typeof p.output === 'string'
            ? p.output
            : JSON.stringify(p.output)
          : '',
        is_error: undefined,
      }));
      // If the last message is already a user message with tool
      // results, merge into it. Otherwise start a new user message.
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        const existing = (last.content as unknown as AnthropicToolResultBlock[]).filter(
          (b) => (b as any)?.type === 'tool_result',
        );
        last.content = [...existing, ...blocks];
      } else {
        messages.push({ role: 'user', content: blocks });
      }
    }
  }
  return { system: systemParts.join('\n\n').trim(), messages };
}

function textOf(content: LanguageModelV2Message['content'] | string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
    .join('');
}

function userPartToAnthropic(p: any): AnthropicTextBlock | AnthropicToolResultBlock | null {
  if (p.type === 'text') {
    return { type: 'text', text: p.text };
  }
  // tool results inside a user message are also valid input shapes
  // (some SDKs render them as part of the user turn).
  if (p.type === 'tool-result') {
    return {
      type: 'tool_result',
      tool_use_id: p.toolCallId,
      content:
        typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''),
    };
  }
  return null;
}

/**
 * Parse Anthropic's SSE event stream into `LanguageModelV2StreamPart`s.
 *
 * Anthropic's wire protocol emits one named event per line with the
 * shape `event: <type>\ndata: <json>\n\n`. The events we care about:
 *   message_start     → response started; carries initial usage
 *   content_block_start
 *   content_block_delta
 *   content_block_stop
 *   message_delta     → carries stop_reason
 *   message_stop      → end of stream
 *   error             → upstream error
 */
function parseSseStream(
  body: ReadableStream<Uint8Array>,
  provider: string,
  modelId: string,
): ReadableStream<LanguageModelV2StreamPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Track state so we can emit text-start/text-delta/text-end and
  // tool-input-start/tool-input-delta/tool-input-end in order.
  type Block =
    | { kind: 'text'; id: string; started: boolean }
    | { kind: 'tool'; id: string; name: string; inputJson: string; started: boolean };
  const blocks = new Map<number, Block>();
  const responseId = `resp_${Date.now().toString(36)}`;
  const toolNameById = new Map<string, string>();

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    async pull(controller) {
      const enqueue = (part: LanguageModelV2StreamPart) => {
        try {
          controller.enqueue(part);
        } catch {
          // already closed
        }
      };
      try {
        if (!started) {
          started = true;
          enqueue({ type: 'stream-start', warnings: [] });
        }
        const { value, done } = await reader.read();
        if (done) {
          enqueue({ type: 'finish', finishReason: 'stop', usage: emptyUsage() });
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parseSseEvent(raw);
          if (!event) continue;
          handleEvent(event, enqueue);
        }
      } catch (err: any) {
        controller.error(err);
      }
    },
  });

  let started = false;

  function emptyUsage(): LanguageModelV2Usage {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  function parseSseEvent(raw: string): { event: string; data: any } | null {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      if (line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const val = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'event') event = val;
      else if (field === 'data') dataLines.push(val);
    }
    const dataStr = dataLines.join('\n').trim();
    if (!dataStr) return null;
    if (dataStr === '[DONE]') return null;
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return null;
    }
    return { event, data };
  }

  function handleEvent(
    evt: { event: string; data: any },
    enqueue: (p: LanguageModelV2StreamPart) => void,
  ): void {
    const { event, data } = evt;
    if (event === 'message_start') {
      // Initial metadata. The V2 spec exposes a single
      // `response-metadata` part with id/modelId/timestamp.
      enqueue({
        type: 'response-metadata',
        id: data?.message?.id ?? responseId,
        modelId: data?.message?.model ?? modelId,
        timestamp: data?.message?.created_at
          ? new Date(data.message.created_at * 1000)
          : new Date(),
      });
      return;
    }
    if (event === 'content_block_start') {
      const idx: number = data.index;
      const block = data.content_block;
      if (block?.type === 'text') {
        blocks.set(idx, { kind: 'text', id: `txt_${idx}`, started: false });
      } else if (block?.type === 'tool_use') {
        toolNameById.set(block.id, block.name);
        blocks.set(idx, {
          kind: 'tool',
          id: block.id,
          name: block.name,
          inputJson: '',
          started: false,
        });
      }
      return;
    }
    if (event === 'content_block_delta') {
      const idx: number = data.index;
      const delta = data.delta;
      const blk = blocks.get(idx);
      if (delta?.type === 'text_delta' && blk?.kind === 'text') {
        if (!blk.started) {
          blk.started = true;
          enqueue({ type: 'text-start', id: blk.id });
        }
        enqueue({ type: 'text-delta', id: blk.id, delta: delta.text ?? '' });
      } else if (delta?.type === 'input_json_delta' && blk?.kind === 'tool') {
        if (!blk.started) {
          blk.started = true;
          enqueue({ type: 'tool-input-start', id: blk.id, toolName: blk.name });
        }
        const piece = delta.partial_json ?? '';
        blk.inputJson += piece;
        enqueue({ type: 'tool-input-delta', id: blk.id, delta: piece });
      }
      return;
    }
    if (event === 'content_block_stop') {
      const idx: number = data.index;
      const blk = blocks.get(idx);
      if (blk?.kind === 'text' && blk.started) {
        enqueue({ type: 'text-end', id: blk.id });
      } else if (blk?.kind === 'tool') {
        if (blk.started) enqueue({ type: 'tool-input-end', id: blk.id });
        let parsed: unknown = {};
        try {
          parsed = blk.inputJson ? JSON.parse(blk.inputJson) : {};
        } catch {
          parsed = blk.inputJson;
        }
        enqueue({
          type: 'tool-call',
          toolCallId: blk.id,
          toolName: blk.name,
          input: JSON.stringify(parsed),
        });
      }
      blocks.delete(idx);
      return;
    }
    if (event === 'message_delta') {
      const stop = data?.delta?.stop_reason ?? data?.stop_reason;
      if (stop) {
        enqueue({
          type: 'finish',
          finishReason: mapStopReason(stop),
          usage: emptyUsage(),
        });
      }
      return;
    }
    if (event === 'message_stop') {
      // No-op: finish event already emitted on message_delta.
      return;
    }
    if (event === 'error' || data?.type === 'error') {
      enqueue({
        type: 'error',
        error: new Error(data?.error?.message ?? 'upstream error'),
      });
    }
  }

  return stream;
}
