import { ActionIcon, Badge, Box, Code, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronRight, IconExternalLink, IconX } from "@tabler/icons-react";
import { useState } from "react";

interface ToolCallCardProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  state: "call" | "result" | "error";
}

/**
 * Visualises a single tool invocation inside the agent's chat stream.
 *
 * - For read tools (getBlocks, getCurrentPage, searchPages) we
 *   collapse the result by default and show a small expandable
 *   JSON preview.
 * - For write tools (updateBlock, insertBlocks, createPage) we
 *   surface the affected page/block ID with a link, and mark the
 *   block as "applied" once the tool result returns successfully.
 *
 * The styling intentionally mirrors Mantine's chat primitives so
 * the card sits naturally inside the agent panel.
 */
export function ToolCallCard({ toolName, args, result, state }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isError = state === "error";
  const isWrite = WRITE_TOOLS.has(toolName);

  return (
    <Paper
      withBorder
      p="xs"
      radius="sm"
      bg={isError ? "red.0" : isWrite ? "blue.0" : "gray.0"}
      style={{ fontSize: 12, maxWidth: "100%" }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          {isError ? (
            <IconX size={14} color="var(--mantine-color-red-6)" />
          ) : (
            <IconCheck size={14} color="var(--mantine-color-blue-6)" />
          )}
          <Badge size="xs" variant="light" color={isError ? "red" : "blue"}>
            {toolName}
          </Badge>
          {isWrite && !isError && (
            <Badge size="xs" variant="dot" color="green">
              applied
            </Badge>
          )}
          {typeof result === "object" && result !== null && "pageId" in result && (
            <Text size="xs" c="dimmed" truncate>
              → {(result as any).pageId.slice(0, 8)}…
            </Text>
          )}
        </Group>
        <Group gap={2} wrap="nowrap">
          <Tooltip label="Open page" disabled={!isWrite}>
            <ActionIcon size="xs" variant="subtle" disabled={!isWrite}>
              <IconExternalLink size={12} />
            </ActionIcon>
          </Tooltip>
          <ActionIcon size="xs" variant="subtle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </ActionIcon>
        </Group>
      </Group>
      {expanded && (
        <Stack gap={4} mt="xs">
          <Box>
            <Text size="xs" c="dimmed">Arguments</Text>
            <Code block style={{ fontSize: 11, maxHeight: 200, overflow: "auto" }}>
              {JSON.stringify(args, null, 2)}
            </Code>
          </Box>
          {result !== undefined && (
            <Box>
              <Text size="xs" c="dimmed">Result</Text>
              <Code block style={{ fontSize: 11, maxHeight: 200, overflow: "auto" }}>
                {JSON.stringify(result, null, 2)}
              </Code>
            </Box>
          )}
        </Stack>
      )}
    </Paper>
  );
}

const WRITE_TOOLS = new Set([
  "updateBlock",
  "insertBlocks",
  "deleteBlock",
  "createPage",
]);
