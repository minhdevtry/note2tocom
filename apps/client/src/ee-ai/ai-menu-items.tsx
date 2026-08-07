import {
  AIExtension,
  aiDocumentFormats,
  type AIMenuSuggestionItem,
} from "@blocknote/xl-ai";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  IconLanguage,
  IconList,
  IconPencil,
  IconSparkles,
  IconWand,
  IconAlertTriangle,
  IconArrowsHorizontal,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
} from "@tabler/icons-react";

/**
 * Custom AI menu items for BlockNote.
 *
 * Mirrors the actions Docmost's `ee/ai` shipped (improve, fix grammar,
 * summarise, expand, translate, change tone) so the existing muscle
 * memory transfers. Each item calls `editor.getExtension(AIExtension)
 * ?.invokeAI(...)` with a prompt + a `streamToolsProvider` that
 * scopes the LLM to *update* operations only — the user picked a
 * selection, so the AI should never silently insert or delete
 * blocks outside of it.
 *
 * The same transport configured on `AIExtension` (in page-editor.tsx)
 * is reused here automatically — no extra wiring.
 */

const NO_DELETE = { add: false, delete: false, update: true } as const;

export const aiMenuItems = (editor: BlockNoteEditor): AIMenuSuggestionItem[] => [
  {
    key: "improve_writing",
    title: "Improve writing",
    aliases: ["rewrite", "polish", "better writing"],
    icon: <IconSparkles size={18} />,
    group: "Edit",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Rewrite the selected text to be clearer, more concise, and more engaging. Keep the same meaning. Do not change the length by more than ±20%.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
  {
    key: "fix_spelling_grammar",
    title: "Fix spelling & grammar",
    aliases: ["fix", "typo", "proofread", "grammar"],
    icon: <IconCheck size={18} />,
    group: "Edit",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Fix any spelling, punctuation, and grammar errors in the selected text. Keep the original meaning, tone, and length.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
  {
    key: "make_shorter",
    title: "Make shorter",
    aliases: ["condense", "shorten", "trim"],
    icon: <IconArrowDown size={18} />,
    group: "Edit",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Make the selected text at least 30% shorter while preserving the key points. Use tighter phrasing and remove redundancy.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
  {
    key: "make_longer",
    title: "Make longer",
    aliases: ["expand", "elaborate", "more detail"],
    icon: <IconArrowUp size={18} />,
    group: "Edit",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Expand the selected text with relevant detail, examples, and explanation. Aim for roughly 50% more length. Keep the original tone and meaning.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
  {
    key: "simplify",
    title: "Simplify",
    aliases: ["plain language", "simpler", "easier to read"],
    icon: <IconArrowsHorizontal size={18} />,
    group: "Edit",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Rewrite the selected text in plain, accessible language. Aim for a reading level of grade 8. Keep the same meaning.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
  {
    key: "summarize",
    title: "Summarize into bullets",
    aliases: ["summary", "tldr", "key points"],
    icon: <IconList size={18} />,
    group: "Transform",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Replace the selected text with a concise bulleted summary of its key points. Use between 3 and 7 bullets, each a single short sentence.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
  {
    key: "explain",
    title: "Explain",
    aliases: ["what does this mean", "clarify"],
    icon: <IconAlertTriangle size={18} />,
    group: "Transform",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Add a short explanation after the selected text that clarifies what it means in plain language. Use a callout or quote block to visually separate it from the original.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: { add: true, delete: false, update: false },
        }),
      });
    },
  },
  {
    key: "continue_writing",
    title: "Continue writing",
    aliases: ["keep going", "more text"],
    icon: <IconPencil size={18} />,
    group: "Generate",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Continue the document naturally from the end of the current selection. Match the existing tone, voice, and topic. Write 2-4 paragraphs.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: { add: true, delete: false, update: false },
        }),
      });
    },
  },
  {
    key: "change_tone",
    title: "Change tone to friendly",
    aliases: ["warmer", "less formal"],
    icon: <IconWand size={18} />,
    group: "Transform",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Rewrite the selected text in a warm, conversational tone while keeping the same meaning and approximate length. Avoid jargon.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
  {
    key: "translate_vi",
    title: "Translate to Vietnamese",
    aliases: ["vietnamese", "tiếng việt"],
    icon: <IconLanguage size={18} />,
    group: "Transform",
    onItemClick: () => {
      editor.getExtension(AIExtension)?.invokeAI({
        userPrompt:
          "Translate the selected text to natural, fluent Vietnamese. Preserve formatting, tone, and any code blocks unchanged.",
        useSelection: true,
        streamToolsProvider: aiDocumentFormats.html.getStreamToolsProvider({
          defaultStreamTools: NO_DELETE,
        }),
      });
    },
  },
];

/**
 * Drop-in menu component that augments BlockNote's default AI menu
 * with our custom items. Used by `AIMenuController aiMenu={...}` in
 * the page editor.
 */
export function customAIMenu(editor: BlockNoteEditor) {
  return aiMenuItems(editor);
}
