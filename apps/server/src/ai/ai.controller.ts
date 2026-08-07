import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { streamText, tool, stepCountIs, convertToModelMessages } from 'ai';
import {
  buildToolHandlerMap,
  ToolHandlers,
} from './tools/handlers';
import { toolSchemas, ToolContext } from './tools/definitions';
import { LlmService } from './services/llm.service';
import { RagService } from './services/rag.service';
import { TokenService } from '../core/auth/services/token.service';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { JwtType } from '../core/auth/dto/jwt-payload';
import { ChatRepo } from './repos/chat.repo';

/**
 * Streaming chat endpoint for the in-web agent.
 *
 * The same `toolSchemas` + handlers power the MCP server and any
 * future HTTP integrations, so any tool added to the LLM here is
 * automatically available to external clients.
 *
 * Request body (useChat / Vercel AI SDK UI shape):
 *   {
 *     messages: UIMessage[],         // UI message stream format
 *     pageId?: string,              // page the user is on
 *     chatId?: string,              // for resuming an existing chat
 *     model?: string,               // override env's AI_MODEL
 *   }
 *
 * Response: Vercel AI SDK UI message stream (text/plain + chunks).
 * Compatible with `useChat` on the client.
 */
@Controller('ai')
export class AiController {
  constructor(
    private readonly toolHandlers: ToolHandlers,
    private readonly llm: LlmService,
    private readonly rag: RagService,
    private readonly tokenService: TokenService,
    private readonly env: EnvironmentService,
    private readonly chatRepo: ChatRepo,
  ) {}

  @Post('chat')
  async chat(
    @Body() body: { messages: any[]; pageId?: string; chatId?: string; model?: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) res: FastifyReply,
  ) {
    if (!this.env.isAiEnabled()) {
      throw new ForbiddenException('AI is disabled by configuration.');
    }
    const user = await this.resolveUser(req);
    const ctx: ToolContext = {
      userId: user.id,
      workspaceId: user.workspaceId,
      currentPageId: body.pageId,
    };
    const handlers = buildToolHandlerMap(this.toolHandlers);

    // Build the tool set. The same shape is fed to the LLM and to
    // the MCP server — single source of truth.
    const tools: Record<string, any> = {};
    for (const [name, def] of Object.entries(toolSchemas)) {
      tools[name] = tool({
        description: def.description,
        inputSchema: def.inputSchema as any,
        execute: async (args: unknown) =>
          (handlers as any)[name](args, ctx),
      });
    }

    // RAG: pull top-k context-relevant pages and inject as a
    // synthetic user-side system message. The most recent user
    // message is used as the query.
    const lastUserMessage = [...(body.messages ?? [])]
      .reverse()
      .find((m: any) => m?.role === 'user');
    const queryText = this.extractText(lastUserMessage);
    let contextPages: { title: string; snippet: string; slugId: string }[] = [];
    if (queryText) {
      try {
        const { results } = await this.rag.search(queryText, 5, 'hybrid', ctx);
        contextPages = results.map((r) => ({
          title: r.title,
          snippet: r.snippet,
          slugId: r.slugId,
        }));
      } catch {
        // RAG is best-effort; never block the agent on retrieval.
      }
    }

    const systemPrompt = [
      `You are an AI agent inside a Notion-like workspace. You can read and edit pages via the available tools. Be concise. When the user says "this page", call getCurrentPage first.`,
      `Current user: ${user.name} (${user.email}).`,
      ctx.currentPageId ? `The user is currently viewing page ${ctx.currentPageId}.` : '',
      contextPages.length
        ? `\nRelevant context from the workspace:\n${contextPages
            .map((p) => `- [${p.title}](/p/${p.slugId}): ${p.snippet}`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Persist incoming messages so the chat history is recoverable
    // (and so the user can come back later and pick up where they
    // left off). We do this best-effort before streaming.
    let chatId = body.chatId;
    if (!chatId) {
      chatId = await this.chatRepo.createChat({
        userId: user.id,
        workspaceId: user.workspaceId,
        pageId: ctx.currentPageId,
      });
    }
    await this.chatRepo.appendMessage({
      chatId,
      userId: user.id,
      workspaceId: user.workspaceId,
      role: 'user',
      content: queryText,
    });

    const result = streamText({
      model: this.llm.getModel(),
      system: systemPrompt,
      messages: await convertToModelMessages(body.messages ?? []),
      tools,
      // Multi-step agent loop — LLM can call multiple tools in a
      // single user turn, e.g. search → read → insertBlocks.
      stopWhen: stepCountIs(10),
      onFinish: async ({ text, toolCalls, usage }) => {
        await this.chatRepo.appendMessage({
          chatId,
          userId: user.id,
          workspaceId: user.workspaceId,
          role: 'assistant',
          content: text ?? '',
          metadata: { toolCalls, usage },
        });
      },
    });

    // `toUIMessageStreamResponse` returns a Web `Response` object.
    // NestJS's default JSON serializer would drop its body, so we
    // hand the headers + body stream to Fastify directly.
    const webResponse = result.toUIMessageStreamResponse();
    res.status(webResponse.status);
    webResponse.headers.forEach((value, key) => {
      res.header(key, value);
    });
    if (webResponse.body) {
      // Fastify's `send` accepts a Web ReadableStream directly
      // in modern versions; otherwise we'd convert to a Node
      // stream. Cast through unknown to keep the type-checker
      // happy with both shapes.
      res.send(webResponse.body as unknown as NodeJS.ReadableStream);
    } else {
      res.send('');
    }
    return;
  }

  /**
   * Vercel AI SDK's UI message parts can be plain strings or
   * `{ type: 'text', text }` shapes depending on the client version.
   * Normalise so we can index into the latest user prompt.
   */
  private extractText(message: any): string {
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
        .join(' ');
    }
    if (Array.isArray(message.parts)) {
      return message.parts
        .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
        .join(' ');
    }
    return '';
  }

  private async resolveUser(req: FastifyRequest) {
    // Accept either the workspace JWT or a collab JWT. Either way
    // we need the user + workspace. The same verification is used
    // for MCP auth in mcp.controller.ts.
    const header = req.headers['authorization'];
    const token = header?.toString().startsWith('Bearer ')
      ? header.toString().slice(7)
      : ((req as any).cookies?.authToken as string | undefined);
    if (!token) throw new ForbiddenException('Missing auth token');
    const payload = await this.tokenService.verifyJwt(token, JwtType.ACCESS);
    return { id: payload.sub, workspaceId: payload.workspaceId, email: payload.email, name: payload.name };
  }
}
