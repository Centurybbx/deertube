import type {
  ChatMessage,
  DeepSearchStreamPayload,
  SubagentStreamPayload,
} from "@/types/chat";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import { readToolCallId } from "./tool-call-input";
import {
  deriveDeepSearchResultStatus,
  deriveSubagentResultStatus,
  mergeDeepSearchPayload,
  readDeepSearchPartPayload,
  readSubagentPartPayload,
  resolveToolStatusByChatState,
} from "./message-part-parsers";

const isStreamingStatus = (status: string): boolean =>
  status === "streaming" || status === "submitted";

const getLatestAssistantMessageId = (
  messages: DeertubeUIMessage[],
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message.id;
    }
  }
  return null;
};

const readMessageCreatedAt = (message: DeertubeUIMessage): string => {
  if ("createdAt" in message && message.createdAt) {
    return message.createdAt instanceof Date
      ? message.createdAt.toISOString()
      : String(message.createdAt);
  }
  return new Date().toISOString();
};

const isDeepSearchDone = (
  payload: DeepSearchStreamPayload,
  doneByPartType: boolean,
): boolean => {
  if (doneByPartType) {
    return true;
  }
  return (
    payload.complete === true ||
    payload.status === "complete" ||
    payload.status === "failed" ||
    payload.status === "skipped"
  );
};

interface SubagentAccumulator {
  payload: SubagentStreamPayload;
  parentMessageId: string;
  createdAt: string;
}

export const buildSubagentEvents = (
  messages: DeertubeUIMessage[],
  status: string,
  deepSearchStatusByToolCall: Map<string, ChatMessage["toolStatus"]>,
): ChatMessage[] => {
  const byToolCall = new Map<string, SubagentAccumulator>();
  const isStreaming = isStreamingStatus(status);
  const activeAssistantMessageId = isStreaming
    ? getLatestAssistantMessageId(messages)
    : null;

  messages.forEach((message) => {
    if (!Array.isArray(message.parts)) {
      return;
    }
    const createdAt = readMessageCreatedAt(message);
    message.parts.forEach((part) => {
      const payload = readSubagentPartPayload(part);
      if (!payload) {
        return;
      }
      byToolCall.set(payload.toolCallId, {
        payload,
        parentMessageId: message.id,
        createdAt,
      });
    });
  });

  return Array.from(byToolCall.values()).map(
    ({ payload, parentMessageId, createdAt }) => {
      const resultStatusFromDeepSearch = deepSearchStatusByToolCall.get(
        payload.toolCallId,
      );
      const resultStatus =
        resultStatusFromDeepSearch ?? deriveSubagentResultStatus(payload);
      const toolStatus = resolveToolStatusByChatState({
        resultStatus,
        isActiveAssistantMessage: parentMessageId === activeAssistantMessageId,
        isStreaming,
      });
      return {
        id: `subagent-${payload.toolCallId}`,
        role: "assistant",
        content: "",
        createdAt,
        kind: "subagent-event",
        toolName: payload.toolName,
        toolInput: {
          responseId: parentMessageId,
          toolCallId: payload.toolCallId,
        },
        toolOutput: payload,
        toolStatus,
      };
    },
  );
};

interface DeepSearchAccumulator {
  payload: DeepSearchStreamPayload;
  parentMessageId: string;
  createdAt: string;
  done: boolean;
}

const upsertDeepSearchAccumulator = ({
  accumulator,
  message,
  partPayload,
}: {
  accumulator: Map<string, DeepSearchAccumulator>;
  message: DeertubeUIMessage;
  partPayload: { payload: DeepSearchStreamPayload; done: boolean };
}) => {
  const { payload, done: doneByPartType } = partPayload;
  const createdAt = readMessageCreatedAt(message);
  const done = isDeepSearchDone(payload, doneByPartType);
  const existing = accumulator.get(payload.toolCallId);

  if (!existing) {
    accumulator.set(payload.toolCallId, {
      payload,
      parentMessageId: message.id,
      createdAt,
      done,
    });
    return;
  }

  const mergedPayload = mergeDeepSearchPayload(existing.payload, payload);
  const mergedDone =
    existing.done || done || isDeepSearchDone(mergedPayload, false);

  accumulator.set(payload.toolCallId, {
    payload: mergedPayload,
    parentMessageId: message.id,
    createdAt,
    done: mergedDone,
  });
};

export const buildDeepSearchEvents = (
  messages: DeertubeUIMessage[],
  status: string,
): ChatMessage[] => {
  const byToolCall = new Map<string, DeepSearchAccumulator>();
  const isStreaming = isStreamingStatus(status);
  const activeAssistantMessageId = isStreaming
    ? getLatestAssistantMessageId(messages)
    : null;

  messages.forEach((message) => {
    if (!Array.isArray(message.parts)) {
      return;
    }
    message.parts.forEach((part) => {
      const deepSearchPart = readDeepSearchPartPayload(part);
      if (!deepSearchPart) {
        return;
      }
      upsertDeepSearchAccumulator({
        accumulator: byToolCall,
        message,
        partPayload: deepSearchPart,
      });
    });
  });

  return Array.from(byToolCall.values()).map(
    ({ payload, parentMessageId, createdAt, done }) => {
      const resultStatus = deriveDeepSearchResultStatus(payload, done);
      const toolStatus = resolveToolStatusByChatState({
        resultStatus,
        isActiveAssistantMessage: parentMessageId === activeAssistantMessageId,
        isStreaming,
      });
      return {
        id: `deepsearch-${payload.toolCallId}`,
        role: "assistant",
        content: "",
        createdAt,
        kind: "deepsearch-event",
        toolName: payload.toolName,
        toolInput: {
          responseId: parentMessageId,
          toolCallId: payload.toolCallId,
        },
        toolOutput: payload,
        toolStatus,
        error:
          typeof payload.error === "string" && payload.error.trim().length > 0
            ? payload.error
            : undefined,
      };
    },
  );
};

export const buildAgentToolStatusByToolCall = (
  events: ChatMessage[],
  kind: "subagent-event" | "deepsearch-event",
): Map<string, ChatMessage["toolStatus"]> => {
  const statusByToolCall = new Map<string, ChatMessage["toolStatus"]>();
  events.forEach((event) => {
    if (event.kind !== kind) {
      return;
    }
    const toolCallId = readToolCallId(event.toolInput);
    if (!toolCallId || !event.toolStatus) {
      return;
    }
    statusByToolCall.set(toolCallId, event.toolStatus);
  });
  return statusByToolCall;
};
