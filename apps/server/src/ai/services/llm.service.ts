import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { openai } from '@ai-sdk/openai';
// Pull the V2 spec types via the same deep path the model file
// uses. Hoisted `@ai-sdk/provider` is V4; V2 lives in the pnpm
// store. We only need a structural alias here.
import type { LanguageModelV2 } from '../../../../../node_modules/.pnpm/@ai-sdk+provider@3.0.8/node_modules/@ai-sdk/provider/dist/index.d.ts';
import { AnthropicCompatModel } from './anthropic-compat.model';

/**
 * LLM factory. Reads the configured model from env and returns a
 * Vercel AI SDK `LanguageModelV2` model instance.
 *
 * Provider selection is driven by the `AI_MODEL` env var, formatted
 * as `<provider>/<model>`. Supported providers:
 *
 *   - anthropic — talks the Anthropic Messages wire format
 *     (POST `${ANTHROPIC_BASE_URL}/v1/messages`). Works with any
 *     Anthropic-compatible gateway. We implement this in-tree
 *     (AnthropicCompatModel) because Vercel's `@ai-sdk/anthropic`
 *     v4 returns `LanguageModelV4`, which AI SDK 5 (ai v6) no
 *     longer accepts — only V2 is supported. Re-implementing the
 *     small slice we need (text + tool use streaming) avoids the
 *     version mismatch entirely.
 *   - openai — official OpenAI API.
 *
 * Examples:
 *   AI_MODEL=anthropic/claude-sonnet-4-5
 *   AI_MODEL=anthropic/MiniMax-M3
 *   AI_MODEL=openai/gpt-4o
 */
@Injectable()
export class LlmService {
  private readonly provider: string;
  private readonly model: string;

  constructor(private readonly env: EnvironmentService) {
    const raw = this.env.getAiModel();
    const [provider, model] = raw.includes('/') ? raw.split('/', 2) : ['anthropic', raw];
    this.provider = provider;
    this.model = model;
  }

  getModel(): LanguageModelV2 {
    switch (this.provider) {
      case 'openai': {
        const key = this.env.getOpenaiApiKey();
        if (!key) {
          throw new Error(
            'OPENAI_API_KEY is not set. Set it in .env to use OpenAI models.',
          );
        }
        return openai(this.model) as unknown as LanguageModelV2;
      }
      case 'anthropic':
      default: {
        const key = this.env.getAnthropicApiKey();
        const baseUrl = this.env.getAnthropicBaseUrl();
        if (!key || !baseUrl) {
          throw new Error(
            'ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL must be set to use Anthropic-compatible models.',
          );
        }
        return new AnthropicCompatModel({
          baseUrl,
          apiKey: key,
          model: this.model,
          providerName: 'anthropic-compat',
        });
      }
    }
  }

  getProviderName(): string {
    return this.provider;
  }

  getModelName(): string {
    return this.model;
  }
}
