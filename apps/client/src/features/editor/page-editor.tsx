import "@/features/editor/styles/index.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebSocketStatus } from "@hocuspocus/provider";
import {
  HocuspocusRoom,
  useHocuspocusEvent,
  useHocuspocusProvider,
} from "@hocuspocus/provider-react";
import { useAtom, useAtomValue } from "jotai";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import { withCollaboration } from "@blocknote/core/yjs";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import {
  AIExtension,
  AIMenu,
  AIMenuController,
  AIToolbarButton,
  getAISlashMenuItems,
  getDefaultAIMenuItems,
} from "@blocknote/xl-ai";
import "@blocknote/xl-ai/style.css";
import { DefaultChatTransport } from "ai";
import { useDocumentVisibility } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import {
  currentPageEditModeAtom,
  yjsConnectionStatusAtom,
  yjsSyncedAtom,
} from "@/features/editor/atoms/editor-atoms";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import { FIVE_MINUTES } from "@/lib/constants.ts";
import { useIdle } from "@/hooks/use-idle.ts";
import { queryClient } from "@/main.tsx";
import { searchSpotlight } from "@/features/search/constants.ts";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { platformModifierKey } from "@/lib";
import { aiMenuItems } from "@/ee-ai/ai-menu-items";
import {
  agentContextAtom,
  agentCurrentPageIdAtom,
  type AgentContext,
} from "@/ee-ai/ai-store";

interface PageEditorProps {
  pageId: string;
  editable: boolean;
  content?: unknown;
  canComment?: boolean;
}

/**
 * Generate a stable color from a user identifier so collaborator
 * cursors are consistent across sessions.
 */
function colorForUser(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

export default function PageEditor({ pageId, editable }: PageEditorProps) {
  const { t } = useTranslation();
  const collabQuery = useCollabToken();
  const token = collabQuery.data?.token;

  const handleStateless = useCallback((data: { payload: string }) => {
    try {
      const payload = JSON.parse(data.payload);
      if (payload?.type === "page.updated") {
        queryClient.setQueryData(["pages", payload.slugId], (old: any) => {
          if (!old) return old;
          return {
            ...old,
            updatedAt: payload.updatedAt,
            lastUpdatedBy: payload.lastUpdatedBy,
          };
        });
      }
    } catch {
      // ignore malformed payload
    }
  }, []);

  const handleAuthenticationFailed = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["collab-token"] });
  }, []);

  if (!token) {
    return <div className="bn-container" data-loading="true" aria-label={t("Loading")} />;
  }

  return (
    <HocuspocusRoom
      name={`page.${pageId}`}
      token={token}
      flushDelay={500}
      onStateless={handleStateless}
      onAuthenticationFailed={handleAuthenticationFailed}
    >
      <CollabPageEditor pageId={pageId} editable={editable} />
    </HocuspocusRoom>
  );
}

