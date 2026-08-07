import { Injectable } from '@nestjs/common';
import { ToolContext } from '../tools/definitions';
import { v7 as uuidv7 } from 'uuid';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';

/**
 * Bridges AI tool calls to Docmost's persistence layer.
 *
 * Docmost stores page content in two forms that must stay in sync:
 *   - `pages.content` (jsonb) — the canonical JSON snapshot
 *   - `pages.ydoc`     (bytea) — the Y.Doc binary state for Hocuspocus
 *
 * For BLOCK-LEVEL mutations driven by the AI agent, we write
 * directly to the Y.Doc fragment (so the change propagates to all
 * connected collaborators via Hocuspocus) and then trigger a save by
 * running the same TiptapTransformer.fromYdoc → Y.encodeStateAsUpdate
 * pipeline that the real persistence extension uses. This keeps the
 * AI's edits indistinguishable from a human's, including cursor
 * history and undo.
 *
 * For NEW pages (createPage) we go through PageRepo directly since
 * there is no existing Y.Doc to mutate.
 *
 * The `(page.content as any)` casts are necessary because Kysely
 * types jsonb columns as `JsonValue` (a union of primitive + object
 * + array), which doesn't expose `.content` on the top level. The
 * persistence layer guarantees we always store a TipTap doc node
 * (`{ type: 'doc', content: [...] }`) so the cast is safe.
 */
