import { type Kysely, sql } from 'kysely';

/**
 * Page embeddings table for RAG (Retrieval-Augmented Generation).
 *
 * Docmost already indexes page text in `pages.tsv` (GIN, BM25 via tsvector).
 * This migration adds a vector column for semantic search via pgvector.
 *
 * We deliberately use `vector(1536)` to match OpenAI's text-embedding-3-small
 * and the local nomic-embed-text via Ollama (both 768/1536-dim). If you
 * pick a different model, change the dimension and re-run.
 *
 * The hybrid search query combines:
 *   - vector_cosine_ops (semantic) via the ivfflat index
 *   - BM25 via pages.tsv + websearch_to_tsquery
 *   - trigram via pg_trgm on title (already enabled)
 *
 * See apps/server/src/ai/services/rag.service.ts for the query builder.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // pgvector must be created as an extension. Supabase already has it enabled.
  // Self-hosted Postgres needs: CREATE EXTENSION IF NOT EXISTS vector;
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  // pg_trgm is required by the existing ai_chat_messages trigger (f_unaccent).
  // Enable here too so a fresh Supabase project works out of the box.
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await db.schema
    .createTable('page_embeddings')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('chunk_index', 'integer', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('embedding', sql`vector(1536)`, (col) => col)
    .addColumn('tsv', sql`tsvector`, (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // IVFFlat index for cosine distance. lists = sqrt(rows) is a common heuristic.
  // For < 100k rows this is fine. For larger, switch to HNSW (Postgres 16+).
  await sql`
    CREATE INDEX IF NOT EXISTS page_embeddings_vec_idx
    ON page_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS page_embeddings_tsv_idx
    ON page_embeddings
    USING GIN (tsv)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS page_embeddings_page_idx
    ON page_embeddings (page_id, chunk_index)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS page_embeddings_workspace_idx
    ON page_embeddings (workspace_id)
  `.execute(db);

  // Keep tsv in sync with content. Mirrors the pattern used by
  // pages and ai_chat_messages in upstream Docmost.
  await sql`
    CREATE OR REPLACE FUNCTION page_embeddings_tsvector_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.tsv :=
        setweight(to_tsvector('english', f_unaccent(coalesce(NEW.content, ''))), 'A');
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS page_embeddings_tsvector_update ON page_embeddings;
    CREATE TRIGGER page_embeddings_tsvector_update
      BEFORE INSERT OR UPDATE OF content ON page_embeddings
      FOR EACH ROW EXECUTE FUNCTION page_embeddings_tsvector_trigger();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS page_embeddings_tsvector_update ON page_embeddings`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS page_embeddings_tsvector_trigger`.execute(db);
  await sql`DROP INDEX IF EXISTS page_embeddings_workspace_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS page_embeddings_page_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS page_embeddings_tsv_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS page_embeddings_vec_idx`.execute(db);
  await db.schema.dropTable('page_embeddings').ifExists().execute();
}
