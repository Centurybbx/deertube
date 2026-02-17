import {
  finishRunningChatJob,
  startRunningChatJob,
} from "@/lib/running-chat-jobs";
import { trpcClient } from "@/lib/trpc";
import type { RuntimeSettingsPayload } from "@/lib/settings";
import type {
  ChatMessage,
  DeepSearchReferencePayload,
  DeepSearchSourcePayload,
  DeepSearchStreamPayload,
  SubagentStreamPayload,
} from "@/types/chat";
import type { DeepResearchConfig } from "@/shared/deepresearch-config";
import {
  deriveSubagentResultStatus,
  mergeDeepSearchPayload,
} from "./message-part-parsers";
import { readToolCallId } from "./tool-call-input";

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

interface RunPostAnswerValidationForResponseOptions {
  responseId: string;
  responseText: string;
  chatId: string | null;
  projectPath: string;
  deepResearchConfig: DeepResearchConfig;
  runtimeSettings: RuntimeSettingsPayload | undefined;
  queryOverride: string;
  force?: boolean;
  setAsyncSubagentEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
  onValidationRunStart?: (
    runJobId: string,
    abortController: AbortController,
    context: {
      responseId: string;
      toolCallId: string;
    },
  ) => void;
  onValidationRunFinish?: (
    runJobId: string,
    context: {
      responseId: string;
      toolCallId: string;
    },
  ) => void;
}

const VALIDATE_ASYNC_LOG_PREFIX = "[validate][chat.async]";

const logValidateAsync = (
  event: string,
  payload?: Record<string, unknown>,
): void => {
  if (payload) {
    console.log(VALIDATE_ASYNC_LOG_PREFIX, event, payload);
    return;
  }
  console.log(VALIDATE_ASYNC_LOG_PREFIX, event);
};

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

