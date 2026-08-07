import {
  All,
  Controller,
  Req,
  Res,
  ForbiddenException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolHandlers, buildToolHandlerMap } from '../ai/tools/handlers';
import { toolSchemas, ToolContext } from '../ai/tools/definitions';
import { TokenService } from '../core/auth/services/token.service';
import { JwtType } from '../core/auth/dto/jwt-payload';
import { EnvironmentService } from '../integrations/environment/environment.service';

/**
 * Model Context Protocol server.
 *
 * Exposes the same AI tool registry that the in-web agent uses
 * (see ../ai/tools/definitions.ts) over MCP Streamable HTTP, so
 * external clients (Claude Desktop, Cursor, Cline, Zed) can drive
 * the workspace as their document store.
 *
 * Auth: a bearer JWT — same Docmost access token used for the
 * collaboration socket. The MCP client just needs to send
 *   Authorization: Bearer <jwt>
 * in every request. For OAuth flows, see README; not implemented
 * for 2-user internal use.
 *
 * Each session gets its own (McpServer, StreamableHTTPServerTransport)
 * pair, held in memory; on disconnect we clean up.
 */
@Controller('mcp')
export class McpController {
  private readonly sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  constructor(
    private readonly toolHandlers: ToolHandlers,
    private readonly tokenService: TokenService,
    private readonly env: EnvironmentService,
  ) {}

  @All()
  async handleMcp(
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) res: FastifyReply,
  ) {
    if (!this.env.isAiEnabled()) {
      throw new ForbiddenException('AI is disabled by configuration.');
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!session) {
      // Auth + create a fresh session
      const ctx = await this.resolveContext(req);
      const server = this.buildServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { server, transport });
        },
      });
      transport.onclose = () => {
        // Best-effort cleanup; if `sessionId` is undefined (initial
        // request) the map is still empty so this is a no-op.
        if (sessionId) this.sessions.delete(sessionId);
      };
      await server.connect(transport);
      session = { server, transport };
    }

    // The MCP SDK's StreamableHTTPServerTransport expects raw
    // Node.js IncomingMessage + ServerResponse (it calls .on() and
    // .writeHead() directly). Fastify wraps both — `.raw` exposes
    // the underlying Node objects. Without this, `transport`
    // crashes with "outgoing.on is not a function".
    const rawReq = (req as any).raw ?? req;
    const rawRes = (res as any).raw ?? res;
    await session.transport.handleRequest(rawReq, rawRes, req.body);
  }

  /**
   * Construct the McpServer with every tool from the AI tool layer
   * wired up. The Zod schemas in toolSchemas are converted to JSON
   * Schema (the wire format MCP expects) via zod-to-json-schema.
   */
  private buildServer(ctx: ToolContext): McpServer {
    const server = new McpServer(
      { name: 'notionclone', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    const handlers = buildToolHandlerMap(this.toolHandlers);

    for (const [name, def] of Object.entries(toolSchemas)) {
      server.registerTool(
        name,
        {
          description: def.description,
          inputSchema: zodToJsonSchema(def.inputSchema as any, {
            target: 'openApi3',
          }) as any,
        },
        async (args: any) => {
          try {
            const result = await (handlers as any)[name](args, ctx);
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Tool ${name} failed: ${err?.message ?? String(err)}`,
                },
              ],
            };
          }
        },
      );
    }

    return server;
  }

  private async resolveContext(req: FastifyRequest): Promise<ToolContext> {
    const header = req.headers['authorization'];
    const token = header?.toString().startsWith('Bearer ')
      ? header.toString().slice(7)
      : ((req as any).cookies?.authToken as string | undefined);
    if (!token) {
      throw new ForbiddenException('Missing auth token');
    }
    const payload = await this.tokenService.verifyJwt(token, JwtType.ACCESS);
    return {
      userId: payload.sub,
      workspaceId: payload.workspaceId,
      // MCP clients do not have a "current page" — agents that need
      // a default scope should call listSpaces + searchPages first.
    };
  }
}