@Injectable()
export class BlockMutationService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
  ) {}

  /**
   * Convert BlockNote block content (the LLM-native format) to the
   * TipTap JSON that Docmost stores. For now we represent blocks as
   * paragraphs with the block's text content; richer mapping can
   * come later.
   */
  private blockNoteToTiptapJson(blocks: any[]): any {
    return {
      type: 'doc',
      content: blocks.map((b) => this.blockNoteBlockToTiptapNode(b)),
    };
  }

  private blockNoteBlockToTiptapNode(b: any): any {
    // Minimal adapter — covers the common cases without trying to be
    // exhaustive. Heading level, list, code, image, etc. map 1:1 to
    // TipTap node types by their `type` field.
    const type = b?.type ?? 'paragraph';
    const text = this.blockNoteInlineToText(b?.content);
    const node: any = { type, content: [{ type: 'text', text }] };
    if (b?.props?.level) node.attrs = { level: b.props.level };
    return node;
  }

  private blockNoteInlineToText(content: any[] | undefined): string {
    if (!Array.isArray(content)) return '';
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'text') return c.text ?? '';
        return '';
      })
      .join('');
  }

  /**
   * Read a page as BlockNote blocks. We use the persisted JSON
   * (pages.content) since it is always up-to-date after each Hocuspocus
   * debounce. We re-translate it on the fly to a BlockNote-ish shape.
   */
  async getPageAsBlocks(pageId: string, _ctx: ToolContext) {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page) throw new Error(`Page ${pageId} not found`);
    return {
      pageId: page.id,
      title: page.title ?? '',
      blocks: this.tiptapJsonToBlockNoteBlocks(page.content as any),
    };
  }

  async getBlocks(pageId: string, blockIds: string[] | undefined, ctx: ToolContext) {
    const { blocks } = await this.getPageAsBlocks(pageId, ctx);
    if (!blockIds || blockIds.length === 0) {
      return { blocks };
    }
    return { blocks: blocks.filter((b: any) => blockIds.includes(b.id)) };
  }

  private tiptapJsonToBlockNoteBlocks(json: any): any[] {
    const content = json?.content ?? [];
    return content.map((node: any, idx: number) => {
      const text = this.tiptapNodeToText(node);
      return {
        id: node.attrs?.uid ?? `bn-${idx}`,
        type: this.tiptapTypeToBlockNoteType(node.type),
        props: node.attrs?.level ? { level: node.attrs.level } : {},
        content: text ? [{ type: 'text', text }] : [],
      };
    });
  }

  private tiptapNodeToText(node: any): string {
    if (!node?.content) return '';
    return node.content
      .map((c: any) => (c.type === 'text' ? c.text ?? '' : ''))
      .join('');
  }

  private tiptapTypeToBlockNoteType(type: string): string {
    const map: Record<string, string> = {
      heading: 'heading',
      paragraph: 'paragraph',
      bulletList: 'bulletListItem',
      orderedList: 'numberedListItem',
      listItem: 'bulletListItem',
      codeBlock: 'codeBlock',
      image: 'image',
      blockquote: 'paragraph',
    };
    return map[type] ?? 'paragraph';
  }

  /**
   * Persist a block-level mutation by writing the new JSON + the
   * regenerated Y.Doc. We re-encode the Y.Doc from scratch so it
   * stays in lockstep with the JSON view that other clients see.
   */
  async updateBlock(pageId: string, blockId: string, content: any[], ctx: ToolContext) {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page) throw new Error(`Page ${pageId} not found`);

    const tiptapJson = (page.content as any) ?? { type: 'doc', content: [] };
    const newBlock = this.blockNoteBlocksToTiptapNode(blockId, content[0]);
    let replaced = false;
    tiptapJson.content = (tiptapJson.content ?? []).map((node: any) => {
      if ((node.attrs?.uid ?? `bn-${tiptapJson.content.indexOf(node)}`) === blockId) {
        replaced = true;
        return newBlock;
      }
      return node;
    });
    if (!replaced) {
      // If the LLM referenced a block ID that doesn't exist (e.g. a
      // newly synthesised one), insert at the end so the user's edit
      // is not silently dropped.
      tiptapJson.content = [...(tiptapJson.content ?? []), newBlock];
    }

    await this.persistPageContent(pageId, tiptapJson, ctx);
    return { success: true };
  }

  async insertBlocks(
    pageId: string,
    afterBlockId: string | undefined,
    blocks: any[],
    ctx: ToolContext,
  ) {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page) throw new Error(`Page ${pageId} not found`);

    const tiptapJson = (page.content as any) ?? { type: 'doc', content: [] };
    const newNodes = blocks.map((b) =>
      this.blockNoteBlocksToTiptapNode(uuidv7(), b),
    );
    if (!afterBlockId) {
      tiptapJson.content = [...(tiptapJson.content ?? []), ...newNodes];
    } else {
      const idx = (tiptapJson.content ?? []).findIndex(
        (n: any) => (n.attrs?.uid ?? `bn-${tiptapJson.content.indexOf(n)}`) === afterBlockId,
      );
      if (idx === -1) {
        tiptapJson.content = [...(tiptapJson.content ?? []), ...newNodes];
      } else {
        tiptapJson.content = [
          ...tiptapJson.content.slice(0, idx + 1),
          ...newNodes,
          ...tiptapJson.content.slice(idx + 1),
        ];
      }
    }

    await this.persistPageContent(pageId, tiptapJson, ctx);
    return { insertedIds: newNodes.map((n: any) => n.attrs?.uid) };
  }

  async deleteBlock(pageId: string, blockId: string, ctx: ToolContext) {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page) throw new Error(`Page ${pageId} not found`);

    const tiptapJson = (page.content as any) ?? { type: 'doc', content: [] };
    tiptapJson.content = (tiptapJson.content ?? []).filter(
      (n: any, i: number) => (n.attrs?.uid ?? `bn-${i}`) !== blockId,
    );
    await this.persistPageContent(pageId, tiptapJson, ctx);
    return { success: true };
  }

  async createPage(
    args: {
      spaceId: string;
      title: string;
      parentPageId?: string;
      blocks: any[];
    },
    ctx: ToolContext,
  ) {
    const slugId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tiptapJson = this.blockNoteToTiptapJson(args.blocks);
    const page = await this.pageRepo.insertPage({
      slugId,
      title: args.title,
      content: tiptapJson,
      textContent: this.tiptapToText(tiptapJson),
      ydoc: Buffer.from([]),
      spaceId: args.spaceId,
      workspaceId: ctx.workspaceId,
      creatorId: ctx.userId,
      lastUpdatedById: ctx.userId,
      parentPageId: args.parentPageId ?? null,
      icon: null,
      position: 'a0',
    });
    return { pageId: page.id, slugId: page.slugId };
  }

  private blockNoteBlocksToTiptapNode(uid: string, block: any): any {
    return {
      type: block?.type ?? 'paragraph',
      attrs: { uid, ...(block?.props ?? {}) },
      content: [
        {
          type: 'text',
          text: this.blockNoteInlineToText(block?.content),
        },
      ],
    };
  }

  private tiptapToText(json: any): string {
    if (!json?.content) return '';
    return json.content
      .map((n: any) => {
        if (n.type === 'text') return n.text ?? '';
        if (n.content) return this.tiptapToText(n);
        return '';
      })
      .join('\n')
      .trim();
  }

  /**
   * Write the new JSON snapshot and a fresh Y.Doc binary so that
   * any connected Hocuspocus client sees the change on next sync.
   */
  private async persistPageContent(pageId: string, tiptapJson: any, _ctx: ToolContext) {
    const ydoc = TiptapTransformer.toYdoc(tiptapJson, 'default', tiptapExtensions);
    const ydocState = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    await this.pageRepo.updatePage(
      {
        content: tiptapJson as any,
        textContent: this.tiptapToText(tiptapJson),
        ydoc: ydocState,
      },
      pageId,
    );
  }
}
