import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

/**
 * Persistence for AI chat history. Uses the `ai_chats` and
 * `ai_chat_messages` tables that Docmost already migrated.
 *
 * Keeping the chat log lets the user resume a conversation later
 * (across page navigations) and gives us an audit trail of what the
 * agent did — which is important when the agent can mutate
 * workspace content.
 *
 * Note: Kysely maps the snake_case table names to camelCase
 * identifiers here (`ai_chats` → `aiChats`).
 */
@Injectable()
export class ChatRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async createChat(opts: {
    userId: string;
    workspaceId: string;
    pageId?: string;
  }): Promise<string> {
    const row = await this.db
      .insertInto('aiChats')
      .values({
        workspaceId: opts.workspaceId,
        creatorId: opts.userId,
        title: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async appendMessage(opts: {
    chatId: string;
    userId: string | null;
    workspaceId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    metadata?: Record<string, unknown>;
    toolCalls?: unknown;
  }): Promise<void> {
    await this.db
      .insertInto('aiChatMessages')
      .values({
        chatId: opts.chatId,
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        role: opts.role,
        content: opts.content,
        toolCalls: opts.toolCalls as any,
        metadata: opts.metadata as any,
      })
      .execute();
  }

  async listChats(workspaceId: string, userId: string) {
    return this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .execute();
  }

  async listMessages(chatId: string) {
    return this.db
      .selectFrom('aiChatMessages')
      .selectAll()
      .where('chatId', '=', chatId)
      .orderBy('createdAt', 'asc')
      .execute();
  }
}
