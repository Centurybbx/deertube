import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactFlowInstance } from "reactflow";
import { trpc } from "../../lib/trpc";
import {
  finishRunningChatJob,
  startRunningChatJob,
} from "@/lib/running-chat-jobs";
import type {
  FlowEdge,
  FlowNode,
} from "../../types/flow";
import { buildRuntimeSettings, type ProviderProfile } from "../../lib/settings";
import type {
  ChatMessage,
} from "../../types/chat";
import { useChat } from "@/lib/chat/use-electron-chat";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import type { DeepResearchConfig } from "@/shared/deepresearch-config";
import { useContextBuilder } from "./useContextBuilder";
import {
  buildGraphSnapshot,
  buildNodeContext,
  buildNodeQuote,
  hasNodeQuote,
  isStartNode,
} from "./chatActions/node-context";
import {
  loadDeepResearchConfig,
  loadGraphAutoGenerationEnabled,
  saveDeepResearchConfig,
  saveGraphAutoGenerationEnabled,
} from "./chatActions/persistence";
import {
  extractUiMessageText,
  mapChatToUiMessage,
  readDeepSearchPartPayload,
  readSubagentPartPayload,
} from "./chatActions/message-events";
import { runGraphToolsForResponse } from "./chatActions/graph-tools-runner";
import { runPostAnswerValidationForResponse } from "./chatActions/post-answer-validation-runner";
import { buildDerivedMessages } from "./chatActions/derived-messages";

interface UseChatActionsOptions {
  projectPath: string;
  chatId: string | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  setEdges: (updater: (prev: FlowEdge[]) => FlowEdge[]) => void;
  selectedId: string | null;
  flowInstance: ReactFlowInstance | null;
  activeProfile: ProviderProfile | null;
  initialMessages: ChatMessage[];
  onBeforeSendPrompt?: (prompt: string) => Promise<void> | void;
}

const CHAT_ACTION_DEBUG_LOGS_ENABLED =
  import.meta.env.DEV &&
  import.meta.env.VITE_CHAT_ACTION_DEBUG_LOGS === "true";
const CHAT_STREAM_RUNNING_JOB_ID = "chat-stream";
const CHAT_VALIDATE_LOG_PREFIX = "[validate][chat.manager]";

const logChatValidateManager = (
  event: string,
  payload?: Record<string, unknown>,
) => {
  if (payload) {
    console.log(CHAT_VALIDATE_LOG_PREFIX, event, payload);
    return;
  }
  console.log(CHAT_VALIDATE_LOG_PREFIX, event);
};

