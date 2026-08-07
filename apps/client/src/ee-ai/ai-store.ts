import { atom } from "jotai";

/**
 * UI state for the in-web agent panel.
 *
 * The chat messages themselves live in Vercel AI SDK's `useChat`
 * hook (inside AgentPanel), since it owns the streaming lifecycle.
 * This atom only holds toggles and the current page context.
 */
export const agentPanelOpenAtom = atom<boolean>(false);

export interface AgentContext {
  pageId?: string;
  pageTitle?: string;
  spaceId?: string;
}

export const agentContextAtom = atom<AgentContext>({});

/**
 * Set by the page editor when the user navigates to a new page,
 * so the agent always knows which page is in scope.
 */
export const agentCurrentPageIdAtom = atom<string | undefined>(undefined);
