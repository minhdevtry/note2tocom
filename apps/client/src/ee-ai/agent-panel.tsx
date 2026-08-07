import { ActionIcon, Box, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconPlus, IconSparkles, IconTrash } from "@tabler/icons-react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import {
  agentContextAtom,
  agentCurrentPageIdAtom,
  agentPanelOpenAtom,
} from "./ai-store";

interface AgentPanelProps {
  chatId?: string;
  onChatIdChange?: (id: string) => void;
}

/**
 * The in-web agent panel. Drops into Docmost's existing right-side
 * `Aside` slot (with `tab: 'chat'`) and replaces the old TipTap-based
 * `AsideChatPanel` from `ee/ai-chat/`.
 *
 * State is driven by Vercel AI SDK's `useChat`, which owns the
 * message stream + the SSE connection. The transport is set up to
 * POST to our `/api/ai/chat` endpoint (proxied via Vite to the
 * NestJS server) and to send the current page + workspace as the
 * request body so the server-side agent has context.
 *
 * The server echoes the chatId back in a `X-Chat-Id` header on the
 * first response of a new conversation. We capture it via a custom
 * `fetch` wrapper so useChat can re-key on the next render and
 * resume from this conversation if the page reloads.
 */
export function AgentPanel({ chatId, onChatIdChange }: AgentPanelProps) {
  const { t: _t } = useTranslation();
  const context = useAtomValue(agentContextAtom);
  const currentPageId = useAtomValue(agentCurrentPageIdAtom);
  const [panelOpen] = useAtom(agentPanelOpenAtom);
  const onChatIdChangeRef = useRef(onChatIdChange);
  onChatIdChangeRef.current = onChatIdChange;

  // Stable transport so changing chatId doesn't tear down the stream
  // mid-response.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/chat",
        body: () => ({
          pageId: currentPageId,
          spaceId: context.spaceId,
          chatId: chatId || undefined,
        }),
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          const newId = res.headers.get("x-chat-id");
          if (newId && onChatIdChangeRef.current) {
            onChatIdChangeRef.current(newId);
          }
          return res;
        },
      }),
    [chatId, currentPageId, context.spaceId],
  );

  const { messages, sendMessage, status, stop, error, setMessages } = useChat({
    id: chatId,
    transport,
  });

  useEffect(() => {
    if (panelOpen && !chatId) {
      setMessages([]);
    }
  }, [panelOpen, chatId, setMessages]);

  const contextLabel = useMemo(() => {
    if (context.pageTitle) return `on: ${context.pageTitle}`;
    if (currentPageId) return `on page ${currentPageId.slice(0, 8)}…`;
    return undefined;
  }, [context.pageTitle, currentPageId]);

  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }}>
      <Group
        justify="space-between"
        px="sm"
        py="xs"
        style={{ borderBottom: "1px solid var(--mantine-color-gray-3)" }}
      >
        <Group gap={6}>
          <IconSparkles size={16} color="var(--mantine-color-grape-6)" />
          <Text size="sm" fw={500}>
            Agent
          </Text>
          {status === "streaming" && (
            <Text size="xs" c="dimmed">
              · streaming
            </Text>
          )}
        </Group>
        <Group gap={4}>
          <Tooltip label="New chat">
            <ActionIcon
              size="sm"
              variant="subtle"
              onClick={() => {
                if (onChatIdChangeRef.current) onChatIdChangeRef.current("");
                setMessages([]);
              }}
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Clear messages">
            <ActionIcon
              size="sm"
              variant="subtle"
              onClick={() => setMessages([])}
              disabled={messages.length === 0}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <MessageList messages={messages} status={status} />

      {error && (
        <Box p="xs" bg="red.0" style={{ borderTop: "1px solid var(--mantine-color-red-2)" }}>
          <Text size="xs" c="red.7">
            {error.message}
          </Text>
        </Box>
      )}

      <Composer
        status={status}
        onSubmit={(text) => sendMessage({ text })}
        onStop={stop}
        contextLabel={contextLabel}
      />
    </Stack>
  );
}
