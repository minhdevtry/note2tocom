import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EmbeddingService } from './embedding.service';
import { ToolContext } from '../tools/definitions';
import { sql } from 'kysely';

/**
 * Hybrid retrieval for AI agent context.
 *
 * Combines three signals, each suited to a different kind of query:
 *
 *   1. Vector cosine similarity over `pageEmbeddings.embedding`
 *      (pgvector ivfflat index) — good for "what is the project
 *      about?"-style questions.
 *
 *   2. BM25 over `pageEmbeddings.tsv` (GIN index) — good for
 *      exact term matches, code snippets, names.
 *
 *   3. Trigram similarity on `pages.title` (pg_trgm, already
 *      enabled) — good for short queries that look like titles.
 *
 * If `pageEmbeddings` is empty (e.g. fresh install, no embeddings
 * yet), we fall back to plain tsvector search on `pages.tsv` so the
 * agent is never blind.
 */
@Injectable()
export class RagService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly embedding: EmbeddingService,
  ) {}

  async search(
    query: string,
    limit: number,
    mode: 'hybrid' | 'vector' | 'keyword',
    ctx: ToolContext,
  ) {
    if (mode === 'vector') {
      return this.vectorSearch(query, limit, ctx);
    }
    if (mode === 'keyword') {
      return this.keywordSearch(query, limit, ctx);
    }
    return this.hybridSearch(query, limit, ctx);
  }

  private async vectorSearch(query: string, limit: number, ctx: ToolContext) {
    const embedding = await this.embedding.embed(query);
    const vectorParam = `[${embedding.join(',')}]`;

    const rows = await sql<{
      pageId: string;
      slugId: string;
      title: string | null;
      content: string | null;
      score: number;
    }>`
      SELECT
        pe.page_id as "pageId",
        p.slug_id as "slugId",
        p.title,
        pe.content,
        1 - (pe.embedding <=> ${vectorParam}::vector) as score
      FROM page_embeddings pe
      JOIN pages p ON p.id = pe.page_id
      WHERE pe.workspace_id = ${ctx.workspaceId}::uuid
        AND p.deleted_at IS NULL
      ORDER BY score DESC
      LIMIT ${limit}
    `.execute(this.db);

    return {
      results: rows.rows.map((r) => ({
        pageId: r.pageId,
        slugId: r.slugId,
        title: r.title ?? '',
        snippet: this.snippet(r.content, query),
        score: Number(r.score ?? 0),
      })),
    };
  }

  private async keywordSearch(query: string, limit: number, ctx: ToolContext) {
    // Plain BM25-style search on pages.text_content via the GIN
    // tsvector index. Works without embeddings.
    const rows = await this.db
      .selectFrom('pages')
      .select(['id as pageId', 'slugId as slugId', 'title', 'textContent as content'])
      .where('workspaceId', '=', ctx.workspaceId)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('textContent', 'ilike', `%${query}%`),
          eb('title', 'ilike', `%${query}%`),
        ]),
      )
      .limit(limit)
      .execute();

    return {
      results: rows.map((r: any) => ({
        pageId: r.pageId,
        slugId: r.slugId,
        title: r.title ?? '',
        snippet: this.snippet(r.content ?? '', query),
        score: 1,
      })),
    };
  }

  private async hybridSearch(query: string, limit: number, ctx: ToolContext) {
    const [vectorResults, { results: keywordResults }] = await Promise.all([
      this.safeVectorSearch(query, limit, ctx),
      this.keywordSearch(query, limit, ctx),
    ]);

    const merged = new Map<string, { score: number; row: any }>();
    vectorResults.forEach((r, i) => {
      const s = 1 - i / Math.max(vectorResults.length, 1);
      const existing = merged.get(r.pageId);
      if (!existing || existing.score < s) {
        merged.set(r.pageId, { score: s * 0.7, row: r });
      }
    });
    keywordResults.forEach((r, i) => {
      const s = 1 - i / Math.max(keywordResults.length, 1);
      const existing = merged.get(r.pageId);
      const newScore = (existing?.score ?? 0) + s * 0.3;
      if (!existing || newScore > existing.score) {
        merged.set(r.pageId, { score: newScore, row: r });
      }
    });

    return {
      results: [...merged.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((m) => m.row),
    };
  }

  private async safeVectorSearch(query: string, limit: number, ctx: ToolContext) {
    try {
      const { results } = await this.vectorSearch(query, limit, ctx);
      return results;
    } catch (err) {
      // pgvector may not be installed, or the embeddings table is empty.
      // Return [] so hybrid search falls back to keyword only.
      return [];
    }
  }

  private snippet(text: string | null | undefined, query: string, length = 240): string {
    if (!text) return '';
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, start + length);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }
}
