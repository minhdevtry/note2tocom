import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { ToolContext, ToolName, toolSchemas } from './definitions';
import { z } from 'zod';
import { RagService } from '../services/rag.service';
import { BlockMutationService } from '../services/block-mutation.service';

/**
 * Concrete implementations of every AI tool.
 *
 * The handler map is built at module construction time and frozen so
 * the LLM-side tool registry, the Vercel AI SDK tools object, and the
 * MCP server all call into the same function references. Adding a
 * tool means: add a schema in definitions.ts + add a method here +
 * add a row in the handlers map.
 */
@Injectable()
export class ToolHandlers {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly rag: RagService,
    private readonly blocks: BlockMutationService,
  ) {}

  /**
   * Read the page the user is currently viewing. Falls back to the
   * most recent page if no currentPageId was passed in context.
   */
  async getCurrentPage(args: z.infer<typeof toolSchemas.getCurrentPage.inputSchema>, ctx: ToolContext) {
    if (!ctx.currentPageId) {
      throw new Error(
        'No current page is set for this conversation. Ask the user to open a page first, or call searchPages to find one.',
      );
    }
    return this.blocks.getPageAsBlocks(ctx.currentPageId, ctx);
  }

  async getBlocks(
    args: z.infer<typeof toolSchemas.getBlocks.inputSchema>,
    ctx: ToolContext,
  ) {
    return this.blocks.getBlocks(args.pageId, args.blockIds, ctx);
  }

  async updateBlock(
    args: z.infer<typeof toolSchemas.updateBlock.inputSchema>,
    ctx: ToolContext,
  ) {
    return this.blocks.updateBlock(args.pageId, args.blockId, args.content, ctx);
  }

  async insertBlocks(
    args: z.infer<typeof toolSchemas.insertBlocks.inputSchema>,
    ctx: ToolContext,
  ) {
    return this.blocks.insertBlocks(args.pageId, args.afterBlockId, args.blocks, ctx);
  }

  async deleteBlock(
    args: z.infer<typeof toolSchemas.deleteBlock.inputSchema>,
    ctx: ToolContext,
  ) {
    return this.blocks.deleteBlock(args.pageId, args.blockId, ctx);
  }

  async searchPages(
    args: z.infer<typeof toolSchemas.searchPages.inputSchema>,
    ctx: ToolContext,
  ) {
    return this.rag.search(args.query, args.limit, args.mode, ctx);
  }

  async createPage(
    args: z.infer<typeof toolSchemas.createPage.inputSchema>,
    ctx: ToolContext,
  ) {
    return this.blocks.createPage(args, ctx);
  }

  async listSpaces(
    _args: z.infer<typeof toolSchemas.listSpaces.inputSchema>,
    ctx: ToolContext,
  ) {
    // The repo requires `query` and `adminView` for type-completeness
    // but does not actually filter on them in the listing call path.
    // Pass empty defaults; revisit if the repo tightens validation.
    const result = await this.spaceMemberRepo.getUserSpaces(ctx.userId, {
      limit: 100,
      query: '',
      adminView: false,
    } as any);
    return {
      spaces: (result.items ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
      })),
    };
  }
}

/**
 * Public lookup: tool name -> bound handler.
 * The AI controller, MCP server, and tests all go through this map.
 */
export function buildToolHandlerMap(handlers: ToolHandlers) {
  return {
    getCurrentPage: handlers.getCurrentPage.bind(handlers),
    getBlocks: handlers.getBlocks.bind(handlers),
    updateBlock: handlers.updateBlock.bind(handlers),
    insertBlocks: handlers.insertBlocks.bind(handlers),
    deleteBlock: handlers.deleteBlock.bind(handlers),
    searchPages: handlers.searchPages.bind(handlers),
    createPage: handlers.createPage.bind(handlers),
    listSpaces: handlers.listSpaces.bind(handlers),
  } as const;
}

export type ToolHandlerMap = ReturnType<typeof buildToolHandlerMap>;
export type AnyToolHandler = ToolHandlerMap[ToolName];