export function useChatActions({
  projectPath,
  chatId,
  nodes,
  edges,
  setNodes,
  setEdges,
  selectedId,
  flowInstance,
  activeProfile,
  initialMessages,
  onBeforeSendPrompt,
}: UseChatActionsOptions) {
  const [historyInput, setHistoryInput] = useState("");
  const [panelInput, setPanelInput] = useState("");
  const [deepResearchConfig, setDeepResearchConfig] =
    useState<DeepResearchConfig>(() => loadDeepResearchConfig(projectPath));
  const [graphGenerationEnabled, setGraphGenerationEnabled] =
    useState<boolean>(() => loadGraphAutoGenerationEnabled(projectPath));
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphEventMessages, setGraphEventMessages] = useState<ChatMessage[]>(
    () => initialMessages.filter((message) => message.kind === "graph-event"),
  );
  const persistedSubagentEvents = useMemo(
    () =>
      initialMessages.filter((message) => message.kind === "subagent-event"),
    [initialMessages],
  );
  const persistedDeepSearchEvents = useMemo(
    () =>
      initialMessages.filter((message) => message.kind === "deepsearch-event"),
    [initialMessages],
  );
  const [asyncSubagentEventMessages, setAsyncSubagentEventMessages] =
    useState<ChatMessage[]>([]);
  const [asyncDeepSearchEventMessages, setAsyncDeepSearchEventMessages] =
    useState<ChatMessage[]>([]);
  const loggedGraphEventsRef = useRef<Map<string, string>>(new Map());
  const loggedStreamPartsRef = useRef<Map<string, string>>(new Map());
  const fallbackCreatedAtByIdRef = useRef<Map<string, string>>(new Map());
  const asyncValidationAbortControllersRef = useRef<
    Map<string, AbortController>
  >(new Map());
  const lastSubmittedPromptRef = useRef("");
  const mountedRef = useRef(true);
  const [asyncValidationBusy, setAsyncValidationBusy] = useState(false);

  const markAsyncValidationBusy = useCallback(() => {
    setAsyncValidationBusy(
      asyncValidationAbortControllersRef.current.size > 0,
    );
  }, []);

  const handleValidationRunStart = useCallback(
    (runJobId: string, abortController: AbortController) => {
      asyncValidationAbortControllersRef.current.set(runJobId, abortController);
      logChatValidateManager("run-start", {
        chatId,
        runJobId,
        activeRuns: asyncValidationAbortControllersRef.current.size,
      });
      markAsyncValidationBusy();
    },
    [chatId, markAsyncValidationBusy],
  );

  const handleValidationRunFinish = useCallback(
    (runJobId: string) => {
      asyncValidationAbortControllersRef.current.delete(runJobId);
      logChatValidateManager("run-finish", {
        chatId,
        runJobId,
        activeRuns: asyncValidationAbortControllersRef.current.size,
      });
      markAsyncValidationBusy();
    },
    [chatId, markAsyncValidationBusy],
  );

  const stopAsyncValidationTasks = useCallback(() => {
    const activeRuns = asyncValidationAbortControllersRef.current.size;
    logChatValidateManager("manual-stop-all", {
      chatId,
      activeRuns,
    });
    asyncValidationAbortControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    asyncValidationAbortControllersRef.current.clear();
    markAsyncValidationBusy();
  }, [chatId, markAsyncValidationBusy]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      asyncValidationAbortControllersRef.current.forEach((controller) => {
        controller.abort();
      });
      asyncValidationAbortControllersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    setDeepResearchConfig(loadDeepResearchConfig(projectPath));
    setGraphGenerationEnabled(loadGraphAutoGenerationEnabled(projectPath));
  }, [projectPath]);

  useEffect(() => {
    saveDeepResearchConfig(projectPath, deepResearchConfig);
  }, [deepResearchConfig, projectPath]);

  useEffect(() => {
    saveGraphAutoGenerationEnabled(projectPath, graphGenerationEnabled);
  }, [graphGenerationEnabled, projectPath]);

  useEffect(() => {
    if (!CHAT_ACTION_DEBUG_LOGS_ENABLED) {
      return;
    }
    graphEventMessages.forEach((event) => {
      if (event.kind !== "graph-event") {
        return;
      }
      const signature = JSON.stringify({
        content: event.content,
        toolStatus: event.toolStatus,
        toolInput: event.toolInput,
        toolOutput: event.toolOutput,
        error: event.error,
      });
      const previous = loggedGraphEventsRef.current.get(event.id);
      if (previous === signature) {
        return;
      }
      loggedGraphEventsRef.current.set(event.id, signature);
      console.log("[graph-subagent]", event);
    });
  }, [graphEventMessages]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const runtimeSettings = useMemo(
    () => buildRuntimeSettings(activeProfile),
    [activeProfile],
  );
  const selectedNodeForContext = useMemo(
    () => (isStartNode(selectedNode) ? null : selectedNode),
    [selectedNode],
  );
  const selectedNodeSummary = useMemo(
    () => buildNodeContext(selectedNodeForContext) || undefined,
    [selectedNodeForContext],
  );
  const { buildContextSummary } = useContextBuilder(nodes, edges);
  const selectedPathSummary = useMemo(() => {
    if (!selectedId) {
      return undefined;
    }
    const summary = buildContextSummary(selectedId).trim();
    return summary.length > 0 ? summary : undefined;
  }, [buildContextSummary, selectedId]);
  const selectedNodeForQuote = useMemo(
    () =>
      selectedId
        ? (nodes.find((node) => node.id === selectedId) ?? null)
        : null,
    [nodes, selectedId],
  );

  const initialUiMessages = useMemo(
    () =>
      initialMessages
        .filter(
          (message) =>
            message.kind !== "graph-event" &&
            message.kind !== "subagent-event" &&
            message.kind !== "deepsearch-event",
        )
        .map(mapChatToUiMessage),
    [initialMessages],
  );

  const runGraphTools = useCallback(
    async (responseId: string, responseText: string) => {
      const graphSnapshot = buildGraphSnapshot(nodes, edges);
      await runGraphToolsForResponse({
        responseId,
        responseText,
        chatId,
        projectPath,
        selectedId,
        selectedNodeSummary,
        graphSnapshot,
        nodes,
        edges,
        runtimeSettings,
        flowInstance,
        setGraphBusy,
        setNodes,
        setEdges,
        setGraphEventMessages,
        runGraphMutation: (input) => trpc.graph.run.mutate(input),
      });
    },
    [
      chatId,
      edges,
      flowInstance,
      nodes,
      projectPath,
      runtimeSettings,
      selectedId,
      selectedNodeSummary,
      setEdges,
      setNodes,
    ],
  );

  const runPostAnswerValidation = useCallback(
    async (
      responseId: string,
      responseText: string,
      options?: {
        force?: boolean;
        queryOverride?: string;
      },
    ) => {
      await runPostAnswerValidationForResponse({
        responseId,
        responseText,
        chatId,
        projectPath,
        deepResearchConfig,
        runtimeSettings,
        queryOverride: options?.queryOverride ?? lastSubmittedPromptRef.current,
        force: options?.force ?? false,
        isMounted: () => mountedRef.current,
        setAsyncSubagentEventMessages,
        setAsyncDeepSearchEventMessages,
        onValidationRunStart: handleValidationRunStart,
        onValidationRunFinish: handleValidationRunFinish,
      });
    },
    [
      chatId,
      deepResearchConfig,
      handleValidationRunFinish,
      handleValidationRunStart,
      projectPath,
      runtimeSettings,
    ],
  );

  const { messages, sendMessage, regenerate, status, error, stop } =
    useChat<DeertubeUIMessage>({
      messages: initialUiMessages,
      context: {
        projectPath,
        selectedNodeSummary,
        selectedPathSummary,
        deepResearch: deepResearchConfig,
        settings: runtimeSettings,
      },
      onFinish: ({ message }: { message?: DeertubeUIMessage }) => {
        if (!message || message.role !== "assistant") {
          return;
        }
        const text = extractUiMessageText(message);
        if (!text.trim()) {
          return;
        }
        void runPostAnswerValidation(message.id, text);
        if (!graphGenerationEnabled) {
          return;
        }
        void runGraphTools(message.id, text);
      },
    });

  const latestAssistantValidationTarget = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") {
        continue;
      }
      const responseText = extractUiMessageText(message).trim();
      if (!responseText) {
        continue;
      }
      return {
        responseId: message.id,
        responseText,
      };
    }
    return null;
  }, [messages]);

  const latestUserValidationQuery = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "user") {
        continue;
      }
      if (!("content" in message) || typeof message.content !== "string") {
        continue;
      }
      const query = message.content.trim();
      if (query.length > 0) {
        return query;
      }
    }
    return lastSubmittedPromptRef.current.trim();
  }, [messages]);

  const canValidateCurrentChat = latestAssistantValidationTarget !== null;

  const validateCurrentChat = useCallback(() => {
    const target = latestAssistantValidationTarget;
    if (!target) {
      logChatValidateManager("manual-skip-no-assistant", {
        chatId,
      });
      return;
    }
    const queryOverride =
      latestUserValidationQuery.trim() || target.responseText.trim();
    logChatValidateManager("manual-start", {
      chatId,
      responseId: target.responseId,
      queryLength: queryOverride.length,
      answerLength: target.responseText.length,
    });
    void runPostAnswerValidation(target.responseId, target.responseText, {
      force: true,
      queryOverride,
    });
  }, [
    chatId,
    latestAssistantValidationTarget,
    latestUserValidationQuery,
    runPostAnswerValidation,
  ]);
  useEffect(() => {
    if (!chatId) {
      return;
    }
    const isStreaming = status === "streaming" || status === "submitted";
    if (isStreaming) {
      startRunningChatJob(projectPath, chatId, CHAT_STREAM_RUNNING_JOB_ID);
    } else {
      finishRunningChatJob(projectPath, chatId, CHAT_STREAM_RUNNING_JOB_ID);
    }
    return () => {
      finishRunningChatJob(projectPath, chatId, CHAT_STREAM_RUNNING_JOB_ID);
    };
  }, [chatId, projectPath, status]);
  useEffect(() => {
    if (!CHAT_ACTION_DEBUG_LOGS_ENABLED) {
      return;
    }
    messages.forEach((message) => {
      if (!Array.isArray(message.parts)) {
        return;
      }
      message.parts.forEach((part) => {
        const subagentPayload = readSubagentPartPayload(part);
        const deepSearchPart = subagentPayload
          ? null
          : readDeepSearchPartPayload(part);
        const deepSearchPayload = deepSearchPart?.payload;
        const payload = subagentPayload ?? deepSearchPayload;
        if (!payload) {
          return;
        }
        const partType = subagentPayload ? "data-subagent-stream" : part.type;
        const key = `${message.id}-${partType}-${payload.toolCallId}`;
        const signature = JSON.stringify(payload);
        const previous = loggedStreamPartsRef.current.get(key);
        if (previous === signature) {
          return;
        }
        loggedStreamPartsRef.current.set(key, signature);
        if (subagentPayload) {
          console.log("[ui.subagent.stream]", {
            toolCallId: subagentPayload.toolCallId,
            toolName: subagentPayload.toolName,
            messages: subagentPayload.messages.length,
          });
        } else {
          if (!deepSearchPayload) {
            return;
          }
          console.log("[ui.deepsearch.stream]", {
            toolCallId: deepSearchPayload.toolCallId,
            toolName: deepSearchPayload.toolName,
            status: deepSearchPayload.status,
            query: deepSearchPayload.query,
            sources: deepSearchPayload.sources?.length ?? 0,
            conclusionLength: deepSearchPayload.conclusion?.length ?? 0,
            error: deepSearchPayload.error,
          });
        }
      });
    });
  }, [messages]);

  const derivedMessages = useMemo(() => {
    return buildDerivedMessages({
      messages,
      status,
      error,
      fallbackCreatedAtById: fallbackCreatedAtByIdRef.current,
      graphEventMessages,
      asyncSubagentEventMessages,
      asyncDeepSearchEventMessages,
      persistedSubagentEvents,
      persistedDeepSearchEvents,
    });
  }, [
    messages,
    status,
    error,
    graphEventMessages,
    asyncSubagentEventMessages,
    asyncDeepSearchEventMessages,
    persistedSubagentEvents,
    persistedDeepSearchEvents,
  ]);

  const sendPrompt = useCallback(
    async (rawPrompt: string, reset: () => void) => {
      if (!rawPrompt.trim()) {
        return;
      }
      const prompt = rawPrompt.trim();
      await onBeforeSendPrompt?.(prompt);
      const quotePrefix =
        selectedNodeForQuote && !hasNodeQuote(prompt)
          ? `${buildNodeQuote(selectedNodeForQuote)} `
          : "";
      const finalPrompt = `${quotePrefix}${prompt}`;
      lastSubmittedPromptRef.current = prompt;
      reset();
      if (status === "streaming" || status === "submitted") {
        void stop();
      }
      void sendMessage({ text: finalPrompt });
    },
    [onBeforeSendPrompt, selectedNodeForQuote, sendMessage, status, stop],
  );

  const retryMessage = useCallback(
    (_messageId: string) => {
      void regenerate();
    },
    [regenerate],
  );

  const handleSendFromHistory = useCallback(() => {
    void sendPrompt(historyInput, () => setHistoryInput(""));
  }, [historyInput, sendPrompt]);

  const handleSendFromPanel = useCallback(() => {
    void sendPrompt(panelInput, () => setPanelInput(""));
  }, [panelInput, sendPrompt]);

  const stopChatGeneration = useCallback(() => {
    void stop();
  }, [stop]);

  const busy = status === "streaming" || status === "submitted";

  return {
    historyInput,
    setHistoryInput,
    panelInput,
    setPanelInput,
    deepResearchConfig,
    setDeepResearchConfig,
    graphGenerationEnabled,
    setGraphGenerationEnabled,
    busy,
    chatBusy: busy,
    graphBusy,
    asyncTaskBusy: asyncValidationBusy,
    canValidateCurrentChat,
    validateCurrentChat,
    handleSendFromHistory,
    handleSendFromPanel,
    stopChatGeneration,
    stopAsyncTasks: stopAsyncValidationTasks,
    retryMessage,
    selectedNode,
    messages: derivedMessages,
  };
}
