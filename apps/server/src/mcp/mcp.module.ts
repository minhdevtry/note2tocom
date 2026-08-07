import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { McpController } from './mcp.controller';
import { ToolHandlers } from '../ai/tools/handlers';
import { TokenService } from '../core/auth/services/token.service';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { AiModule } from '../ai/ai.module';

/**
 * Standalone MCP module. Pulls the same `ToolHandlers` instance
 * from the DI graph as the in-web agent, so the two surfaces stay
 * in lockstep — adding a tool to the agent automatically exposes
 * it on the MCP server.
 *
 * We import `AiModule` (rather than just `ToolHandlers`) because
 * `ToolHandlers` depends on `RagService` and `BlockMutationService`,
 * which the DI graph only resolves if we bring in their declaring
 * module.
 */
@Module({
  imports: [
    AiModule,
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
  controllers: [McpController],
  providers: [ToolHandlers, TokenService, EnvironmentService],
})
export class McpModule {}
