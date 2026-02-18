import type {
  ChatMessage,
  DeepSearchStreamPayload,
  SubagentStreamPayload,
} from "@/types/chat";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import { isJsonObject } from "@/types/json";

export type DeertubeMessagePart = DeertubeUIMessage["parts"][number];

const isSubagentStreamPayload = (
  value: unknown,
): value is SubagentStreamPayload => {
  if (!isJsonObject(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.toolCallId === "string" &&
    Array.isArray(candidate.messages)
  );
};

const isDeepSearchStreamPayload = (
  value: unknown,
): value is DeepSearchStreamPayload => {
  if (!isJsonObject(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.toolCallId === "string";
};

export const readSubagentPartPayload = (
  part: DeertubeMessagePart,
): SubagentStreamPayload | null => {
  if (part.type !== "data-subagent-stream") {
    return null;
  }
  const payload = (part as { data?: unknown }).data;
  return isSubagentStreamPayload(payload) ? payload : null;
};

export const readDeepSearchPartPayload = (
  part: DeertubeMessagePart,
): { payload: DeepSearchStreamPayload; done: boolean } | null => {
  if (
    part.type !== "data-deepsearch-stream" &&
    part.type !== "data-deepsearch-done"
  ) {
    return null;
  }
  const payload = (part as { data?: unknown }).data;
  if (!isDeepSearchStreamPayload(payload)) {
    return null;
  }
  return {
    payload,
    done: part.type === "data-deepsearch-done",
  };
};

const readKnownToolStatus = (value: unknown): ChatMessage["toolStatus"] | null => {
  if (
    value === "running" ||
    value === "complete" ||
    value === "failed" ||
    value === "skipped"
  ) {
    return value;
  }
  return null;
};

const readToolPartResultStatus = (
  part: DeertubeMessagePart,
): ChatMessage["toolStatus"] | null => {
  const partState =
    "state" in part && typeof part.state === "string" ? part.state : undefined;
  const hasErrorState =
    (partState?.includes("error") ?? false) ||
    (partState?.includes("denied") ?? false);
  if (hasErrorState) {
    return "failed";
  }
  if ("output" in part && part.output !== undefined) {
    if (isJsonObject(part.output)) {
      const status = readKnownToolStatus(part.output.status);
      if (status) {
        return status;
      }
    }
    return "complete";
  }
  if (partState === "output-available") {
    return "complete";
  }
  return null;
};

const isToolExecutionPart = (part: DeertubeMessagePart): boolean =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool";

export const deriveSubagentResultStatus = (
  payload: SubagentStreamPayload,
): ChatMessage["toolStatus"] | null => {
  const lastMessage = payload.messages.at(-1);
  if (
    !lastMessage ||
    typeof lastMessage !== "object" ||
    !("parts" in lastMessage) ||
    !Array.isArray((lastMessage as { parts?: unknown }).parts)
  ) {
    return null;
  }
  const parts = (lastMessage as { parts: DeertubeMessagePart[] }).parts;
  const statuses = parts
    .filter(isToolExecutionPart)
    .map((part) => readToolPartResultStatus(part))
    .filter((status): status is ChatMessage["toolStatus"] => status !== null);
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("running")) {
    return "running";
  }
  if (statuses.includes("skipped")) {
    return "skipped";
  }
  if (statuses.includes("complete")) {
    return "complete";
  }
  return null;
};

const hasDeepSearchEvidence = (payload: DeepSearchStreamPayload): boolean => {
  const hasConclusion =
    typeof payload.conclusion === "string" && payload.conclusion.trim().length > 0;
  const hasSources = Array.isArray(payload.sources) && payload.sources.length > 0;
  const hasReferences =
    Array.isArray(payload.references) && payload.references.length > 0;
  return hasConclusion || hasSources || hasReferences;
};

export const deriveDeepSearchResultStatus = (
  payload: DeepSearchStreamPayload,
  done: boolean,
): ChatMessage["toolStatus"] | null => {
  const payloadStatus = readKnownToolStatus(payload.status);
  if (
    payloadStatus === "failed" ||
    payloadStatus === "complete" ||
    payloadStatus === "skipped"
  ) {
    return payloadStatus;
  }
  if (done) {
    return "complete";
  }
  const hasError =
    typeof payload.error === "string" && payload.error.trim().length > 0;
  if (hasError) {
    return "failed";
  }
  if (hasDeepSearchEvidence(payload)) {
    return payloadStatus ?? "complete";
  }
  return payloadStatus;
};

const isTerminalToolStatus = (
  status: ChatMessage["toolStatus"] | null,
): status is "complete" | "failed" | "skipped" =>
  status === "complete" || status === "failed" || status === "skipped";

const mergeDeepSearchStatus = (
  previous: DeepSearchStreamPayload["status"],
  next: DeepSearchStreamPayload["status"],
): DeepSearchStreamPayload["status"] => {
  const previousKnown = readKnownToolStatus(previous);
  const nextKnown = readKnownToolStatus(next);
  if (!previousKnown) {
    return nextKnown ?? previous;
  }
  if (!nextKnown) {
    return previousKnown;
  }
  if (isTerminalToolStatus(previousKnown) && nextKnown === "running") {
    return previousKnown;
  }
  return nextKnown;
};

export const mergeDeepSearchPayload = (
  previous: DeepSearchStreamPayload,
  next: DeepSearchStreamPayload,
): DeepSearchStreamPayload => ({
  ...previous,
  ...next,
  mode: "mode" in next ? next.mode : previous.mode,
  query: "query" in next ? next.query : previous.query,
  projectId: "projectId" in next ? next.projectId : previous.projectId,
  searchId: "searchId" in next ? next.searchId : previous.searchId,
  status: mergeDeepSearchStatus(previous.status, next.status),
  sources: "sources" in next ? next.sources : previous.sources,
  references: "references" in next ? next.references : previous.references,
  prompt: "prompt" in next ? next.prompt : previous.prompt,
  conclusion: "conclusion" in next ? next.conclusion : previous.conclusion,
  error: "error" in next ? next.error : previous.error,
  complete: "complete" in next ? next.complete : previous.complete,
});

export const resolveToolStatusByChatState = ({
  resultStatus,
  isActiveAssistantMessage,
  isStreaming,
}: {
  resultStatus: ChatMessage["toolStatus"] | null;
  isActiveAssistantMessage: boolean;
  isStreaming: boolean;
}): ChatMessage["toolStatus"] => {
  if (resultStatus) {
    return resultStatus;
  }
  if (isActiveAssistantMessage && isStreaming) {
    return "running";
  }
  return "failed";
};

const extractDeepSearchToolText = (part: DeertubeMessagePart): string | null => {
  const isDeepSearchToolPart =
    part.type === "tool-deepSearch" ||
    (part.type === "dynamic-tool" &&
      "toolName" in part &&
      part.toolName === "deepSearch");
  if (!isDeepSearchToolPart || !("output" in part)) {
    return null;
  }
  if (!isJsonObject(part.output)) {
    return null;
  }
  const answer = part.output.answer;
  if (typeof answer === "string" && answer.trim().length > 0) {
    return answer;
  }
  const conclusion = part.output.conclusion;
  if (typeof conclusion === "string" && conclusion.trim().length > 0) {
    return conclusion;
  }
  return null;
};

export function extractUiMessageText(message: DeertubeUIMessage): string {
  if ("content" in message && typeof message.content === "string") {
    return message.content;
  }
  if (!("parts" in message) || !Array.isArray(message.parts)) {
    return "";
  }
  for (const part of message.parts) {
    const toolText = extractDeepSearchToolText(part);
    if (toolText) {
      return toolText;
    }
    const deepSearch = readDeepSearchPartPayload(part);
    if (!deepSearch) {
      continue;
    }
    const conclusion = deepSearch.payload.conclusion;
    if (typeof conclusion === "string" && conclusion.trim().length > 0) {
      return conclusion;
    }
  }
  const text = message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part,
    )
    .map((part) => part.text)
    .join("");
  return text.trim().length > 0 ? text : "";
}
