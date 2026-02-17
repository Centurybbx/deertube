import type {
  ChatMessage,
  DeepSearchReferencePayload,
  DeepSearchSourcePayload,
  DeepSearchStreamPayload,
} from "@/types/chat";

const normalizeLine = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\s+/g, " ");
};

const clampText = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}...` : value;

const normalizeInline = (value: string | undefined): string | undefined => {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const formatAccuracy = (
  accuracy: DeepSearchReferencePayload["accuracy"],
): string | undefined => {
  if (!accuracy) {
    return undefined;
  }
  if (accuracy === "high") return "High";
  if (accuracy === "medium") return "Medium";
  if (accuracy === "low") return "Low";
  if (accuracy === "conflicting") return "Conflicting";
  if (accuracy === "insufficient") return "Insufficient";
  return undefined;
};

const formatSourceAuthority = (
  sourceAuthority: DeepSearchReferencePayload["sourceAuthority"],
): string | undefined => {
  if (!sourceAuthority) {
    return undefined;
  }
  if (sourceAuthority === "high") return "High";
  if (sourceAuthority === "medium") return "Medium";
  if (sourceAuthority === "low") return "Low";
  if (sourceAuthority === "unknown") return "Unknown";
  return undefined;
};

const buildValidationPrompt = ({
  pageUrl,
  pageTitle,
}: {
  pageUrl: string;
  pageTitle?: string;
}): string => {
  const titleLine = normalizeLine(pageTitle);
  if (titleLine) {
    return `Validate page content truthfulness:\nTitle: ${titleLine}\nURL: ${pageUrl}`;
  }
  return `Validate page content truthfulness:\nURL: ${pageUrl}`;
};

export interface PageValidationChatSeed {
  firstQuestion: string;
  requestMessageId: string;
  toolCallId: string;
  eventId: string;
  requestMessage: ChatMessage;
  runningEventMessage: ChatMessage;
}

export const createPageValidationChatSeed = ({
  pageUrl,
  pageTitle,
}: {
  pageUrl: string;
  pageTitle?: string;
}): PageValidationChatSeed => {
  const createdAt = new Date().toISOString();
  const requestMessageId = `validate-page-request-${crypto.randomUUID()}`;
  const toolCallId = `validate-page-${crypto.randomUUID()}`;
  const eventId = `deepsearch-${toolCallId}`;
  const normalizedTitle = normalizeLine(pageTitle);
  const firstQuestion = clampText(
    normalizedTitle ?? pageUrl,
    120,
  );
  const requestMessage: ChatMessage = {
    id: requestMessageId,
    role: "user",
    content: buildValidationPrompt({
      pageUrl,
      pageTitle: normalizedTitle,
    }),
    createdAt,
    status: "complete",
  };
  const runningPayload: DeepSearchStreamPayload = {
    toolCallId,
    toolName: "validate.run",
    mode: "validate",
    query: normalizedTitle ?? pageUrl,
    status: "running",
  };
  const runningEventMessage: ChatMessage = {
    id: eventId,
    role: "assistant",
    content: "",
    createdAt,
    kind: "deepsearch-event",
    toolName: "validate.run",
    toolInput: {
      responseId: requestMessageId,
      toolCallId,
    },
    toolOutput: runningPayload,
    toolStatus: "running",
    status: "complete",
  };
  return {
    firstQuestion,
    requestMessageId,
    toolCallId,
    eventId,
    requestMessage,
    runningEventMessage,
  };
};

export const buildCompletedValidationEvent = ({
  previousEvent,
  query,
  searchId,
  projectId,
  sources,
  references,
}: {
  previousEvent: ChatMessage;
  query: string;
  searchId?: string;
  projectId?: string;
  sources: DeepSearchSourcePayload[];
  references: DeepSearchReferencePayload[];
}): ChatMessage => {
  const payload: DeepSearchStreamPayload = {
    toolCallId:
      typeof (previousEvent.toolInput as { toolCallId?: string } | undefined)
        ?.toolCallId === "string"
        ? (
            previousEvent.toolInput as {
              toolCallId: string;
            }
          ).toolCallId
        : `validate-page-${crypto.randomUUID()}`,
    toolName: "validate.run",
    mode: "validate",
    query,
    projectId,
    searchId,
    status: "complete",
    sources,
    references,
    complete: true,
  };
  return {
    ...previousEvent,
    toolStatus: "complete",
    toolOutput: payload,
    error: undefined,
  };
};

export const buildFailedValidationEvent = ({
  previousEvent,
  query,
  errorMessage,
}: {
  previousEvent: ChatMessage;
  query: string;
  errorMessage: string;
}): ChatMessage => {
  const payload: DeepSearchStreamPayload = {
    toolCallId:
      typeof (previousEvent.toolInput as { toolCallId?: string } | undefined)
        ?.toolCallId === "string"
        ? (
            previousEvent.toolInput as {
              toolCallId: string;
            }
          ).toolCallId
        : `validate-page-${crypto.randomUUID()}`,
    toolName: "validate.run",
    mode: "validate",
    query,
    status: "failed",
    error: errorMessage,
    complete: true,
  };
  return {
    ...previousEvent,
    toolStatus: "failed",
    toolOutput: payload,
    error: errorMessage,
  };
};

export const buildPageValidationSummaryMessage = ({
  toolCallId,
  query,
  references,
}: {
  toolCallId: string;
  query: string;
  references: DeepSearchReferencePayload[];
}): ChatMessage => {
  const summaryId = `validate-page-summary-${toolCallId}`;
  const header = `Validation claims for: ${clampText(query, 180)}`;
  const claimLines = references.slice(0, 12).map((reference, index) => {
    const uri = normalizeInline(reference.uri);
    const refLabel =
      typeof reference.refId === "number" ? `Ref ${reference.refId}` : `Ref ${index + 1}`;
    const marker = uri ? `[${refLabel}](${uri})` : undefined;
    const viewpoint =
      normalizeInline(reference.viewpoint) ??
      normalizeInline(reference.title) ??
      `Claim ${index + 1}`;
    const accuracy = formatAccuracy(reference.accuracy);
    const sourceAuthority = formatSourceAuthority(reference.sourceAuthority);
    const scoreLabel =
      accuracy && sourceAuthority
        ? `(Accuracy: ${accuracy}, Source: ${sourceAuthority})`
        : accuracy
          ? `(Accuracy: ${accuracy})`
          : sourceAuthority
            ? `(Source: ${sourceAuthority})`
            : undefined;
    if (!marker) {
      return scoreLabel ? `- ${viewpoint} ${scoreLabel}` : `- ${viewpoint}`;
    }
    return scoreLabel
      ? `- ${viewpoint} ${marker} ${scoreLabel}`
      : `- ${viewpoint} ${marker}`;
  });
  const content =
    claimLines.length > 0
      ? [header, "", ...claimLines].join("\n")
      : `${header}\n\nNo validated references were returned.`;
  return {
    id: summaryId,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    status: "complete",
    kind: "text",
  };
};

export const upsertChatMessage = (
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] => {
  const existingIndex = messages.findIndex((item) => item.id === message.id);
  if (existingIndex < 0) {
    return [...messages, message];
  }
  return messages.map((item) => (item.id === message.id ? message : item));
};
