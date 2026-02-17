import { create } from "zustand";

export interface BrowserTabHistoryEntry {
  stack: string[];
  index: number;
}

export interface BrowserTabNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  currentUrl: string | null;
}

interface BrowserTabHistoryStoreState {
  historiesBySession: Record<string, Record<string, BrowserTabHistoryEntry>>;
  getNavigationState: (
    sessionId: string,
    tabId: string,
  ) => BrowserTabNavigationState;
  pushUrl: (
    sessionId: string,
    tabId: string,
    url: string,
  ) => BrowserTabNavigationState;
  stepBack: (
    sessionId: string,
    tabId: string,
  ) => { targetUrl: string | null; navigation: BrowserTabNavigationState };
  stepForward: (
    sessionId: string,
    tabId: string,
  ) => { targetUrl: string | null; navigation: BrowserTabNavigationState };
  removeTab: (sessionId: string, tabId: string) => void;
  clearSession: (sessionId: string) => void;
}

const EMPTY_NAVIGATION_STATE: BrowserTabNavigationState = {
  canGoBack: false,
  canGoForward: false,
  currentUrl: null,
};

const buildNavigationState = (
  entry: BrowserTabHistoryEntry | undefined,
): BrowserTabNavigationState => {
  if (!entry || entry.stack.length === 0) {
    return EMPTY_NAVIGATION_STATE;
  }
  const normalizedIndex = Math.max(0, Math.min(entry.index, entry.stack.length - 1));
  return {
    canGoBack: normalizedIndex > 0,
    canGoForward: normalizedIndex < entry.stack.length - 1,
    currentUrl: entry.stack[normalizedIndex] ?? null,
  };
};

const createEntry = (url: string): BrowserTabHistoryEntry => ({
  stack: [url],
  index: 0,
});

const cloneEntry = (entry: BrowserTabHistoryEntry): BrowserTabHistoryEntry => ({
  stack: [...entry.stack],
  index: entry.index,
});

export const useBrowserTabHistoryStore = create<BrowserTabHistoryStoreState>(
  (set, get) => ({
    historiesBySession: {},
    getNavigationState: (sessionId: string, tabId: string) => {
      const session = get().historiesBySession[sessionId];
      return buildNavigationState(session?.[tabId]);
    },
    pushUrl: (sessionId: string, tabId: string, url: string) => {
      const nextUrl = url.trim();
      if (!nextUrl) {
        return get().getNavigationState(sessionId, tabId);
      }
      let nextEntry: BrowserTabHistoryEntry | undefined;
      set((state) => {
        const session = state.historiesBySession[sessionId] ?? {};
        const current = session[tabId];
        if (!current) {
          const created = createEntry(nextUrl);
          nextEntry = created;
          return {
            historiesBySession: {
              ...state.historiesBySession,
              [sessionId]: {
                ...session,
                [tabId]: created,
              },
            },
          };
        }

        const currentUrl = current.stack[current.index] ?? null;
        if (currentUrl === nextUrl) {
          nextEntry = current;
          return state;
        }

        const truncated = current.stack.slice(0, current.index + 1);
        truncated.push(nextUrl);
        const updated: BrowserTabHistoryEntry = {
          stack: truncated,
          index: truncated.length - 1,
        };
        nextEntry = updated;
        return {
          historiesBySession: {
            ...state.historiesBySession,
            [sessionId]: {
              ...session,
              [tabId]: updated,
            },
          },
        };
      });
      return buildNavigationState(nextEntry);
    },
    stepBack: (sessionId: string, tabId: string) => {
      let targetUrl: string | null = null;
      let nextEntry: BrowserTabHistoryEntry | undefined;
      set((state) => {
        const session = state.historiesBySession[sessionId] ?? {};
        const current = session[tabId];
        if (!current || current.index <= 0) {
          nextEntry = current;
          return state;
        }
        const updated = cloneEntry(current);
        updated.index -= 1;
        targetUrl = updated.stack[updated.index] ?? null;
        nextEntry = updated;
        return {
          historiesBySession: {
            ...state.historiesBySession,
            [sessionId]: {
              ...session,
              [tabId]: updated,
            },
          },
        };
      });
      return {
        targetUrl,
        navigation: buildNavigationState(nextEntry),
      };
    },
    stepForward: (sessionId: string, tabId: string) => {
      let targetUrl: string | null = null;
      let nextEntry: BrowserTabHistoryEntry | undefined;
      set((state) => {
        const session = state.historiesBySession[sessionId] ?? {};
        const current = session[tabId];
        if (!current || current.index >= current.stack.length - 1) {
          nextEntry = current;
          return state;
        }
        const updated = cloneEntry(current);
        updated.index += 1;
        targetUrl = updated.stack[updated.index] ?? null;
        nextEntry = updated;
        return {
          historiesBySession: {
            ...state.historiesBySession,
            [sessionId]: {
              ...session,
              [tabId]: updated,
            },
          },
        };
      });
      return {
        targetUrl,
        navigation: buildNavigationState(nextEntry),
      };
    },
    removeTab: (sessionId: string, tabId: string) => {
      set((state) => {
        const session = state.historiesBySession[sessionId];
        if (!session || !(tabId in session)) {
          return state;
        }
        const nextSession = { ...session };
        delete nextSession[tabId];
        const nextHistories = { ...state.historiesBySession };
        if (Object.keys(nextSession).length === 0) {
          delete nextHistories[sessionId];
        } else {
          nextHistories[sessionId] = nextSession;
        }
        return { historiesBySession: nextHistories };
      });
    },
    clearSession: (sessionId: string) => {
      set((state) => {
        if (!(sessionId in state.historiesBySession)) {
          return state;
        }
        const next = { ...state.historiesBySession };
        delete next[sessionId];
        return { historiesBySession: next };
      });
    },
  }),
);

export const browserTabHistoryStoreApi = useBrowserTabHistoryStore;
