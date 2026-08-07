import { ActionIcon, Box, Group, Textarea, Tooltip } from "@mantine/core";
import { IconArrowUp, IconPlayerStop, IconWand } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

interface ComposerProps {
  onSubmit: (text: string) => void;
  onStop?: () => void;
  status: "submitted" | "streaming" | "ready" | "error";
  disabled?: boolean;
  contextLabel?: string;
}

/**
 * The bottom-of-panel input box for the in-web agent.
 *
 * - Enter to send, Shift+Enter for newline.
 * - When the model is mid-stream, the send button morphs into a
 *   stop button that aborts the request.
 * - The `contextLabel` chip (e.g. "on: Q3 OKRs") shows the user
 *   which page the agent is currently scoped to, so they always
 *   know what "this page" means to the model.
 */
export function Composer({ onSubmit, onStop, status, disabled, contextLabel }: ComposerProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Reset on stream end so the user can immediately send a follow-up.
    if (status === "ready") {
      // Keep value — most users want to iterate.
    }
  }, [status]);

  const isStreaming = status === "submitted" || status === "streaming";

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
    ref.current?.focus();
  };

  return (
    <Box
      p="xs"
      style={{
        borderTop: "1px solid var(--mantine-color-gray-3)",
        background: "var(--mantine-color-gray-0)",
      }}
    >
      {contextLabel && (
        <Group gap={4} mb={6} align="center">
          <IconWand size={12} color="var(--mantine-color-grape-6)" />
          <Box
            style={{
              fontSize: 11,
              color: "var(--mantine-color-dimmed)",
              padding: "1px 6px",
              borderRadius: 8,
              background: "var(--mantine-color-gray-1)",
            }}
          >
            {contextLabel}
          </Box>
        </Group>
      )}
      <Group gap="xs" align="flex-end">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask the agent…"
          autosize
          minRows={1}
          maxRows={8}
          disabled={disabled}
          style={{ flex: 1 }}
          styles={{ input: { fontSize: 13 } }}
        />
        {isStreaming ? (
          <Tooltip label="Stop">
            <ActionIcon color="red" variant="light" size="lg" onClick={onStop}>
              <IconPlayerStop size={16} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <Tooltip label="Send (Enter)">
            <ActionIcon
              color="blue"
              variant="filled"
              size="lg"
              onClick={submit}
              disabled={!value.trim() || disabled}
            >
              <IconArrowUp size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Box>
  );
}
