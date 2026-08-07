import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { openai } from '@ai-sdk/openai';
import { embed, embedMany } from 'ai';

/**
 * Embedding generator for RAG.
 *
 * Defaults to OpenAI `text-embedding-3-small` (1536d, ~$0.02 per
 * million tokens) via the Vercel AI SDK. Falls back gracefully if
 * the API key is missing — callers should treat a missing-key
 * embedding result as a signal to skip vector search.
 *
 * To switch providers, set the env vars documented in .env.example
 * and swap the import below. The schema column in `page_embeddings`
 * is `vector(1536)`; if you change dimension, write a new migration.
 */
@Injectable()
export class EmbeddingService {
  private readonly modelName: string;
  private readonly apiKey: string | undefined;

  constructor(private readonly env: EnvironmentService) {
    this.modelName = this.env.getEmbeddingModel();
    this.apiKey = this.env.getOpenaiApiKey();
  }

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. Configure it in .env to enable vector search.',
      );
    }
    const { embedding } = await embed({
      model: openai.textEmbedding(this.modelName),
      value: text,
    });
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not set.');
    }
    const { embeddings } = await embedMany({
      model: openai.textEmbedding(this.modelName),
      values: texts,
    });
    return embeddings;
  }
}