function CollabPageEditor({ pageId, editable }: PageEditorProps) {
  const { t } = useTranslation();
  const provider = useHocuspocusProvider();
  const isComponentMounted = useRef(false);

  useEffect(() => {
    isComponentMounted.current = true;
  }, []);

  const [currentUser] = useAtom(currentUserAtom);
  const [isLocalSynced, setIsLocalSynced] = useState(false);
  const [yjsConnectionStatus, setYjsConnectionStatus] = useAtom(
    yjsConnectionStatusAtom,
  );
  const [, setYjsSynced] = useAtom(yjsSyncedAtom);
  const documentState = useDocumentVisibility();
  const { isIdle, resetIdle } = useIdle(FIVE_MINUTES, { initialState: false });
  const currentPageEditMode = useAtomValue(currentPageEditModeAtom);
  const [, setAgentContext] = useAtom(agentContextAtom) as readonly [
    AgentContext,
    (v: AgentContext) => void,
  ];
  const [, setAgentCurrentPageId] = useAtom(agentCurrentPageIdAtom) as readonly [
    string | undefined,
    (v: string | undefined) => void,
  ];

  // Keep the in-web agent panel informed of the current page so
  // when the user types "improve this" the model knows which page
  // is in scope.
  useEffect(() => {
    setAgentCurrentPageId(pageId);
    setAgentContext({ pageId });
  }, [pageId, setAgentCurrentPageId, setAgentContext]);

  // Bind y-indexeddb to the same Y.Doc the Hocuspocus provider owns.
  // This gives the user offline cache for the page.
  useEffect(() => {
    const local = new IndexeddbPersistence(
      provider.configuration.name,
      provider.document,
    );
    local.on("synced", () => setIsLocalSynced(true));
    return () => {
      local.destroy();
    };
  }, [provider]);

  useHocuspocusEvent("synced", ({ state }) => setYjsSynced(state));
  useHocuspocusEvent("status", ({ status }) => setYjsConnectionStatus(status));

  // Connect/disconnect based on tab visibility + idle state.
  useEffect(() => {
    const socket = (provider.configuration as any).websocketProvider;
    if (!socket) return;

    if (
      isIdle &&
      documentState === "hidden" &&
      yjsConnectionStatus === WebSocketStatus.Connected
    ) {
      socket.disconnect();
      return;
    }
    if (
      documentState === "visible" &&
      yjsConnectionStatus === WebSocketStatus.Disconnected
    ) {
      resetIdle();
      socket.connect();
    }
  }, [isIdle, documentState, provider, resetIdle, yjsConnectionStatus]);

  // Build the BlockNote editor with Hocuspocus-backed Y.Doc collaboration.
  // CRITICAL: the fragment name "default" must match what Docmost's
  // persistence extension uses. See:
  //   apps/server/src/collaboration/extensions/persistence.extension.ts
  //     TiptapTransformer.toYdoc(page.content, "default", tiptapExtensions)
  //
  // BlockNote only needs the Y.XmlFragment (for sync, via the Hocuspocus
  // provider bound to the same Y.Doc upstream) and the awareness object
  // (for cursor presence). The HocuspocusProvider does the actual
  // WebSocket sync independently.
  const userId = currentUser?.user?.id ?? "anon";
  const userName = currentUser?.user?.name ?? "Anonymous";
  const userColor = colorForUser(userId);

  const editor = useCreateBlockNote({
    // Collaboration: bind to the same Y.Doc Hocuspocus owns. The
    // fragment name "default" must match what Docmost's persistence
    // extension uses on the server.
    ...withCollaboration({
      collaboration: {
        fragment: provider.document.getXmlFragment("default"),
        user: {
          id: userId,
          name: userName,
          color: userColor,
        },
        provider: {
          awareness: (provider as any).awareness,
        },
        showCursorLabels: "activity",
      },
    }),
    // AI extension — single transport shared with the side panel.
    // The /api/ai/chat endpoint speaks the Vercel AI SDK UI message
    // stream format. Page context is sent as part of the request body
    // so the server-side agent knows which page to scope tool calls
    // to.
    //
    // The `as any` on the transport is a workaround for a peer
    // version mismatch between BlockNote xl-ai (compiled against
    // ai@6) and @ai-sdk/react@4 (which transitively brings ai@7).
    // Both versions are wire-compatible for our request shape.
    extensions: [
      AIExtension({
        transport: new DefaultChatTransport({
          api: "/api/ai/chat",
          body: () => ({
            pageId,
            spaceId: currentUser?.user?.workspaceId,
          }),
        }) as any,
        agentCursor: { name: "AI", color: "#8bc6ff" },
      }),
    ],
  });

  // Keyboard shortcut: Cmd/Ctrl+K → open search spotlight
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (platformModifierKey(e) && e.key === "k") {
        e.preventDefault();
        searchSpotlight.open();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!isLocalSynced) {
    return <div className="bn-container" data-loading="true" aria-label={t("Loading")} />;
  }

  return (
    <div className="bn-container" data-editable={editable}>
      <BlockNoteView
        editor={editor as any}
        editable={editable && currentPageEditMode !== PageEditMode.Read}
        theme={"light"}
        slashMenu={false}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor as any),
                ...getAISlashMenuItems(editor as any),
              ],
              query,
            )
          }
        />
        <AIMenuController
          aiMenu={CustomAIMenu as any}
        />
      </BlockNoteView>
    </div>
  );
}

/**
 * Custom AI menu that augments BlockNote's defaults with our
 * domain-specific items (improve writing, fix grammar, summarise,
 * translate to Vietnamese, etc.).
 */
const CustomAIMenu = (props: any) => (
  <AIMenu {...props} items={(editor: any) => {
    if (props.aiResponseStatus === "user-input") {
      return [
        ...getDefaultAIMenuItems(editor, props.aiResponseStatus),
        ...aiMenuItems(editor),
      ];
    }
    return getDefaultAIMenuItems(editor, props.aiResponseStatus);
  }} />
);
