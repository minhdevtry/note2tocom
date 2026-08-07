import { z } from 'zod';

/**
 * AI tool layer — single source of truth for AI actions.
 *
 * Every tool exposed to the LLM (whether via the in-web BlockNote agent,
 * the Vercel AI SDK chat endpoint, or the MCP server) is defined here
 * as a Zod schema. Handlers live in ./handlers.ts and are bound to
 * the concrete context (user, workspace, optional live Y.Doc) at
 * call time. Adding a new tool is one file edit; the three AI surfaces
 * pick it up automatically.
 *
 * Schemas are intentionally permissive about BlockNote's `content`
 * shape (`z.any()` for block content) because the LLM is the source
 * of truth for block shape — we trust it to produce valid BlockNote
 * blocks, then validate structurally before persisting.
 */

// ---------- Schemas ----------

export const getCurrentPageSchema = {
  description:
    'Read the page the user is currently viewing, including all its blocks. Call this when you need full context for an edit, or when the user says "this page" without naming it.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    pageId: z.string(),
    title: z.string(),
    blocks: z.array(z.any()),
  }),
};

export const getBlocksSchema = {
  description:
    'Read specific blocks (or the whole page if blockIds is omitted) by ID. Use this when the user references "the third paragraph" or asks you to verify what you wrote earlier.',
  inputSchema: z.object({
    pageId: z.string().uuid(),
    blockIds: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    blocks: z.array(z.any()),
  }),
};

export const updateBlockSchema = {
  description:
    'Replace a single block with new content. The blockId must come from getBlocks or getCurrentPage. Use this for surgical edits ("fix the typo in this paragraph", "make this heading clearer") so the user keeps the rest of the page intact.',
  inputSchema: z.object({
    pageId: z.string().uuid(),
    blockId: z.string(),
    content: z.array(z.any()).min(1),
  }),
  outputSchema: z.object({ success: z.boolean() }),
};

export const insertBlocksSchema = {
  description:
    'Append new blocks after a given block (or at the end of the page if afterBlockId is omitted). Use this when the user says "add a section about X" or to materialize generated content.',
  inputSchema: z.object({
    pageId: z.string().uuid(),
    afterBlockId: z.string().optional(),
    blocks: z.array(z.any()).min(1),
  }),
  outputSchema: z.object({ insertedIds: z.array(z.string()) }),
};

export const deleteBlockSchema = {
  description:
    'Remove a block and its content. Use sparingly — prefer updateBlock with empty content. Always confirm the user intent before calling.',
  inputSchema: z.object({
    pageId: z.string().uuid(),
    blockId: z.string(),
  }),
  outputSchema: z.object({ success: z.boolean() }),
};

export const searchPagesSchema = {
  description:
    'Hybrid semantic + keyword search across the workspace. Use this when the user asks a question that likely lives in another page, or to gather context before writing. Returns top-k results with title and a snippet.',
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(5),
    mode: z.enum(['hybrid', 'vector', 'keyword']).default('hybrid'),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        pageId: z.string(),
        slugId: z.string(),
        title: z.string(),
        snippet: z.string(),
        score: z.number(),
      }),
    ),
  }),
};

export const createPageSchema = {
  description:
    'Create a new page in a space. Use this when the user says "make a new page" or to materialize a long document into its own page.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    title: z.string().min(1).max(255),
    parentPageId: z.string().uuid().optional(),
    blocks: z.array(z.any()).default([]),
  }),
  outputSchema: z.object({ pageId: z.string(), slugId: z.string() }),
};

export const listSpacesSchema = {
  description:
    'List the spaces the current user can write to. Call this before createPage if you do not already know the spaceId.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    spaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
      }),
    ),
  }),
};

// ---------- Registry ----------

export const toolSchemas = {
  getCurrentPage: getCurrentPageSchema,
  getBlocks: getBlocksSchema,
  updateBlock: updateBlockSchema,
  insertBlocks: insertBlocksSchema,
  deleteBlock: deleteBlockSchema,
  searchPages: searchPagesSchema,
  createPage: createPageSchema,
  listSpaces: listSpacesSchema,
} as const;

export type ToolName = keyof typeof toolSchemas;
export type ToolInput<T extends ToolName> = z.infer<
  (typeof toolSchemas)[T]['inputSchema']
>;
export type ToolOutput<T extends ToolName> = z.infer<
  (typeof toolSchemas)[T]['outputSchema']
>;

// ---------- Context ----------

/**
 * The bound context a tool handler runs with. Built per-request by
 * the AI controller (or MCP server) from the authenticated user +
 * workspace, plus optional metadata like the page the user is
 * currently viewing (so the agent can call getCurrentPage without
 * the LLM having to pass it).
 */
export interface ToolContext {
  userId: string;
  workspaceId: string;
  currentPageId?: string;
}

export type ToolHandler<T extends ToolName> = (
  args: ToolInput<T>,
  ctx: ToolContext,
) => Promise<ToolOutput<T>>;
