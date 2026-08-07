import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { AiController } from './ai.controller';
import { ToolHandlers } from './tools/handlers';
import { RagService } from './services/rag.service';
import { EmbeddingService } from './services/embedding.service';
import { LlmService } from './services/llm.service';
import { BlockMutationService } from './services/block-mutation.service';
import { ChatRepo } from './repos/chat.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { TokenService } from '../core/auth/services/token.service';
import { EnvironmentService } from '../integrations/environment/environment.service';

/**
 * NestJS module for the AI agent layer.
 *
 * Registers the AI services, handlers, and controller. Register this
 * module in app.module.ts to enable both the in-web chat endpoint
 * and the MCP server (which is mounted separately in mcp.module.ts).
 *
 * Imports JwtModule directly because TokenService (used for verifying
 * the user's JWT in the AI controller and MCP controller) depends on
 * @nestjs/jwt's JwtService, which is not re-exported by TokenModule.
 * Re-registering JwtModule here shares the same singleton — JWT
 * verification uses the same secret/signing options as Docmost's auth.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: async (environmentService: EnvironmentService) => ({
        secret: environmentService.getAppSecret(),
        signOptions: {
          expiresIn: environmentService.getJwtTokenExpiresIn() as StringValue,
          issuer: 'Docmost',
        },
      }),
      inject: [EnvironmentService],
    }),
  ],
  controllers: [AiController],
  providers: [
    ToolHandlers,
    RagService,
    EmbeddingService,
    LlmService,
    BlockMutationService,
    ChatRepo,
    PageRepo,
    SpaceMemberRepo,
    TokenService,
  ],
  exports: [ToolHandlers, RagService, BlockMutationService, ChatRepo],
})
export class AiModule {}
