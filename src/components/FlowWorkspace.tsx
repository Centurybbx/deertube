import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  type ReactFlowInstance,
  type Viewport,
  useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import type {
  IJsonModel,
  IJsonTabNode,
} from "@massbug/flexlayout-react";
import { Actions, DockLocation, Model } from "@massbug/flexlayout-react";
import { trpc, trpcClient } from "../lib/trpc";
import type { IpcRendererEvent } from "electron";
import QuestionNode from "./nodes/QuestionNode";
import SourceNode from "./nodes/SourceNode";
import InsightNode from "./nodes/InsightNode";
import SettingsPanel from "./SettingsPanel";
import { Button } from "@/components/ui/button";
import {
  GitBranch,
  Globe,
  LayoutGrid,
  LoaderCircle,
  Lock,
  LockOpen,
  LocateFixed,
  MessageSquare,
  Network,
} from "lucide-react";
import {
  buildRuntimeSettings,
  createProfileDraft,
  type ProviderProfile,
  type RuntimeSettingsPayload,
} from "../lib/settings";
import { getNodeSize } from "../lib/elkLayout";
import FlowHeader from "./flow/FlowHeader";
import FlowPanelInput from "./flow/FlowPanelInput";
import type {
  FlowWorkspaceProps,
  ProjectChatSummary,
  ProjectState,
} from "./flow/types";
import { useAutoLayout } from "./flow/useAutoLayout";
import { useFlowState } from "./flow/useFlowState";
import { useInitialFit } from "./flow/useInitialFit";
import { usePanelState } from "./flow/usePanelState";
import { usePreviewHover } from "./flow/usePreviewHover";
import { useProfileSettings } from "./flow/useProfileSettings";
import { useChatActions } from "./flow/useChatActions";
import { QuestionActionProvider } from "./flow/QuestionActionProvider";
import { SourceActionProvider } from "./flow/SourceActionProvider";
import {
  executeBrowserValidation,
  updateBrowserTabValidationState,
} from "./flow/browserValidation";
import { buildValidationGraphInsertion } from "./flow/validate-graph";
import {
  buildCompletedValidationEvent,
  buildFailedValidationEvent,
  buildPageValidationSummaryMessage,
  createPageValidationChatSeed,
  upsertChatMessage,
} from "./flow/page-validation-chat";
import {
  isHttpUrl,
  normalizeBrowserLabel,
  normalizeHttpUrl,
  stripLineNumberPrefix,
  toReferenceHighlightPayload,
  toReferenceHighlightFromDeepSearchReference,
  toValidationHighlightPayload,
  truncateLabel,
} from "./flow/browser-utils";
import ChatHistoryPanel from "./chat/ChatHistoryPanel";
import type { FlowEdge, FlowNode, InsightNodeData } from "../types/flow";
import type {
  ChatMessage,
  DeepSearchStreamPayload,
  DeepSearchReferencePayload,
  DeepSearchSourcePayload,
  SubagentStreamPayload,
} from "../types/chat";
import { FlowFlexLayout } from "./flow/FlowFlexLayout";
import { BrowserTab } from "./browser/BrowserTab";
import { ChatTabActions } from "./flow/ChatTabActions";
import type {
  BrowserValidationFailureReason,
  BrowserPageValidationStatusRecord,
  BrowserPageValidationRecord,
  CdpBrowserValidateRequestPayload,
  CdpBrowserValidateStopRequestPayload,
  BrowserViewBounds,
  BrowserViewReferenceHighlight,
  BrowserViewSelection,
  BrowserViewStatePayload,
  BrowserViewTabState,
} from "../types/browserview";
import {
  isDeepResearchRefUri,
  type DeepResearchResolvedReference,
} from "@/shared/deepresearch";
import {
  finishRunningChatJob,
  listRunningChatIds,
  startRunningChatJob,
  subscribeRunningChatJobs,
} from "@/lib/running-chat-jobs";
import { browserTabHistoryStoreApi } from "@/lib/browser-tab-history-store";
import {
  BROWSER_TAB_PREFIX,
  CHAT_TABSET_ID,
  CHAT_TAB_ID,
  GRAPH_TABSET_ID,
  GRAPH_TAB_ID,
  collectBrowserTabIds,
  collectVisibleBrowserTabIds,
  createDefaultLayoutModel,
  createSingleBrowserLayoutModel,
  createSingleTabLayoutModel,
  findFirstTabsetId,
  findTabsetIdContainingBrowserTab,
  findTabsetIdContainingGraph,
  hasTab,
  hasTabset,
  normalizeLayoutModel,
  parseBrowserTabId,
} from "./flow/flexlayout-utils";
import type { FlexLayoutNode } from "./flow/flexlayout-utils";

const BROWSER_TAB_MAX_LABEL_LENGTH = 36;
const DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  style: { stroke: "var(--flow-edge)", strokeWidth: 1.6 },
} as const;

type ProjectStateInput = Omit<ProjectState, "chat"> & { chat?: ChatMessage[] };

interface ValidateExecutionResult {
  status: "complete" | "failed" | "skipped";
  query?: string;
  projectId?: string;
  searchId?: string;
  sources?: DeepSearchSourcePayload[];
  references?: DeepSearchReferencePayload[];
}

type ValidateStreamProgressEvent =
  | {
      type: "subagent-stream";
      payload: SubagentStreamPayload;
    }
  | {
      type: "deepsearch-stream";
      payload: DeepSearchStreamPayload;
    }
  | {
      type: "deepsearch-done";
      payload: DeepSearchStreamPayload;
    };

type ValidateStreamEvent =
  | ValidateStreamProgressEvent
  | {
      type: "result";
      payload: ValidateExecutionResult;
    };

interface BrowserValidationRunSession {
  runId: string;
  tabRuntimeId: string;
  chatId: string | null;
  pageUrls: string[];
  pageUrl: string;
  querySeed: string;
  eventId: string;
  toolCallId: string;
  abortController: AbortController;
  messages: ChatMessage[];
}

const createAbortError = (): Error => {
  const error = new Error("Validation stopped by user.");
  error.name = "AbortError";
  return error;
};

const isAbortError = (error: unknown): boolean => {
  if (!error) {
    return false;
  }
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /abort/i.test(error.message);
};

const VALIDATE_LOG_ROOT_PREFIX = "[validate]";
const BROWSER_VALIDATE_LOG_PREFIX = `${VALIDATE_LOG_ROOT_PREFIX}[browser]`;
const CDP_OPEN_LOG_PREFIX = `${VALIDATE_LOG_ROOT_PREFIX}[cdp.open]`;

const logBrowserValidate = (
  event: string,
  payload?: Record<string, unknown>,
) => {
  if (payload) {
    console.log(BROWSER_VALIDATE_LOG_PREFIX, event, payload);
    return;
  }
  console.log(BROWSER_VALIDATE_LOG_PREFIX, event);
};

const resolveBrowserValidationFailureReason = (
  errorMessage: string,
): BrowserValidationFailureReason =>
  /stopped by user|abort/i.test(errorMessage) ? "stopped" : "failed";

const buildBrowserValidationStatusRecord = ({
  status,
  error,
  failureReason,
}: {
  status: "running" | "complete" | "failed";
  error?: string;
  failureReason?: BrowserValidationFailureReason;
}): BrowserPageValidationStatusRecord => ({
  status,
  error: status === "failed" ? error : undefined,
  failureReason: status === "failed" ? failureReason : undefined,
  updatedAt: new Date().toISOString(),
});

const mergeBrowserValidationStatusByUrls = ({
  previous,
  urls,
  record,
}: {
  previous: Record<string, BrowserPageValidationStatusRecord>;
  urls: (string | null | undefined)[];
  record: BrowserPageValidationStatusRecord;
}): Record<string, BrowserPageValidationStatusRecord> => {
  const next = { ...previous };
  const seen = new Set<string>();
  urls.forEach((url) => {
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    next[url] = { ...record };
  });
  return next;
};

interface BrowserTabTransferPayload {
  url: string;
  title?: string;
  referenceHighlight?: BrowserViewReferenceHighlight;
}

interface BrowserTabTransferRequest extends BrowserTabTransferPayload {
  requestId: string;
}

interface ValidationChatMessagesUpdatedEventDetail {
  chatId: string;
  messages: ChatMessage[];
  validationByUrl?: Record<string, BrowserPageValidationRecord>;
  validationChatByUrl?: Record<string, string>;
  validationStatusByUrl?: Record<string, BrowserPageValidationStatusRecord>;
}

const VALIDATION_CHAT_MESSAGES_UPDATED_EVENT =
  "deertube:validation-chat-messages-updated";

const dispatchValidationChatMessagesUpdated = (
  detail: ValidationChatMessagesUpdatedEventDetail,
) => {
  window.dispatchEvent(
    new CustomEvent<ValidationChatMessagesUpdatedEventDetail>(
      VALIDATION_CHAT_MESSAGES_UPDATED_EVENT,
      {
        detail,
      },
    ),
  );
};

const runValidateStream = (
  input: {
    projectPath: string;
    query: string;
    answer: string;
    toolCallId?: string;
    force?: boolean;
    settings: RuntimeSettingsPayload | undefined;
    deepResearch: import("@/shared/deepresearch-config").DeepResearchConfig;
  },
  signal: AbortSignal,
  onProgressEvent?: (event: ValidateStreamProgressEvent) => void,
): Promise<ValidateExecutionResult> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let handleAbort: (() => void) | null = null;
    const cleanup = () => {
      if (handleAbort) {
        signal.removeEventListener("abort", handleAbort);
        handleAbort = null;
      }
    };
    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const subscription = trpcClient.chat.validateStream.subscribe(input, {
      onData: (event: ValidateStreamEvent) => {
        if (event.type === "result") {
          finalize(() => {
            resolve(event.payload);
            subscription.unsubscribe();
          });
          return;
        }
        onProgressEvent?.(event);
      },
      onError: (error) => {
        finalize(() => {
          reject(error);
        });
      },
      onComplete: () => {
        finalize(() => {
          reject(new Error("Validation stream ended without a result."));
        });
      },
    });
    handleAbort = () => {
      subscription.unsubscribe();
      finalize(() => {
        reject(createAbortError());
      });
    };
    if (signal.aborted) {
      handleAbort();
      return;
    }
    signal.addEventListener("abort", handleAbort, { once: true });
  });

const coerceProjectState = (state: ProjectStateInput): ProjectState => ({
  nodes: state.nodes,
  edges: state.edges,
  chat: state.chat ?? [],
  autoLayoutLocked:
    typeof state.autoLayoutLocked === "boolean" ? state.autoLayoutLocked : true,
  browserValidationByUrl: state.browserValidationByUrl ?? {},
  browserValidationChatByUrl: state.browserValidationChatByUrl ?? {},
  browserValidationStatusByUrl: state.browserValidationStatusByUrl ?? {},
});

const createEmptyProjectState = (): ProjectState => ({
  nodes: [],
  edges: [],
  chat: [],
  autoLayoutLocked: true,
  browserValidationByUrl: {},
  browserValidationChatByUrl: {},
  browserValidationStatusByUrl: {},
});

const toTimestamp = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortChatSummariesDesc = (
  chats: ProjectChatSummary[],
): ProjectChatSummary[] =>
  [...chats].sort(
    (left, right) => {
      const leftValidation = left.isValidation === true ? 1 : 0;
      const rightValidation = right.isValidation === true ? 1 : 0;
      if (leftValidation !== rightValidation) {
        return rightValidation - leftValidation;
      }
      return toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
    },
  );

interface FlowWorkspaceSession {
  slotId: string;
  chatId: string | null;
  initialState: ProjectState;
  pendingBrowserTransfer: BrowserTabTransferRequest | null;
}

const buildChatSlotId = (chatId: string): string => `chat:${chatId}`;
const buildDraftSlotId = (): string => `draft:${crypto.randomUUID()}`;

const applyRunningStatusToSummaries = (
  chats: ProjectChatSummary[],
  runningChatIds: Set<string>,
): ProjectChatSummary[] =>
  chats.map((chat) => ({
    ...chat,
    isRunning: Boolean(chat.isRunning) || runningChatIds.has(chat.id),
  }));

interface FlowWorkspaceInnerProps extends FlowWorkspaceProps {
  sessionSlotId: string;
  isActive: boolean;
  activeChatId: string | null;
  pendingBrowserTransfer: BrowserTabTransferRequest | null;
  chatSummaries: ProjectChatSummary[];
  onSwitchChat: (
    chatId: string,
    browserTransfer?: BrowserTabTransferPayload,
  ) => Promise<void>;
  onConsumePendingBrowserTransfer: (
    slotId: string,
    requestId: string,
  ) => void;
  onRenameChat: (chatId: string, title: string) => Promise<void>;
  onDeleteChat: (chatId: string) => Promise<void>;
  onCreateDraftChat: () => void;
  onPersistDraftChat: (payload: {
    firstQuestion: string;
    state: ProjectState;
    settings?: RuntimeSettingsPayload;
  }) => Promise<string | null>;
  onSavedChatUpdate: (chat: ProjectChatSummary | null) => void;
}