const runValidateStream = (
  input: {
    projectPath: string;
    query: string;
    answer: string;
    toolCallId?: string;
    force?: boolean;
    settings: RuntimeSettingsPayload | undefined;
    deepResearch: DeepResearchConfig;
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

const upsertMessage = (messages: ChatMessage[], nextMessage: ChatMessage) => {
  const existingIndex = messages.findIndex((item) => item.id === nextMessage.id);
  if (existingIndex < 0) {
    return [...messages, nextMessage];
  }
  return messages.map((item, index) =>
    index === existingIndex ? nextMessage : item,
  );
};

const setValidationEventRunning = ({
  responseId,
  eventId,
  toolCallId,
  query,
  setAsyncDeepSearchEventMessages,
}: {
  responseId: string;
  eventId: string;
  toolCallId: string;
  query: string;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  const startedAt = new Date().toISOString();
  setAsyncDeepSearchEventMessages((prev) => [
    ...prev,
    {
      id: eventId,
      role: "assistant",
      content: "",
      createdAt: startedAt,
      kind: "deepsearch-event",
      toolName: "validate.run",
      toolStatus: "running",
      toolInput: {
        responseId,
        toolCallId,
      },
      toolOutput: {
        toolCallId,
        toolName: "validate.run",
        mode: "validate",
        query,
        status: "running",
      } satisfies DeepSearchStreamPayload,
    },
  ]);
};

const setValidationEventResolved = ({
  eventId,
  toolCallId,
  result,
  setAsyncDeepSearchEventMessages,
}: {
  eventId: string;
  toolCallId: string;
  result: ValidateExecutionResult;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  const skipped = result.status === "skipped";
  const status = result.status === "complete" ? "complete" : "failed";
  const skippedError = skipped ? "Validation skipped by config." : undefined;

  setAsyncDeepSearchEventMessages((prev) =>
    prev.map((event) =>
      event.id !== eventId
        ? event
        : {
            ...event,
            toolStatus: status,
            toolOutput: {
              toolCallId,
              toolName: "validate.run",
              mode: "validate",
              query: result.query,
              projectId: result.projectId,
              searchId: result.searchId,
              status,
              sources: result.sources,
              references: result.references,
              error: skippedError,
              complete: true,
            } satisfies DeepSearchStreamPayload,
            error: skippedError,
          },
    ),
  );
};

const setValidationSubagentEventProgress = ({
  responseId,
  payload,
  setAsyncSubagentEventMessages,
}: {
  responseId: string;
  payload: SubagentStreamPayload;
  setAsyncSubagentEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  const eventId = `subagent-${payload.toolCallId}`;
  setAsyncSubagentEventMessages((prev) => {
    const existingEvent = prev.find((event) => event.id === eventId);
    const toolStatus =
      deriveSubagentResultStatus(payload) ??
      (existingEvent?.toolStatus ?? "running");
    return upsertMessage(prev, {
      id: eventId,
      role: "assistant",
      content: "",
      createdAt: existingEvent?.createdAt ?? new Date().toISOString(),
      kind: "subagent-event",
      toolName: payload.toolName,
      toolInput: {
        responseId,
        toolCallId: payload.toolCallId,
      },
      toolOutput: payload,
      toolStatus,
      status: "complete",
    });
  });
};

const resolveDeepSearchStatus = (
  payload: DeepSearchStreamPayload,
  eventType: ValidateStreamProgressEvent["type"],
): ChatMessage["toolStatus"] => {
  if (payload.status === "failed") {
    return "failed";
  }
  if (
    payload.status === "complete" ||
    payload.complete === true ||
    eventType === "deepsearch-done"
  ) {
    return "complete";
  }
  return "running";
};

const setValidationEventProgress = ({
  responseId,
  eventType,
  payload,
  setAsyncDeepSearchEventMessages,
}: {
  responseId: string;
  eventType: ValidateStreamProgressEvent["type"];
  payload: DeepSearchStreamPayload;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}): ChatMessage["toolStatus"] => {
  const eventId = `deepsearch-${payload.toolCallId}`;
  const resolvedStatus = resolveDeepSearchStatus(payload, eventType);
  const resolvedError =
    typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : undefined;
  setAsyncDeepSearchEventMessages((prev) => {
    const existingEvent = prev.find((event) => event.id === eventId);
    const existingPayload =
      existingEvent?.kind === "deepsearch-event" &&
      existingEvent.toolOutput &&
      typeof existingEvent.toolOutput === "object"
        ? (existingEvent.toolOutput as DeepSearchStreamPayload)
        : undefined;
    const nextPayload = existingPayload
      ? mergeDeepSearchPayload(existingPayload, payload)
      : payload;
    return upsertMessage(prev, {
      id: eventId,
      role: "assistant",
      content: "",
      createdAt: existingEvent?.createdAt ?? new Date().toISOString(),
      kind: "deepsearch-event",
      toolName: payload.toolName,
      toolInput: {
        responseId,
        toolCallId: payload.toolCallId,
      },
      toolOutput: nextPayload,
      toolStatus: resolvedStatus,
      status: "complete",
      error: resolvedError,
    });
  });
  return resolvedStatus;
};

const setSubagentStatusForToolCall = ({
  toolCallId,
  status,
  setAsyncSubagentEventMessages,
}: {
  toolCallId: string;
  status: ChatMessage["toolStatus"];
  setAsyncSubagentEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  if (status !== "complete" && status !== "failed") {
    return;
  }
  setAsyncSubagentEventMessages((prev) =>
    prev.map((event) => {
      if (event.kind !== "subagent-event") {
        return event;
      }
      const eventToolCallId = readToolCallId(event.toolInput);
      if (eventToolCallId !== toolCallId) {
        return event;
      }
      return {
        ...event,
        toolStatus: status,
      };
    }),
  );
};

const setValidationEventFailed = ({
  eventId,
  toolCallId,
  query,
  errorMessage,
  setAsyncDeepSearchEventMessages,
}: {
  eventId: string;
  toolCallId: string;
  query: string;
  errorMessage: string;
  setAsyncDeepSearchEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  setAsyncDeepSearchEventMessages((prev) =>
    prev.map((event) =>
      event.id !== eventId
        ? event
        : {
            ...event,
            toolStatus: "failed",
            error: errorMessage,
            toolOutput: {
              toolCallId,
              toolName: "validate.run",
              mode: "validate",
              query,
              status: "failed",
              error: errorMessage,
              complete: true,
            } satisfies DeepSearchStreamPayload,
          },
    ),
  );
};

export const runPostAnswerValidationForResponse = async ({
  responseId,
  responseText,
  chatId,
  projectPath,
  deepResearchConfig,
  runtimeSettings,
  queryOverride,
  force = false,
  setAsyncSubagentEventMessages,
  setAsyncDeepSearchEventMessages,
  onValidationRunStart,
  onValidationRunFinish,
}: RunPostAnswerValidationForResponseOptions): Promise<void> => {
  if (
    !force &&
    (!deepResearchConfig.enabled || !deepResearchConfig.validate.enabled)
  ) {
    logValidateAsync("skip-disabled", {
      responseId,
      chatId,
    });
    return;
  }

  const query = queryOverride.trim() || responseText.trim();
  if (!query) {
    logValidateAsync("skip-empty-query", {
      responseId,
      chatId,
    });
    return;
  }

  const toolCallId = `validate-${crypto.randomUUID()}`;
  const eventId = `deepsearch-${toolCallId}`;
  const runningJobId = `validate:${toolCallId}`;
  logValidateAsync("start", {
    chatId,
    responseId,
    toolCallId,
    runningJobId,
    force,
    queryLength: query.length,
    answerLength: responseText.length,
  });

  if (chatId) {
    startRunningChatJob(projectPath, chatId, runningJobId);
  }
  setValidationEventRunning({
    responseId,
    eventId,
    toolCallId,
    query,
    setAsyncDeepSearchEventMessages,
  });

  const abortController = new AbortController();
  onValidationRunStart?.(runningJobId, abortController, {
    responseId,
    toolCallId,
  });
  try {
    const result = await runValidateStream(
      {
        projectPath,
        query,
        answer: responseText,
        force,
        settings: runtimeSettings,
        deepResearch: deepResearchConfig,
        toolCallId,
      },
      abortController.signal,
      (event) => {
        logValidateAsync("progress", {
          runningJobId,
          type: event.type,
          toolCallId:
            event.type === "subagent-stream"
              ? event.payload.toolCallId
              : event.payload.toolCallId,
          status:
            event.type === "subagent-stream"
              ? deriveSubagentResultStatus(event.payload) ?? "running"
              : event.payload.status ?? "running",
        });
        if (event.type === "subagent-stream") {
          setValidationSubagentEventProgress({
            responseId,
            payload: event.payload,
            setAsyncSubagentEventMessages,
          });
          return;
        }
        const resolvedStatus = setValidationEventProgress({
          responseId,
          eventType: event.type,
          payload: event.payload,
          setAsyncDeepSearchEventMessages,
        });
        setSubagentStatusForToolCall({
          toolCallId: event.payload.toolCallId,
          status: resolvedStatus,
          setAsyncSubagentEventMessages,
        });
      },
    );
    setValidationEventResolved({
      eventId,
      toolCallId,
      result,
      setAsyncDeepSearchEventMessages,
    });
    logValidateAsync("done", {
      runningJobId,
      status: result.status,
      references: Array.isArray(result.references) ? result.references.length : 0,
      sources: Array.isArray(result.sources) ? result.sources.length : 0,
    });
  } catch (error) {
    if (isAbortError(error)) {
      setValidationEventFailed({
        eventId,
        toolCallId,
        query,
        errorMessage: "Validation stopped by user.",
        setAsyncDeepSearchEventMessages,
      });
      setSubagentStatusForToolCall({
        toolCallId,
        status: "failed",
        setAsyncSubagentEventMessages,
      });
      logValidateAsync("aborted", {
        runningJobId,
        toolCallId,
      });
      return;
    }
    const errorMessage =
      error instanceof Error ? error.message : "Post-answer validation failed";
    setValidationEventFailed({
      eventId,
      toolCallId,
      query,
      errorMessage,
      setAsyncDeepSearchEventMessages,
    });
    logValidateAsync("failed", {
      runningJobId,
      toolCallId,
      errorMessage,
    });
    throw error instanceof Error ? error : new Error(errorMessage);
  } finally {
    onValidationRunFinish?.(runningJobId, {
      responseId,
      toolCallId,
    });
    if (chatId) {
      finishRunningChatJob(projectPath, chatId, runningJobId);
    }
    logValidateAsync("finish", {
      runningJobId,
      chatId,
    });
  }
};
