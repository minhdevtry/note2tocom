import { Box, Group, Paper, Text, ScrollArea, Loader, Stack, Badge } from "@mantine/core";
import { IconUser, IconRobot } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { ToolCallCard } from "./tool-call-card";
import type { UIMessage } from "@ai-sdk/react";

interface MessageListProps {
  messages: UIMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
}

/**
 * Renders the chat transcript + tool invocations in the agent panel.
 *
 * Vercel AI SDK's UIMessage has a `parts` array. Each part is one of:
 *   { type: 'text', text: '...' }
 *   { type: 'reasoning', text: '...' }        (when reasoning models emit it)
 *   { type: 'tool-<toolName>', toolCallId, state, input, output }
 *
 * We render text parts as Markdown-style plain text (we deliberately
 * do not pull a markdown library — plain text is enough for 2 users
 * and avoids the XSS surface area). Tool parts use ToolCallCard.
 */
export function MessageList({ messages, status }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll on new content. The threshold is small so a long
    // tool result doesn't yank the user to the bottom unexpectedly.
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, status]);

  if (messages.length === 0) {
    return (
      <Box p="md">
        <Stack gap="xs" align="center" c="dimmed">
          <IconRobot size={32} />
          <Text size="sm" ta="center">
            Ask me to read, write, or search the workspace.
          </Text>
          <Text size="xs" ta="center">
            Try: "summarise this page", "find docs about Q3 OKRs", or "fix the typo in this paragraph".
          </Text>
        </Stack>
      </Box>
    );
  }

  return (
    <ScrollArea viewportRef={scrollRef} style={{ flex: 1 }} p="sm" type="auto">
      <Stack gap="sm">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {status === "submitted" && (
          <Group gap="xs" pl="xs" c="dimmed">
            <Loader size="xs" />
            <Text size="xs">Thinking…</Text>
          </Group>
        )}
      </Stack>
    </ScrollArea>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  return (
    <Group align="flex-start" gap="xs" wrap="nowrap" style={{ flexDirection: isUser ? "row-reverse" : "row" }}>
      <Box
        style={{
          flexShrink: 0,
          width: 24,
          height: 24,
          borderRadius: 12,
          background: isUser ? "var(--mantine-color-blue-1)" : "var(--mantine-color-grape-1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {isUser ? <IconUser size={14} /> : <IconRobot size={14} />}
      </Box>
      <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
        {message.parts?.map((part: any, i: number) => {
          if (part.type === "text" || part.text) {
            return (
              <Paper
                key={i}
                withBorder={false}
                p="xs"
                radius="sm"
                bg={isUser ? "blue.0" : "gray.0"}
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13 }}
              >
                {part.text ?? ""}
              </Paper>
            );
          }
          if (part.type?.startsWith("tool-") || part.type === "tool-invocation") {
            return (
              <ToolCallCard
                key={i}
                toolName={(part.typeName ?? part.type?.replace(/^tool-/, "") ?? "tool")}
                args={part.input ?? part.args ?? {}}
                result={part.output ?? part.result}
                state={
                  part.state === "result"
                    ? "result"
                    : part.state === "error"
                      ? "error"
                      : "call"
                }
              />
            );
          }
          return null;
        })}
      </Stack>
    </Group>
  );
}