function FlowWorkspaceLoader(props: FlowWorkspaceProps) {
  const workspaceVisible = props.isVisible ?? true;
  const [sessions, setSessions] = useState<FlowWorkspaceSession[]>([]);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [chatSummaries, setChatSummaries] = useState<ProjectChatSummary[]>([]);
  const [runningChatIds, setRunningChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const lastPathRef = useRef<string | null>(null);
  const sessionsRef = useRef<FlowWorkspaceSession[]>([]);
  const activeSlotIdRef = useRef<string | null>(null);
  const saveEnabled = props.saveEnabled ?? true;
  const activeSession = useMemo(
    () => sessions.find((session) => session.slotId === activeSlotId) ?? null,
    [activeSlotId, sessions],
  );
  const activeChatId = activeSession?.chatId ?? null;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSlotIdRef.current = activeSlotId;
  }, [activeSlotId]);

  useEffect(() => {
    const refresh = () => {
      setRunningChatIds(listRunningChatIds(props.project.path));
    };
    refresh();
    return subscribeRunningChatJobs(refresh);
  }, [props.project.path]);

  useEffect(() => {
    let cancelled = false;
    const samePath = lastPathRef.current === props.project.path;
    const previousPath = lastPathRef.current;
    lastPathRef.current = props.project.path;
    setLoading(true);
    if (!samePath) {
      if (previousPath) {
        void trpc.browserView.closeAll.mutate();
      }
      setSessions([]);
      setActiveSlotId(null);
      setChatSummaries([]);
    }
    trpc.project.open
      .mutate({ path: props.project.path })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const resolvedChatId = result.activeChatId ?? null;
        const slotId = resolvedChatId
          ? buildChatSlotId(resolvedChatId)
          : buildDraftSlotId();
        setSessions([
          {
            slotId,
            chatId: resolvedChatId,
            initialState: coerceProjectState(result.state),
            pendingBrowserTransfer: null,
          },
        ]);
        setActiveSlotId(slotId);
        setChatSummaries(
          sortChatSummariesDesc(
            applyRunningStatusToSummaries(
              result.chats ?? [],
              listRunningChatIds(props.project.path),
            ),
          ),
        );
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        throw error;
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.initialState, props.project.path]);

  const handleSwitchChat = useCallback(
    async (
      chatId: string,
      browserTransfer?: BrowserTabTransferPayload,
    ) => {
      if (!chatId) {
        return;
      }
      if (chatId === activeChatId) {
        if (browserTransfer && activeSlotIdRef.current) {
          const activeSlot = activeSlotIdRef.current;
          setSessions((previous) =>
            previous.map((session) =>
              session.slotId === activeSlot
                ? {
                    ...session,
                    pendingBrowserTransfer: {
                      requestId: crypto.randomUUID(),
                      ...browserTransfer,
                    },
                  }
                : session,
            ),
          );
        }
        return;
      }
      const existing = sessionsRef.current.find(
        (session) => session.chatId === chatId,
      );
      if (existing) {
        if (browserTransfer) {
          setSessions((previous) =>
            previous.map((session) =>
              session.slotId === existing.slotId
                ? {
                    ...session,
                    pendingBrowserTransfer: {
                      requestId: crypto.randomUUID(),
                      ...browserTransfer,
                    },
                  }
                : session,
            ),
          );
        }
        setActiveSlotId(existing.slotId);
        return;
      }
      setLoading(true);
      try {
        const result = await trpc.project.openChat.mutate({
          path: props.project.path,
          chatId,
        });
        const slotId = buildChatSlotId(result.chatId);
        setSessions((previous) => {
          if (previous.some((session) => session.chatId === result.chatId)) {
            return previous;
          }
          return [
            ...previous,
            {
              slotId,
              chatId: result.chatId,
              initialState: coerceProjectState(result.state),
              pendingBrowserTransfer: browserTransfer
                ? {
                    requestId: crypto.randomUUID(),
                    ...browserTransfer,
                  }
                : null,
            },
          ];
        });
        setActiveSlotId(slotId);
        setChatSummaries(
          sortChatSummariesDesc(
            applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
          ),
        );
      } finally {
        setLoading(false);
      }
    },
    [activeChatId, props.project.path, runningChatIds],
  );

  const handleConsumePendingBrowserTransfer = useCallback(
    (slotId: string, requestId: string) => {
      setSessions((previous) =>
        previous.map((session) => {
          if (session.slotId !== slotId) {
            return session;
          }
          if (
            !session.pendingBrowserTransfer ||
            session.pendingBrowserTransfer.requestId !== requestId
          ) {
            return session;
          }
          return {
            ...session,
            pendingBrowserTransfer: null,
          };
        }),
      );
    },
    [],
  );

  const handleCreateDraftChat = useCallback(() => {
    const existingDraft = sessionsRef.current.find(
      (session) => session.chatId === null,
    );
    if (existingDraft) {
      setActiveSlotId(existingDraft.slotId);
      return;
    }
    const slotId = buildDraftSlotId();
    setSessions((previous) => [
      ...previous,
      {
        slotId,
        chatId: null,
        initialState: createEmptyProjectState(),
        pendingBrowserTransfer: null,
      },
    ]);
    setActiveSlotId(slotId);
  }, []);

  const handlePersistDraftChat = useCallback(
    async ({
      firstQuestion,
      state,
      settings,
    }: {
      firstQuestion: string;
      state: ProjectState;
      settings?: RuntimeSettingsPayload;
    }) => {
      if (activeSession?.chatId) {
        return activeSession.chatId;
      }
      const result = await trpc.project.createChat.mutate({
        path: props.project.path,
        firstQuestion,
        settings,
        state: {
          version: 1,
          nodes: state.nodes,
          edges: state.edges,
          chat: state.chat,
          autoLayoutLocked: state.autoLayoutLocked,
          browserValidationByUrl: state.browserValidationByUrl,
          browserValidationChatByUrl: state.browserValidationChatByUrl,
          browserValidationStatusByUrl: state.browserValidationStatusByUrl,
        },
      });
      const nextChatId = result.activeChatId ?? result.chat.id;
      const targetSlotId = activeSlotIdRef.current;
      setSessions((previous) => {
        if (!targetSlotId) {
          return previous;
        }
        return previous.map((session) =>
          session.slotId === targetSlotId
            ? { ...session, chatId: nextChatId }
            : session,
        );
      });
      setChatSummaries(
        sortChatSummariesDesc(
          applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
        ),
      );
      return nextChatId;
    },
    [activeSession, props.project.path, runningChatIds],
  );
  const handleRenameChat = useCallback(
    async (chatId: string, title: string) => {
      const result = await trpc.project.renameChat.mutate({
        path: props.project.path,
        chatId,
        title,
      });
      setChatSummaries(
        sortChatSummariesDesc(
          applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
        ),
      );
      const nextActiveChatId = result.activeChatId ?? null;
      if (!nextActiveChatId) {
        return;
      }
      const existing = sessionsRef.current.find(
        (session) => session.chatId === nextActiveChatId,
      );
      if (existing) {
        setActiveSlotId(existing.slotId);
      }
    },
    [props.project.path, runningChatIds],
  );
  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      setLoading(true);
      try {
        const result = await trpc.project.deleteChat.mutate({
          path: props.project.path,
          chatId,
        });
        const nextActiveChatId = result.activeChatId ?? null;
        const stateFromServer = coerceProjectState(result.state);
        const filtered = sessionsRef.current.filter(
          (session) => session.chatId !== chatId,
        );
        let nextSessions = filtered;
        let nextSlotId: string | null = null;
        if (!nextActiveChatId) {
          const draft = filtered.find((session) => session.chatId === null);
          if (draft) {
            nextSlotId = draft.slotId;
          } else {
            const draftSlotId = buildDraftSlotId();
            nextSessions = [
              ...filtered,
              {
                slotId: draftSlotId,
                chatId: null,
                initialState: stateFromServer,
                pendingBrowserTransfer: null,
              },
            ];
            nextSlotId = draftSlotId;
          }
        } else {
          const existing = filtered.find(
            (session) => session.chatId === nextActiveChatId,
          );
          if (existing) {
            nextSlotId = existing.slotId;
          } else {
            const slotId = buildChatSlotId(nextActiveChatId);
            nextSessions = [
              ...filtered,
              {
                slotId,
                chatId: nextActiveChatId,
                initialState: stateFromServer,
                pendingBrowserTransfer: null,
              },
            ];
            nextSlotId = slotId;
          }
        }
        setSessions(nextSessions);
        setActiveSlotId(nextSlotId);
        setChatSummaries(
          sortChatSummariesDesc(
            applyRunningStatusToSummaries(result.chats ?? [], runningChatIds),
          ),
        );
      } finally {
        setLoading(false);
      }
    },
    [props.project.path, runningChatIds],
  );

  const handleSavedChatUpdate = useCallback(
    (chat: ProjectChatSummary | null) => {
      if (!chat) {
        return;
      }
      setSessions((previous) => {
        const alreadyBound = previous.some((session) => session.chatId === chat.id);
        if (alreadyBound) {
          return previous;
        }
        const targetSlotId = activeSlotIdRef.current;
        if (!targetSlotId) {
          return previous;
        }
        const activeDraft = previous.find(
          (session) =>
            session.slotId === targetSlotId && session.chatId === null,
        );
        if (!activeDraft) {
          return previous;
        }
        return previous.map((session) =>
          session.slotId === activeDraft.slotId
            ? { ...session, chatId: chat.id }
            : session,
        );
      });
      setChatSummaries((prev) =>
        sortChatSummariesDesc([
          {
            ...chat,
            isRunning: Boolean(chat.isRunning) || runningChatIds.has(chat.id),
          },
          ...prev.filter((item) => item.id !== chat.id),
        ]),
      );
    },
    [runningChatIds],
  );

  useEffect(() => {
    setChatSummaries((prev) =>
      sortChatSummariesDesc(applyRunningStatusToSummaries(prev, runningChatIds)),
    );
  }, [runningChatIds]);

  if (loading && sessions.length === 0) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
        <div className="rounded-xl border border-border/70 bg-card/80 px-6 py-4 text-xs uppercase tracking-[0.3em] text-muted-foreground shadow-lg">
          Reloading project...
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="relative h-screen w-screen">
      {sessions.map((session) => (
        <div
          key={session.slotId}
          className={session.slotId === activeSlotId ? "absolute inset-0" : "hidden"}
        >
          <FlowWorkspaceInner
            {...props}
            sessionSlotId={session.slotId}
            isActive={workspaceVisible && session.slotId === activeSlotId}
            initialState={session.initialState}
            activeChatId={session.chatId}
            pendingBrowserTransfer={session.pendingBrowserTransfer}
            chatSummaries={chatSummaries}
            onSwitchChat={handleSwitchChat}
            onConsumePendingBrowserTransfer={handleConsumePendingBrowserTransfer}
            onRenameChat={handleRenameChat}
            onDeleteChat={handleDeleteChat}
            onCreateDraftChat={handleCreateDraftChat}
            onPersistDraftChat={handlePersistDraftChat}
            onSavedChatUpdate={handleSavedChatUpdate}
            saveEnabled={saveEnabled}
          />
        </div>
      ))}
      {loading ? (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="rounded-xl border border-border/70 bg-card/90 px-5 py-3 text-xs uppercase tracking-[0.3em] text-muted-foreground shadow-lg">
            Reloading project...
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FlowWorkspaceInner({
  project,
  sessionSlotId,
  isActive,
  initialState,
  activeChatId,
  pendingBrowserTransfer,
  chatSummaries,
  onSwitchChat,
  onConsumePendingBrowserTransfer,
  onRenameChat,
  onDeleteChat,
  onCreateDraftChat,
  onPersistDraftChat,
  onSavedChatUpdate,
  theme,
  onToggleTheme,
  onExit,
  saveEnabled = true,
}: FlowWorkspaceInnerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [sessionChatId, setSessionChatId] = useState<string | null>(activeChatId);
  const [externalPersistedChatMessages, setExternalPersistedChatMessages] =
    useState<ChatMessage[] | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(
    null,
  );
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [autoLayoutLocked, setAutoLayoutLocked] = useState(
    () => initialState.autoLayoutLocked ?? true,
  );
  const [showSupportRelations, setShowSupportRelations] = useState(true);
  const [chatScrollSignal, setChatScrollSignal] = useState(0);
  const [chatFocusSignal, setChatFocusSignal] = useState(0);
  const [layoutModel, setLayoutModel] = useState<IJsonModel>(
    () => createDefaultLayoutModel(),
  );
  const [browserTabs, setBrowserTabs] = useState<BrowserViewTabState[]>([]);
  const [browserValidationByUrl, setBrowserValidationByUrl] = useState<
    Record<string, BrowserPageValidationRecord>
  >(() => initialState.browserValidationByUrl ?? {});
  const [browserValidationChatByUrl, setBrowserValidationChatByUrl] = useState<
    Record<string, string>
  >(() => initialState.browserValidationChatByUrl ?? {});
  const [browserValidationStatusByUrl, setBrowserValidationStatusByUrl] =
    useState<Record<string, BrowserPageValidationStatusRecord>>(
      () => initialState.browserValidationStatusByUrl ?? {},
    );
  const [browserBounds, setBrowserBounds] = useState<
    Record<string, BrowserViewBounds>
  >({});
  const [browserSelection, setBrowserSelection] =
    useState<BrowserViewSelection | null>(null);
  const previousBrowserTabIdsRef = useRef<Set<string>>(new Set());
  const visibleBrowserTabsRef = useRef<Set<string>>(new Set());
  const openedBrowserTabsRef = useRef<Set<string>>(new Set());
  const browserTabsRef = useRef<BrowserViewTabState[]>([]);
  const browserBoundsRef = useRef<Record<string, BrowserViewBounds>>({});
  const browserHighlightTimersRef = useRef<Set<number>>(new Set());
  const nodesRef = useRef<FlowNode[]>(initialState.nodes ?? []);
  const edgesRef = useRef<FlowEdge[]>(initialState.edges ?? []);
  const projectTitleClickTimestampsRef = useRef<number[]>([]);
  const referenceResolveCacheRef = useRef<
    Map<string, DeepResearchResolvedReference | null>
  >(new Map());
  const browserValidationRunsRef = useRef<
    Map<string, BrowserValidationRunSession>
  >(new Map());
  const browserValidationByUrlRef = useRef<
    Record<string, BrowserPageValidationRecord>
  >(initialState.browserValidationByUrl ?? {});
  const browserValidationChatByUrlRef = useRef<Record<string, string>>(
    initialState.browserValidationChatByUrl ?? {},
  );
  const browserValidationStatusByUrlRef = useRef<
    Record<string, BrowserPageValidationStatusRecord>
  >(initialState.browserValidationStatusByUrl ?? {});
  const validationChatMessagesRef = useRef<Record<string, ChatMessage[]>>({});
  const validationMessagesByUrlRef = useRef<Record<string, ChatMessage[]>>({});
  const validationChatPersistQueueRef = useRef<Record<string, Promise<void>>>({});
  const validationChatCreationByUrlRef = useRef<Record<string, Promise<string | null>>>(
    {},
  );
  const saveTimer = useRef<number | null>(null);
  const inputZoomRef = useRef<{ viewport: Viewport; nodeId: string } | null>(null);
  const nodeZoomRef = useRef<Viewport | null>(null);
  const autoLayoutPendingRef = useRef(false);
  const autoLayoutWasRunningRef = useRef(false);
  const autoLayoutZoomingRef = useRef(false);
  const autoLayoutZoomTimeoutRef = useRef<number | null>(null);
  const autoLayoutLockEntryPendingRef = useRef(autoLayoutLocked);
  const autoLayoutLockPreviousRef = useRef(autoLayoutLocked);
  const autoLayoutLastSizesRef = useRef<
    Map<string, { width: number; height: number }> | null
  >(null);
  const autoLayoutLastCountRef = useRef<number | null>(null);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const browserHistorySessionId = useMemo(
    () => `${project.path}::${sessionSlotId}`,
    [project.path, sessionSlotId],
  );
  const getBrowserNavigationState = useCallback(
    (tabId: string) =>
      browserTabHistoryStoreApi
        .getState()
        .getNavigationState(browserHistorySessionId, tabId),
    [browserHistorySessionId],
  );
  const pushBrowserHistoryUrl = useCallback(
    (tabId: string, url: string) =>
      browserTabHistoryStoreApi
        .getState()
        .pushUrl(browserHistorySessionId, tabId, url),
    [browserHistorySessionId],
  );
  const stepBrowserHistoryBack = useCallback(
    (tabId: string) =>
      browserTabHistoryStoreApi.getState().stepBack(browserHistorySessionId, tabId),
    [browserHistorySessionId],
  );
  const stepBrowserHistoryForward = useCallback(
    (tabId: string) =>
      browserTabHistoryStoreApi
        .getState()
        .stepForward(browserHistorySessionId, tabId),
    [browserHistorySessionId],
  );
  const removeBrowserHistoryTab = useCallback(
    (tabId: string) =>
      browserTabHistoryStoreApi.getState().removeTab(browserHistorySessionId, tabId),
    [browserHistorySessionId],
  );
  const { getNode } = useReactFlow();

  const syncBrowserHistoryForUrl = useCallback(
    (tabId: string, url: string) => {
      const normalized = normalizeHttpUrl(url);
      if (!normalized) {
        return getBrowserNavigationState(tabId);
      }
      return pushBrowserHistoryUrl(tabId, normalized);
    },
    [getBrowserNavigationState, pushBrowserHistoryUrl],
  );

  const setValidationStatusForUrls = useCallback(
    ({
      urls,
      status,
      error,
      failureReason,
    }: {
      urls: (string | null | undefined)[];
      status: "running" | "complete" | "failed";
      error?: string;
      failureReason?: BrowserValidationFailureReason;
    }) => {
      const record = buildBrowserValidationStatusRecord({
        status,
        error,
        failureReason,
      });
      setBrowserValidationStatusByUrl((previous) => {
        const next = mergeBrowserValidationStatusByUrls({
          previous,
          urls,
          record,
        });
        browserValidationStatusByUrlRef.current = next;
        return next;
      });
    },
    [],
  );

  const {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    hydrated,
  } = useFlowState(initialState);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  useEffect(() => {
    setSessionChatId(activeChatId);
    setExternalPersistedChatMessages(null);
  }, [activeChatId]);
  useEffect(() => {
    const handleValidationChatMessagesUpdated = (event: Event) => {
      const typedEvent =
        event as CustomEvent<ValidationChatMessagesUpdatedEventDetail>;
      const detail = typedEvent.detail;
      if (!detail || detail.chatId !== sessionChatId) {
        return;
      }
      setExternalPersistedChatMessages(detail.messages);
      if (detail.validationByUrl) {
        setBrowserValidationByUrl((previous) => ({
          ...previous,
          ...detail.validationByUrl,
        }));
      }
      if (detail.validationChatByUrl) {
        setBrowserValidationChatByUrl((previous) => ({
          ...previous,
          ...detail.validationChatByUrl,
        }));
      }
      if (detail.validationStatusByUrl) {
        setBrowserValidationStatusByUrl((previous) => ({
          ...previous,
          ...detail.validationStatusByUrl,
        }));
      }
    };
    window.addEventListener(
      VALIDATION_CHAT_MESSAGES_UPDATED_EVENT,
      handleValidationChatMessagesUpdated as EventListener,
    );
    return () => {
      window.removeEventListener(
        VALIDATION_CHAT_MESSAGES_UPDATED_EVENT,
        handleValidationChatMessagesUpdated as EventListener,
      );
    };
  }, [sessionChatId]);
  const resolvedInitialChatMessages = useMemo(
    () => externalPersistedChatMessages ?? initialState.chat ?? [],
    [externalPersistedChatMessages, initialState.chat],
  );
  const {
    profiles,
    setProfiles,
    activeProfileId,
    setActiveProfileId,
    activeProfile,
  } = useProfileSettings(project.path);
  const { panelVisible, panelNodeId } = usePanelState(selectedId, isDragging);
  const displayEdges = useMemo(
    () =>
      showSupportRelations
        ? edges
        : edges.filter((edge) => {
            const edgeData = edge.data as { relationType?: string } | undefined;
            return edgeData?.relationType !== "support";
          }),
    [edges, showSupportRelations],
  );
  const runtimeSettings = useMemo(
    () => buildRuntimeSettings(activeProfile),
    [activeProfile],
  );
  const prefersCdpBrowser = activeProfile?.browserDisplayMode === "cdp";
  const persistDraftChatBeforeSend = useCallback(
    async (prompt: string) => {
      if (sessionChatId) {
        return;
      }
      const nextChatId = await onPersistDraftChat({
        firstQuestion: prompt,
        settings: runtimeSettings,
        state: {
          nodes,
          edges,
          chat: [],
          autoLayoutLocked,
          browserValidationByUrl,
          browserValidationChatByUrl,
          browserValidationStatusByUrl,
        },
      });
      if (nextChatId) {
        setSessionChatId(nextChatId);
      }
    },
    [
      autoLayoutLocked,
      browserValidationChatByUrl,
      browserValidationByUrl,
      browserValidationStatusByUrl,
      edges,
      nodes,
      onPersistDraftChat,
      runtimeSettings,
      sessionChatId,
    ],
  );
  const {
    historyInput,
    setHistoryInput,
    panelInput,
    setPanelInput,
    deepResearchConfig,
    setDeepResearchConfig,
    messages: chatMessages,
    busy,
    chatBusy,
    graphBusy,
    asyncTaskBusy,
    toggleValidateResponse,
    generateGraphResponse,
    retryMessage,
    handleSendFromHistory,
    handleSendFromPanel,
    stopChatGeneration,
    stopAsyncTasks,
  } = useChatActions({
    projectPath: project.path,
    chatId: sessionChatId,
    nodes,
    edges,
    setNodes,
    setEdges,
    selectedId,
    flowInstance,
    activeProfile,
    initialMessages: resolvedInitialChatMessages,
    onBeforeSendPrompt: persistDraftChatBeforeSend,
  });
  const lastFailedMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index];
      if (
        message.kind === "graph-event" ||
        message.kind === "subagent-event" ||
        message.kind === "deepsearch-event"
      ) {
        continue;
      }
      return message.status === "failed" ? message.id : null;
    }
    return null;
  }, [chatMessages]);
  const { isLayouting, handleAutoLayout } = useAutoLayout({
    flowInstance,
    nodes,
    edges,
    setNodes,
    focusNodeId: selectedId,
  });
  const { handleNodeEnter, handleNodeLeave } = usePreviewHover();
  const retryQuestion = useCallback(() => undefined, []);

  useInitialFit(flowInstance, nodes.length);

  const nodeTypes = useMemo(
    () => ({ question: QuestionNode, source: SourceNode, insight: InsightNode }),
    [],
  );

  const suspendAutoLayoutForZoom = useCallback(
    (durationMs: number) => {
      if (!autoLayoutLocked) {
        return;
      }
      autoLayoutZoomingRef.current = true;
      if (autoLayoutZoomTimeoutRef.current) {
        window.clearTimeout(autoLayoutZoomTimeoutRef.current);
      }
      autoLayoutZoomTimeoutRef.current = window.setTimeout(() => {
        autoLayoutZoomingRef.current = false;
        autoLayoutZoomTimeoutRef.current = null;
        if (!autoLayoutLocked) {
          autoLayoutPendingRef.current = false;
          return;
        }
        if (!autoLayoutPendingRef.current || isLayouting) {
          return;
        }
        autoLayoutPendingRef.current = false;
        void handleAutoLayout();
      }, durationMs);
    },
    [autoLayoutLocked, handleAutoLayout, isLayouting],
  );

  useEffect(() => {
    if (!autoLayoutLocked) {
      autoLayoutPendingRef.current = false;
      autoLayoutLastSizesRef.current = null;
      autoLayoutLastCountRef.current = null;
      autoLayoutZoomingRef.current = false;
      if (autoLayoutZoomTimeoutRef.current) {
        window.clearTimeout(autoLayoutZoomTimeoutRef.current);
        autoLayoutZoomTimeoutRef.current = null;
      }
      return;
    }
    const resolveDimension = (value: number | null | undefined) =>
      typeof value === "number" && value > 0 ? value : undefined;
    const currentSizes = new Map<string, { width: number; height: number }>();
    nodes.forEach((node) => {
      const internal = flowInstance?.getNode(node.id);
      const width =
        resolveDimension(internal?.width) ?? resolveDimension(node.width);
      const height =
        resolveDimension(internal?.height) ?? resolveDimension(node.height);
      const size = getNodeSize({
        ...node,
        width,
        height,
      });
      currentSizes.set(node.id, size);
    });

    const previousSizes = autoLayoutLastSizesRef.current;
    const previousCount = autoLayoutLastCountRef.current;
    const countChanged =
      typeof previousCount === "number" && nodes.length !== previousCount;
    let sizeChanged = false;
    if (previousSizes && previousSizes.size === currentSizes.size) {
      for (const [id, size] of currentSizes) {
        const previousSize = previousSizes.get(id);
        if (!previousSize) {
          sizeChanged = true;
          break;
        }
        if (
          previousSize.width !== size.width ||
          previousSize.height !== size.height
        ) {
          sizeChanged = true;
          break;
        }
      }
    } else if (previousSizes) {
      sizeChanged = true;
    }

    const shouldLayout = countChanged || sizeChanged;
    autoLayoutLastSizesRef.current = currentSizes;
    autoLayoutLastCountRef.current = nodes.length;

    if (!shouldLayout) {
      return;
    }
    if (autoLayoutZoomingRef.current) {
      autoLayoutPendingRef.current = true;
      return;
    }
    if (isLayouting) {
      autoLayoutPendingRef.current = true;
      return;
    }
    void handleAutoLayout();
  }, [
    autoLayoutLocked,
    flowInstance,
    handleAutoLayout,
    isLayouting,
    nodes,
    viewport.zoom,
  ]);

  useEffect(() => {
    const previous = autoLayoutLockPreviousRef.current;
    if (!previous && autoLayoutLocked) {
      autoLayoutLockEntryPendingRef.current = true;
    }
    autoLayoutLockPreviousRef.current = autoLayoutLocked;
  }, [autoLayoutLocked]);

  useEffect(() => {
    if (!autoLayoutLockEntryPendingRef.current) {
      return;
    }
    if (!autoLayoutLocked) {
      return;
    }
    if (!hydrated.current || !flowInstance || nodes.length === 0) {
      return;
    }
    if (isLayouting) {
      return;
    }
    autoLayoutLockEntryPendingRef.current = false;
    void handleAutoLayout();
  }, [autoLayoutLocked, flowInstance, handleAutoLayout, hydrated, isLayouting, nodes.length]);

  useEffect(() => {
    const wasLayouting = autoLayoutWasRunningRef.current;
    autoLayoutWasRunningRef.current = isLayouting;
    if (!wasLayouting || isLayouting) {
      return;
    }
    if (autoLayoutLockEntryPendingRef.current) {
      autoLayoutLockEntryPendingRef.current = false;
    }
    if (!autoLayoutLocked) {
      autoLayoutPendingRef.current = false;
      return;
    }
    if (!autoLayoutPendingRef.current) {
      return;
    }
    autoLayoutPendingRef.current = false;
    void handleAutoLayout();
  }, [autoLayoutLocked, handleAutoLayout, isLayouting]);
  const browserTabMap = useMemo(
    () => new Map(browserTabs.map((tab) => [tab.id, tab])),
    [browserTabs],
  );

  useEffect(() => {
    browserTabsRef.current = browserTabs;
  }, [browserTabs]);

  useEffect(() => {
    browserBoundsRef.current = browserBounds;
  }, [browserBounds]);

  useEffect(() => {
    browserValidationByUrlRef.current = browserValidationByUrl;
  }, [browserValidationByUrl]);

  useEffect(() => {
    browserValidationChatByUrlRef.current = browserValidationChatByUrl;
  }, [browserValidationChatByUrl]);

  useEffect(() => {
    browserValidationStatusByUrlRef.current = browserValidationStatusByUrl;
  }, [browserValidationStatusByUrl]);

  useEffect(() => {
    referenceResolveCacheRef.current.clear();
  }, [project.path]);

  useEffect(() => {
    const highlightTimers = browserHighlightTimersRef.current;
    const validationRuns = browserValidationRunsRef.current;
    return () => {
      validationRuns.forEach((run) => {
        run.abortController.abort();
      });
      validationRuns.clear();
      highlightTimers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      highlightTimers.clear();
      const tabs = browserTabsRef.current;
      tabs.forEach((tab) => {
        void trpc.browserView.close.mutate({ tabId: tab.id });
      });
      browserTabHistoryStoreApi.getState().clearSession(browserHistorySessionId);
      void trpc.browserView.hide.mutate();
    };
  }, [browserHistorySessionId]);

  const selectedResponseId = useMemo(() => {
    const selectedNode = nodes.find((node) => node.id === selectedId);
    if (!selectedNode || selectedNode.type !== "insight") {
      return null;
    }
    const data = selectedNode.data as InsightNodeData;
    return data.responseId ?? null;
  }, [nodes, selectedId]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );


  const handleLayoutChange = useCallback((nextModel: IJsonModel) => {
    setLayoutModel(normalizeLayoutModel(nextModel));
  }, []);

  useEffect(() => {
    const layout = layoutModel.layout as FlexLayoutNode | undefined;
    const existingIds = collectBrowserTabIds(layout);
    const visibleIds = isActive
      ? collectVisibleBrowserTabIds(layout)
      : new Set<string>();
    visibleBrowserTabsRef.current = visibleIds;
    const previousIds = previousBrowserTabIdsRef.current;
    previousIds.forEach((tabId) => {
      if (!existingIds.has(tabId)) {
        void trpc.browserView.close.mutate({ tabId });
        openedBrowserTabsRef.current.delete(tabId);
        removeBrowserHistoryTab(tabId);
      }
    });
    previousBrowserTabIdsRef.current = existingIds;
    setBrowserTabs((prev) => prev.filter((tab) => existingIds.has(tab.id)));
    setBrowserBounds((prev) => {
      const next: Record<string, BrowserViewBounds> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (existingIds.has(key)) {
          next[key] = value;
        }
      });
      return next;
    });
    if (!isActive) {
      existingIds.forEach((tabId) => {
        void trpc.browserView.hideTab.mutate({ tabId });
      });
      return;
    }
    const boundsMap = browserBoundsRef.current;
    const tabs = browserTabsRef.current;
    const tabLookup = new Map(tabs.map((tab) => [tab.id, tab]));

    existingIds.forEach((tabId) => {
      if (!visibleIds.has(tabId)) {
        void trpc.browserView.hideTab.mutate({ tabId });
      }
    });

    visibleIds.forEach((tabId) => {
      const tab = tabLookup.get(tabId);
      const bounds = boundsMap[tabId];
      if (!tab || !bounds || bounds.width <= 1 || bounds.height <= 1) {
        return;
      }
      if (!openedBrowserTabsRef.current.has(tabId)) {
        void trpc.browserView.open.mutate({
          tabId,
          url: tab.url,
          bounds,
        });
        openedBrowserTabsRef.current.add(tabId);
        return;
      }
      void trpc.browserView.updateBounds.mutate({
        tabId,
        bounds,
      });
    });
  }, [isActive, layoutModel, removeBrowserHistoryTab]);

  useEffect(() => {
    const ipc = window.ipcRenderer;
    if (!ipc) {
      return;
    }
    const handleState = (
      _event: IpcRendererEvent,
      payload: BrowserViewStatePayload,
    ) => {
      if (!payload?.tabId) {
        return;
      }
      setBrowserTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== payload.tabId) {
            return tab;
          }
          const nextUrl = payload.url ?? tab.url;
          const urlChanged = nextUrl !== tab.url;
          const navigation = syncBrowserHistoryForUrl(tab.id, nextUrl);
          return {
            ...tab,
            url: nextUrl,
            title: payload.title ?? tab.title,
            canGoBack: navigation.canGoBack,
            canGoForward: navigation.canGoForward,
            isLoading: payload.isLoading ?? tab.isLoading,
            validationStatus: urlChanged ? undefined : tab.validationStatus,
            validationError: urlChanged ? undefined : tab.validationError,
            validationFailureReason: urlChanged
              ? undefined
              : tab.validationFailureReason,
          };
        }),
      );
    };
    const handleSelection = (
      _event: IpcRendererEvent,
      payload: BrowserViewSelection,
    ) => {
      if (!payload) {
        return;
      }
      const text = payload.text?.trim();
      if (!text) {
        setBrowserSelection(null);
        return;
      }
      setBrowserSelection(payload);
    };

    ipc.on("browserview-state", handleState);
    ipc.on("browserview-selection", handleSelection);
    return () => {
      ipc.off("browserview-state", handleState);
      ipc.off("browserview-selection", handleSelection);
    };
  }, [syncBrowserHistoryForUrl]);

  const persistCurrentChatStateNow = useCallback(async () => {
    if (!saveEnabled) {
      return;
    }
    if (!sessionChatId) {
      return;
    }
    if (!hydrated.current) {
      return;
    }
    const result = await trpc.project.saveState.mutate({
      path: project.path,
      chatId: sessionChatId,
      settings: runtimeSettings,
      state: {
        nodes,
        edges,
        chat: chatMessages,
        autoLayoutLocked,
        browserValidationByUrl,
        browserValidationChatByUrl,
        browserValidationStatusByUrl,
        version: 1,
      },
    });
    onSavedChatUpdate(result.chat);
  }, [
    autoLayoutLocked,
    browserValidationByUrl,
    browserValidationChatByUrl,
    browserValidationStatusByUrl,
    chatMessages,
    edges,
    hydrated,
    nodes,
    onSavedChatUpdate,
    project.path,
    runtimeSettings,
    saveEnabled,
    sessionChatId,
  ]);

  const switchChatWithOptionalBrowserTransfer = useCallback(
    async (
      chatId: string,
      browserTransfer?: BrowserTabTransferPayload,
    ) => {
      await persistCurrentChatStateNow();
      await onSwitchChat(chatId, browserTransfer);
    },
    [onSwitchChat, persistCurrentChatStateNow],
  );

  const persistValidationChatState = useCallback(
    async ({
      chatId,
      messages,
      pageMapping,
      validationByUrl,
      validationStatusByUrl,
    }: {
      chatId: string;
      messages: ChatMessage[];
      pageMapping: Record<string, string>;
      validationByUrl: Record<string, BrowserPageValidationRecord>;
      validationStatusByUrl: Record<string, BrowserPageValidationStatusRecord>;
    }) => {
      validationChatMessagesRef.current[chatId] = messages;
      dispatchValidationChatMessagesUpdated({
        chatId,
        messages,
        validationByUrl,
        validationChatByUrl: pageMapping,
        validationStatusByUrl,
      });
      const result = await trpc.project.saveState.mutate({
        path: project.path,
        chatId,
        activate: false,
        settings: runtimeSettings,
        state: {
          version: 1,
          nodes: [],
          edges: [],
          chat: messages,
          autoLayoutLocked: true,
          browserValidationByUrl: validationByUrl,
          browserValidationChatByUrl: pageMapping,
          browserValidationStatusByUrl: validationStatusByUrl,
        },
      });
      onSavedChatUpdate(result.chat);
    },
    [onSavedChatUpdate, project.path, runtimeSettings],
  );

  const upsertValidationMessagesForUrls = useCallback(
    ({
      urls,
      messages,
    }: {
      urls: (string | null | undefined)[];
      messages: ChatMessage[];
    }) => {
      const next = { ...validationMessagesByUrlRef.current };
      const seen = new Set<string>();
      let changed = false;
      urls.forEach((url) => {
        if (!url || seen.has(url)) {
          return;
        }
        seen.add(url);
        if (next[url] === messages) {
          return;
        }
        next[url] = messages;
        changed = true;
      });
      if (!changed) {
        return;
      }
      validationMessagesByUrlRef.current = next;
    },
    [],
  );

  const buildValidationChatMappingForUrls = useCallback(
    (chatId: string, urls: (string | null | undefined)[]): Record<string, string> => {
      const mapping = Object.fromEntries(
        Object.entries(browserValidationChatByUrlRef.current).filter(
          ([, mappedChatId]) => mappedChatId === chatId,
        ),
      );
      const seen = new Set<string>();
      urls.forEach((url) => {
        if (!url || seen.has(url)) {
          return;
        }
        seen.add(url);
        mapping[url] = chatId;
      });
      return mapping;
    },
    [],
  );

  const upsertBrowserValidationChatMapping = useCallback(
    (mapping: Record<string, string>) => {
      const entries = Object.entries(mapping).filter(
        ([url, chatId]) => url.length > 0 && chatId.length > 0,
      );
      if (entries.length === 0) {
        return;
      }
      const next = { ...browserValidationChatByUrlRef.current };
      let changed = false;
      entries.forEach(([url, chatId]) => {
        if (next[url] === chatId) {
          return;
        }
        next[url] = chatId;
        changed = true;
      });
      if (!changed) {
        return;
      }
      browserValidationChatByUrlRef.current = next;
      setBrowserValidationChatByUrl((previous) => ({
        ...previous,
        ...Object.fromEntries(entries),
      }));
    },
    [],
  );

  const queueValidationChatPersist = useCallback(
    ({
      chatId,
      messages,
      pageMapping,
    }: {
      chatId: string;
      messages: ChatMessage[];
      pageMapping: Record<string, string>;
    }): Promise<void> => {
      const previous =
        validationChatPersistQueueRef.current[chatId] ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await persistValidationChatState({
            chatId,
            messages,
            pageMapping,
            validationByUrl: browserValidationByUrlRef.current,
            validationStatusByUrl: browserValidationStatusByUrlRef.current,
          });
        });
      validationChatPersistQueueRef.current[chatId] = next;
      return next;
    },
    [persistValidationChatState],
  );

  const ensureValidationChatForUrl = useCallback(
    async ({
      tabRuntimeId,
      normalizedTabUrl,
      pageTitle,
    }: {
      tabRuntimeId: string;
      normalizedTabUrl: string;
      pageTitle?: string;
    }): Promise<string | null> => {
      const existingChatId = browserValidationChatByUrlRef.current[normalizedTabUrl];
      if (existingChatId) {
        return existingChatId;
      }
      const inFlight = validationChatCreationByUrlRef.current[normalizedTabUrl];
      if (inFlight !== undefined) {
        return inFlight;
      }
      const createPromise = (async () => {
        const runningSession = browserValidationRunsRef.current.get(tabRuntimeId);
        const hasValidationContext =
          Boolean(runningSession) ||
          Boolean(browserValidationByUrlRef.current[normalizedTabUrl]) ||
          Boolean(browserValidationStatusByUrlRef.current[normalizedTabUrl]) ||
          Boolean(validationMessagesByUrlRef.current[normalizedTabUrl]);
        if (!hasValidationContext) {
          return null;
        }
        const seed = createPageValidationChatSeed({
          pageUrl: normalizedTabUrl,
          pageTitle,
        });
        const candidateMessages =
          runningSession?.messages ?? validationMessagesByUrlRef.current[normalizedTabUrl];
        const initialMessages =
          candidateMessages && candidateMessages.length > 0
            ? candidateMessages
            : runningSession
              ? [seed.requestMessage, seed.runningEventMessage]
              : [];
        const candidateUrls =
          runningSession?.pageUrls && runningSession.pageUrls.length > 0
            ? runningSession.pageUrls
            : Object.entries(validationMessagesByUrlRef.current)
                .filter(([, messages]) => messages === candidateMessages)
                .map(([url]) => url);
        const result = await trpc.project.createChat.mutate({
          path: project.path,
          firstQuestion: runningSession?.querySeed ?? seed.firstQuestion,
          settings: runtimeSettings,
          activate: false,
          state: {
            version: 1,
            nodes: [],
            edges: [],
            chat: initialMessages,
            autoLayoutLocked: true,
            browserValidationByUrl: browserValidationByUrlRef.current,
            browserValidationChatByUrl: {},
            browserValidationStatusByUrl: browserValidationStatusByUrlRef.current,
          },
        });
        const chatId = result.chat.id;
        const pageMapping = buildValidationChatMappingForUrls(chatId, [
          normalizedTabUrl,
          ...candidateUrls,
        ]);
        await queueValidationChatPersist({
          chatId,
          messages: initialMessages,
          pageMapping,
        });
        upsertBrowserValidationChatMapping(pageMapping);
        upsertValidationMessagesForUrls({
          urls: Object.keys(pageMapping),
          messages: initialMessages,
        });
        const activeRun = browserValidationRunsRef.current.get(tabRuntimeId);
        if (activeRun && activeRun.chatId === null) {
          activeRun.chatId = chatId;
          startRunningChatJob(project.path, chatId, activeRun.runId);
        }
        return chatId;
      })().finally(() => {
        delete validationChatCreationByUrlRef.current[normalizedTabUrl];
      });
      validationChatCreationByUrlRef.current[normalizedTabUrl] = createPromise;
      return createPromise;
    },
    [
      buildValidationChatMappingForUrls,
      project.path,
      queueValidationChatPersist,
      runtimeSettings,
      upsertBrowserValidationChatMapping,
      upsertValidationMessagesForUrls,
    ],
  );

  const stopPageValidationRun = useCallback((tabRuntimeId: string): boolean => {
    const running = browserValidationRunsRef.current.get(tabRuntimeId);
    if (!running) {
      logBrowserValidate("stop-miss", {
        tabRuntimeId,
      });
      return false;
    }
    logBrowserValidate("stop-hit", {
      tabRuntimeId,
      runId: running.runId,
      chatId: running.chatId,
    });
    running.abortController.abort();
    return true;
  }, []);

  const startPageValidation = useCallback(
    async ({
      tabRuntimeId,
      tab,
      normalizedTabUrl,
      captureValidationSnapshot,
      onRunning,
      onComplete,
      onFailed,
    }: {
      tabRuntimeId: string;
      tab: BrowserViewTabState;
      normalizedTabUrl: string;
      captureValidationSnapshot: () => Promise<{
        snapshot?: {
          text: string;
          url: string;
          title?: string;
        } | null;
      }>;
      onRunning: () => void | Promise<void>;
      onComplete: (result: {
        record: BrowserPageValidationRecord;
        references: DeepSearchReferencePayload[];
      }) => void | Promise<void>;
      onFailed: (result: {
        message: string;
        reason: BrowserValidationFailureReason;
      }) => void | Promise<void>;
    }) => {
      logBrowserValidate("start-request", {
        tabRuntimeId,
        url: normalizedTabUrl,
        title: tab.title,
      });
      const previousRun = browserValidationRunsRef.current.get(tabRuntimeId);
      if (previousRun) {
        logBrowserValidate("abort-previous-run", {
          tabRuntimeId,
          previousRunId: previousRun.runId,
        });
        previousRun.abortController.abort();
      }

      await onRunning();
      setValidationStatusForUrls({
        urls: [normalizedTabUrl],
        status: "running",
      });

      const seed = createPageValidationChatSeed({
        pageUrl: normalizedTabUrl,
        pageTitle: tab.title,
      });
      const mappedChatId = browserValidationChatByUrlRef.current[normalizedTabUrl] ?? null;
      const existingMessages = mappedChatId
        ? validationChatMessagesRef.current[mappedChatId] ??
          (
            await trpc.project.readChatState.mutate({
              path: project.path,
              chatId: mappedChatId,
            })
          ).state.chat ??
          []
        : [];
      const seedMessages: ChatMessage[] = [
        ...existingMessages,
        seed.requestMessage,
        seed.runningEventMessage,
      ];
      const abortController = new AbortController();
      const runId = `validate-run-${crypto.randomUUID()}`;
      const runSession: BrowserValidationRunSession = {
        runId,
        tabRuntimeId,
        chatId: mappedChatId,
        pageUrls: [normalizedTabUrl],
        pageUrl: normalizedTabUrl,
        querySeed: seed.firstQuestion,
        eventId: seed.eventId,
        toolCallId: seed.toolCallId,
        abortController,
        messages: seedMessages,
      };
      let runningMessages = seedMessages;
      let runningPersistChain: Promise<void> = Promise.resolve();
      const queueRunningValidationChatPersist = (messages: ChatMessage[]): Promise<void> => {
        runningMessages = messages;
        runSession.messages = messages;
        upsertValidationMessagesForUrls({
          urls: runSession.pageUrls,
          messages,
        });
        const activeRun = browserValidationRunsRef.current.get(tabRuntimeId);
        if (!activeRun || activeRun.runId !== runId || !activeRun.chatId) {
          return runningPersistChain;
        }
        const pageMapping = buildValidationChatMappingForUrls(
          activeRun.chatId,
          runSession.pageUrls,
        );
        runningPersistChain = queueValidationChatPersist({
          chatId: activeRun.chatId,
          messages,
          pageMapping,
        });
        return runningPersistChain;
      };
      browserValidationRunsRef.current.set(tabRuntimeId, runSession);
      void queueRunningValidationChatPersist(seedMessages);
      if (mappedChatId) {
        const initialMapping = buildValidationChatMappingForUrls(mappedChatId, [
          normalizedTabUrl,
        ]);
        upsertBrowserValidationChatMapping(initialMapping);
        startRunningChatJob(project.path, mappedChatId, runId);
      }
      let terminalStatusSettled = false;
      const settleComplete = async (result: {
        record: BrowserPageValidationRecord;
        references: DeepSearchReferencePayload[];
      }) => {
        if (terminalStatusSettled) {
          return;
        }
        terminalStatusSettled = true;
        await onComplete(result);
      };
      const settleFailed = async (message: string) => {
        if (terminalStatusSettled) {
          return;
        }
        terminalStatusSettled = true;
        const reason = resolveBrowserValidationFailureReason(message);
        setValidationStatusForUrls({
          urls: [normalizedTabUrl],
          status: "failed",
          error: message,
          failureReason: reason,
        });
        logBrowserValidate("terminal-failed", {
          tabRuntimeId,
          runId,
          message,
          reason,
        });
        await onFailed({
          message,
          reason,
        });
      };
      logBrowserValidate("run-started", {
        tabRuntimeId,
        runId,
        chatId: runSession.chatId,
        querySeed: seed.firstQuestion,
      });
      try {
        const {
          resolvedPageUrl,
          record,
          query,
          projectId,
          searchId,
          sources,
          references,
        } = await executeBrowserValidation({
          tab,
          normalizedTabUrl,
          projectPath: project.path,
          runtimeSettings,
          deepResearchConfig,
          captureValidationSnapshot,
          validateAnswer: (input, signal) =>
            runValidateStream(
              {
                ...input,
                toolCallId: seed.toolCallId,
              },
              signal ?? abortController.signal,
              (event) => {
                const activeRun = browserValidationRunsRef.current.get(tabRuntimeId);
                if (!activeRun || activeRun.runId !== runId) {
                  return;
                }
                logBrowserValidate("stream-event", {
                  tabRuntimeId,
                  runId,
                  type: event.type,
                  toolCallId: event.payload.toolCallId,
                  status:
                    event.type === "subagent-stream"
                      ? "running"
                      : event.payload.status ?? "running",
                });
                if (event.type === "subagent-stream") {
                  const toolCallId = event.payload.toolCallId;
                  const eventId = `subagent-${toolCallId}`;
                  const existingEvent = runningMessages.find(
                    (message) =>
                      message.id === eventId && message.kind === "subagent-event",
                  );
                  const subagentEvent: ChatMessage = {
                    id: eventId,
                    role: "assistant",
                    content: "",
                    createdAt:
                      existingEvent?.createdAt ?? seed.runningEventMessage.createdAt,
                    kind: "subagent-event",
                    toolName: event.payload.toolName,
                    toolInput: {
                      responseId: seed.requestMessageId,
                      toolCallId,
                    },
                    toolOutput: event.payload,
                    toolStatus: "running",
                    status: "complete",
                  };
                  void queueRunningValidationChatPersist(
                    upsertChatMessage(runningMessages, subagentEvent),
                  );
                  return;
                }
                const toolCallId = event.payload.toolCallId;
                const eventId = `deepsearch-${toolCallId}`;
                const existingEvent = runningMessages.find(
                  (message) =>
                    message.id === eventId && message.kind === "deepsearch-event",
                );
                const resolvedStatus =
                  event.payload.status === "failed"
                    ? "failed"
                    : event.payload.status === "complete" ||
                        event.payload.complete === true
                      ? "complete"
                      : "running";
                const resolvedError =
                  typeof event.payload.error === "string" &&
                  event.payload.error.trim().length > 0
                    ? event.payload.error
                    : undefined;
                const deepSearchEvent: ChatMessage = {
                  id: eventId,
                  role: "assistant",
                  content: "",
                  createdAt:
                    existingEvent?.createdAt ?? seed.runningEventMessage.createdAt,
                  kind: "deepsearch-event",
                  toolName: event.payload.toolName,
                  toolInput: {
                    responseId: seed.requestMessageId,
                    toolCallId,
                  },
                  toolOutput: event.payload,
                  toolStatus: resolvedStatus,
                  status: "complete",
                  error: resolvedError,
                };
                void queueRunningValidationChatPersist(
                  upsertChatMessage(runningMessages, deepSearchEvent),
                );
              },
            ),
          signal: abortController.signal,
        });
        const activeRun = browserValidationRunsRef.current.get(tabRuntimeId);
        if (!activeRun || activeRun.runId !== runId) {
          logBrowserValidate("run-ignored-inactive", {
            tabRuntimeId,
            runId,
          });
          return;
        }
        await runningPersistChain;
        const normalizedSources = Array.isArray(sources) ? sources : [];
        const normalizedReferences = Array.isArray(references) ? references : [];
        const completedEvent = buildCompletedValidationEvent({
          previousEvent:
            runningMessages.find(
              (message) =>
                message.id === seed.eventId && message.kind === "deepsearch-event",
            ) ?? seed.runningEventMessage,
          query,
          searchId,
          projectId,
          sources: normalizedSources,
          references: normalizedReferences,
        });
        const summaryMessage = buildPageValidationSummaryMessage({
          toolCallId: seed.toolCallId,
          query,
          references: normalizedReferences,
        });
        const completedMessages = upsertChatMessage(
          upsertChatMessage(runningMessages, completedEvent),
          summaryMessage,
        );
        runSession.pageUrls = [normalizedTabUrl, resolvedPageUrl];
        runSession.pageUrl = resolvedPageUrl;
        if (runSession.chatId) {
          const pageMapping = buildValidationChatMappingForUrls(
            runSession.chatId,
            runSession.pageUrls,
          );
          upsertBrowserValidationChatMapping(pageMapping);
        }
        await queueRunningValidationChatPersist(completedMessages);
        setValidationStatusForUrls({
          urls: [normalizedTabUrl, resolvedPageUrl],
          status: "complete",
        });
        const nextValidationByUrl = {
          ...browserValidationByUrlRef.current,
          [resolvedPageUrl]: record,
        };
        browserValidationByUrlRef.current = nextValidationByUrl;
        setBrowserValidationByUrl(nextValidationByUrl);
        const graphInsertion = buildValidationGraphInsertion({
          baseNodes: nodesRef.current,
          validation: record,
          references: normalizedReferences,
        });
        if (graphInsertion.nodes.length > 0) {
          setNodes((prev) => [...prev, ...graphInsertion.nodes]);
        }
        if (graphInsertion.edges.length > 0) {
          setEdges((prev) => [...prev, ...graphInsertion.edges]);
        }
        await settleComplete({
          record,
          references: normalizedReferences,
        });
        logBrowserValidate("terminal-complete", {
          tabRuntimeId,
          runId,
          accuracy: record.accuracy,
          sourceCount: record.sourceCount,
          referenceCount: record.referenceCount,
        });
      } catch (error) {
        const message = isAbortError(error)
          ? "Validation stopped by user."
          : error instanceof Error
            ? error.message
            : "Page validation failed";
        const activeRun = browserValidationRunsRef.current.get(tabRuntimeId);
        if (!activeRun) {
          await settleFailed(message);
          if (!isAbortError(error)) {
            throw error instanceof Error ? error : new Error(message);
          }
          return;
        }
        if (activeRun.runId !== runId) {
          logBrowserValidate("ignore-error-stale-run", {
            tabRuntimeId,
            runId,
            activeRunId: activeRun.runId,
            isAbort: isAbortError(error),
          });
          if (!isAbortError(error)) {
            throw error instanceof Error ? error : new Error(message);
          }
          return;
        }
        await runningPersistChain;
        const failedEvent = buildFailedValidationEvent({
          previousEvent:
            runningMessages.find(
              (chatMessage) =>
                chatMessage.id === seed.eventId &&
                chatMessage.kind === "deepsearch-event",
            ) ?? seed.runningEventMessage,
          query: runSession.querySeed,
          errorMessage: message,
        });
        const failedMessages = upsertChatMessage(
          runningMessages,
          failedEvent,
        );
        runSession.pageUrls = [normalizedTabUrl];
        runSession.pageUrl = normalizedTabUrl;
        if (runSession.chatId) {
          const failedMapping = buildValidationChatMappingForUrls(
            runSession.chatId,
            runSession.pageUrls,
          );
          upsertBrowserValidationChatMapping(failedMapping);
        }
        await queueRunningValidationChatPersist(failedMessages);
        await settleFailed(message);
        if (isAbortError(error)) {
          logBrowserValidate("aborted", {
            tabRuntimeId,
            runId,
          });
          return;
        }
        logBrowserValidate("failed-throw", {
          tabRuntimeId,
          runId,
          message,
        });
        throw error instanceof Error ? error : new Error(message);
      } finally {
        const activeRun = browserValidationRunsRef.current.get(tabRuntimeId);
        if (activeRun?.runId === runId && !terminalStatusSettled) {
          logBrowserValidate("terminal-missing", {
            tabRuntimeId,
            runId,
          });
          await settleFailed("Validation finished without terminal status.");
        }
        if (runSession.chatId) {
          finishRunningChatJob(project.path, runSession.chatId, runId);
        }
        if (activeRun?.runId === runId) {
          browserValidationRunsRef.current.delete(tabRuntimeId);
        }
        logBrowserValidate("run-finished", {
          tabRuntimeId,
          runId,
        });
      }
    },
    [
      buildValidationChatMappingForUrls,
      setValidationStatusForUrls,
      deepResearchConfig,
      project.path,
      queueValidationChatPersist,
      runtimeSettings,
      setEdges,
      setNodes,
      upsertBrowserValidationChatMapping,
      upsertValidationMessagesForUrls,
    ],
  );

  const handleCdpValidateRequest = useCallback(
    async (payload: CdpBrowserValidateRequestPayload) => {
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      const normalizedTabUrl = normalizeHttpUrl(payload.url);
      if (!sessionId || !normalizedTabUrl) {
        if (sessionId) {
          await trpc.cdpBrowser.setValidationState.mutate({
            sessionId,
            status: "failed",
            message: "Invalid page URL for validation.",
          });
        }
        return;
      }
      const tab: BrowserViewTabState = {
        id: `cdp:${sessionId}`,
        url: normalizedTabUrl,
        title: payload.title,
      };
      const tabRuntimeId = `cdp:${sessionId}`;
      logBrowserValidate("cdp-start-request", {
        sessionId,
        tabRuntimeId,
        url: normalizedTabUrl,
      });
      try {
        await startPageValidation({
          tabRuntimeId,
          tab,
          normalizedTabUrl,
          captureValidationSnapshot: () =>
            trpc.cdpBrowser.captureValidationSnapshot.mutate({ sessionId }),
          onRunning: async () => {
            logBrowserValidate("cdp-ui-running", {
              sessionId,
            });
            await trpc.cdpBrowser.setValidationState.mutate({
              sessionId,
              status: "running",
            });
          },
          onComplete: async ({ record }) => {
            logBrowserValidate("cdp-ui-complete", {
              sessionId,
              accuracy: record.accuracy,
            });
            const completeMessage =
              record.accuracy && record.accuracy.length > 0
                ? `Validation complete (${record.accuracy}).`
                : "Validation complete.";
            await trpc.cdpBrowser.setValidationState.mutate({
              sessionId,
              status: "complete",
              message: completeMessage,
            });
          },
          onFailed: async ({ message, reason }) => {
            logBrowserValidate("cdp-ui-failed", {
              sessionId,
              message,
              reason,
            });
            await trpc.cdpBrowser.setValidationState.mutate({
              sessionId,
              status: "failed",
              message,
            });
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Page validation failed";
        logBrowserValidate("cdp-ui-failed-catch", {
          sessionId,
          message,
        });
        await trpc.cdpBrowser.setValidationState.mutate({
          sessionId,
          status: "failed",
          message,
        });
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [startPageValidation],
  );

  const handleCdpValidateStopRequest = useCallback(
    async (payload: CdpBrowserValidateStopRequestPayload) => {
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      if (!sessionId) {
        return;
      }
      const stopped = stopPageValidationRun(`cdp:${sessionId}`);
      logBrowserValidate("cdp-stop-request", {
        sessionId,
        stopped,
      });
      if (!stopped) {
        return;
      }
      await trpc.cdpBrowser.setValidationState
        .mutate({
          sessionId,
          status: "failed",
          message: "Validation stopped by user.",
        });
    },
    [stopPageValidationRun],
  );

  const handleCdpOpenValidationChatRequest = useCallback(
    async (payload: CdpBrowserValidateRequestPayload) => {
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      const normalizedTabUrl = normalizeHttpUrl(payload.url);
      if (!sessionId || !normalizedTabUrl) {
        return;
      }
      const chatId = await ensureValidationChatForUrl({
        tabRuntimeId: `cdp:${sessionId}`,
        normalizedTabUrl,
        pageTitle: payload.title,
      });
      if (!chatId) {
        return;
      }
      await switchChatWithOptionalBrowserTransfer(chatId, {
        url: normalizedTabUrl,
        title: payload.title,
      });
    },
    [ensureValidationChatForUrl, switchChatWithOptionalBrowserTransfer],
  );

  useEffect(() => {
    const ipc = window.ipcRenderer;
    if (!ipc) {
      return;
    }
    const handleValidateRequest = (
      _event: IpcRendererEvent,
      payload: CdpBrowserValidateRequestPayload,
    ) => {
      void handleCdpValidateRequest(payload);
    };
    const handleValidateStopRequest = (
      _event: IpcRendererEvent,
      payload: CdpBrowserValidateStopRequestPayload,
    ) => {
      void handleCdpValidateStopRequest(payload);
    };
    const handleOpenValidationChatRequest = (
      _event: IpcRendererEvent,
      payload: CdpBrowserValidateRequestPayload,
    ) => {
      void handleCdpOpenValidationChatRequest(payload);
    };
    ipc.on("cdp-browser-validate-request", handleValidateRequest);
    ipc.on("cdp-browser-validate-stop-request", handleValidateStopRequest);
    ipc.on(
      "cdp-browser-open-validation-chat-request",
      handleOpenValidationChatRequest,
    );
    return () => {
      ipc.off("cdp-browser-validate-request", handleValidateRequest);
      ipc.off("cdp-browser-validate-stop-request", handleValidateStopRequest);
      ipc.off(
        "cdp-browser-open-validation-chat-request",
        handleOpenValidationChatRequest,
      );
    };
  }, [
    handleCdpOpenValidationChatRequest,
    handleCdpValidateRequest,
    handleCdpValidateStopRequest,
  ]);

  const openOrFocusTab = useCallback(
    (tabKind: "chat" | "graph") => {
      const tabId = tabKind === "chat" ? CHAT_TAB_ID : GRAPH_TAB_ID;
      const tabsetId = tabKind === "chat" ? CHAT_TABSET_ID : GRAPH_TABSET_ID;
      const targetDock =
        tabKind === "chat" ? DockLocation.LEFT : DockLocation.RIGHT;

      const jsonModel = layoutModel;
      const layout = jsonModel.layout as FlexLayoutNode | undefined;
      const model = Model.fromJson(jsonModel);

      if (hasTab(layout, tabId)) {
        model.doAction(Actions.selectTab(tabId));
        handleLayoutChange(model.toJson());
        return;
      }

      const tab: IJsonTabNode = {
        type: "tab",
        id: tabId,
        name: tabKind === "chat" ? "Chat" : "Graph",
        component: tabKind,
        enableClose: true,
      };

      if (hasTabset(layout, tabsetId)) {
        model.doAction(
          Actions.addNode(tab, tabsetId, DockLocation.CENTER, -1, true),
        );
        handleLayoutChange(model.toJson());
        return;
      }

      const fallbackTabset = findFirstTabsetId(layout);
      if (!fallbackTabset) {
        handleLayoutChange(createSingleTabLayoutModel(tabKind));
        return;
      }

      model.doAction(Actions.addNode(tab, fallbackTabset, targetDock, -1, true));
      handleLayoutChange(model.toJson());
    },
    [handleLayoutChange, layoutModel],
  );

  const selectBrowserTab = useCallback(
    (tabId: string) => {
      const jsonModel = layoutModel;
      const layout = jsonModel.layout as FlexLayoutNode | undefined;
      if (!hasTab(layout, tabId)) {
        return false;
      }
      const model = Model.fromJson(jsonModel);
      model.doAction(Actions.selectTab(tabId));
      handleLayoutChange(model.toJson());
      return true;
    },
    [handleLayoutChange, layoutModel],
  );

  const openBrowserUrl = useCallback(
    (
      rawUrl: string,
      label?: string,
      referenceHighlight?: BrowserViewReferenceHighlight,
    ): string | null => {
      const normalized = normalizeHttpUrl(rawUrl);
      if (!normalized) {
        return null;
      }
      const existing = browserTabs.find((tab) => tab.url === normalized);
      if (existing) {
        const navigation = pushBrowserHistoryUrl(existing.id, normalized);
        setBrowserTabs((prev) =>
          prev.map((tab) =>
            tab.id === existing.id
              ? {
                  ...tab,
                  referenceHighlight,
                  canGoBack: navigation.canGoBack,
                  canGoForward: navigation.canGoForward,
                }
              : tab,
          ),
        );
        selectBrowserTab(existing.id);
        return existing.id;
      }

      const tabId = `browser-${crypto.randomUUID()}`;
      const resolvedLabel = normalizeBrowserLabel(label);
      const navigation = pushBrowserHistoryUrl(tabId, normalized);
      const nextTab: BrowserViewTabState = {
        id: tabId,
        url: normalized,
        title: resolvedLabel,
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        isLoading: true,
        referenceHighlight,
      };
      setBrowserTabs((prev) => [...prev, nextTab]);

      const jsonModel = layoutModel;
      const layout = jsonModel.layout as FlexLayoutNode | undefined;
      const model = Model.fromJson(jsonModel);
      const tab: IJsonTabNode = {
        type: "tab",
        id: tabId,
        name: resolvedLabel ?? "Browser",
        component: `${BROWSER_TAB_PREFIX}${tabId}`,
        enableClose: true,
      };

      const firstBrowserTabId = browserTabs[0]?.id ?? null;
      const targetTabsetId = firstBrowserTabId
        ? findTabsetIdContainingBrowserTab(layout, firstBrowserTabId) ??
          findTabsetIdContainingGraph(layout)
        : findTabsetIdContainingGraph(layout);
      if (targetTabsetId && hasTabset(layout, targetTabsetId)) {
        model.doAction(
          Actions.addNode(tab, targetTabsetId, DockLocation.CENTER, -1, true),
        );
        handleLayoutChange(model.toJson());
        return tabId;
      }

      const fallbackTabsetId = findFirstTabsetId(layout);
      if (!fallbackTabsetId) {
        handleLayoutChange(createSingleBrowserLayoutModel(tabId, resolvedLabel));
        return tabId;
      }
      model.doAction(
        Actions.addNode(tab, fallbackTabsetId, DockLocation.CENTER, -1, true),
      );
      handleLayoutChange(model.toJson());
      return tabId;
    },
    [
      browserTabs,
      handleLayoutChange,
      layoutModel,
      pushBrowserHistoryUrl,
      selectBrowserTab,
    ],
  );

  const scheduleBrowserReferenceHighlight = useCallback(
    (
      tabId: string,
      reference: BrowserViewReferenceHighlight,
      options?: {
        attempt?: number;
        baseDelayMs?: number;
      },
    ) => {
      const attempt = options?.attempt ?? 0;
      const baseDelayMs = options?.baseDelayMs ?? 0;
      if (attempt > 8) {
        throw new Error(
          `highlightReference retry budget exceeded for tab ${tabId}`,
        );
      }
      const delay =
        baseDelayMs +
        (attempt === 0 ? 180 : Math.min(1300, 220 * (attempt + 1)));
      const timerId = window.setTimeout(() => {
        browserHighlightTimersRef.current.delete(timerId);
        void trpc.browserView.highlightReference
          .mutate({
            tabId,
            reference,
          })
          .then((result) => {
            if (!result.ok) {
              if (attempt >= 8) {
                throw new Error(
                  `highlightReference failed after retries for tab ${tabId}`,
                );
              }
              scheduleBrowserReferenceHighlight(tabId, reference, {
                attempt: attempt + 1,
                baseDelayMs,
              });
            }
          });
      }, delay);
      browserHighlightTimersRef.current.add(timerId);
    },
    [],
  );

  const scheduleBrowserReferenceHighlights = useCallback(
    (tabId: string, references: BrowserViewReferenceHighlight[]) => {
      const dedupe = new Set<string>();
      const normalized = references
        .filter((reference) => reference.text.trim().length > 0)
        .filter((reference) => {
          const key = `${reference.refId}:${reference.startLine ?? 0}:${reference.endLine ?? 0}:${reference.text.trim()}`;
          if (dedupe.has(key)) {
            return false;
          }
          dedupe.add(key);
          return true;
        })
        .slice(0, 8);
      normalized.forEach((reference, index) => {
        scheduleBrowserReferenceHighlight(
          tabId,
          {
            ...reference,
            append: index > 0,
            showMarker: reference.showMarker ?? true,
          },
          { baseDelayMs: index * 260 },
        );
      });
    },
    [scheduleBrowserReferenceHighlight],
  );

  const resolveBrowserReference = useCallback(
    async (uri: string) => {
      const normalizedUri = uri.trim();
      if (!normalizedUri) {
        return null;
      }
      const isDeertubeRef = normalizedUri.toLowerCase().startsWith("deertube://");
      if (!isDeertubeRef && !isDeepResearchRefUri(normalizedUri)) {
        return null;
      }
      const cached = referenceResolveCacheRef.current.get(normalizedUri);
      if (cached !== undefined) {
        return cached;
      }
      const result = await trpc.deepSearch.resolveReference.mutate({
        projectPath: project.path,
        uri: normalizedUri,
      });
      const reference = result.reference ?? null;
      referenceResolveCacheRef.current.set(normalizedUri, reference);
      return reference;
    },
    [project.path],
  );

  const resolveReferencePreview = useCallback(
    async (uri: string) => {
      const reference = await resolveBrowserReference(uri);
      if (!reference) {
        return null;
      }
      return {
        title: reference.title,
        url: reference.url,
        text: stripLineNumberPrefix(reference.text),
        startLine: reference.startLine,
        endLine: reference.endLine,
        mode: reference.mode,
        validationRefContent: reference.validationRefContent,
        accuracy: reference.accuracy,
        sourceAuthority: reference.sourceAuthority,
        issueReason: reference.issueReason,
        correctFact: reference.correctFact,
      };
    },
    [resolveBrowserReference],
  );

  const openCdpUrl = useCallback(
    (
      url: string,
      reference?: BrowserViewReferenceHighlight,
    ) => {
      const normalizedUrl = normalizeHttpUrl(url);
      if (!normalizedUrl) {
        console.warn(CDP_OPEN_LOG_PREFIX, "openCdpUrl:invalid-url", { url });
        return;
      }
      console.info(CDP_OPEN_LOG_PREFIX, "openCdpUrl:request", {
        url: normalizedUrl,
        hasReference: Boolean(reference),
        refId: reference?.refId ?? null,
        referenceTextLength: reference?.text.length ?? 0,
      });
      void trpc.cdpBrowser.open
        .mutate({
          url: normalizedUrl,
          reference,
        })
        .then((result) => {
          console.info(CDP_OPEN_LOG_PREFIX, "openCdpUrl:response", result);
        });
    },
    [],
  );

  const openBrowserReference = useCallback(
    (rawUrl: string, label?: string) => {
      if (prefersCdpBrowser) {
        if (isHttpUrl(rawUrl)) {
          openCdpUrl(rawUrl);
          return;
        }
        void resolveBrowserReference(rawUrl).then((reference) => {
          if (!reference) {
            return;
          }
          openCdpUrl(reference.url, {
            ...toReferenceHighlightPayload(reference),
            showMarker: false,
          });
        });
        return;
      }
      if (isHttpUrl(rawUrl)) {
        openBrowserUrl(rawUrl, label);
        return;
      }
      void resolveBrowserReference(rawUrl).then((reference) => {
        if (!reference) {
          return;
        }
        const chatReferenceHighlight: BrowserViewReferenceHighlight = {
          ...toReferenceHighlightPayload(reference),
          showMarker: false,
        };
        const tabId = openBrowserUrl(
          reference.url,
          reference.title ?? label ?? `Ref ${reference.refId}`,
          chatReferenceHighlight,
        );
        if (!tabId) {
          return;
        }
        scheduleBrowserReferenceHighlight(tabId, chatReferenceHighlight);
      });
    },
    [
      openBrowserUrl,
      openCdpUrl,
      prefersCdpBrowser,
      resolveBrowserReference,
      scheduleBrowserReferenceHighlight,
    ],
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }
    if (!pendingBrowserTransfer) {
      return;
    }
    const {
      requestId,
      url,
      title,
      referenceHighlight,
    } = pendingBrowserTransfer;
    const normalizedUrl = normalizeHttpUrl(url);
    if (!normalizedUrl) {
      onConsumePendingBrowserTransfer(sessionSlotId, requestId);
      return;
    }
    if (prefersCdpBrowser) {
      openCdpUrl(normalizedUrl, referenceHighlight);
    } else {
      const tabId = openBrowserUrl(normalizedUrl, title, referenceHighlight);
      if (tabId && referenceHighlight) {
        scheduleBrowserReferenceHighlight(tabId, referenceHighlight);
      }
    }
    onConsumePendingBrowserTransfer(sessionSlotId, requestId);
  }, [
    isActive,
    onConsumePendingBrowserTransfer,
    openBrowserUrl,
    openCdpUrl,
    pendingBrowserTransfer,
    prefersCdpBrowser,
    scheduleBrowserReferenceHighlight,
    sessionSlotId,
  ]);

  const handleBrowserBoundsChange = useCallback(
    (tabId: string, bounds: BrowserViewBounds) => {
      setBrowserBounds((prev) => ({ ...prev, [tabId]: bounds }));
      if (!isActive) {
        void trpc.browserView.hideTab.mutate({ tabId });
        return;
      }
      if (bounds.width <= 1 || bounds.height <= 1) {
        void trpc.browserView.hideTab.mutate({ tabId });
        return;
      }
      const tab = browserTabMap.get(tabId);
      if (!tab) {
        return;
      }
      if (!openedBrowserTabsRef.current.has(tabId)) {
        void trpc.browserView.open.mutate({
          tabId,
          url: tab.url,
          bounds,
        });
        openedBrowserTabsRef.current.add(tabId);
        return;
      }
      void trpc.browserView.updateBounds.mutate({
        tabId,
        bounds,
      });
    },
    [browserTabMap, isActive],
  );

  const handleBrowserBack = useCallback(
    (tabId: string) => {
      const { targetUrl, navigation } = stepBrowserHistoryBack(tabId);
      if (!targetUrl) {
        return;
      }
      setBrowserTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url: targetUrl,
                canGoBack: navigation.canGoBack,
                canGoForward: navigation.canGoForward,
                isLoading: true,
              }
            : tab,
        ),
      );
      if (!isActive) {
        return;
      }
      const bounds = browserBoundsRef.current[tabId];
      if (!bounds) {
        return;
      }
      void trpc.browserView.open.mutate({
        tabId,
        url: targetUrl,
        bounds,
      });
      openedBrowserTabsRef.current.add(tabId);
    },
    [isActive, stepBrowserHistoryBack],
  );

  const handleBrowserForward = useCallback(
    (tabId: string) => {
      const { targetUrl, navigation } = stepBrowserHistoryForward(tabId);
      if (!targetUrl) {
        return;
      }
      setBrowserTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url: targetUrl,
                canGoBack: navigation.canGoBack,
                canGoForward: navigation.canGoForward,
                isLoading: true,
              }
            : tab,
        ),
      );
      if (!isActive) {
        return;
      }
      const bounds = browserBoundsRef.current[tabId];
      if (!bounds) {
        return;
      }
      void trpc.browserView.open.mutate({
        tabId,
        url: targetUrl,
        bounds,
      });
      openedBrowserTabsRef.current.add(tabId);
    },
    [isActive, stepBrowserHistoryForward],
  );

  const handleBrowserReload = useCallback((tabId: string) => {
    void trpc.browserView.reload.mutate({ tabId });
  }, []);

  const handleBrowserOpenExternal = useCallback((url: string) => {
    if (!isHttpUrl(url)) {
      return;
    }
    void trpc.browserView.openExternal.mutate({ url });
  }, []);

  const handleBrowserOpenCdp = useCallback(
    (tabId: string, url: string) => {
      const tab = browserTabMap.get(tabId);
      openCdpUrl(url, tab?.referenceHighlight);
    },
    [browserTabMap, openCdpUrl],
  );

  const handleBrowserOpenValidationChat = useCallback(
    async (tabId: string) => {
      const tab = browserTabMap.get(tabId);
      if (!tab) {
        return;
      }
      const normalizedTabUrl = normalizeHttpUrl(tab.url);
      if (!normalizedTabUrl) {
        return;
      }
      const chatId = await ensureValidationChatForUrl({
        tabRuntimeId: tabId,
        normalizedTabUrl,
        pageTitle: tab.title,
      });
      if (!chatId) {
        return;
      }
      await switchChatWithOptionalBrowserTransfer(chatId, {
        url: normalizedTabUrl,
        title: tab.title,
        referenceHighlight: tab.referenceHighlight,
      });
      openOrFocusTab("chat");
    },
    [
      browserTabMap,
      ensureValidationChatForUrl,
      openOrFocusTab,
      switchChatWithOptionalBrowserTransfer,
    ],
  );

  const handleBrowserValidate = useCallback(
    (tabId: string) => {
      const tab = browserTabMap.get(tabId);
      if (!tab) {
        return;
      }
      const normalizedTabUrl = normalizeHttpUrl(tab.url);
      const effectiveStatus = normalizedTabUrl
        ? (browserValidationStatusByUrlRef.current[normalizedTabUrl]?.status ??
            tab.validationStatus)
        : tab.validationStatus;
      if (effectiveStatus === "running") {
        const stopped = stopPageValidationRun(tabId);
        logBrowserValidate("manual-stop", {
          tabId,
          stopped,
        });
        if (stopped) {
          setValidationStatusForUrls({
            urls: [normalizedTabUrl],
            status: "failed",
            error: "Validation stopped by user.",
            failureReason: "stopped",
          });
          setBrowserTabs((prev) =>
            updateBrowserTabValidationState({
              tabs: prev,
              tabId,
              status: "failed",
              error: "Validation stopped by user.",
              failureReason: "stopped",
            }),
          );
          return;
        }
        setValidationStatusForUrls({
          urls: [normalizedTabUrl],
          status: "failed",
          error: "Validation run is no longer active. Please retry.",
          failureReason: "failed",
        });
        setBrowserTabs((prev) =>
          updateBrowserTabValidationState({
            tabs: prev,
            tabId,
            status: "failed",
            error: "Validation run is no longer active. Please retry.",
            failureReason: "failed",
          }),
        );
        return;
      }
      if (!normalizedTabUrl) {
        return;
      }
      logBrowserValidate("manual-start", {
        tabId,
        url: normalizedTabUrl,
        title: tab.title,
      });
      void startPageValidation({
        tabRuntimeId: tabId,
        tab,
        normalizedTabUrl,
        captureValidationSnapshot: () =>
          trpc.browserView.captureValidationSnapshot.mutate({ tabId }),
        onRunning: () => {
          logBrowserValidate("ui-running", {
            tabId,
          });
          setBrowserTabs((prev) =>
            updateBrowserTabValidationState({
              tabs: prev,
              tabId,
              status: "running",
            }),
          );
        },
        onComplete: ({ record, references }) => {
          logBrowserValidate("ui-complete", {
            tabId,
            accuracy: record.accuracy,
          });
          const validationHighlights = references
            .map((reference) =>
              toReferenceHighlightFromDeepSearchReference(reference),
            )
            .filter(
              (
                reference,
              ): reference is NonNullable<typeof reference> => reference !== null,
            );
          if (validationHighlights.length > 0) {
            scheduleBrowserReferenceHighlights(tabId, validationHighlights);
          }
          const primaryValidationHighlight =
            validationHighlights[0] ?? toValidationHighlightPayload(record);
          setBrowserTabs((prev) =>
            updateBrowserTabValidationState({
              tabs: prev.map((item) =>
                item.id === tabId
                  ? {
                      ...item,
                      referenceHighlight:
                        primaryValidationHighlight ?? item.referenceHighlight,
                    }
                  : item,
              ),
              tabId,
              status: "complete",
            }),
          );
        },
        onFailed: ({ message, reason }) => {
          logBrowserValidate("ui-failed", {
            tabId,
            message,
            reason,
          });
          setBrowserTabs((prev) =>
            updateBrowserTabValidationState({
              tabs: prev,
              tabId,
              status: "failed",
              error: message,
              failureReason: reason,
            }),
          );
        },
      }).catch((error) => {
        const message =
          error instanceof Error ? error.message : "Page validation failed";
        const failureReason = resolveBrowserValidationFailureReason(message);
        logBrowserValidate("ui-failed-catch", {
          tabId,
          message,
          reason: failureReason,
        });
        setBrowserTabs((prev) =>
          updateBrowserTabValidationState({
            tabs: prev,
            tabId,
            status: "failed",
            error: message,
            failureReason,
          }),
        );
        throw error instanceof Error ? error : new Error(message);
      });
    },
    [
      browserTabMap,
      scheduleBrowserReferenceHighlights,
      setValidationStatusForUrls,
      startPageValidation,
      stopPageValidationRun,
    ],
  );

  const handleBrowserNavigate = useCallback(
    (tabId: string, url: string) => {
      const normalizedUrl = normalizeHttpUrl(url);
      if (!normalizedUrl) {
        return;
      }
      const navigation = pushBrowserHistoryUrl(tabId, normalizedUrl);
      setBrowserTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url: normalizedUrl,
                canGoBack: navigation.canGoBack,
                canGoForward: navigation.canGoForward,
                title: undefined,
                isLoading: true,
                referenceHighlight: undefined,
                validationStatus: undefined,
                validationError: undefined,
                validationFailureReason: undefined,
              }
            : tab,
        ),
      );
      if (!isActive) {
        return;
      }
      const bounds = browserBoundsRef.current[tabId];
      if (bounds) {
        void trpc.browserView.open.mutate({
          tabId,
          url: normalizedUrl,
          bounds,
        });
        openedBrowserTabsRef.current.add(tabId);
      }
    },
    [isActive, pushBrowserHistoryUrl],
  );

  const handleInsertBrowserSelection = useCallback(
    (selection: BrowserViewSelection) => {
      const text = selection.text.trim();
      if (!text) {
        return;
      }
      const title = selection.title?.trim();
      const url = selection.url?.trim();
      const header = title ? `${title}` : url;
      const sourceLine = url ? `Source: ${url}` : "";
      const quoted = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `> ${line}`)
        .join("\n");
      const payload = [header, sourceLine, quoted].filter(Boolean).join("\n");
      setHistoryInput((prev) =>
        prev.trim().length > 0 ? `${prev.trimEnd()}\n\n${payload}\n` : `${payload}\n`,
      );
      setBrowserSelection(null);
      setChatScrollSignal((prev) => prev + 1);
    },
    [setBrowserSelection, setChatScrollSignal, setHistoryInput],
  );

  useEffect(() => {
    if (!saveEnabled) {
      return;
    }
    if (!sessionChatId) {
      return;
    }
    if (!hydrated.current) {
      return;
    }
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      void trpc.project.saveState
        .mutate({
          path: project.path,
          chatId: sessionChatId,
          state: {
            nodes,
            edges,
            chat: chatMessages,
            autoLayoutLocked,
            browserValidationByUrl,
            browserValidationChatByUrl,
            browserValidationStatusByUrl,
            version: 1,
          },
        })
        .then((result) => {
          onSavedChatUpdate(result.chat);
        });
    }, 500);
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, [
    autoLayoutLocked,
    browserValidationChatByUrl,
    browserValidationByUrl,
    browserValidationStatusByUrl,
    chatMessages,
    edges,
    hydrated,
    nodes,
    onSavedChatUpdate,
    project.path,
    saveEnabled,
    sessionChatId,
  ]);

  const handleExit = useCallback(() => {
    void trpc.preview.hide.mutate();
    onExit();
  }, [onExit]);

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      openOrFocusTab("graph");
      if (!flowInstance) {
        return;
      }
      setNodes((prev) =>
        prev.map((node) => ({
          ...node,
          selected: node.id === nodeId,
        })),
      );
      const internalNode = getNode(nodeId);
      const node = internalNode ?? nodes.find((item) => item.id === nodeId) ?? null;
      if (!node) {
        return;
      }
      const position =
        "positionAbsolute" in node && node.positionAbsolute
          ? node.positionAbsolute
          : node.position;
      const width = "width" in node ? node.width ?? 0 : 0;
      const height = "height" in node ? node.height ?? 0 : 0;
      const centerX = position.x + width / 2;
      const centerY = position.y + height / 2;
      requestAnimationFrame(() => {
        suspendAutoLayoutForZoom(450);
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.05),
          duration: 400,
        });
      });
      setSelectedId(nodeId);
      setChatFocusSignal((prev) => prev + 1);
    },
    [
      flowInstance,
      getNode,
      nodes,
      openOrFocusTab,
      setNodes,
      setSelectedId,
      suspendAutoLayoutForZoom,
    ],
  );

  const handleNodeDoubleClick = useCallback(
    (_: MouseEvent, node: { id: string }) => {
      if (!flowInstance) {
        return;
      }
      if (!nodeZoomRef.current) {
        nodeZoomRef.current = flowInstance.getViewport();
      }
      const internalNode = getNode(node.id);
      const position =
        internalNode?.positionAbsolute ?? internalNode?.position ?? { x: 0, y: 0 };
      const width = internalNode?.width ?? 0;
      const height = internalNode?.height ?? 0;
      const centerX = position.x + width / 2;
      const centerY = position.y + height / 2;
      requestAnimationFrame(() => {
        suspendAutoLayoutForZoom(520);
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.6),
          duration: 450,
        });
      });
      setSelectedId(node.id);
      setChatFocusSignal((prev) => prev + 1);
    },
    [flowInstance, getNode, setSelectedId, suspendAutoLayoutForZoom],
  );
  const handleRequestClearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);
  const handleFlowInit = useCallback((instance: ReactFlowInstance) => {
    setFlowInstance(instance);
    const nextViewport = instance.getViewport();
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, []);
  const handleFlowMove = useCallback((_: unknown, nextViewport: Viewport) => {
    if (nextViewport.zoom !== viewportRef.current.zoom) {
      autoLayoutZoomingRef.current = true;
    }
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, []);
  const handleFlowMoveStart = useCallback(() => {
    setIsDragging(true);
  }, []);
  const handleFlowMoveEnd = useCallback(() => {
    setIsDragging(false);
    if (!autoLayoutZoomingRef.current) {
      return;
    }
    autoLayoutZoomingRef.current = false;
    if (autoLayoutZoomTimeoutRef.current) {
      window.clearTimeout(autoLayoutZoomTimeoutRef.current);
      autoLayoutZoomTimeoutRef.current = null;
    }
    if (!autoLayoutLocked) {
      autoLayoutPendingRef.current = false;
      return;
    }
    if (!autoLayoutPendingRef.current || isLayouting) {
      return;
    }
    autoLayoutPendingRef.current = false;
    void handleAutoLayout();
  }, [autoLayoutLocked, handleAutoLayout, isLayouting]);
  const handleFlowNodeClick = useCallback(
    (_: unknown, node: { id: string }) => {
      setSelectedId(node.id);
      setPanelInput("");
      setChatFocusSignal((prev) => prev + 1);
    },
    [setPanelInput],
  );
  const handleFlowPaneClick = useCallback(() => {
    setSelectedId(null);
    if (flowInstance && inputZoomRef.current) {
      const { viewport } = inputZoomRef.current;
      inputZoomRef.current = null;
      requestAnimationFrame(() => {
        suspendAutoLayoutForZoom(420);
        flowInstance.setViewport(viewport, { duration: 350 });
      });
    }
    if (flowInstance && nodeZoomRef.current) {
      const viewport = nodeZoomRef.current;
      nodeZoomRef.current = null;
      requestAnimationFrame(() => {
        suspendAutoLayoutForZoom(420);
        flowInstance.setViewport(viewport, { duration: 350 });
      });
    }
  }, [flowInstance, suspendAutoLayoutForZoom]);
  const handleFlowNodeDragStart = useCallback(() => {
    setIsDragging(true);
  }, []);
  const handleFlowNodeDragStop = useCallback(() => {
    setIsDragging(false);
  }, []);

  const renderPanelInput = () => {
    if (!panelNodeId || !flowInstance) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === panelNodeId);
    if (!selectedNode) {
      return null;
    }
    const internalNode = getNode(selectedNode.id);
    const position =
      internalNode?.positionAbsolute ??
      selectedNode.positionAbsolute ??
      selectedNode.position;
    const nodeWidth = internalNode?.width ?? selectedNode.width ?? 0;
    const nodeHeight = internalNode?.height ?? 0;
    const screenX = position.x * viewport.zoom + viewport.x;
    const screenY = position.y * viewport.zoom + viewport.y;
    const panelTop = screenY + nodeHeight * viewport.zoom + 10 * viewport.zoom;
    const isMicro = viewport.zoom <= 0.55;
    const isCompact = !isMicro && viewport.zoom <= 0.85;
    const minWidth = isMicro ? 160 : isCompact ? 200 : 240;
    const nodeScreenWidth = nodeWidth * viewport.zoom;
    const resolvedWidth = Math.max(nodeScreenWidth || minWidth, minWidth);
    const centerX = screenX + nodeScreenWidth / 2;
    const panelLeft = Math.max(0, centerX - resolvedWidth / 2);

    const handleInputFocusZoom = (focusInput: () => void) => {
      if (!flowInstance) {
        return;
      }
      if (!inputZoomRef.current) {
        inputZoomRef.current = { viewport: flowInstance.getViewport(), nodeId: selectedNode.id };
      }
      const centerX = position.x + nodeWidth / 2;
      const centerY = position.y + nodeHeight / 2;
      requestAnimationFrame(() => {
        suspendAutoLayoutForZoom(420);
        flowInstance.setCenter(centerX, centerY, {
          zoom: Math.max(flowInstance.getZoom(), 1.6),
          duration: 350,
        });
        focusInput();
      });
    };

    return (
      <FlowPanelInput
        visible={panelVisible}
        left={panelLeft}
        top={panelTop}
        width={resolvedWidth}
        zoom={viewport.zoom}
        prompt={panelInput}
        busy={busy}
        asyncBusy={asyncTaskBusy}
        onPromptChange={setPanelInput}
        onSend={() => {
          void handleSendFromPanel();
          setChatScrollSignal((prev) => prev + 1);
        }}
        onStop={stopChatGeneration}
        onStopAsync={stopAsyncTasks}
        onRetry={retryMessage}
        retryMessageId={lastFailedMessageId}
        onFocusZoom={handleInputFocusZoom}
      />
    );
  };

  const renderTab = (tabId: string) => {
    const browserTabId = parseBrowserTabId(tabId);
    if (browserTabId) {
      const tab = browserTabMap.get(browserTabId);
      const normalizedTabUrl = tab ? normalizeHttpUrl(tab.url) : null;
      const validation =
        normalizedTabUrl !== null
          ? browserValidationByUrl[normalizedTabUrl]
          : undefined;
      const validationChatId =
        normalizedTabUrl !== null
          ? browserValidationChatByUrl[normalizedTabUrl]
          : undefined;
      const validationStatusRecord =
        normalizedTabUrl !== null
          ? browserValidationStatusByUrl[normalizedTabUrl]
          : undefined;
      return (
        <BrowserTab
          tabId={browserTabId}
          url={tab?.url ?? ""}
          canGoBack={tab?.canGoBack}
          canGoForward={tab?.canGoForward}
          validation={validation}
          validationChatId={validationChatId}
          validationStatus={
            validationStatusRecord?.status ?? tab?.validationStatus
          }
          validationError={validationStatusRecord?.error ?? tab?.validationError}
          validationFailureReason={
            validationStatusRecord?.failureReason ?? tab?.validationFailureReason
          }
          onBoundsChange={handleBrowserBoundsChange}
          onRequestBack={handleBrowserBack}
          onRequestForward={handleBrowserForward}
          onRequestReload={handleBrowserReload}
          onRequestValidate={handleBrowserValidate}
          onRequestOpenValidationChat={handleBrowserOpenValidationChat}
          onRequestHighlightReference={(tabId, reference) => {
            setBrowserTabs((prev) =>
              prev.map((item) =>
                item.id === tabId
                  ? {
                      ...item,
                      referenceHighlight: reference,
                    }
                  : item,
              ),
            );
            scheduleBrowserReferenceHighlight(tabId, reference);
          }}
          onRequestOpenCdp={handleBrowserOpenCdp}
          onRequestOpenExternal={handleBrowserOpenExternal}
          onRequestNavigate={handleBrowserNavigate}
        />
      );
    }
    if (tabId === "chat" || tabId === CHAT_TAB_ID) {
      return (
        <ChatHistoryPanel
          developerMode={developerMode}
          messages={chatMessages}
          selectedResponseId={selectedResponseId}
          selectedNode={selectedNode}
          nodes={nodes}
          onFocusNode={handleFocusNode}
          onReferenceClick={openBrowserReference}
          onResolveReferencePreview={resolveReferencePreview}
          browserSelection={browserSelection}
          onInsertBrowserSelection={handleInsertBrowserSelection}
          scrollToBottomSignal={chatScrollSignal}
          focusSignal={chatFocusSignal}
          onRequestClearSelection={handleRequestClearSelection}
          input={historyInput}
          deepResearchConfig={deepResearchConfig}
          onDeepResearchConfigChange={setDeepResearchConfig}
          busy={chatBusy}
          asyncBusy={asyncTaskBusy}
          graphBusy={graphBusy}
          onToggleValidateResponse={toggleValidateResponse}
          onGenerateGraphResponse={generateGraphResponse}
          onInputChange={setHistoryInput}
          onSend={handleSendFromHistory}
          onStop={stopChatGeneration}
          onStopAsync={stopAsyncTasks}
          onRetry={retryMessage}
          lastFailedMessageId={lastFailedMessageId}
        />
      );
    }
    if (tabId === "graph" || tabId === GRAPH_TAB_ID) {
      return (
        <div className="relative h-full w-full">
            <ReactFlow
              nodes={nodes}
              edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            nodesDraggable={!autoLayoutLocked}
            onInit={handleFlowInit}
            onMove={handleFlowMove}
            onMoveStart={handleFlowMoveStart}
            onMoveEnd={handleFlowMoveEnd}
            onNodeClick={handleFlowNodeClick}
            selectNodesOnDrag={false}
            onPaneClick={handleFlowPaneClick}
            onNodeDragStart={handleFlowNodeDragStart}
            onNodeDragStop={handleFlowNodeDragStop}
            onNodeMouseEnter={handleNodeEnter}
            onNodeMouseLeave={handleNodeLeave}
            onNodeDoubleClick={handleNodeDoubleClick}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            className="h-full w-full"
            fitView
          >
            <Background gap={20} size={1} color="var(--flow-grid)" />
            <Panel position="top-right" className="flex items-center gap-2">
              <Button
                size="icon"
                variant="outline"
                className={`h-9 w-9 border-border/70 bg-card/80 text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground ${
                  showSupportRelations ? "border-primary/50 text-foreground" : ""
                }`}
                onClick={() => {
                  setShowSupportRelations((prev) => !prev);
                }}
                disabled={nodes.length === 0}
                aria-label={
                  showSupportRelations
                    ? "Hide support relations"
                    : "Show support relations"
                }
                aria-pressed={showSupportRelations}
                title={
                  showSupportRelations
                    ? "Hide support relations"
                    : "Show support relations"
                }
              >
                <GitBranch />
              </Button>
              {!autoLayoutLocked ? (
                <Button
                  size="icon"
                  variant="outline"
                  className="h-9 w-9 border-border/70 bg-card/80 text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
                  onClick={() => {
                    void handleAutoLayout();
                  }}
                  disabled={nodes.length === 0 || isLayouting}
                  aria-label="Run auto layout"
                  title="Run auto layout"
                >
                  <LayoutGrid />
                </Button>
              ) : null}
              <Button
                size="icon"
                variant="outline"
                className={`h-9 w-9 border-border/70 bg-card/80 text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground ${
                  autoLayoutLocked ? "border-primary/50 text-foreground" : ""
                }`}
                onClick={() => {
                  setAutoLayoutLocked((prev) => !prev);
                }}
                disabled={nodes.length === 0}
                aria-label={
                  autoLayoutLocked ? "Disable auto layout lock" : "Enable auto layout lock"
                }
                aria-pressed={autoLayoutLocked}
                title={
                  autoLayoutLocked ? "Auto layout locked" : "Auto layout unlocked"
                }
              >
                {autoLayoutLocked ? <Lock /> : <LockOpen />}
              </Button>
            </Panel>
            <Controls
              showInteractive={false}
              className="rounded-xl border border-border/70 bg-card/80 text-foreground shadow-md"
            />
            <MiniMap
              className="rounded-xl border border-border/70 bg-card/70"
              zoomable
              pannable
            />
          </ReactFlow>
          {renderPanelInput()}
        </div>
      );
    }
    return null;
  };
  const inferBrowserTransferForChat = useCallback(
    (chatId: string): BrowserTabTransferPayload | undefined => {
      const mappedUrls = Object.entries(browserValidationChatByUrl)
        .filter(([, mappedChatId]) => mappedChatId === chatId)
        .map(([url]) => url);
      if (mappedUrls.length === 0) {
        return undefined;
      }
      const selectedUrl = [...mappedUrls].sort((left, right) => {
        const leftTime = Date.parse(browserValidationByUrl[left]?.checkedAt ?? "");
        const rightTime = Date.parse(browserValidationByUrl[right]?.checkedAt ?? "");
        const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
        const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;
        return normalizedRight - normalizedLeft;
      })[0];
      const normalizedUrl = normalizeHttpUrl(selectedUrl);
      if (!normalizedUrl) {
        return undefined;
      }
      const record = browserValidationByUrl[selectedUrl];
      return {
        url: normalizedUrl,
        title: record?.title ?? record?.referenceTitle,
      };
    },
    [browserValidationByUrl, browserValidationChatByUrl],
  );

  const handleSwitchChatAction = useCallback(
    (chatId: string) => {
      void switchChatWithOptionalBrowserTransfer(
        chatId,
        inferBrowserTransferForChat(chatId),
      );
    },
    [inferBrowserTransferForChat, switchChatWithOptionalBrowserTransfer],
  );
  const handleRenameChatAction = useCallback(
    (chatId: string, title: string) => {
      void onRenameChat(chatId, title);
    },
    [onRenameChat],
  );
  const handleDeleteChatAction = useCallback(
    (chatId: string) => {
      void onDeleteChat(chatId);
    },
    [onDeleteChat],
  );

  const renderTabLabel = useCallback(
    (tabId: string) => {
      const browserTabId = parseBrowserTabId(tabId);
      if (browserTabId) {
        const tab = browserTabMap.get(browserTabId);
          const resolvedLabel = normalizeBrowserLabel(tab?.title);
          const rawLabel =
            resolvedLabel ??
            (() => {
              if (!tab?.url) {
                return "Browser";
              }
              if (!URL.canParse(tab.url)) {
                return tab.url;
              }
              return new URL(tab.url).host;
            })();
        const label = truncateLabel(rawLabel, BROWSER_TAB_MAX_LABEL_LENGTH);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {tab?.isLoading ? (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="max-w-[24ch] truncate text-sm font-medium text-foreground" title={rawLabel}>
              {label}
            </span>
          </div>
        );
      }
      if (tabId === "chat" || tabId === CHAT_TAB_ID) {
        return (
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-foreground">Chat</span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {chatMessages.length} MSG
            </span>
            <ChatTabActions
              chats={chatSummaries}
              activeChatId={sessionChatId}
              busy={busy}
              onSwitchChat={handleSwitchChatAction}
              onRenameChat={handleRenameChatAction}
              onDeleteChat={handleDeleteChatAction}
              onCreateChat={onCreateDraftChat}
            />
          </div>
        );
      }
      if (tabId === "graph" || tabId === GRAPH_TAB_ID) {
        return (
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-foreground">Graph</span>
          </div>
        );
      }
      return <span className="text-sm font-medium text-foreground">{tabId}</span>;
    },
    [
      browserTabMap,
      busy,
      chatMessages.length,
      chatSummaries,
      handleDeleteChatAction,
      handleRenameChatAction,
      handleSwitchChatAction,
      onCreateDraftChat,
      sessionChatId,
    ],
  );

  const renderTabButtons = useCallback(
    (tabId: string) => {
      const browserTabId = parseBrowserTabId(tabId);
      if (!browserTabId) {
        return null;
      }
      const tab = browserTabMap.get(browserTabId);
      const reference = tab?.referenceHighlight;
      if (!reference) {
        return null;
      }
      const stopTabHeaderEvent = (event: SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };
      return [
        <button
          key={`${browserTabId}-refocus-reference`}
          type="button"
          className="flexlayout__tab_button_trailing"
          title="Scroll and highlight reference"
          aria-label="Scroll and highlight reference"
          onMouseDown={(event) => {
            stopTabHeaderEvent(event);
          }}
          onClick={(event) => {
            stopTabHeaderEvent(event);
            selectBrowserTab(browserTabId);
            scheduleBrowserReferenceHighlight(browserTabId, reference);
          }}
        >
          <LocateFixed className="h-3.5 w-3.5" />
        </button>,
      ];
    },
    [browserTabMap, scheduleBrowserReferenceHighlight, selectBrowserTab],
  );

  const handleProjectNameClick = useCallback(() => {
    const now = Date.now();
    const windowMs = 2000;
    const requiredClicks = 5;
    const recent = projectTitleClickTimestampsRef.current.filter(
      (timestamp) => now - timestamp <= windowMs,
    );
    recent.push(now);
    projectTitleClickTimestampsRef.current = recent;
    if (recent.length >= requiredClicks) {
      setDeveloperMode((previous) => !previous);
      projectTitleClickTimestampsRef.current = [];
    }
  }, []);
  const questionActionValue = useMemo(
    () => ({ retryQuestion, busy }),
    [retryQuestion, busy],
  );
  const sourceActionValue = useMemo(
    () => ({ openReference: openBrowserReference }),
    [openBrowserReference],
  );
  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);
  const handleFocusChat = useCallback(() => {
    openOrFocusTab("chat");
  }, [openOrFocusTab]);
  const handleFocusGraph = useCallback(() => {
    openOrFocusTab("graph");
  }, [openOrFocusTab]);
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);
  const handleActiveProfileChange = useCallback((id: string) => {
    setActiveProfileId(id);
  }, [setActiveProfileId]);
  const handleProfileAdd = useCallback(() => {
    setProfiles((prev) => {
      const nextIndex = prev.length + 1;
      return [...prev, createProfileDraft(`Profile ${nextIndex}`)];
    });
  }, [setProfiles]);
  const handleProfileDelete = useCallback(
    (id: string) => {
      setProfiles((prev) => {
        const next = prev.filter((profile) => profile.id !== id);
        if (activeProfileId === id) {
          setActiveProfileId(next[0]?.id ?? null);
        }
        return next;
      });
    },
    [activeProfileId, setActiveProfileId, setProfiles],
  );
  const handleProfileChange = useCallback(
    (id: string, patch: Partial<ProviderProfile>) => {
      setProfiles((prev) =>
        prev.map((profile) =>
          profile.id === id ? { ...profile, ...patch } : profile,
        ),
      );
    },
    [setProfiles],
  );


  return (
    <QuestionActionProvider value={questionActionValue}>
      <SourceActionProvider value={sourceActionValue}>
        <div className="flex h-screen w-screen flex-col bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
          <FlowHeader
            projectName={project.name}
            projectPath={project.path}
            developerMode={developerMode}
            busy={busy}
            onProjectNameClick={handleProjectNameClick}
            onOpenSettings={handleOpenSettings}
            onFocusChat={handleFocusChat}
            onFocusGraph={handleFocusGraph}
            theme={theme}
            onToggleTheme={onToggleTheme}
            onExit={handleExit}
          />
          <div className="relative flex-1">
            <FlowFlexLayout
              model={layoutModel}
              onModelChange={handleLayoutChange}
              renderTab={renderTab}
              renderTabLabel={renderTabLabel}
              renderTabButtons={renderTabButtons}
            />
          </div>
          <SettingsPanel
            open={settingsOpen}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onClose={handleCloseSettings}
            onActiveProfileChange={handleActiveProfileChange}
            onProfileAdd={handleProfileAdd}
            onProfileDelete={handleProfileDelete}
            onProfileChange={handleProfileChange}
          />
        </div>
      </SourceActionProvider>
    </QuestionActionProvider>
  );
}

export default function FlowWorkspace(props: FlowWorkspaceProps) {
  return (
    <ReactFlowProvider>
      <FlowWorkspaceLoader {...props} />
    </ReactFlowProvider>
  );
}
