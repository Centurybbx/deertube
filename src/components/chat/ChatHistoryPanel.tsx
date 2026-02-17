import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeertubeUIMessage } from "@/modules/ai/tools";
import { isJsonObject } from "@/types/json";
import type {
  ChatMessage,
  DeepSearchReferencePayload,
  DeepSearchStreamPayload,
  GraphToolInput,
  GraphToolOutput,
  SubagentStreamPayload,
} from "../../types/chat";
import type {
  FlowNode,
  InsightNodeData,
  QuestionNodeData,
  SourceNodeData,
} from "../../types/flow";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { Chat } from "@/modules/chat/components/chat";
import { ChatMessages } from "@/modules/chat/components/chat-messages";
import {
  MarkdownRenderer,
  type MarkdownReferencePreview,
} from "@/components/markdown/renderer";
import { getHighlightExcerptKey } from "@/components/markdown/highlight-excerpt-key";
import {
  ChatEvent,
  ChatEventAddon,
  ChatEventBody,
  ChatEventContent,
  ChatEventDescription,
  ChatEventTitle,
} from "@/modules/chat/components/chat-event";
import { PrimaryMessage } from "@/modules/chat/components/primary-message";
import { AdditionalMessage } from "@/modules/chat/components/additional-message";
import { DateItem } from "@/modules/chat/components/date-item";
import {
  ChatToolbar,
  ChatToolbarAddonStart,
  ChatToolbarAddonEnd,
  ChatToolbarUnderInput,
  ChatToolbarTextarea,
} from "@/modules/chat/components/chat-toolbar";
import {
  AlertCircle,
  ArrowDown,
  Bot,
  Check,
  CircleHelp,
  CircleCheck,
  ChevronDown,
  Copy,
  FolderOpen,
  Loader2,
  MessageSquare,
  Network,
  RefreshCw,
  RotateCw,
  Search as SearchIcon,
  Send,
  Settings,
  ShieldCheck,
  Square,
  UserRound,
  Wrench,
} from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { BrowserViewSelection } from "@/types/browserview";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DEEP_RESEARCH_PROMPT_PLACEHOLDERS,
  buildMainAgentSystemPrompt,
  buildSearchSubagentRuntimePrompt,
  buildSearchSubagentSystemPrompt,
  DeepResearchConfig,
  resolveDeepResearchConfig,
  type DeepResearchStrictness,
  type SubagentSearchComplexity,
  type TavilySearchDepth,
} from "@/shared/deepresearch-config";
import type { AgentSkillProfile } from "@/shared/agent-skills";

interface ChatHistoryPanelProps {
  developerMode?: boolean;
  messages: ChatMessage[];
  selectedResponseId: string | null;
  selectedNode?: FlowNode | null;
  nodes?: FlowNode[];
  onFocusNode?: (nodeId: string) => void;
  onReferenceClick?: (url: string, label?: string) => void;
  onResolveReferencePreview?: (
    uri: string,
  ) => Promise<MarkdownReferencePreview | null>;
  browserSelection?: BrowserViewSelection | null;
  onInsertBrowserSelection?: (selection: BrowserViewSelection) => void;
  scrollToBottomSignal?: number;
  focusSignal?: number;
  onRequestClearSelection?: () => void;
  input: string;
  deepResearchConfig: DeepResearchConfig;
  onDeepResearchConfigChange: (next: DeepResearchConfig) => void;
  busy: boolean;
  asyncBusy?: boolean;
  graphBusy?: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onStopAsync?: () => void;
  onToggleValidateResponse?: (responseId: string) => void;
  onGenerateGraphResponse?: (responseId: string) => void;
  onRetry?: (messageId: string) => void;
  lastFailedMessageId?: string | null;
}

interface SubagentEntry {
  id: string;
  label: string;
  status: ToolExecutionStatus;
  compactDetail?: string;
  fullDetail?: string;
  tone?: "warn";
}

type ToolExecutionStatus = "running" | "complete" | "failed";

interface ToolProgress {
  total: number;
  done: number;
  running: number;
  failed: number;
}

interface GraphChatItem {
  kind: "graph";
  id: string;
  message: ChatMessage;
}

interface SubagentChatItem {
  kind: "subagent";
  id: string;
  message: ChatMessage;
  deepSearchMessage?: ChatMessage;
}

interface DeepSearchChatItem {
  kind: "deepsearch";
  id: string;
  message: ChatMessage;
}

type ToolChatItem = GraphChatItem | SubagentChatItem | DeepSearchChatItem;
type ChatItem =
  | { kind: "date"; id: string; timestamp: number }
  | { kind: "primary"; id: string; message: ChatMessage }
  | { kind: "additional"; id: string; message: ChatMessage }
  | ToolChatItem;

interface ValidateRunDetails {
  responseId: string;
  toolCallId: string;
  deepSearchMessage?: ChatMessage;
  subagentMessage?: ChatMessage;
}

interface SearchSkillOption {
  name: string;
  title: string;
  description: string;
  relativePath?: string;
}

interface StickyQuestionItem {
  messageId: string;
  order: number;
}

const TOOL_DETAIL_MAX_CHARS = 120;
const HIGHLIGHT_SCROLL_MAX_RETRIES = 18;
const STICKY_COLLAPSE_DELAY_MS = 80;
const STICKY_STACK_COLLAPSED_OFFSET_PX = 6;
const STICKY_STACK_EXPANDED_GAP_PX = 8;
const STICKY_STACK_EXPANDED_FALLBACK_HEIGHT_PX = 84;
const STICKY_STACK_COLLAPSED_VISIBLE_COUNT = 6;
const STICKY_FOCUS_SAFETY_GAP_PX = 14;
const STICKY_POST_CLICK_COLLAPSE_DELAY_MS = 1150;
const SKILL_PROFILE_OPTIONS: {
  value: AgentSkillProfile;
  label: string;
}[] = [
  { value: "auto", label: "Auto Recall" },
  { value: "web3-investing", label: "Web3 / Investing" },
  { value: "academic-research", label: "Academic Research" },
  { value: "news-analysis", label: "News" },
  { value: "none", label: "Disable Skill" },
];
const SEARCH_COMPLEXITY_OPTIONS: {
  value: SubagentSearchComplexity;
  label: string;
}[] = [
  { value: "standard", label: "Standard" },
  { value: "balanced", label: "Balanced" },
  { value: "deep", label: "Deep" },
];
const TAVILY_SEARCH_DEPTH_OPTIONS: {
  value: TavilySearchDepth;
  label: string;
}[] = [
  { value: "basic", label: "Basic" },
  { value: "advanced", label: "Advanced" },
];
const SEARCH_POLICY_OPTIONS: {
  value: DeepResearchStrictness;
  label: string;
  description: string;
}[] = [
  {
    value: "no-search",
    label: "Never",
    description: "Do not run search.",
  },
  {
    value: "uncertain-claims",
    label: "Uncertain",
    description: "Run search only for uncertain claims.",
  },
  {
    value: "all-claims",
    label: "Every Claim",
    description: "Run search for every claim.",
  },
];
const OVERRIDE_TEMPLATE_PLACEHOLDER_KEYS = [
  "query",
  "searchEnabled",
  "validateEnabled",
  "validateStrictness",
  "searchComplexity",
  "tavilySearchDepth",
  "maxSearchCalls",
  "maxExtractCalls",
  "maxRepeatSearchQuery",
  "maxRepeatExtractUrl",
  "mode",
  "answerToValidate",
] as const;
const OVERRIDE_TEMPLATE_PLACEHOLDER_HINT = `Placeholders: ${OVERRIDE_TEMPLATE_PLACEHOLDER_KEYS.map((key) => `{{${key}}}`).join(", ")}`;
const OVERRIDE_TEMPLATE_PLACEHOLDER_TITLES = DEEP_RESEARCH_PROMPT_PLACEHOLDERS
  .filter((item) =>
    OVERRIDE_TEMPLATE_PLACEHOLDER_KEYS.includes(
      item.key as (typeof OVERRIDE_TEMPLATE_PLACEHOLDER_KEYS)[number],
    ),
  )
  .map((item) => `{{${item.key}}}: ${item.description}`)
  .join("\n");

const searchPolicyToIndex = (strictness: DeepResearchStrictness): number => {
  const index = SEARCH_POLICY_OPTIONS.findIndex(
    (option) => option.value === strictness,
  );
  return index >= 0 ? index : 1;
};

const indexToSearchPolicy = (index: number): DeepResearchStrictness =>
  SEARCH_POLICY_OPTIONS[Math.min(2, Math.max(0, index))]?.value ??
  "uncertain-claims";

type ValidateStrictness = Exclude<DeepResearchStrictness, "no-search">;

const normalizeValidateStrictness = (
  strictness: DeepResearchStrictness,
): ValidateStrictness =>
  strictness === "all-claims" ? "all-claims" : "uncertain-claims";

const MARKDOWN_DEERTUBE_REF_LINK_PATTERN = /\[[^\]]+\]\((deertube:\/\/[^)\s]+)\)/gi;
const VALIDATE_REFERENCE_INLINE_LIMIT = 16;
const VALIDATE_LINE_TOKEN_MIN_LENGTH = 3;

const extractReferencedUrisFromMarkdown = (source: string): Set<string> => {
  const uriSet = new Set<string>();
  for (const match of source.matchAll(MARKDOWN_DEERTUBE_REF_LINK_PATTERN)) {
    const normalized = match[1]?.trim();
    if (normalized) {
      uriSet.add(normalized);
    }
  }
  return uriSet;
};

const normalizeTextForMatch = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const extractTokensForMatch = (value: string): string[] => {
  const normalized = normalizeTextForMatch(value);
  if (!normalized) {
    return [];
  }
  const dedupe = new Set<string>();
  normalized.split(" ").forEach((token) => {
    if (token.length < VALIDATE_LINE_TOKEN_MIN_LENGTH) {
      return;
    }
    dedupe.add(token);
  });
  return Array.from(dedupe.values());
};

const resolveValidateMarkerLabel = (
  reference: DeepSearchReferencePayload,
  fallbackIndex: number,
): string => {
  if (
    typeof reference.refId === "number" &&
    Number.isFinite(reference.refId) &&
    reference.refId > 0
  ) {
    return String(reference.refId);
  }
  return String(fallbackIndex + 1);
};

const truncateInline = (value: string, maxChars = TOOL_DETAIL_MAX_CHARS): string => {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxChars - 3))}...`;
};

const parseToolPayload = (value: unknown): unknown => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("[") &&
      !trimmed.startsWith("\"")
    ) {
      return trimmed;
    }
    return JSON.parse(trimmed) as unknown;
  }
  return value ?? null;
};

const stripLineNumberPrefix = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\d+\s+\|\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join("\n")
    .trim();

const formatAccuracyLabel = (
  accuracy: string | undefined,
): string | null => {
  if (!accuracy) {
    return null;
  }
  if (accuracy === "high") return "High";
  if (accuracy === "medium") return "Medium";
  if (accuracy === "low") return "Low";
  if (accuracy === "conflicting") return "Conflicting";
  if (accuracy === "insufficient") return "Insufficient";
  return null;
};

const formatSourceAuthorityLabel = (
  sourceAuthority: DeepSearchReferencePayload["sourceAuthority"],
): string | null => {
  if (!sourceAuthority) {
    return null;
  }
  if (sourceAuthority === "high") return "High";
  if (sourceAuthority === "medium") return "Medium";
  if (sourceAuthority === "low") return "Low";
  return "Unknown";
};

const mergeValidateReferencesInline = ({
  source,
  references,
}: {
  source: string;
  references: DeepSearchReferencePayload[];
}): {
  content: string;
  accuracyHints: Record<string, DeepSearchReferencePayload["accuracy"]>;
  sourceAuthorityHints: Record<
    string,
    DeepSearchReferencePayload["sourceAuthority"]
  >;
} => {
  const accuracyHints: Record<
    string,
    DeepSearchReferencePayload["accuracy"]
  > = {};
  const sourceAuthorityHints: Record<
    string,
    DeepSearchReferencePayload["sourceAuthority"]
  > = {};
  references.forEach((reference) => {
    const uri =
      typeof reference.uri === "string" && reference.uri.trim().length > 0
        ? reference.uri.trim()
        : "";
    if (!uri) {
      return;
    }
    if (reference.accuracy) {
      accuracyHints[uri] = reference.accuracy;
    }
    if (reference.sourceAuthority) {
      sourceAuthorityHints[uri] = reference.sourceAuthority;
    }
  });
  if (references.length === 0) {
    return { content: source, accuracyHints, sourceAuthorityHints };
  }
  const existingUris = extractReferencedUrisFromMarkdown(source);
  const dedupe = new Set<string>();
  const inlineReferences = references
    .map((reference, index) => {
      const uri =
        typeof reference.uri === "string" && reference.uri.trim().length > 0
          ? reference.uri.trim()
          : "";
      if (!uri || dedupe.has(uri)) {
        return null;
      }
      dedupe.add(uri);
      return {
        reference,
        uri,
        label: resolveValidateMarkerLabel(reference, index),
        marker: `[${resolveValidateMarkerLabel(reference, index)}](${uri})`,
        tokens: extractTokensForMatch(
          [
            reference.viewpoint,
            reference.validationRefContent,
            reference.text,
            reference.title,
          ]
            .filter((item): item is string => typeof item === "string")
            .join(" "),
        ),
      };
    })
    .filter(
      (item): item is NonNullable<typeof item> =>
        item !== null && !existingUris.has(item.uri),
    )
    .slice(0, VALIDATE_REFERENCE_INLINE_LIMIT);
  if (inlineReferences.length === 0) {
    return { content: source, accuracyHints, sourceAuthorityHints };
  }

  const lines = source.split("\n");
  const codeFenceRanges: { start: number; end: number }[] = [];
  let openFenceStart: number | null = null;
  lines.forEach((line, index) => {
    if (!line.trimStart().startsWith("```")) {
      return;
    }
    if (openFenceStart === null) {
      openFenceStart = index;
      return;
    }
    codeFenceRanges.push({ start: openFenceStart, end: index });
    openFenceStart = null;
  });
  const isInCodeFence = (index: number): boolean =>
    codeFenceRanges.some((range) => index >= range.start && index <= range.end);
  const candidateLineIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => line.trim().length > 0 && !isInCodeFence(index))
    .map(({ index }) => index);
  if (candidateLineIndexes.length === 0) {
    return { content: source, accuracyHints, sourceAuthorityHints };
  }

  const lineTokenMap = new Map<number, Set<string>>();
  candidateLineIndexes.forEach((index) => {
    lineTokenMap.set(index, new Set(extractTokensForMatch(lines[index])));
  });
  const markersByLine = new Map<number, string[]>();
  const chooseLineIndex = (tokens: string[]): number => {
    if (tokens.length === 0) {
      return candidateLineIndexes[candidateLineIndexes.length - 1];
    }
    let bestIndex = candidateLineIndexes[candidateLineIndexes.length - 1];
    let bestScore = -1;
    candidateLineIndexes.forEach((index) => {
      const lineTokens = lineTokenMap.get(index);
      if (!lineTokens || lineTokens.size === 0) {
        return;
      }
      let score = 0;
      tokens.forEach((token) => {
        if (lineTokens.has(token)) {
          score += 1;
        }
      });
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  };

  inlineReferences.forEach((item) => {
    const targetIndex = chooseLineIndex(item.tokens);
    const currentLine = lines[targetIndex];
    if (
      currentLine.includes(`(${item.uri})`) ||
      currentLine.includes(`[${item.label}](`)
    ) {
      return;
    }
    const markers = markersByLine.get(targetIndex) ?? [];
    markers.push(item.marker);
    markersByLine.set(targetIndex, markers);
  });

  if (markersByLine.size === 0) {
    return { content: source, accuracyHints, sourceAuthorityHints };
  }
  const nextLines = lines.map((line, index) => {
    const markers = markersByLine.get(index);
    if (!markers || markers.length === 0) {
      return line;
    }
    const suffix = markers.join(" ");
    return `${line.trimEnd()} ${suffix}`.trimEnd();
  });
  return {
    content: nextLines.join("\n"),
    accuracyHints,
    sourceAuthorityHints,
  };
};

const getValidateAccuracyToneClasses = (
  accuracy: string | undefined,
): string => {
  if (accuracy === "high") {
    return "border-emerald-400/45 bg-emerald-500/10";
  }
  if (accuracy === "medium") {
    return "border-amber-400/45 bg-amber-500/10";
  }
  if (accuracy === "low") {
    return "border-orange-400/45 bg-orange-500/10";
  }
  if (accuracy === "conflicting") {
    return "border-red-400/45 bg-red-500/10";
  }
  if (accuracy === "insufficient") {
    return "border-slate-400/45 bg-slate-500/10";
  }
  return "border-border/70 bg-card/60";
};

const getValidateAccuracyTextClass = (
  accuracy: string | undefined,
): string => {
  if (accuracy === "high") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (accuracy === "medium") {
    return "text-amber-700 dark:text-amber-300";
  }
  if (accuracy === "low") {
    return "text-orange-700 dark:text-orange-300";
  }
  if (accuracy === "conflicting") {
    return "text-red-700 dark:text-red-300";
  }
  if (accuracy === "insufficient") {
    return "text-slate-700 dark:text-slate-300";
  }
  return "text-muted-foreground";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isJsonObject(value);

const isSubagentPayload = (value: unknown): value is SubagentStreamPayload => {
  if (!value || !isRecord(value)) {
    return false;
  }
  return typeof value.toolCallId === "string" && Array.isArray(value.messages);
};

const isDeepSearchPayload = (value: unknown): value is DeepSearchStreamPayload => {
  if (!value || !isRecord(value)) {
    return false;
  }
  return "sources" in value || "conclusion" in value || "query" in value || "status" in value;
};

type DeertubeMessagePart = DeertubeUIMessage["parts"][number];
type ToolMessagePart = Extract<
  DeertubeMessagePart,
  { type: `tool-${string}` | "dynamic-tool" }
>;

const isToolPart = (
  part: DeertubeMessagePart,
): part is ToolMessagePart => part.type.startsWith("tool-") || part.type === "dynamic-tool";

const getToolName = (part: ToolMessagePart): string | undefined => {
  if (part.type.startsWith("tool-")) {
    return part.type.slice(5);
  }
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
    return part.toolName;
  }
  return undefined;
};

const resolvePartStatus = (part: ToolMessagePart): ToolExecutionStatus => {
  const partState =
    "state" in part && typeof part.state === "string" ? part.state : undefined;
  if (partState?.includes("error")) {
    return "failed";
  }
  if (partState?.includes("denied")) {
    return "failed";
  }
  if ("output" in part && part.output !== undefined) {
    return "complete";
  }
  if (partState === "output-available") {
    return "complete";
  }
  return "running";
};

const toExecutionStatus = (
  status: ChatMessage["toolStatus"],
): ToolExecutionStatus => {
  if (status === "failed") {
    return "failed";
  }
  if (status === "complete") {
    return "complete";
  }
  return "running";
};

const isTerminalToolStatus = (
  status: ChatMessage["toolStatus"] | undefined,
): status is "complete" | "failed" =>
  status === "complete" || status === "failed";

const shouldPreferDeepSearchMessage = (
  current: ChatMessage | undefined,
  next: ChatMessage,
): boolean => {
  if (!current) {
    return true;
  }
  const currentStatus = current.toolStatus;
  const nextStatus = next.toolStatus;
  if (isTerminalToolStatus(currentStatus) && nextStatus === "running") {
    return false;
  }
  if (isTerminalToolStatus(nextStatus) && currentStatus === "running") {
    return true;
  }
  const currentTimestamp = Date.parse(current.createdAt);
  const nextTimestamp = Date.parse(next.createdAt);
  if (!Number.isFinite(currentTimestamp)) {
    return true;
  }
  if (!Number.isFinite(nextTimestamp)) {
    return false;
  }
  return nextTimestamp >= currentTimestamp;
};

const shouldPreferLatestRunMessage = (
  current: ChatMessage | undefined,
  next: ChatMessage,
): boolean => {
  if (!current) {
    return true;
  }
  const currentTimestamp = Date.parse(current.createdAt);
  const nextTimestamp = Date.parse(next.createdAt);
  if (!Number.isFinite(currentTimestamp)) {
    return true;
  }
  if (!Number.isFinite(nextTimestamp)) {
    return false;
  }
  return nextTimestamp >= currentTimestamp;
};

const resolveSubagentParentExecutionStatus = (
  subagentMessage: ChatMessage,
  deepSearchMessage?: ChatMessage,
): ToolExecutionStatus => {
  if (deepSearchMessage?.toolStatus) {
    return toExecutionStatus(deepSearchMessage.toolStatus);
  }
  const resolvedError = subagentMessage.error ?? deepSearchMessage?.error;
  if (typeof resolvedError === "string" && resolvedError.trim().length > 0) {
    return "failed";
  }
  return toExecutionStatus(subagentMessage.toolStatus);
};

const normalizeSubagentEntryStatuses = (
  entries: SubagentEntry[],
  parentStatus: ToolExecutionStatus,
): SubagentEntry[] => {
  if (parentStatus === "running") {
    return entries;
  }
  return entries.map((entry) =>
    entry.status === "running" ? { ...entry, status: parentStatus } : entry,
  );
};

const getProgressByStatuses = (statuses: ToolExecutionStatus[]): ToolProgress => {
  const total = statuses.length;
  const done = statuses.filter((status) => status !== "running").length;
  const running = statuses.filter((status) => status === "running").length;
  const failed = statuses.filter((status) => status === "failed").length;
  return { total, done, running, failed };
};

const summarizeToolInput = (toolName: string | undefined, input: unknown) => {
  if (!isRecord(input)) {
    return undefined;
  }
  if (toolName === "search" && typeof input.query === "string") {
    return `query: ${input.query}`;
  }
  if (toolName === "extract" && typeof input.url === "string") {
    return `url: ${input.url}`;
  }
  const preview = JSON.stringify(input);
  return preview.length > 160 ? `${preview.slice(0, 160)}...` : preview;
};

const summarizeToolOutput = (
  toolName: string | undefined,
  output: unknown,
): { detail?: string; tone?: "warn" } => {
  if (!isRecord(output)) {
    return { detail: undefined };
  }
  if (toolName === "search" && Array.isArray(output.results)) {
    return { detail: `results: ${output.results.length}` };
  }
  if (toolName === "extract") {
    const selections = Array.isArray(output.selections)
      ? output.selections.length
      : undefined;
    const broken = output.broken === true;
    const detailParts: string[] = [];
    if (typeof selections === "number") detailParts.push(`selections: ${selections}`);
    if (broken) detailParts.push("broken");
    return {
      detail: detailParts.length > 0 ? detailParts.join(", ") : undefined,
      tone: broken ? "warn" : undefined,
    };
  }
  return { detail: undefined };
};

const stringifyToolDetail = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = parseToolPayload(trimmed);
    if (parsed !== null && typeof parsed !== "string") {
      const serialized = JSON.stringify(parsed, null, 2);
      return serialized ?? trimmed;
    }
    return trimmed;
  }
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
};

const buildSubagentEntries = (payload: SubagentStreamPayload): SubagentEntry[] => {
  const byId = new Map<string, SubagentEntry>();
  payload.messages.forEach((message, messageIndex) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("parts" in message) ||
      !Array.isArray((message as { parts?: unknown }).parts)
    ) {
      return;
    }
    const parts = (message as { parts: DeertubeMessagePart[] }).parts;
    parts.forEach((part, partIndex) => {
      if (!isToolPart(part)) {
        return;
      }
      const toolName = getToolName(part);
      const label = toolName ?? "tool";
      const rawId =
        "toolCallId" in part && typeof part.toolCallId === "string"
          ? part.toolCallId
          : `${label}-${messageIndex}-${partIndex}`;
      const inputCompact =
        "input" in part && part.input !== undefined
          ? summarizeToolInput(toolName, part.input)
          : undefined;
      const inputDetail =
        "input" in part && part.input !== undefined
          ? stringifyToolDetail(part.input)
          : undefined;
      const prior = byId.get(rawId);
      const nextStatus = resolvePartStatus(part);
      let compactDetail = prior?.compactDetail ?? inputCompact;
      let fullDetail = prior?.fullDetail ?? inputDetail;
      let tone = prior?.tone;
      if ("output" in part && part.output !== undefined) {
        const summary = summarizeToolOutput(toolName, part.output);
        compactDetail = summary.detail ?? compactDetail;
        fullDetail = stringifyToolDetail(part.output) ?? fullDetail;
        tone = summary.tone ?? tone;
      }
      byId.set(rawId, {
        id: rawId,
        label,
        status: nextStatus,
        compactDetail,
        fullDetail,
        tone,
      });
    });
  });
  return Array.from(byId.values());
};

const parseGraphToolInput = (value: ChatMessage["toolInput"]): GraphToolInput | null => {
  if (!value || !isRecord(value)) {
    return null;
  }
  const responseId =
    typeof value.responseId === "string" && value.responseId.length > 0
      ? value.responseId
      : undefined;
  const selectedNodeId =
    typeof value.selectedNodeId === "string" || value.selectedNodeId === null
      ? value.selectedNodeId
      : undefined;
  const selectedNodeSummary =
    typeof value.selectedNodeSummary === "string" ||
    value.selectedNodeSummary === null
      ? value.selectedNodeSummary
      : undefined;
  if (
    !responseId &&
    selectedNodeId === undefined &&
    selectedNodeSummary === undefined
  ) {
    return null;
  }
  return { responseId, selectedNodeId, selectedNodeSummary };
};

const readToolCallId = (value: ChatMessage["toolInput"]): string | null => {
  if (!value || !isRecord(value)) {
    return null;
  }
  return typeof value.toolCallId === "string" ? value.toolCallId : null;
};

const readResponseId = (value: ChatMessage["toolInput"]): string | null => {
  if (!value || !isRecord(value)) {
    return null;
  }
  if (typeof value.responseId !== "string" || value.responseId.trim().length === 0) {
    return null;
  }
  return value.responseId;
};

const isToolChatItem = (item: ChatItem): item is ToolChatItem =>
  item.kind === "graph" || item.kind === "subagent" || item.kind === "deepsearch";

const isToolEventMessage = (message: ChatMessage): boolean =>
  message.kind === "graph-event" ||
  message.kind === "subagent-event" ||
  message.kind === "deepsearch-event";

const isValidateDeepSearchEvent = (message: ChatMessage): boolean => {
  if (message.kind !== "deepsearch-event") {
    return false;
  }
  if (message.toolName === "validate.run") {
    return true;
  }
  const outputPayload = parseToolPayload(message.toolOutput);
  if (!isDeepSearchPayload(outputPayload)) {
    return false;
  }
  return outputPayload.mode === "validate";
};

export default function ChatHistoryPanel({
  developerMode = false,
  messages,
  selectedResponseId,
  selectedNode,
  nodes = [],
  onFocusNode,
  onReferenceClick,
  onResolveReferencePreview,
  browserSelection,
  onInsertBrowserSelection,
  scrollToBottomSignal = 0,
  focusSignal = 0,
  onRequestClearSelection,
  input,
  deepResearchConfig,
  onDeepResearchConfigChange,
  busy,
  asyncBusy = false,
  graphBusy = false,
  onInputChange,
  onSend,
  onStop,
  onStopAsync,
  onToggleValidateResponse,
  onGenerateGraphResponse,
  onRetry,
  lastFailedMessageId: lastFailedMessageIdProp,
}: ChatHistoryPanelProps) {
  const { scrollRef, contentRef } = useStickToBottom();
  const highlightedId = selectedResponseId;
  const ignoreHighlightRef = useRef(false);
  const stickyManualFocusLockUntilRef = useRef(0);
  const [advancedPanelOpen, setAdvancedPanelOpen] = useState(false);
  const [deepResearchQuickOpen, setDeepResearchQuickOpen] = useState(false);
  const [quickConfigTab, setQuickConfigTab] = useState<"search" | "validate">(
    "search",
  );
  const [advancedConfigTab, setAdvancedConfigTab] = useState<
    "search" | "validate"
  >("search");
  const [skillsDirectory, setSkillsDirectory] = useState("");
  const [searchSkillOptions, setSearchSkillOptions] = useState<
    SearchSkillOption[]
  >([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [toolOpenById, setToolOpenById] = useState<Record<string, boolean>>({});
  const [toolGroupOpenById, setToolGroupOpenById] = useState<
    Record<string, boolean>
  >({});
  const [stickyQuestionsExpanded, setStickyQuestionsExpanded] = useState(false);
  const [activeStickyQuestionById, setActiveStickyQuestionById] = useState<
    Record<string, boolean>
  >({});
  const [stickyQuestionHeightById, setStickyQuestionHeightById] = useState<
    Record<string, number>
  >({});
  const stickyCollapseTimeoutRef = useRef<number | null>(null);
  const stickyPostClickCollapseTimeoutRef = useRef<number | null>(null);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const validateDetailsPopoverTimerRef = useRef<number | null>(null);
  const [validateDetailsPopoverMessageId, setValidateDetailsPopoverMessageId] =
    useState<string | null>(null);
  const stickyQuestionAnchorByIdRef = useRef<Map<string, HTMLDivElement>>(
    new Map(),
  );
  const stickyQuestionElementByIdRef = useRef<Map<string, HTMLDivElement>>(
    new Map(),
  );
  const resolvedDeepResearchConfig = useMemo(
    () => resolveDeepResearchConfig(deepResearchConfig),
    [deepResearchConfig],
  );
  const searchPolicy = resolvedDeepResearchConfig.strictness;
  const searchPolicyIndex = searchPolicyToIndex(searchPolicy);
  const searchEnabled = searchPolicy !== "no-search";
  const searchAllClaimsEnabled = searchPolicy === "all-claims";
  const validatePolicy = normalizeValidateStrictness(
    resolvedDeepResearchConfig.validate.strictness,
  );
  const validateEnabled = resolvedDeepResearchConfig.validate.enabled;
  const validateAllClaimsEnabled = validatePolicy === "all-claims";
  const deepResearchSwitchEnabled = resolvedDeepResearchConfig.enabled;
  const deepResearchActive =
    deepResearchSwitchEnabled && (searchEnabled || validateEnabled);
  const highSearchComplexity =
    resolvedDeepResearchConfig.subagent.searchComplexity === "deep";
  const highValidateSearchComplexity =
    resolvedDeepResearchConfig.validate.subagent.searchComplexity === "deep";
  const fullPromptOverrideEnabled =
    resolvedDeepResearchConfig.fullPromptOverrideEnabled;
  const selectedSkillNames = resolvedDeepResearchConfig.selectedSkillNames;
  const defaultOverridePrompts = useMemo(() => {
    const baseConfig = resolveDeepResearchConfig({
      ...resolvedDeepResearchConfig,
      fullPromptOverrideEnabled: false,
      mainPromptOverride: undefined,
      subagent: {
        ...resolvedDeepResearchConfig.subagent,
        systemPromptOverride: undefined,
        promptOverride: undefined,
      },
      validate: {
        ...resolvedDeepResearchConfig.validate,
        subagent: {
          ...resolvedDeepResearchConfig.validate.subagent,
          systemPromptOverride: undefined,
          promptOverride: undefined,
        },
      },
    });
    const queryPlaceholder = "{{query}}";
    return {
      mainPrompt: buildMainAgentSystemPrompt([], baseConfig, {
        query: queryPlaceholder,
      }),
      subagentSystemPrompt: buildSearchSubagentSystemPrompt({
        subagentConfig: baseConfig.subagent,
        query: queryPlaceholder,
        skillProfile: baseConfig.skillProfile,
        selectedSkillNames: baseConfig.selectedSkillNames,
        fullPromptOverrideEnabled: false,
      }),
      subagentRuntimePrompt: buildSearchSubagentRuntimePrompt({
        query: queryPlaceholder,
        subagentConfig: baseConfig.subagent,
        fullPromptOverrideEnabled: false,
      }),
      validateSubagentSystemPrompt: buildSearchSubagentSystemPrompt({
        subagentConfig: baseConfig.validate.subagent,
        query: queryPlaceholder,
        strictness: baseConfig.validate.strictness,
        skillProfile: baseConfig.skillProfile,
        selectedSkillNames: baseConfig.selectedSkillNames,
        fullPromptOverrideEnabled: false,
        mode: "validate",
        answerToValidate: "{{answerToValidate}}",
      }),
      validateSubagentRuntimePrompt: buildSearchSubagentRuntimePrompt({
        query: queryPlaceholder,
        subagentConfig: baseConfig.validate.subagent,
        strictness: baseConfig.validate.strictness,
        fullPromptOverrideEnabled: false,
        mode: "validate",
        answerToValidate: "{{answerToValidate}}",
      }),
    };
  }, [resolvedDeepResearchConfig]);
  const nodeLookup = useMemo(() => {
    const map = new Map<string, FlowNode>();
    nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [nodes]);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [copyFeedbackState, setCopyFeedbackState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [copyFeedbackMessageId, setCopyFeedbackMessageId] = useState<string | null>(
    null,
  );
  const rawMessages = useMemo(() => messages, [messages]);
  const {
    hiddenValidateToolCallIds,
    latestValidateRunByResponseId,
    graphMessageByResponseId,
  } = useMemo(() => {
    const assistantResponseIds = new Set(
      rawMessages
        .filter(
          (message) =>
            message.role === "assistant" &&
            message.kind !== "graph-event" &&
            message.kind !== "subagent-event" &&
            message.kind !== "deepsearch-event",
        )
        .map((message) => message.id),
    );
    const allValidateToolCallIds = new Set<string>();
    const hiddenToolCallIds = new Set<string>();
    const responseIdByToolCall = new Map<string, string>();
    const deepSearchByToolCall = new Map<string, ChatMessage>();
    const subagentByToolCall = new Map<string, ChatMessage>();
    rawMessages.forEach((message) => {
      if (!isValidateDeepSearchEvent(message)) {
        return;
      }
      const toolCallId = readToolCallId(message.toolInput);
      const responseId = readResponseId(message.toolInput);
      if (!toolCallId || !responseId) {
        return;
      }
      allValidateToolCallIds.add(toolCallId);
      responseIdByToolCall.set(toolCallId, responseId);
      if (assistantResponseIds.has(responseId)) {
        hiddenToolCallIds.add(toolCallId);
      }
      const current = deepSearchByToolCall.get(toolCallId);
      if (shouldPreferDeepSearchMessage(current, message)) {
        deepSearchByToolCall.set(toolCallId, message);
      }
    });
    rawMessages.forEach((message) => {
      if (message.kind !== "subagent-event") {
        return;
      }
      const toolCallId = readToolCallId(message.toolInput);
      if (!toolCallId || !allValidateToolCallIds.has(toolCallId)) {
        return;
      }
      const current = subagentByToolCall.get(toolCallId);
      if (shouldPreferDeepSearchMessage(current, message)) {
        subagentByToolCall.set(toolCallId, message);
      }
    });
    const latestByResponseId = new Map<string, ValidateRunDetails>();
    allValidateToolCallIds.forEach((toolCallId) => {
      const responseId = responseIdByToolCall.get(toolCallId);
      if (!responseId) {
        return;
      }
      const nextRun: ValidateRunDetails = {
        responseId,
        toolCallId,
        deepSearchMessage: deepSearchByToolCall.get(toolCallId),
        subagentMessage: subagentByToolCall.get(toolCallId),
      };
      const currentRun = latestByResponseId.get(responseId);
      const currentMessage =
        currentRun?.deepSearchMessage ?? currentRun?.subagentMessage;
      const nextMessage = nextRun.deepSearchMessage ?? nextRun.subagentMessage;
      if (!nextMessage) {
        return;
      }
      if (shouldPreferLatestRunMessage(currentMessage, nextMessage)) {
        latestByResponseId.set(responseId, nextRun);
      }
    });

    const graphByResponseId = new Map<string, ChatMessage>();
    rawMessages.forEach((message) => {
      if (message.kind !== "graph-event") {
        return;
      }
      const graphToolInput = parseGraphToolInput(message.toolInput);
      const responseId = graphToolInput?.responseId;
      if (!responseId) {
        return;
      }
      const current = graphByResponseId.get(responseId);
      if (shouldPreferLatestRunMessage(current, message)) {
        graphByResponseId.set(responseId, message);
      }
    });

    return {
      hiddenValidateToolCallIds: hiddenToolCallIds,
      latestValidateRunByResponseId: latestByResponseId,
      graphMessageByResponseId: graphByResponseId,
    };
  }, [rawMessages]);
  const sortedMessages = useMemo(
    () =>
      rawMessages.filter((message) => {
        if (isValidateDeepSearchEvent(message)) {
          const toolCallId = readToolCallId(message.toolInput);
          if (!toolCallId) {
            return true;
          }
          return !hiddenValidateToolCallIds.has(toolCallId);
        }
        if (message.kind !== "subagent-event") {
          return true;
        }
        const toolCallId = readToolCallId(message.toolInput);
        if (!toolCallId) {
          return true;
        }
        return !hiddenValidateToolCallIds.has(toolCallId);
      }),
    [hiddenValidateToolCallIds, rawMessages],
  );
  const selectedSummary = useMemo(() => {
    if (!selectedNode) {
      return null;
    }
    if (selectedNode.type === "insight") {
      const data = selectedNode.data as InsightNodeData;
      if (data.responseId === "" && data.titleShort === "Start") {
        return null;
      }
      return {
        id: selectedNode.id,
        title: data.titleShort || data.titleLong,
        subtitle: data.excerpt,
        kind: "Insight",
      };
    }
    if (selectedNode.type === "source") {
      const data = selectedNode.data as SourceNodeData;
      return {
        id: selectedNode.id,
        title: data.title,
        subtitle: data.snippet ?? data.url,
        kind: "Source",
      };
    }
    if (selectedNode.type === "question") {
      const data = selectedNode.data as QuestionNodeData;
      return {
        id: selectedNode.id,
        title: data.question,
        subtitle: data.answer,
        kind: "Q/A",
      };
    }
    return null;
  }, [selectedNode]);
  const selectedExcerpt = useMemo(() => {
    if (!selectedNode || selectedNode.type !== "insight") {
      return "";
    }
    const data = selectedNode.data as InsightNodeData;
    if (data.responseId === "") {
      return "";
    }
    return data.excerpt ?? "";
  }, [selectedNode]);
  const selectedHighlightExcerptKey = useMemo(() => {
    const excerpt = selectedExcerpt.trim();
    if (!excerpt) {
      return null;
    }
    return getHighlightExcerptKey(excerpt);
  }, [selectedExcerpt]);
  const selectedTagLabel = useMemo(() => {
    if (!selectedSummary) {
      return "";
    }
    const title =
      typeof selectedSummary.title === "string" && selectedSummary.title.trim().length > 0
        ? selectedSummary.title.trim()
        : selectedSummary.kind;
    return title ? `@${title}` : "";
  }, [selectedSummary]);
  const nodeExcerptRefs = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "insight")
        .map((node) => {
          const data = node.data as InsightNodeData;
          return { id: node.id, text: data.excerpt ?? "" };
        })
        .filter((item) => item.text.trim().length > 0),
    [nodes],
  );
  useEffect(
    () => () => {
      if (stickyCollapseTimeoutRef.current !== null) {
        window.clearTimeout(stickyCollapseTimeoutRef.current);
        stickyCollapseTimeoutRef.current = null;
      }
      if (stickyPostClickCollapseTimeoutRef.current !== null) {
        window.clearTimeout(stickyPostClickCollapseTimeoutRef.current);
        stickyPostClickCollapseTimeoutRef.current = null;
      }
      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
        copyFeedbackTimeoutRef.current = null;
      }
      if (validateDetailsPopoverTimerRef.current !== null) {
        window.clearTimeout(validateDetailsPopoverTimerRef.current);
        validateDetailsPopoverTimerRef.current = null;
      }
    },
    [],
  );
  useEffect(() => {
    setToolOpenById((previous) => {
      const next = { ...previous };
      const activeIds = new Set<string>();
      let changed = false;
      sortedMessages.forEach((message) => {
        if (
          message.kind !== "graph-event" &&
          message.kind !== "subagent-event" &&
          message.kind !== "deepsearch-event"
        ) {
          return;
        }
        activeIds.add(message.id);
        if (next[message.id] === undefined) {
          next[message.id] = false;
          changed = true;
        }
      });
      Object.keys(next).forEach((id) => {
        if (activeIds.has(id)) {
          return;
        }
        delete next[id];
        changed = true;
      });
      if (!changed) {
        return previous;
      }
      return next;
    });
  }, [sortedMessages]);

  const handleNodeLinkClick = useCallback(
    (nodeId: string) => {
      if (!onFocusNode) {
        return;
      }
      onFocusNode(nodeId);
    },
    [onFocusNode],
  );
  const resolveNodeLabel = useCallback(
    (nodeId: string) => {
      const node = nodeLookup.get(nodeId);
      if (!node) {
        return undefined;
      }
      if (node.type === "question") {
        const data = node.data as QuestionNodeData;
        return data.question;
      }
      if (node.type === "source") {
        const data = node.data as SourceNodeData;
        return data.title ?? data.url;
      }
      if (node.type === "insight") {
        const data = node.data as InsightNodeData;
        return data.titleShort ?? data.titleLong ?? data.titleTiny;
      }
      return undefined;
    },
    [nodeLookup],
  );
  const renderUserContent = useCallback(
    (text: string) => {
      const parts: React.ReactNode[] = [];
      const regex = /\[\[node:([^\]|]+)(?:\|([^\]]+))?\]\]/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const [raw, nodeId, label] = match;
        const start = match.index;
        if (start > lastIndex) {
          parts.push(text.slice(lastIndex, start));
        }
        const cleanedLabel = label?.trim();
        const resolvedLabel =
          cleanedLabel ??
          resolveNodeLabel(nodeId) ??
          `Node ${nodeId.slice(0, 6)}`;
        parts.push(
          <button
            key={`node-${nodeId}-${start}`}
            type="button"
            onClick={() => handleNodeLinkClick(nodeId)}
            className="mx-1 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary shadow-sm shadow-black/20 transition hover:-translate-y-0.5 hover:border-primary/60 hover:bg-primary/15"
            title={`Focus node ${resolvedLabel}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 shadow-[0_0_8px_rgba(14,165,233,0.6)]" />
            <span className="max-w-[240px] truncate">{resolvedLabel}</span>
          </button>,
        );
        lastIndex = start + raw.length;
      }
      if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
      }
      return parts.length > 0 ? parts : text;
    },
    [handleNodeLinkClick, resolveNodeLabel],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!scrollRef.current) {
        return;
      }
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior,
      });
    },
    [scrollRef],
  );

  const recomputeActiveStickyQuestions = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      setActiveStickyQuestionById((previous) =>
        Object.keys(previous).length > 0 ? {} : previous,
      );
      return;
    }
    setActiveStickyQuestionById((previous) => {
      const next: Record<string, boolean> = {};
      for (const [messageId, anchor] of stickyQuestionAnchorByIdRef.current) {
        if (container.scrollTop >= anchor.offsetTop - 1) {
          next[messageId] = true;
        }
      }
      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      if (previousKeys.length !== nextKeys.length) {
        return next;
      }
      for (const key of nextKeys) {
        if (next[key] !== previous[key]) {
          return next;
        }
      }
      return previous;
    });
  }, [scrollRef]);

  const registerStickyQuestionAnchor = useCallback(
    (messageId: string, element: HTMLDivElement | null) => {
      const map = stickyQuestionAnchorByIdRef.current;
      if (element) {
        map.set(messageId, element);
      } else {
        map.delete(messageId);
      }
      window.requestAnimationFrame(() => {
        recomputeActiveStickyQuestions();
      });
    },
    [recomputeActiveStickyQuestions],
  );

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) {
      return;
    }
    const el = scrollRef.current;
    const threshold = 24;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    setIsAtBottom(atBottom);
    recomputeActiveStickyQuestions();
  }, [recomputeActiveStickyQuestions, scrollRef]);

  const registerStickyQuestionElement = useCallback(
    (messageId: string, element: HTMLDivElement | null) => {
      const map = stickyQuestionElementByIdRef.current;
      if (element) {
        map.set(messageId, element);
        return;
      }
      map.delete(messageId);
    },
    [],
  );

  const measureStickyQuestionHeights = useCallback(() => {
    setStickyQuestionHeightById((previous) => {
      const next: Record<string, number> = {};
      for (const [messageId, element] of stickyQuestionElementByIdRef.current) {
        const height = Math.ceil(element.getBoundingClientRect().height);
        if (height > 0) {
          next[messageId] = height;
        }
      }
      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      if (previousKeys.length !== nextKeys.length) {
        return next;
      }
      for (const key of nextKeys) {
        if (next[key] !== previous[key]) {
          return next;
        }
      }
      return previous;
    });
  }, []);

  const expandStickyQuestions = useCallback(() => {
    if (stickyCollapseTimeoutRef.current !== null) {
      window.clearTimeout(stickyCollapseTimeoutRef.current);
      stickyCollapseTimeoutRef.current = null;
    }
    if (stickyPostClickCollapseTimeoutRef.current !== null) {
      window.clearTimeout(stickyPostClickCollapseTimeoutRef.current);
      stickyPostClickCollapseTimeoutRef.current = null;
    }
    measureStickyQuestionHeights();
    setStickyQuestionsExpanded(true);
    window.requestAnimationFrame(() => {
      measureStickyQuestionHeights();
    });
  }, [measureStickyQuestionHeights]);

  const collapseStickyQuestions = useCallback(() => {
    if (stickyCollapseTimeoutRef.current !== null) {
      window.clearTimeout(stickyCollapseTimeoutRef.current);
    }
    if (stickyPostClickCollapseTimeoutRef.current !== null) {
      window.clearTimeout(stickyPostClickCollapseTimeoutRef.current);
      stickyPostClickCollapseTimeoutRef.current = null;
    }
    const now = Date.now();
    const remainingLockMs = Math.max(
      0,
      stickyManualFocusLockUntilRef.current - now,
    );
    stickyCollapseTimeoutRef.current = window.setTimeout(() => {
      setStickyQuestionsExpanded(false);
      stickyCollapseTimeoutRef.current = null;
    }, STICKY_COLLAPSE_DELAY_MS + remainingLockMs);
  }, []);

  const scheduleStickyPostClickCollapse = useCallback(() => {
    if (stickyPostClickCollapseTimeoutRef.current !== null) {
      window.clearTimeout(stickyPostClickCollapseTimeoutRef.current);
      stickyPostClickCollapseTimeoutRef.current = null;
    }
    stickyPostClickCollapseTimeoutRef.current = window.setTimeout(() => {
      const container = scrollRef.current;
      if (!container) {
        setStickyQuestionsExpanded(false);
        stickyPostClickCollapseTimeoutRef.current = null;
        return;
      }
      const hoveringSticky = container.querySelector(
        '[data-sticky-card="true"]:hover',
      );
      if (!hoveringSticky) {
        setStickyQuestionsExpanded(false);
      }
      stickyPostClickCollapseTimeoutRef.current = null;
    }, STICKY_POST_CLICK_COLLAPSE_DELAY_MS);
  }, [scrollRef]);

  const handleStickyQuestionFocus = useCallback(
    (messageId: string) => {
      const container = scrollRef.current;
      if (!container) {
        return;
      }
      if (stickyCollapseTimeoutRef.current !== null) {
        window.clearTimeout(stickyCollapseTimeoutRef.current);
        stickyCollapseTimeoutRef.current = null;
      }
      stickyManualFocusLockUntilRef.current = Date.now() + 900;
      setStickyQuestionsExpanded(true);
      setIsAtBottom(false);
      scheduleStickyPostClickCollapse();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          measureStickyQuestionHeights();
          const cardTarget = container.querySelector<HTMLElement>(
            `[data-message-id="${messageId}"]`,
          );
          if (!cardTarget) {
            return;
          }
          const orderRaw = cardTarget.dataset.stickyOrder;
          const parsedOrder = orderRaw ? Number.parseInt(orderRaw, 10) : 1;
          const stickyOrder =
            Number.isFinite(parsedOrder) && parsedOrder > 0 ? parsedOrder : 1;
          const stickyEntries = Array.from(
            stickyQuestionElementByIdRef.current.entries(),
          )
            .map(([id, element]) => {
              const entryOrderRaw = element.dataset.stickyOrder;
              const entryOrder = entryOrderRaw
                ? Number.parseInt(entryOrderRaw, 10)
                : 0;
              return {
                id,
                order:
                  Number.isFinite(entryOrder) && entryOrder > 0 ? entryOrder : 0,
                height:
                  Math.ceil(element.getBoundingClientRect().height) ||
                  stickyQuestionHeightById[id] ||
                  STICKY_STACK_EXPANDED_FALLBACK_HEIGHT_PX,
              };
            })
            .filter((entry) => entry.order > 0)
            .sort((left, right) => left.order - right.order);
          let expandedTopOffset = 0;
          for (const entry of stickyEntries) {
            if (entry.order >= stickyOrder) {
              break;
            }
            expandedTopOffset += entry.height + STICKY_STACK_EXPANDED_GAP_PX;
          }
          const safeTopInset = expandedTopOffset + STICKY_FOCUS_SAFETY_GAP_PX;

          const anchorTarget =
            container.querySelector<HTMLElement>(
              `[data-scroll-anchor-id="${messageId}"]`,
            ) ?? cardTarget;
          const containerRect = container.getBoundingClientRect();
          const targetRect = anchorTarget.getBoundingClientRect();
          const anchorTop =
            container.scrollTop + (targetRect.top - containerRect.top);
          const nextTop = Math.max(0, anchorTop - safeTopInset);
          container.scrollTo({
            top: nextTop,
            behavior: "smooth",
          });
        });
      });
    },
    [
      measureStickyQuestionHeights,
      scheduleStickyPostClickCollapse,
      scrollRef,
      stickyQuestionHeightById,
    ],
  );

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    if (Date.now() < stickyManualFocusLockUntilRef.current) {
      return;
    }
    let frameId: number | null = null;
    if (highlightedId && !ignoreHighlightRef.current) {
      let retryCount = 0;

      const scrollToHighlightedExcerpt = () => {
        const container = scrollRef.current;
        if (!container) {
          return;
        }
        const target = container.querySelector<HTMLElement>(
          `[data-message-id="${highlightedId}"]`,
        );
        if (!target) {
          return;
        }

        const excerptSelector = selectedHighlightExcerptKey
          ? `mark[data-highlight-excerpt-key="${selectedHighlightExcerptKey}"]`
          : 'mark[data-highlight-excerpt="true"]';
        const excerpt = target.querySelector<HTMLElement>(excerptSelector);
        if (excerpt) {
          excerpt.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          return;
        }

        if (retryCount >= HIGHLIGHT_SCROLL_MAX_RETRIES) {
          target.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          return;
        }

        retryCount += 1;
        frameId = window.requestAnimationFrame(() => {
          frameId = null;
          scrollToHighlightedExcerpt();
        });
      };

      scrollToHighlightedExcerpt();
      return () => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }
    ignoreHighlightRef.current = false;
    if (isAtBottom) {
      scrollToBottom("smooth");
    }
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    highlightedId,
    focusSignal,
    selectedHighlightExcerptKey,
    sortedMessages.length,
    isAtBottom,
    scrollRef,
    scrollToBottom,
  ]);

  useEffect(() => {
    if (scrollToBottomSignal === 0) {
      return;
    }
    if (Date.now() < stickyManualFocusLockUntilRef.current) {
      return;
    }
    setIsAtBottom(true);
    ignoreHighlightRef.current = true;
    scrollToBottom("smooth");
  }, [scrollToBottomSignal, scrollToBottom]);

  useEffect(() => {
    handleScroll();
  }, [handleScroll, sortedMessages.length, busy, graphBusy]);

  const chatItems = useMemo(() => {
    const items: ChatItem[] = [];
    const deepSearchByToolCall = new Map<string, ChatMessage>();
    const subagentToolCallIds = new Set<string>();
    let lastDateKey = "";
    let lastRole: ChatMessage["role"] | null = null;

    sortedMessages.forEach((message) => {
      if (message.kind === "subagent-event") {
        const toolCallId = readToolCallId(message.toolInput);
        if (toolCallId) {
          subagentToolCallIds.add(toolCallId);
        }
      }
      if (message.kind !== "deepsearch-event") {
        return;
      }
      const toolCallId = readToolCallId(message.toolInput);
      if (!toolCallId) {
        return;
      }
      const current = deepSearchByToolCall.get(toolCallId);
      if (shouldPreferDeepSearchMessage(current, message)) {
        deepSearchByToolCall.set(toolCallId, message);
      }
    });

    sortedMessages.forEach((message) => {
      const timestamp = new Date(message.createdAt).getTime();
      const dateKey = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(timestamp);

      if (dateKey !== lastDateKey) {
        items.push({
          kind: "date",
          id: `date-${dateKey}-${items.length}`,
          timestamp,
        });
        lastDateKey = dateKey;
        lastRole = null;
      }

      if (message.kind === "graph-event") {
        items.push({ kind: "graph", id: message.id, message });
        lastRole = null;
        return;
      }
      if (message.kind === "subagent-event") {
        const toolCallId = readToolCallId(message.toolInput);
        const deepSearchMessage = toolCallId
          ? deepSearchByToolCall.get(toolCallId)
          : undefined;
        items.push({
          kind: "subagent",
          id: message.id,
          message,
          deepSearchMessage,
        });
        lastRole = null;
        return;
      }
      if (message.kind === "deepsearch-event") {
        const toolCallId = readToolCallId(message.toolInput);
        if (toolCallId && subagentToolCallIds.has(toolCallId)) {
          // Prefer rendering deep-search updates inside the matching subagent card.
          lastRole = null;
          return;
        }
        items.push({ kind: "deepsearch", id: message.id, message });
        lastRole = null;
        return;
      }

      if (lastRole === message.role) {
        items.push({ kind: "additional", id: message.id, message });
      } else {
        items.push({ kind: "primary", id: message.id, message });
        lastRole = message.role;
      }
    });

    return items;
  }, [sortedMessages]);

  const stickyQuestionItems = useMemo(() => {
    const items: StickyQuestionItem[] = [];
    let order = 1;
    sortedMessages.forEach((message) => {
      if (
        message.kind === "graph-event" ||
        message.kind === "subagent-event" ||
        message.kind === "deepsearch-event" ||
        message.role !== "user"
      ) {
        return;
      }
      items.push({
        messageId: message.id,
        order,
      });
      order += 1;
    });
    return items;
  }, [sortedMessages]);

  const stickyQuestionOrderByMessageId = useMemo(() => {
    const map = new Map<string, number>();
    stickyQuestionItems.forEach((item) => {
      map.set(item.messageId, item.order);
    });
    return map;
  }, [stickyQuestionItems]);

  const stickyQuestionExpandedTopOffsetById = useMemo(() => {
    const map = new Map<string, number>();
    let offset = 0;
    stickyQuestionItems.forEach((item) => {
      map.set(item.messageId, offset);
      const height =
        stickyQuestionHeightById[item.messageId] ??
        STICKY_STACK_EXPANDED_FALLBACK_HEIGHT_PX;
      offset += height + STICKY_STACK_EXPANDED_GAP_PX;
    });
    return map;
  }, [stickyQuestionHeightById, stickyQuestionItems]);

  useEffect(() => {
    if (stickyQuestionItems.length > 1) {
      return;
    }
    if (stickyCollapseTimeoutRef.current !== null) {
      window.clearTimeout(stickyCollapseTimeoutRef.current);
      stickyCollapseTimeoutRef.current = null;
    }
    if (stickyQuestionsExpanded) {
      setStickyQuestionsExpanded(false);
    }
    setActiveStickyQuestionById((previous) =>
      Object.keys(previous).length > 0 ? {} : previous,
    );
  }, [stickyQuestionItems.length, stickyQuestionsExpanded]);

  useEffect(() => {
    if (!stickyQuestionsExpanded) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      measureStickyQuestionHeights();
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [measureStickyQuestionHeights, stickyQuestionsExpanded, sortedMessages.length]);

  useEffect(() => {
    if (stickyQuestionItems.length === 0) {
      setActiveStickyQuestionById((previous) =>
        Object.keys(previous).length > 0 ? {} : previous,
      );
      return;
    }
    recomputeActiveStickyQuestions();
  }, [recomputeActiveStickyQuestions, stickyQuestionItems.length, sortedMessages.length]);

  const toolGroupIds = useMemo(() => {
    const ids: string[] = [];
    chatItems.forEach((item, index) => {
      if (!isToolChatItem(item)) {
        return;
      }
      const previous = index > 0 ? chatItems[index - 1] : undefined;
      if (previous && isToolChatItem(previous)) {
        return;
      }
      ids.push(`tool-group-${item.id}`);
    });
    return ids;
  }, [chatItems]);

  useEffect(() => {
    setToolGroupOpenById((previous) => {
      const next = { ...previous };
      const activeIds = new Set(toolGroupIds);
      let changed = false;

      toolGroupIds.forEach((id) => {
        if (next[id] !== undefined) {
          return;
        }
        next[id] = false;
        changed = true;
      });

      Object.keys(next).forEach((id) => {
        if (activeIds.has(id)) {
          return;
        }
        delete next[id];
        changed = true;
      });

      if (!changed) {
        return previous;
      }
      return next;
    });
  }, [toolGroupIds]);

  const hasPendingAssistant = useMemo(
    () =>
      sortedMessages.some(
        (message) =>
          message.role === "assistant" && message.status === "pending",
      ),
    [sortedMessages],
  );
  const hasBrowserSelection = Boolean(
    browserSelection && browserSelection.text.trim().length > 0,
  );
  const browserSelectionLabel = useMemo(() => {
    if (!browserSelection) {
      return "";
    }
    const text = browserSelection.text.trim().replace(/\s+/g, " ");
    if (!text) {
      return "";
    }
    return text.length > 80 ? `${text.slice(0, 80)}...` : text;
  }, [browserSelection]);
  const latestAssistantMessage = useMemo(() => {
    for (let index = sortedMessages.length - 1; index >= 0; index -= 1) {
      const message = sortedMessages[index];
      if (isToolEventMessage(message) || message.role !== "assistant") {
        continue;
      }
      if (message.content.trim().length === 0) {
        continue;
      }
      return message;
    }
    return null;
  }, [sortedMessages]);
  const lastFailedMessageId = useMemo(() => {
    if (lastFailedMessageIdProp !== undefined) {
      return lastFailedMessageIdProp;
    }
    for (let index = sortedMessages.length - 1; index >= 0; index -= 1) {
      const message = sortedMessages[index];
      if (isToolEventMessage(message)) {
        continue;
      }
      return message.status === "failed" ? message.id : null;
    }
    return null;
  }, [lastFailedMessageIdProp, sortedMessages]);
  const showRetry = Boolean(lastFailedMessageId && onRetry);
  const hasInput = input.trim().length > 0;
  const retryOnly = showRetry && !hasInput;
  const canStop = busy && Boolean(onStop);
  const canStopAsync = asyncBusy && Boolean(onStopAsync);
  const primaryActionLabel = canStop
    ? "Stop generation"
    : retryOnly
      ? "Retry request"
      : "Send message";
  const asyncActionLabel = "Stop async tasks";
  const handleCopyAssistantMessage = useCallback(async (message: ChatMessage) => {
    const text = message.content.trim();
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedbackState("copied");
      setCopyFeedbackMessageId(message.id);
    } catch {
      setCopyFeedbackState("failed");
      setCopyFeedbackMessageId(message.id);
    }
    if (copyFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = window.setTimeout(() => {
      copyFeedbackTimeoutRef.current = null;
      setCopyFeedbackState("idle");
      setCopyFeedbackMessageId(null);
    }, 1400);
  }, []);
  const clearValidateDetailsPopoverTimer = useCallback(() => {
    if (validateDetailsPopoverTimerRef.current !== null) {
      window.clearTimeout(validateDetailsPopoverTimerRef.current);
      validateDetailsPopoverTimerRef.current = null;
    }
  }, []);
  const openValidateDetailsPopover = useCallback(
    (messageId: string) => {
      clearValidateDetailsPopoverTimer();
      setValidateDetailsPopoverMessageId(messageId);
    },
    [clearValidateDetailsPopoverTimer],
  );
  const scheduleCloseValidateDetailsPopover = useCallback(() => {
    clearValidateDetailsPopoverTimer();
    validateDetailsPopoverTimerRef.current = window.setTimeout(() => {
      validateDetailsPopoverTimerRef.current = null;
      setValidateDetailsPopoverMessageId(null);
    }, 140);
  }, [clearValidateDetailsPopoverTimer]);
  useEffect(() => {
    if (!validateDetailsPopoverMessageId) {
      return;
    }
    const exists = sortedMessages.some(
      (message) => message.id === validateDetailsPopoverMessageId,
    );
    if (!exists) {
      setValidateDetailsPopoverMessageId(null);
    }
  }, [sortedMessages, validateDetailsPopoverMessageId]);
  const handlePrimaryAction = useCallback(() => {
    if (canStop) {
      onStop?.();
      return;
    }
    if (retryOnly && lastFailedMessageId && onRetry) {
      onRetry(lastFailedMessageId);
      return;
    }
    onSend();
  }, [canStop, lastFailedMessageId, onRetry, onSend, onStop, retryOnly]);
  const patchDeepResearchConfig = useCallback(
    (patch: Partial<DeepResearchConfig>) => {
      onDeepResearchConfigChange(
        resolveDeepResearchConfig({
          ...resolvedDeepResearchConfig,
          ...patch,
        }),
      );
    },
    [onDeepResearchConfigChange, resolvedDeepResearchConfig],
  );
  const setSearchPolicy = useCallback(
    (strictness: DeepResearchStrictness) => {
      patchDeepResearchConfig({
        strictness,
        enabled:
          strictness === "no-search"
            ? resolvedDeepResearchConfig.enabled
            : true,
      });
    },
    [patchDeepResearchConfig, resolvedDeepResearchConfig.enabled],
  );
  const setValidateStrictness = useCallback(
    (strictness: ValidateStrictness) => {
      patchDeepResearchConfig({
        validate: {
          ...resolvedDeepResearchConfig.validate,
          strictness,
        },
      });
    },
    [patchDeepResearchConfig, resolvedDeepResearchConfig.validate],
  );
  const setValidateAutoEnabled = useCallback(
    (enabled: boolean) => {
      patchDeepResearchConfig({
        validate: {
          ...resolvedDeepResearchConfig.validate,
          enabled,
          strictness: normalizeValidateStrictness(
            resolvedDeepResearchConfig.validate.strictness,
          ),
        },
      });
    },
    [patchDeepResearchConfig, resolvedDeepResearchConfig.validate],
  );
  const handleSearchEnabledSwitchChange = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setSearchPolicy("no-search");
        return;
      }
      setSearchPolicy(
        searchPolicy === "all-claims" ? "all-claims" : "uncertain-claims",
      );
    },
    [searchPolicy, setSearchPolicy],
  );
  const handleSearchAllClaimsSwitchChange = useCallback(
    (checked: boolean) => {
      setSearchPolicy(checked ? "all-claims" : "uncertain-claims");
    },
    [setSearchPolicy],
  );
  const handleValidateEnabledSwitchChange = useCallback(
    (checked: boolean) => {
      setValidateAutoEnabled(checked);
    },
    [setValidateAutoEnabled],
  );
  const handleValidateAllClaimsSwitchChange = useCallback(
    (checked: boolean) => {
      setValidateStrictness(checked ? "all-claims" : "uncertain-claims");
    },
    [setValidateStrictness],
  );
  const handleToggleDeepResearchMaster = useCallback(() => {
    patchDeepResearchConfig({
      enabled: !resolvedDeepResearchConfig.enabled,
    });
  }, [patchDeepResearchConfig, resolvedDeepResearchConfig.enabled]);
  const patchSubagentConfig = useCallback(
    (patch: Partial<DeepResearchConfig["subagent"]>) => {
      onDeepResearchConfigChange(
        resolveDeepResearchConfig({
          ...resolvedDeepResearchConfig,
          subagent: {
            ...resolvedDeepResearchConfig.subagent,
            ...patch,
          },
        }),
      );
    },
    [onDeepResearchConfigChange, resolvedDeepResearchConfig],
  );
  const patchValidateSubagentConfig = useCallback(
    (patch: Partial<DeepResearchConfig["validate"]["subagent"]>) => {
      onDeepResearchConfigChange(
        resolveDeepResearchConfig({
          ...resolvedDeepResearchConfig,
          validate: {
            ...resolvedDeepResearchConfig.validate,
            subagent: {
              ...resolvedDeepResearchConfig.validate.subagent,
              ...patch,
            },
          },
        }),
      );
    },
    [onDeepResearchConfigChange, resolvedDeepResearchConfig],
  );
  const handleNumericSubagentChange = useCallback(
    (
      key:
        | "maxSearchCalls"
        | "maxExtractCalls"
        | "maxRepeatSearchQuery"
        | "maxRepeatExtractUrl",
      rawValue: string,
    ) => {
      const parsed = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }
      patchSubagentConfig({
        [key]: parsed,
      } as Partial<DeepResearchConfig["subagent"]>);
    },
    [patchSubagentConfig],
  );
  const handleNumericValidateSubagentChange = useCallback(
    (
      key:
        | "maxSearchCalls"
        | "maxExtractCalls"
        | "maxRepeatSearchQuery"
        | "maxRepeatExtractUrl",
      rawValue: string,
    ) => {
      const parsed = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }
      patchValidateSubagentConfig({
        [key]: parsed,
      } as Partial<DeepResearchConfig["validate"]["subagent"]>);
    },
    [patchValidateSubagentConfig],
  );
  const handleFullPromptOverrideToggle = useCallback(
    (checked: boolean) => {
      if (!checked) {
        patchDeepResearchConfig({ fullPromptOverrideEnabled: false });
        return;
      }
      onDeepResearchConfigChange(
        resolveDeepResearchConfig({
          ...resolvedDeepResearchConfig,
          fullPromptOverrideEnabled: true,
          mainPromptOverride:
            resolvedDeepResearchConfig.mainPromptOverride ??
            defaultOverridePrompts.mainPrompt,
          subagent: {
            ...resolvedDeepResearchConfig.subagent,
            systemPromptOverride:
              resolvedDeepResearchConfig.subagent.systemPromptOverride ??
              defaultOverridePrompts.subagentSystemPrompt,
            promptOverride:
              resolvedDeepResearchConfig.subagent.promptOverride ??
              defaultOverridePrompts.subagentRuntimePrompt,
          },
          validate: {
            ...resolvedDeepResearchConfig.validate,
            subagent: {
              ...resolvedDeepResearchConfig.validate.subagent,
              systemPromptOverride:
                resolvedDeepResearchConfig.validate.subagent
                  .systemPromptOverride ??
                defaultOverridePrompts.validateSubagentSystemPrompt,
              promptOverride:
                resolvedDeepResearchConfig.validate.subagent.promptOverride ??
                defaultOverridePrompts.validateSubagentRuntimePrompt,
            },
          },
        }),
      );
    },
    [
      defaultOverridePrompts.mainPrompt,
      defaultOverridePrompts.subagentRuntimePrompt,
      defaultOverridePrompts.subagentSystemPrompt,
      defaultOverridePrompts.validateSubagentRuntimePrompt,
      defaultOverridePrompts.validateSubagentSystemPrompt,
      onDeepResearchConfigChange,
      patchDeepResearchConfig,
      resolvedDeepResearchConfig,
    ],
  );

  const refreshSkillCatalog = useCallback(
    async (useRefreshRoute = false) => {
      setSkillsLoading(true);
      setSkillsError(null);
      try {
        const payload = useRefreshRoute
          ? await trpc.skills.refresh.query()
          : await trpc.skills.list.query();
        setSkillsDirectory(payload.directory ?? "");
        const options = payload.skills
          .filter((skill) => skill.isSearchSkill)
          .map((skill) => ({
            name: skill.name,
            title: skill.title,
            description: skill.description,
            relativePath: skill.relativePath,
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        setSearchSkillOptions(options);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to scan skills directory.";
        setSkillsError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        setSkillsLoading(false);
      }
    },
    [],
  );

  const handleOpenSkillsDirectory = useCallback(async () => {
    setSkillsError(null);
    try {
      const result = await trpc.skills.openDirectory.mutate();
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to open skills directory.");
      }
      setSkillsDirectory(result.directory ?? "");
      await refreshSkillCatalog(true);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to open skills directory.";
      setSkillsError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }, [refreshSkillCatalog]);

  const handleToggleSelectedSkill = useCallback(
    (skillName: string) => {
      const normalizedName = skillName.trim();
      if (!normalizedName) {
        return;
      }
      const current = new Set(selectedSkillNames);
      if (current.has(normalizedName)) {
        current.delete(normalizedName);
      } else {
        current.add(normalizedName);
      }
      patchDeepResearchConfig({
        selectedSkillNames: Array.from(current.values()),
      });
    },
    [patchDeepResearchConfig, selectedSkillNames],
  );

  useEffect(() => {
    if (!deepResearchQuickOpen) {
      return;
    }
    void refreshSkillCatalog();
  }, [deepResearchQuickOpen, refreshSkillCatalog]);

  const getToolStatusLabel = useCallback((status: ChatMessage["toolStatus"]) => {
    if (status === "running") {
      return "Running";
    }
    if (status === "failed") {
      return "Failed";
    }
    return "Complete";
  }, []);

  const getExecutionStatusLabel = useCallback((status: ToolExecutionStatus) => {
    if (status === "running") {
      return "running";
    }
    if (status === "failed") {
      return "failed";
    }
    return "done";
  }, []);

  const getToolItemStatuses = useCallback(
    (item: ToolChatItem): ToolExecutionStatus[] => {
      if (item.kind !== "subagent") {
        return [toExecutionStatus(item.message.toolStatus)];
      }

      const outputPayloadRaw = parseToolPayload(item.message.toolOutput);
      const outputPayload = isSubagentPayload(outputPayloadRaw)
        ? outputPayloadRaw
        : null;
      const entries = outputPayload ? buildSubagentEntries(outputPayload) : [];
      const parentStatus = resolveSubagentParentExecutionStatus(
        item.message,
        item.deepSearchMessage,
      );
      const normalizedEntries = normalizeSubagentEntryStatuses(
        entries,
        parentStatus,
      );
      const statuses = normalizedEntries.map((entry) => entry.status);
      const deepSearchStatus = item.deepSearchMessage?.toolStatus;
      if (deepSearchStatus) {
        statuses.push(toExecutionStatus(deepSearchStatus));
      }
      if (statuses.length === 0) {
        statuses.push(parentStatus);
      }
      return statuses;
    },
    [],
  );

  const getGroupToolStatus = useCallback(
    (progress: ToolProgress): ChatMessage["toolStatus"] => {
      if (progress.running > 0) {
        return "running";
      }
      if (progress.failed > 0) {
        return "failed";
      }
      return "complete";
    },
    [],
  );

  const getToolGroupStatusLabel = useCallback(
    (itemCount: number, progress: ToolProgress): string => {
      const base = `${itemCount} tool${itemCount === 1 ? "" : "s"}`;
      if (progress.running > 0) {
        return `${base} · ${progress.running} running`;
      }
      if (progress.failed > 0) {
        return `${base} · ${progress.failed} failed`;
      }
      return `${base} · all done`;
    },
    [],
  );

  const getProgressPercent = useCallback((progress: ToolProgress): number => {
    if (progress.total <= 0) {
      return 0;
    }
    const ratio = progress.done / progress.total;
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  }, []);

  const getToolCardClassName = useCallback((status: ChatMessage["toolStatus"]) => {
    if (status === "running") {
      return "message-marquee border-sky-400/50 bg-sky-500/5";
    }
    if (status === "failed") {
      return "border-destructive/40 bg-destructive/10";
    }
    return "border-border/60 bg-card/25";
  }, []);

  const renderCompleteIcon = useCallback(
    (status: ChatMessage["toolStatus"]) =>
      status === "complete" ? (
        <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-label="Complete" />
      ) : null,
    [],
  );

  const renderExecutionStatusIcon = useCallback((status: ToolExecutionStatus) => {
    if (status === "complete") {
      return <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />;
    }
    if (status === "failed") {
      return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
    }
    return (
      <Loader2
        className="h-3.5 w-3.5 animate-spin text-sky-400"
        style={{ animationDuration: "2.2s" }}
      />
    );
  }, []);

  const renderToolProgress = useCallback(
    (progress: ToolProgress, status: ChatMessage["toolStatus"]) => {
      const progressPercent = getProgressPercent(progress);
      const barClassName =
        status === "failed"
          ? "bg-destructive/70"
          : progress.running > 0
            ? "bg-sky-400/80"
            : "bg-emerald-500/70";
      return (
        <div className="mt-2 space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className={cn("h-full transition-[width] duration-300", barClassName)}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{`${progress.done}/${progress.total} done`}</span>
            {progress.running > 0 ? (
              <span>{`${progress.running} running`}</span>
            ) : progress.failed > 0 ? (
              <span>{`${progress.failed} failed`}</span>
            ) : (
              <span>all done</span>
            )}
          </div>
        </div>
      );
    },
    [getProgressPercent],
  );

  const renderEventLogo = useCallback(
    (kind: "graph" | "subagent" | "deepsearch") => {
      if (kind === "graph") {
        return (
          <div className="mx-auto flex size-8 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-foreground/70 @md/chat:size-10">
            <Network className="size-4 @md/chat:size-5" />
          </div>
        );
      }
      if (kind === "subagent") {
        return (
          <div className="mx-auto flex size-8 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-foreground/70 @md/chat:size-10">
            <MessageSquare className="size-4 @md/chat:size-5" />
          </div>
        );
      }
      return (
        <div className="mx-auto flex size-8 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-foreground/70 @md/chat:size-10">
          <SearchIcon className="size-4 @md/chat:size-5" />
        </div>
      );
    },
    [],
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden border border-border/70 bg-background/85 shadow-2xl shadow-black/25 backdrop-blur">
      <Chat>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatMessages
            ref={scrollRef}
            onScroll={handleScroll}
            contentRef={contentRef}
          >
            {messages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">
                Ask a question to build the conversation.
              </div>
            ) : (
              chatItems.map((item, index) => {
              if (item.kind === "date") {
                return <DateItem key={item.id} timestamp={item.timestamp} />;
              }

              let isToolGroupStart = false;
              let toolGroupId: string | null = null;
              let toolGroupOpen = true;
              let toolGroupStatus: ChatMessage["toolStatus"] = "complete";
              let toolGroupProgress: ToolProgress | null = null;
              let toolGroupStatusLabel = "";
              let toolGroupCount = 0;

              if (isToolChatItem(item)) {
                let startIndex = index;
                while (
                  startIndex > 0 &&
                  isToolChatItem(chatItems[startIndex - 1])
                ) {
                  startIndex -= 1;
                }
                const startItem = chatItems[startIndex];
                if (startItem && isToolChatItem(startItem)) {
                  isToolGroupStart = startIndex === index;
                  toolGroupId = `tool-group-${startItem.id}`;
                  toolGroupOpen = toolGroupOpenById[toolGroupId] ?? false;

                  if (!isToolGroupStart && !toolGroupOpen) {
                    return null;
                  }

                  if (isToolGroupStart) {
                    const groupItems: ToolChatItem[] = [];
                    for (let cursor = startIndex; cursor < chatItems.length; cursor += 1) {
                      const candidate = chatItems[cursor];
                      if (!isToolChatItem(candidate)) {
                        break;
                      }
                      groupItems.push(candidate);
                    }

                    const statuses = groupItems.flatMap((toolItem) =>
                      getToolItemStatuses(toolItem),
                    );
                    const fallbackStatus =
                      groupItems.length > 0
                        ? toExecutionStatus(groupItems[0].message.toolStatus)
                        : toExecutionStatus(item.message.toolStatus);
                    const resolvedStatuses =
                      statuses.length > 0 ? statuses : [fallbackStatus];
                    toolGroupProgress = getProgressByStatuses(resolvedStatuses);
                    toolGroupStatus = getGroupToolStatus(toolGroupProgress);
                    toolGroupCount = groupItems.length;
                    toolGroupStatusLabel = getToolGroupStatusLabel(
                      toolGroupCount,
                      toolGroupProgress,
                    );
                  }
                }
              }

              const wrapToolCard = (card: React.ReactNode): React.ReactNode => {
                if (!isToolChatItem(item)) {
                  return card;
                }
                if (!isToolGroupStart || !toolGroupId || !toolGroupProgress) {
                  return toolGroupOpen ? card : null;
                }
                return (
                  <div key={toolGroupId} className="space-y-2">
                    <ChatEvent className="items-start gap-2 px-2">
                      <ChatEventAddon>
                        <div className="mx-auto flex size-8 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-foreground/70 @md/chat:size-10">
                          <Wrench className="size-4 @md/chat:size-5" />
                        </div>
                      </ChatEventAddon>
                      <ChatEventBody
                        className={cn(
                          "rounded-md border px-3 py-2",
                          getToolCardClassName(toolGroupStatus),
                        )}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <ChatEventTitle className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            Tools
                          </ChatEventTitle>
                          <div className="flex items-center gap-1">
                            {renderCompleteIcon(toolGroupStatus)}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "h-6 w-6 text-muted-foreground transition-transform",
                                toolGroupOpen && "rotate-180",
                              )}
                              onClick={() => {
                                setToolGroupOpenById((previous) => ({
                                  ...previous,
                                  [toolGroupId]: !toolGroupOpen,
                                }));
                              }}
                              aria-label={toolGroupOpen ? "Collapse tools" : "Expand tools"}
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        <ChatEventDescription>{toolGroupStatusLabel}</ChatEventDescription>
                        {!toolGroupOpen &&
                          renderToolProgress(toolGroupProgress, toolGroupStatus)}
                        {toolGroupOpen ? (
                          <div className="mt-2">
                            {toolGroupCount > 0 ? (
                              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                                {`${toolGroupCount} events`}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </ChatEventBody>
                    </ChatEvent>
                    {toolGroupOpen ? card : null}
                  </div>
                );
              };

              if (item.kind === "graph") {
                const { message: eventMessage } = item;
                const toolOpen = toolOpenById[item.id] ?? false;
                const statusLabel = eventMessage.error
                  ? eventMessage.error
                  : getToolStatusLabel(eventMessage.toolStatus);

                const isGraphOutputPayload = (
                  value: unknown,
                ): value is GraphToolOutput => {
                  if (!value || !isRecord(value)) {
                    return false;
                  }
                  if ("nodes" in value && Array.isArray(value.nodes)) {
                    return true;
                  }
                  if ("nodesAdded" in value && typeof value.nodesAdded === "number") {
                    return true;
                  }
                  if ("explanation" in value && typeof value.explanation === "string") {
                    return true;
                  }
                  return false;
                };

                const outputPayloadRaw = parseToolPayload(
                  eventMessage.toolOutput,
                );
                const outputPayload = isGraphOutputPayload(outputPayloadRaw)
                  ? outputPayloadRaw
                  : null;
                const nodesFromOutput = outputPayload?.nodes ?? [];
                const nodesAdded = outputPayload?.nodesAdded;
                const explanation =
                  typeof outputPayload?.explanation === "string"
                    ? outputPayload.explanation
                    : undefined;
                const graphToolInput = parseGraphToolInput(
                  eventMessage.toolInput,
                );
                const responseId = graphToolInput?.responseId;
                const selectedNodeId =
                  graphToolInput?.selectedNodeId ?? undefined;
                const resolvedLabel = selectedNodeId
                  ? resolveNodeLabel(selectedNodeId)
                  : undefined;
                const selectedLabel = resolvedLabel
                  ? resolvedLabel
                  : selectedNodeId
                    ? `Node ${selectedNodeId.slice(0, 6)}`
                    : undefined;
                const logLines: string[] = [];
                if (eventMessage.toolStatus === "running") {
                  logLines.push("Running graph tool...");
                }
                if (responseId) {
                  logLines.push(`Response ${responseId.slice(0, 8)}`);
                }
                if (selectedLabel) {
                  logLines.push(`Selected ${selectedLabel}`);
                }

                const compactCallParts: string[] = [];
                if (responseId) {
                  compactCallParts.push(`response: ${responseId.slice(0, 8)}`);
                }
                if (selectedLabel) {
                  compactCallParts.push(`selected: ${selectedLabel}`);
                }
                const compactCall = truncateInline(compactCallParts.join(" | "));
                const callDetail = stringifyToolDetail(eventMessage.toolInput);
                const resultDetail = stringifyToolDetail(eventMessage.toolOutput);
                const hasDetails =
                  logLines.length > 0 ||
                  nodesAdded !== undefined ||
                  nodesFromOutput.length > 0 ||
                  !!explanation ||
                  Boolean(callDetail) ||
                  Boolean(resultDetail);
                const graphProgress = getProgressByStatuses([
                  toExecutionStatus(eventMessage.toolStatus),
                ]);

                const card = (
                  <ChatEvent key={item.id} className="items-start gap-2 px-2">
                    <ChatEventAddon>{renderEventLogo("graph")}</ChatEventAddon>
                    <ChatEventBody
                      className={cn(
                        "rounded-md border px-3 py-2",
                        getToolCardClassName(eventMessage.toolStatus),
                      )}
                    >
                      <Collapsible
                        open={toolOpen}
                        onOpenChange={(nextOpen) => {
                          setToolOpenById((previous) => ({
                            ...previous,
                            [item.id]: nextOpen,
                          }));
                        }}
                        className="min-w-0"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <ChatEventTitle className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            Graph Update
                          </ChatEventTitle>
                          <div className="flex items-center gap-1">
                            {renderCompleteIcon(eventMessage.toolStatus)}
                            <CollapsibleTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground transition-transform data-[state=open]:rotate-180"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                        </div>
                        <ChatEventDescription>{statusLabel}</ChatEventDescription>
                        {!toolOpen &&
                          renderToolProgress(graphProgress, eventMessage.toolStatus)}
                        <CollapsibleContent className="mt-2 min-w-0">
                          {developerMode ? (
                            hasDetails ? (
                              <ChatEventContent className="space-y-2">
                                {logLines.length > 0 && (
                                  <div className="space-y-1 text-[11px] text-muted-foreground">
                                    {logLines.map((line, index) => (
                                      <div key={`${item.id}-log-${index}`}>
                                        {line}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {callDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Call
                                    </div>
                                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {callDetail}
                                    </pre>
                                  </div>
                                )}
                                {resultDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Result
                                    </div>
                                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {resultDetail}
                                    </pre>
                                  </div>
                                )}
                                {nodesAdded !== undefined && (
                                  <div className="text-xs text-muted-foreground">
                                    Added {nodesAdded} node
                                    {nodesAdded === 1 ? "" : "s"}
                                  </div>
                                )}
                                {explanation && (
                                  <div className="text-xs text-muted-foreground">
                                    {explanation}
                                  </div>
                                )}
                                {nodesFromOutput.length > 0 && (
                                  <div className="space-y-2">
                                    {nodesFromOutput.map((node, index) => {
                                      const nodeId =
                                        typeof node.id === "string"
                                          ? node.id
                                          : "";
                                      const title =
                                        typeof node.titleShort === "string"
                                          ? node.titleShort
                                          : typeof node.titleLong === "string"
                                            ? node.titleLong
                                            : "Insight";
                                      const excerpt =
                                        typeof node.excerpt === "string"
                                          ? node.excerpt
                                          : "";
                                      return (
                                        <button
                                          key={nodeId || `${item.id}-${index}`}
                                          type="button"
                                          className="w-full rounded-md border border-border/70 bg-card/60 px-3 py-2 text-left text-xs transition hover:border-border hover:bg-card/80"
                                          onClick={() => {
                                            if (nodeId && onFocusNode) {
                                              onFocusNode(nodeId);
                                            }
                                          }}
                                        >
                                          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                                            Node
                                          </div>
                                          <div className="text-sm font-semibold text-foreground">
                                            {title}
                                          </div>
                                          {excerpt && (
                                            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                              {excerpt}
                                            </div>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </ChatEventContent>
                            ) : null
                          ) : (
                            compactCall && (
                              <div className="truncate text-[11px] text-muted-foreground">
                                {compactCall}
                              </div>
                            )
                          )}
                        </CollapsibleContent>
                      </Collapsible>
                    </ChatEventBody>
                  </ChatEvent>
                );
                return wrapToolCard(card);
              }
              if (item.kind === "subagent") {
                const { message: eventMessage } = item;
                const toolOpen = toolOpenById[item.id] ?? false;
                const statusLabel = eventMessage.error
                  ? eventMessage.error
                  : getToolStatusLabel(eventMessage.toolStatus);
                const deepSearchMessage = item.deepSearchMessage;

                const outputPayloadRaw = parseToolPayload(
                  eventMessage.toolOutput,
                );
                const outputPayload = isSubagentPayload(outputPayloadRaw)
                  ? outputPayloadRaw
                  : null;
                const entries = outputPayload
                  ? buildSubagentEntries(outputPayload)
                  : [];
                const deepSearchOutputPayloadRaw = parseToolPayload(
                  deepSearchMessage?.toolOutput,
                );
                const deepSearchOutputPayload = isDeepSearchPayload(
                  deepSearchOutputPayloadRaw,
                )
                  ? deepSearchOutputPayloadRaw
                  : null;
                const deepSearchStatus = deepSearchMessage?.toolStatus;
                const parentExecutionStatus = resolveSubagentParentExecutionStatus(
                  eventMessage,
                  deepSearchMessage,
                );
                const normalizedEntries = normalizeSubagentEntryStatuses(
                  entries,
                  parentExecutionStatus,
                );
                const deepSearchStatusLabel = deepSearchMessage?.error
                  ? deepSearchMessage.error
                  : getToolStatusLabel(deepSearchStatus);
                const deepSearchTitle =
                  deepSearchMessage?.toolName ??
                  deepSearchOutputPayload?.toolName ??
                  "Search";
                const deepSearchSources = Array.isArray(
                  deepSearchOutputPayload?.sources,
                )
                  ? deepSearchOutputPayload.sources
                  : [];
                const deepSearchQuery =
                  typeof deepSearchOutputPayload?.query === "string"
                    ? deepSearchOutputPayload.query
                    : undefined;
                const normalizedDeepSearchQuery = deepSearchQuery?.trim() ?? "";
                const deepSearchError =
                  typeof deepSearchOutputPayload?.error === "string"
                    ? deepSearchOutputPayload.error
                    : undefined;
                const subagentDescription =
                  eventMessage.error ??
                  (eventMessage.toolStatus === "complete" &&
                  normalizedDeepSearchQuery.length > 0
                    ? normalizedDeepSearchQuery
                    : statusLabel);
                const deepSearchCallDetail = stringifyToolDetail(
                  deepSearchMessage?.toolInput,
                );
                const deepSearchResultDetail = stringifyToolDetail(
                  deepSearchMessage?.toolOutput,
                );
                const deepSearchSummaryLabel =
                  deepSearchError ??
                  (deepSearchStatus === "complete" &&
                  normalizedDeepSearchQuery.length > 0
                    ? normalizedDeepSearchQuery
                    : deepSearchStatusLabel);
                const deepSearchCompactParts: string[] = [];
                if (deepSearchQuery) {
                  deepSearchCompactParts.push(`query: ${deepSearchQuery}`);
                }
                if (deepSearchSources.length > 0) {
                  deepSearchCompactParts.push(
                    `sources: ${deepSearchSources.length}`,
                  );
                }
                if (deepSearchError) {
                  deepSearchCompactParts.push(
                    `error: ${truncateInline(deepSearchError, 80)}`,
                  );
                }
                const deepSearchCompactSummary = truncateInline(
                  deepSearchCompactParts.join(" | "),
                );
                const hasDeepSearchDetails = Boolean(deepSearchMessage);
                const title = eventMessage.toolName ?? outputPayload?.toolName ?? "Subagent";
                const compactCallEntries = normalizedEntries.map((entry) => {
                  const detailSource = entry.compactDetail ?? entry.fullDetail;
                  const merged = detailSource
                    ? `${entry.label}: ${detailSource}`
                    : entry.label;
                  return truncateInline(merged);
                });
                const hasDetails =
                  normalizedEntries.length > 0 || hasDeepSearchDetails;
                const progressStatuses: ToolExecutionStatus[] = normalizedEntries.map(
                  (entry) => entry.status,
                );
                if (deepSearchStatus) {
                  progressStatuses.push(toExecutionStatus(deepSearchStatus));
                }
                if (progressStatuses.length === 0) {
                  progressStatuses.push(toExecutionStatus(eventMessage.toolStatus));
                }
                const subagentProgress = getProgressByStatuses(progressStatuses);

                const card = (
                  <ChatEvent key={item.id} className="items-start gap-2 px-2">
                    <ChatEventAddon>{renderEventLogo("subagent")}</ChatEventAddon>
                    <ChatEventBody
                      className={cn(
                        "rounded-md border px-3 py-2",
                        getToolCardClassName(eventMessage.toolStatus),
                      )}
                    >
                      <Collapsible
                        open={toolOpen}
                        onOpenChange={(nextOpen) => {
                          setToolOpenById((previous) => ({
                            ...previous,
                            [item.id]: nextOpen,
                          }));
                        }}
                        className="min-w-0"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <ChatEventTitle className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            {title}
                          </ChatEventTitle>
                          <div className="flex items-center gap-1">
                            {renderCompleteIcon(eventMessage.toolStatus)}
                            <CollapsibleTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground transition-transform data-[state=open]:rotate-180"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                        </div>
                        <ChatEventDescription>{subagentDescription}</ChatEventDescription>
                        {!toolOpen &&
                          renderToolProgress(subagentProgress, eventMessage.toolStatus)}
                        {hasDetails ? (
                          <CollapsibleContent className="mt-2 min-w-0">
                            <ChatEventContent className="space-y-2">
                              {developerMode ? (
                                <div className="space-y-1 text-[11px] text-muted-foreground">
                                  {normalizedEntries.map((entry, index) => {
                                    const detail = entry.fullDetail ?? entry.compactDetail;
                                    const statusLabel = getExecutionStatusLabel(entry.status);
                                    return (
                                      <div
                                        key={`${item.id}-subagent-${index}`}
                                        className={cn(
                                          "flex min-w-0 items-start gap-2 rounded-md border border-border/60 bg-card/40 px-2 py-1",
                                          entry.tone === "warn" &&
                                            "border-amber-400/40 bg-amber-500/10 text-amber-700",
                                        )}
                                      >
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center justify-between gap-2">
                                            <div className="truncate text-xs font-medium text-foreground/80">
                                              {entry.label}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-foreground/60">
                                              <span>{statusLabel}</span>
                                              {renderExecutionStatusIcon(entry.status)}
                                            </div>
                                          </div>
                                          {detail && (
                                            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                              {detail}
                                            </pre>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                  {deepSearchMessage && (
                                    <div className="space-y-2 rounded-md border border-border/60 bg-card/40 p-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex min-w-0 items-center gap-1">
                                          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
                                          <div className="truncate text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/80">
                                            {deepSearchTitle}
                                          </div>
                                        </div>
                                        {deepSearchStatus && (
                                          <div className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-foreground/60">
                                            <span>
                                              {getExecutionStatusLabel(
                                                toExecutionStatus(deepSearchStatus),
                                              )}
                                            </span>
                                            {renderExecutionStatusIcon(
                                              toExecutionStatus(deepSearchStatus),
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground">
                                        {deepSearchSummaryLabel}
                                      </div>
                                      {(((deepSearchQuery ?? "").length > 0) ||
                                        deepSearchSources.length > 0) && (
                                        <div className="space-y-1 text-[11px] text-muted-foreground">
                                          {deepSearchQuery && (
                                            <div className="break-words">{`Query: ${deepSearchQuery}`}</div>
                                          )}
                                          {deepSearchSources.length > 0 && (
                                            <div>{`Sources: ${deepSearchSources.length}`}</div>
                                          )}
                                        </div>
                                      )}
                                      {deepSearchCallDetail && (
                                        <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                          <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                            Call
                                          </div>
                                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                            {deepSearchCallDetail}
                                          </pre>
                                        </div>
                                      )}
                                      {deepSearchResultDetail && (
                                        <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                          <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                            Result
                                          </div>
                                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                            {deepSearchResultDetail}
                                          </pre>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="space-y-1 text-[11px] text-muted-foreground">
                                  {compactCallEntries.map((line, index) => {
                                    const entry = normalizedEntries[index];
                                    if (!entry) {
                                      return null;
                                    }
                                    return (
                                      <div
                                        key={`${item.id}-subagent-call-${index}`}
                                        className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card/40 px-2 py-1"
                                        title={line}
                                      >
                                        <span className="min-w-0 flex-1 truncate">
                                          {line}
                                        </span>
                                        <span className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-foreground/60">
                                          <span>{getExecutionStatusLabel(entry.status)}</span>
                                          {renderExecutionStatusIcon(entry.status)}
                                        </span>
                                      </div>
                                    );
                                  })}
                                  {deepSearchCompactSummary && (
                                    <div
                                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card/40 px-2 py-1"
                                      title={deepSearchCompactSummary}
                                    >
                                      <span className="min-w-0 flex-1 truncate">
                                        {`${deepSearchTitle}: ${deepSearchCompactSummary}`}
                                      </span>
                                      {deepSearchStatus && (
                                        <span className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-foreground/60">
                                          <span>
                                            {getExecutionStatusLabel(
                                              toExecutionStatus(deepSearchStatus),
                                            )}
                                          </span>
                                          {renderExecutionStatusIcon(
                                            toExecutionStatus(deepSearchStatus),
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </ChatEventContent>
                          </CollapsibleContent>
                        ) : null}
                      </Collapsible>
                    </ChatEventBody>
                  </ChatEvent>
                );
                return wrapToolCard(card);
              }
              if (item.kind === "deepsearch") {
                const { message: eventMessage } = item;
                const toolOpen = toolOpenById[item.id] ?? false;
                const statusLabel = eventMessage.error
                  ? eventMessage.error
                  : getToolStatusLabel(eventMessage.toolStatus);

                const outputPayloadRaw = parseToolPayload(
                  eventMessage.toolOutput,
                );
                const outputPayload = isDeepSearchPayload(outputPayloadRaw)
                  ? outputPayloadRaw
                  : null;
                const sources = Array.isArray(outputPayload?.sources)
                  ? outputPayload?.sources ?? []
                  : [];
                const references = Array.isArray(outputPayload?.references)
                  ? outputPayload.references
                  : [];
                const conclusion =
                  typeof outputPayload?.conclusion === "string"
                    ? outputPayload.conclusion
                    : undefined;
                const query =
                  typeof outputPayload?.query === "string"
                    ? outputPayload.query
                    : undefined;
                const normalizedQuery = query?.trim() ?? "";
                const error =
                  typeof outputPayload?.error === "string"
                    ? outputPayload.error
                    : undefined;
                const deepSearchDescription =
                  error ??
                  (eventMessage.toolStatus === "complete" &&
                  normalizedQuery.length > 0
                    ? normalizedQuery
                    : statusLabel);
                const callDetail = stringifyToolDetail(eventMessage.toolInput);
                const resultDetail = stringifyToolDetail(eventMessage.toolOutput);
                const title =
                  eventMessage.toolName ??
                  outputPayload?.toolName ??
                  "DeepSearch";
                const isValidateMode = outputPayload?.mode === "validate";
                const shouldShowFullDetails = developerMode || isValidateMode;
                const hasDetails =
                  !!query ||
                  sources.length > 0 ||
                  references.length > 0 ||
                  !!conclusion ||
                  Boolean(callDetail) ||
                  Boolean(resultDetail);
                const compactParts: string[] = [];
                if (query) {
                  compactParts.push(`query: ${query}`);
                }
                if (sources.length > 0) {
                  compactParts.push(`sources: ${sources.length}`);
                }
                if (references.length > 0) {
                  compactParts.push(`refs: ${references.length}`);
                }
                const compactSummary = truncateInline(compactParts.join(" | "));
                const deepSearchProgress = getProgressByStatuses([
                  toExecutionStatus(eventMessage.toolStatus),
                ]);

                const card = (
                  <ChatEvent key={item.id} className="items-start gap-2 px-2">
                    <ChatEventAddon>{renderEventLogo("deepsearch")}</ChatEventAddon>
                    <ChatEventBody
                      className={cn(
                        "rounded-md border px-3 py-2",
                        getToolCardClassName(eventMessage.toolStatus),
                      )}
                    >
                      <Collapsible
                        open={toolOpen}
                        onOpenChange={(nextOpen) => {
                          setToolOpenById((previous) => ({
                            ...previous,
                            [item.id]: nextOpen,
                          }));
                        }}
                        className="min-w-0"
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <ChatEventTitle className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            {title}
                          </ChatEventTitle>
                          <div className="flex items-center gap-1">
                            {renderCompleteIcon(eventMessage.toolStatus)}
                            <CollapsibleTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground transition-transform data-[state=open]:rotate-180"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                        </div>
                        <ChatEventDescription>{deepSearchDescription}</ChatEventDescription>
                        {!toolOpen &&
                          renderToolProgress(deepSearchProgress, eventMessage.toolStatus)}
                        <CollapsibleContent className="mt-2 min-w-0">
                          {shouldShowFullDetails ? (
                            hasDetails ? (
                              <ChatEventContent className="min-w-0 space-y-2">
                                <div className="space-y-1 break-words text-[11px] text-muted-foreground">
                                  {query && <div className="break-words">{`Query: ${query}`}</div>}
                                  {sources.length > 0 && (
                                    <div>{`Sources: ${sources.length}`}</div>
                                  )}
                                  {references.length > 0 && (
                                    <div>{`References: ${references.length}`}</div>
                                  )}
                                </div>
                                {callDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Call
                                    </div>
                                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {callDetail}
                                    </pre>
                                  </div>
                                )}
                                {resultDetail && (
                                  <div className="rounded-md border border-border/60 bg-card/40 p-2">
                                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      Result
                                    </div>
                                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                      {resultDetail}
                                    </pre>
                                  </div>
                                )}
                                {conclusion && (
                                  <div className="break-words rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
                                    {conclusion}
                                  </div>
                                )}
                                {sources.length > 0 && (
                                  <div className="min-w-0 space-y-2">
                                    {sources.map((source, index) => {
                                      const url =
                                        typeof source.url === "string"
                                          ? source.url
                                          : "";
                                      const sourceTitle =
                                        typeof source.title === "string" &&
                                        source.title.trim()
                                          ? source.title
                                          : url || `Source ${index + 1}`;
                                      const snippet =
                                        typeof source.snippet === "string"
                                          ? source.snippet
                                          : "";
                                      const excerptLines = Array.isArray(source.excerpts)
                                        ? source.excerpts
                                            .filter(
                                              (excerpt): excerpt is string =>
                                                typeof excerpt === "string" &&
                                                excerpt.trim().length > 0,
                                            )
                                            .map((excerpt) =>
                                              stripLineNumberPrefix(excerpt),
                                            )
                                        : [];
                                      const hoverText = excerptLines.join("\n\n").trim();
                                      return (
                                        <button
                                          key={`${item.id}-source-${index}`}
                                          type="button"
                                          className="min-w-0 max-w-full w-full overflow-hidden rounded-md border border-border/70 bg-card/60 px-3 py-2 text-left text-xs transition hover:border-border hover:bg-card/80"
                                          title={hoverText || undefined}
                                          onClick={() => {
                                            if (url && onReferenceClick) {
                                              onReferenceClick(url, sourceTitle);
                                            }
                                          }}
                                        >
                                          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                                            Source
                                          </div>
                                          <div className="break-words text-sm font-semibold text-foreground">
                                            {sourceTitle}
                                          </div>
                                          {url && (
                                            <div className="mt-1 max-w-full truncate text-[11px] text-muted-foreground">
                                              {url}
                                            </div>
                                          )}
                                          {snippet && (
                                            <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                                              {snippet}
                                            </div>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                {references.length > 0 && (
                                  <div className="min-w-0 space-y-2">
                                    {references.map((reference, index) => {
                                      const refUri =
                                        typeof reference.uri === "string"
                                          ? reference.uri
                                          : "";
                                      const refUrl =
                                        typeof reference.url === "string"
                                          ? reference.url
                                          : "";
                                      const refTitle =
                                        typeof reference.title === "string" &&
                                        reference.title.trim().length > 0
                                          ? reference.title
                                          : refUrl || `Reference ${index + 1}`;
                                      const refId =
                                        typeof reference.refId === "number"
                                          ? reference.refId
                                          : index + 1;
                                      const startLine =
                                        typeof reference.startLine === "number"
                                          ? reference.startLine
                                          : undefined;
                                      const endLine =
                                        typeof reference.endLine === "number"
                                          ? reference.endLine
                                          : undefined;
                                      const validationRefContent =
                                        typeof reference.validationRefContent ===
                                          "string" &&
                                        reference.validationRefContent.trim()
                                          .length > 0
                                          ? reference.validationRefContent
                                          : undefined;
                                      const accuracyLabel = formatAccuracyLabel(
                                        typeof reference.accuracy === "string"
                                          ? reference.accuracy
                                          : undefined,
                                      );
                                      const accuracyValue =
                                        typeof reference.accuracy === "string"
                                          ? reference.accuracy
                                          : undefined;
                                      const sourceAuthorityLabel =
                                        formatSourceAuthorityLabel(
                                          reference.sourceAuthority,
                                        );
                                      const issueReason =
                                        typeof reference.issueReason === "string" &&
                                        reference.issueReason.trim().length > 0
                                          ? reference.issueReason
                                          : undefined;
                                      const correctFact =
                                        typeof reference.correctFact === "string" &&
                                        reference.correctFact.trim().length > 0
                                          ? reference.correctFact
                                          : undefined;
                                      const refText =
                                        typeof reference.text === "string"
                                          ? stripLineNumberPrefix(reference.text)
                                          : "";
                                      const openHref = refUri || refUrl;
                                      return (
                                        <button
                                          key={`${item.id}-reference-${index}`}
                                          type="button"
                                          className={cn(
                                            "w-full rounded-md border px-3 py-2 text-left text-xs transition",
                                            isValidateMode
                                              ? getValidateAccuracyToneClasses(
                                                  accuracyValue,
                                                )
                                              : "border-border/70 bg-card/60",
                                            "hover:border-border hover:bg-card/80",
                                          )}
                                          onClick={() => {
                                            if (openHref && onReferenceClick) {
                                              onReferenceClick(openHref, refTitle);
                                            }
                                          }}
                                        >
                                          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                                            Ref {refId}
                                          </div>
                                          <div className="break-words text-sm font-semibold text-foreground">
                                            {refTitle}
                                          </div>
                                          {accuracyLabel ? (
                                            <div
                                              className={cn(
                                                "mt-1 text-[11px]",
                                                isValidateMode
                                                  ? getValidateAccuracyTextClass(
                                                      accuracyValue,
                                                    )
                                                  : "text-muted-foreground",
                                              )}
                                            >
                                              Accuracy: {accuracyLabel}
                                            </div>
                                          ) : null}
                                          {sourceAuthorityLabel ? (
                                            <div className="mt-1 text-[11px] text-muted-foreground">
                                              Source authority: {sourceAuthorityLabel}
                                            </div>
                                          ) : null}
                                          {startLine && endLine ? (
                                            <div className="mt-1 text-[11px] text-muted-foreground">
                                              Lines {startLine}-{endLine}
                                            </div>
                                          ) : null}
                                          {validationRefContent ? (
                                            <div className="mt-1 break-words text-[11px] text-foreground/90">
                                              {validationRefContent}
                                            </div>
                                          ) : null}
                                          {issueReason ? (
                                            <div className="mt-1 break-words rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">
                                              Why wrong: {issueReason}
                                            </div>
                                          ) : null}
                                          {correctFact ? (
                                            <div className="mt-1 break-words rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                                              Correct fact: {correctFact}
                                            </div>
                                          ) : null}
                                          {refText ? (
                                            <div className="mt-1 line-clamp-2 break-words text-[11px] text-muted-foreground">
                                              {refText}
                                            </div>
                                          ) : null}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </ChatEventContent>
                            ) : null
                          ) : (
                            compactSummary && (
                              <div className="truncate text-[11px] text-muted-foreground">
                                {compactSummary}
                              </div>
                            )
                          )}
                        </CollapsibleContent>
                      </Collapsible>
                    </ChatEventBody>
                  </ChatEvent>
                );
                return wrapToolCard(card);
              }
              const message = item.message;
              const timestamp = new Date(message.createdAt).getTime();
              const isUser = message.role === "user";
              const isHighlighted = message.id === highlightedId;
              const isFailed = message.status === "failed";
              const stickyQuestionOrder =
                stickyQuestionOrderByMessageId.get(message.id);
              const stickyQuestionCount = stickyQuestionItems.length;
              const stickyQuestionExpandable =
                isUser && stickyQuestionCount > 1;
              const stickyQuestionActive =
                isUser && Boolean(activeStickyQuestionById[message.id]);
              const stickyQuestionStackIndex =
                stickyQuestionOrder !== undefined ? stickyQuestionOrder - 1 : 0;
              const stickyQuestionCollapsedDepth = Math.min(
                stickyQuestionStackIndex,
                STICKY_STACK_COLLAPSED_VISIBLE_COUNT - 1,
              );
              const stickyQuestionExpandedTopOffset =
                stickyQuestionExpandedTopOffsetById.get(message.id) ??
                stickyQuestionStackIndex *
                  (STICKY_STACK_EXPANDED_FALLBACK_HEIGHT_PX +
                    STICKY_STACK_EXPANDED_GAP_PX);
              const stickyQuestionTopOffset = stickyQuestionExpandable
                ? stickyQuestionsExpanded && stickyQuestionActive
                  ? stickyQuestionExpandedTopOffset
                  : 0
                : 0;
              const stickyQuestionTransform = stickyQuestionExpandable
                ? stickyQuestionActive
                  ? stickyQuestionsExpanded
                    ? "translateY(0px) scale(1)"
                    : `translateY(${stickyQuestionCollapsedDepth * STICKY_STACK_COLLAPSED_OFFSET_PX}px) scale(${Math.max(0.9, 1 - stickyQuestionCollapsedDepth * 0.015)})`
                  : undefined
                : undefined;
              const stickyQuestionInteractive =
                stickyQuestionExpandable && stickyQuestionActive;
              const stickyQuestionZIndex = stickyQuestionOrder
                ? 60 + stickyQuestionCount - stickyQuestionOrder
                : undefined;
              const handleStickyQuestionEnter = () => {
                if (!stickyQuestionInteractive) {
                  return;
                }
                expandStickyQuestions();
              };
              const handleStickyQuestionLeave = () => {
                if (!stickyQuestionExpandable) {
                  return;
                }
                collapseStickyQuestions();
              };
              const shouldHighlightExcerpt =
                message.id === selectedResponseId && !!selectedExcerpt;
              const displayContent =
                !isUser && message.status === "pending" && !message.content
                  ? "Thinking..."
                  : message.content;
              const resolvedContent =
                !isUser && isFailed && !displayContent?.trim()
                  ? message.error ?? "Request failed"
                  : displayContent;
              const isLatestAssistantMessage =
                !isUser && latestAssistantMessage?.id === message.id;
              const latestValidateRun = !isUser
                ? latestValidateRunByResponseId.get(message.id)
                : undefined;
              const validateDeepSearchMessage = latestValidateRun?.deepSearchMessage;
              const validateSubagentMessage = latestValidateRun?.subagentMessage;
              const validateDeepSearchPayloadRaw = parseToolPayload(
                validateDeepSearchMessage?.toolOutput,
              );
              const validateDeepSearchPayload = isDeepSearchPayload(
                validateDeepSearchPayloadRaw,
              )
                ? validateDeepSearchPayloadRaw
                : null;
              const validateSubagentPayloadRaw = parseToolPayload(
                validateSubagentMessage?.toolOutput,
              );
              const validateSubagentPayload = isSubagentPayload(
                validateSubagentPayloadRaw,
              )
                ? validateSubagentPayloadRaw
                : null;
              const validateSubagentEntries = validateSubagentPayload
                ? buildSubagentEntries(validateSubagentPayload)
                : [];
              const validateStatus = latestValidateRun
                ? toExecutionStatus(
                    validateDeepSearchMessage?.toolStatus ??
                      validateSubagentMessage?.toolStatus ??
                      "running",
                  )
                : null;
              const validateError =
                validateDeepSearchMessage?.error ?? validateSubagentMessage?.error;
              const validateQuery =
                typeof validateDeepSearchPayload?.query === "string"
                  ? validateDeepSearchPayload.query
                  : undefined;
              const validateSourcesCount = Array.isArray(validateDeepSearchPayload?.sources)
                ? validateDeepSearchPayload.sources.length
                : 0;
              const validateReferences = Array.isArray(
                validateDeepSearchPayload?.references,
              )
                ? validateDeepSearchPayload.references
                : [];
              const validateReferencesCount = validateReferences.length;
              const validateCallDetail = stringifyToolDetail(
                validateDeepSearchMessage?.toolInput,
              );
              const validateResultDetail = stringifyToolDetail(
                validateDeepSearchMessage?.toolOutput,
              );
              const validateInlineMerge =
                !isUser && typeof resolvedContent === "string"
                  ? mergeValidateReferencesInline({
                      source: resolvedContent,
                      references: validateReferences,
                    })
                  : {
                      content: resolvedContent ?? "",
                      accuracyHints: {},
                      sourceAuthorityHints: {},
                    };
              const assistantRenderedContent = validateInlineMerge.content;
              const assistantReferenceAccuracyHints =
                validateInlineMerge.accuracyHints;
              const assistantReferenceSourceAuthorityHints =
                validateInlineMerge.sourceAuthorityHints;
              const validationRunning = validateStatus === "running";
              const validationPopoverVisible = Boolean(
                latestValidateRun && validateStatus,
              );
              const validationPopoverOpen =
                validationPopoverVisible &&
                validateDetailsPopoverMessageId === message.id;
              const copyStateForMessage =
                copyFeedbackMessageId === message.id ? copyFeedbackState : "idle";
              const canCopyMessage =
                !isUser && typeof resolvedContent === "string"
                  ? resolvedContent.trim().length > 0
                  : false;
              const graphMessage = !isUser
                ? graphMessageByResponseId.get(message.id)
                : undefined;
              const graphStatus = graphMessage?.toolStatus;
              const showRegenerateForMessage =
                isLatestAssistantMessage &&
                Boolean(onRetry) &&
                graphStatus !== "complete";
              const canRegenerateForMessage = showRegenerateForMessage && !busy;
              const showGraphGenerateForMessage =
                isLatestAssistantMessage &&
                Boolean(onGenerateGraphResponse) &&
                graphStatus !== "complete";
              const canRunGraphGenerateForMessage =
                showGraphGenerateForMessage &&
                !graphBusy &&
                graphStatus !== "running";
              const actionRow = !isUser ? (
                <div className="mt-1 inline-flex items-center gap-1">
                  {showRegenerateForMessage ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 rounded-md bg-transparent text-muted-foreground hover:bg-muted/35 hover:text-foreground"
                      onClick={() => {
                        onRetry?.(message.id);
                      }}
                      disabled={!canRegenerateForMessage}
                      title="Regenerate this response"
                      aria-label="Regenerate this response"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "h-6 w-6 rounded-md bg-transparent text-muted-foreground hover:bg-muted/35 hover:text-foreground",
                      copyStateForMessage === "copied" && "text-emerald-500",
                      copyStateForMessage === "failed" && "text-destructive",
                    )}
                    onClick={() => {
                      void handleCopyAssistantMessage(message);
                    }}
                    disabled={!canCopyMessage}
                    title={
                      copyStateForMessage === "copied"
                        ? "Copied"
                        : copyStateForMessage === "failed"
                          ? "Copy failed"
                          : "Copy this response"
                    }
                    aria-label="Copy this response"
                  >
                    {copyStateForMessage === "copied" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : copyStateForMessage === "failed" ? (
                      <AlertCircle className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Popover
                    open={validationPopoverOpen}
                    onOpenChange={(nextOpen) => {
                      if (nextOpen) {
                        setValidateDetailsPopoverMessageId(message.id);
                        return;
                      }
                      setValidateDetailsPopoverMessageId((previous) =>
                        previous === message.id ? null : previous,
                      );
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={cn(
                          "group relative h-6 w-6 rounded-md bg-transparent",
                          validationRunning
                            ? "animate-pulse text-sky-600 hover:bg-red-500/20 hover:text-red-600 dark:text-sky-300"
                            : validateStatus === "failed"
                              ? "text-red-600 hover:bg-red-500/15 hover:text-red-600 dark:text-red-300"
                              : validateStatus === "complete"
                                ? "text-emerald-600 hover:bg-emerald-500/15 hover:text-emerald-600 dark:text-emerald-300"
                                : "text-muted-foreground hover:bg-muted/35 hover:text-foreground",
                        )}
                        onClick={() => {
                          onToggleValidateResponse?.(message.id);
                        }}
                        onMouseEnter={() => {
                          if (!validationPopoverVisible) {
                            return;
                          }
                          openValidateDetailsPopover(message.id);
                        }}
                        onMouseLeave={() => {
                          if (!validationPopoverVisible) {
                            return;
                          }
                          scheduleCloseValidateDetailsPopover();
                        }}
                        disabled={!onToggleValidateResponse}
                        title={
                          validationRunning
                            ? "Stop validation"
                            : validateStatus === "failed"
                              ? "Validation failed, click to retry"
                              : validateStatus === "complete"
                                ? "Validate again"
                                : "Validate this response"
                        }
                        aria-label={
                          validationRunning
                            ? "Stop validation"
                            : "Validate this response"
                        }
                      >
                        {validationRunning ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin transition-opacity duration-150 group-hover:opacity-0" />
                            <Square className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                          </>
                        ) : validateStatus === "failed" ? (
                          <AlertCircle className="h-3.5 w-3.5" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </PopoverTrigger>
                    {validationPopoverVisible ? (
                      <PopoverContent
                        side={validationRunning ? "bottom" : "top"}
                        align="start"
                        className="w-[380px] p-3"
                        onMouseEnter={() => {
                          openValidateDetailsPopover(message.id);
                        }}
                        onMouseLeave={() => {
                          scheduleCloseValidateDetailsPopover();
                        }}
                      >
                        <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {validationRunning ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : validateStatus === "complete" ? (
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                            )}
                            <span>
                              {validationRunning
                                ? "Validate running"
                                : validateStatus === "complete"
                                  ? "Validate complete"
                                  : "Validate failed"}
                            </span>
                          </div>
                          {validateQuery ? (
                            <div className="rounded border border-border/60 bg-card/40 px-2 py-1 text-[11px] text-muted-foreground">
                              Query: {validateQuery}
                            </div>
                          ) : null}
                          {validateError ? (
                            <div className="rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">
                              {validateError}
                            </div>
                          ) : null}
                          {validateSubagentEntries.length > 0 ? (
                            <div className="space-y-1">
                              {validateSubagentEntries.map((entry, index) => (
                                <div
                                  key={`${message.id}-validate-entry-${index}`}
                                  className="flex items-center justify-between gap-2 rounded border border-border/60 bg-card/40 px-2 py-1 text-[11px]"
                                >
                                  <span
                                    className="min-w-0 flex-1 truncate text-muted-foreground"
                                    title={entry.compactDetail ?? entry.label}
                                  >
                                    {entry.compactDetail
                                      ? `${entry.label}: ${entry.compactDetail}`
                                      : entry.label}
                                  </span>
                                  <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-foreground/70">
                                    {getExecutionStatusLabel(entry.status)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {validateSourcesCount > 0 || validateReferencesCount > 0 ? (
                            <div className="rounded border border-border/60 bg-card/40 px-2 py-1 text-[11px] text-muted-foreground">
                              {`Sources: ${validateSourcesCount} · References: ${validateReferencesCount}`}
                            </div>
                          ) : null}
                          {validateCallDetail ? (
                            <div className="rounded border border-border/60 bg-card/40 p-2">
                              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                Call
                              </div>
                              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                {validateCallDetail}
                              </pre>
                            </div>
                          ) : null}
                          {validateResultDetail ? (
                            <div className="rounded border border-border/60 bg-card/40 p-2">
                              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                Result
                              </div>
                              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">
                                {validateResultDetail}
                              </pre>
                            </div>
                          ) : null}
                        </div>
                      </PopoverContent>
                    ) : null}
                  </Popover>
                  {showGraphGenerateForMessage ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "h-6 w-6 rounded-md bg-transparent",
                        canRunGraphGenerateForMessage
                          ? "text-sky-600 hover:bg-sky-500/15 hover:text-sky-600 dark:text-sky-300"
                          : "text-muted-foreground",
                      )}
                      onClick={() => {
                        onGenerateGraphResponse?.(message.id);
                      }}
                      disabled={!canRunGraphGenerateForMessage}
                      title={
                        graphStatus === "running"
                          ? "Graph generation is running"
                          : "Generate graph from this response"
                      }
                      aria-label="Generate graph from this response"
                    >
                      {graphStatus === "running" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Network className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  ) : null}
                </div>
              ) : null;
              const content = (
                <div>
                  <div
                    className={cn(
                      "rounded-md px-3 py-2",
                      isUser
                        ? "bg-muted text-foreground"
                        : "bg-secondary text-foreground",
                      isFailed &&
                        "border border-destructive/40 bg-destructive/10 text-destructive",
                      !isUser &&
                        validationRunning &&
                        "animate-pulse ring-1 ring-sky-400/45 bg-sky-500/10",
                      isHighlighted && "ring-2 ring-amber-400/60",
                    )}
                  >
                    {stickyQuestionOrder ? (
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {`Q${stickyQuestionOrder}`}
                      </div>
                    ) : null}
                    {isUser ? (
                      <div className="whitespace-pre-wrap text-sm leading-relaxed">
                        {renderUserContent(displayContent ?? "")}
                      </div>
                    ) : (
                      <MarkdownRenderer
                        source={assistantRenderedContent}
                        referenceAccuracyHints={assistantReferenceAccuracyHints}
                        referenceSourceAuthorityHints={
                          assistantReferenceSourceAuthorityHints
                        }
                        highlightExcerpt={
                          shouldHighlightExcerpt ? selectedExcerpt : undefined
                        }
                        onNodeLinkClick={handleNodeLinkClick}
                        onReferenceClick={onReferenceClick}
                        resolveReferencePreview={onResolveReferencePreview}
                        resolveNodeLabel={resolveNodeLabel}
                        nodeExcerptRefs={nodeExcerptRefs}
                      />
                    )}
                  </div>
                  {actionRow}
                </div>
              );
              const renderMessageCard = (messageBody: React.ReactNode) => (
                <div
                  data-message-id={message.id}
                  data-sticky-card={isUser ? "true" : undefined}
                  data-sticky-order={
                    stickyQuestionOrder !== undefined
                      ? String(stickyQuestionOrder)
                      : undefined
                  }
                  ref={
                    isUser
                      ? (element) => {
                          registerStickyQuestionElement(message.id, element);
                        }
                      : undefined
                  }
                  className={cn(
                    isUser &&
                      "sticky rounded-md bg-background/95 px-1 py-1 shadow-sm backdrop-blur transition-[top,transform,box-shadow] duration-200 ease-out supports-[backdrop-filter]:bg-background/80",
                    stickyQuestionInteractive && "cursor-pointer",
                    stickyQuestionsExpanded &&
                      stickyQuestionInteractive &&
                      "shadow-md",
                  )}
                  style={
                    isUser
                      ? {
                          top: stickyQuestionTopOffset,
                          transform: stickyQuestionTransform,
                          zIndex:
                            stickyQuestionActive ? stickyQuestionZIndex : undefined,
                        }
                      : undefined
                  }
                  onMouseEnter={isUser ? handleStickyQuestionEnter : undefined}
                  onMouseLeave={isUser ? handleStickyQuestionLeave : undefined}
                  onClick={
                    isUser
                      ? () => {
                          if (!stickyQuestionInteractive) {
                            return;
                          }
                          handleStickyQuestionFocus(message.id);
                        }
                      : undefined
                  }
                >
                  {messageBody}
                </div>
              );
              if (item.kind === "primary") {
                const messageBody = (
                  <PrimaryMessage
                    senderName={isUser ? "You" : "Assistant"}
                    avatarFallback={
                      isUser ? (
                        <UserRound className="h-4 w-4" />
                      ) : (
                        <Bot className="h-4 w-4" />
                      )
                    }
                    content={content}
                    timestamp={timestamp}
                  />
                );
                if (!isUser) {
                  return (
                    <div key={item.id}>
                      {renderMessageCard(messageBody)}
                    </div>
                  );
                }
                return (
                  <Fragment key={item.id}>
                    <div
                      ref={(element) => {
                        registerStickyQuestionAnchor(message.id, element);
                      }}
                      data-scroll-anchor-id={message.id}
                      className="h-0"
                    />
                    {renderMessageCard(messageBody)}
                  </Fragment>
                );
              }
              const messageBody = (
                <AdditionalMessage content={content} timestamp={timestamp} />
              );
              if (!isUser) {
                return (
                  <div key={item.id}>
                    {renderMessageCard(messageBody)}
                  </div>
                );
              }
              return (
                <Fragment key={item.id}>
                  <div
                    ref={(element) => {
                      registerStickyQuestionAnchor(message.id, element);
                    }}
                    data-scroll-anchor-id={message.id}
                    className="h-0"
                  />
                  {renderMessageCard(messageBody)}
                </Fragment>
              );
              })
            )}
            {busy && !hasPendingAssistant && (
              <PrimaryMessage
                senderName="Assistant"
                avatarFallback={<Bot className="h-4 w-4" />}
                content={
                  <div className="rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">
                    Thinking...
                  </div>
                }
                timestamp={Date.now()}
              />
            )}
          </ChatMessages>
          {!isAtBottom && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-40 -translate-x-1/2">
              <Button
                size="icon"
                variant="outline"
                className="pointer-events-auto rounded-full shadow-lg"
                onClick={() => {
                  onRequestClearSelection?.();
                  setIsAtBottom(true);
                  scrollToBottom("smooth");
                }}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        <ChatToolbar>
          {(selectedTagLabel || hasBrowserSelection) && (
            <ChatToolbarAddonStart>
              {selectedTagLabel && (
                <span
                  className="max-w-[140px] truncate rounded-full border border-border/70 bg-muted/40 px-2 py-1 text-[11px] font-medium text-foreground/80 @md/chat:max-w-[220px]"
                  title={selectedTagLabel}
                >
                  {selectedTagLabel}
                </span>
              )}
              {hasBrowserSelection && (
                <button
                  type="button"
                  className="max-w-[220px] truncate rounded-full border border-primary/35 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary transition hover:border-primary/55 hover:bg-primary/15"
                  title={browserSelection?.text}
                  onClick={() => {
                    if (browserSelection && onInsertBrowserSelection) {
                      onInsertBrowserSelection(browserSelection);
                    }
                  }}
                >
                  {browserSelectionLabel || "Use web selection"}
                </button>
              )}
            </ChatToolbarAddonStart>
          )}
          <ChatToolbarTextarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Ask a question..."
            disabled={busy}
            onKeyDown={(event) => {
              if (
                event.key === "Backspace" &&
                selectedSummary &&
                onRequestClearSelection
              ) {
                const target = event.currentTarget;
                if (target.selectionStart === 0 && target.selectionEnd === 0) {
                  event.preventDefault();
                  onRequestClearSelection();
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handlePrimaryAction();
              }
            }}
          />
          <ChatToolbarUnderInput className="flex-wrap">
            <div
              className={cn(
                "inline-flex h-7 items-center overflow-visible rounded-md border text-[11px] font-medium transition",
                deepResearchActive
                  ? "border-primary/45 bg-primary/10 text-primary shadow-sm"
                  : "border-border/70 bg-muted/40 text-muted-foreground",
              )}
            >
              <button
                type="button"
                className={cn(
                  "h-full px-2 tracking-[0.08em] transition",
                  deepResearchSwitchEnabled
                    ? "hover:bg-primary/15"
                    : "hover:bg-muted/60",
                )}
                aria-pressed={deepResearchSwitchEnabled}
                onClick={handleToggleDeepResearchMaster}
              >
                DeepResearch
              </button>
              <Popover
                open={deepResearchQuickOpen}
                onOpenChange={setDeepResearchQuickOpen}
              >
                <div className="border-l border-current/20">
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center text-current/80 transition hover:text-current"
                      aria-label="DeepResearch quick settings"
                      title="DeepResearch quick settings"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                </div>
                <PopoverContent
                  side="top"
                  align="center"
                  sideOffset={8}
                  collisionPadding={8}
                  avoidCollisions
                  className="w-[min(320px,calc(100vw-16px))] max-h-[calc(100vh-16px)] overflow-y-auto p-3"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <Tabs
                    value={quickConfigTab}
                    onValueChange={(value) =>
                      setQuickConfigTab(value as "search" | "validate")
                    }
                    className="space-y-2.5"
                  >
                    <TabsList className="grid h-8 w-full grid-cols-2">
                      <TabsTrigger value="search" className="text-[11px]">
                        Search
                        <span className="ml-1 text-[10px] opacity-70">
                          {searchEnabled ? "On" : "Off"}
                        </span>
                      </TabsTrigger>
                      <TabsTrigger value="validate" className="text-[11px]">
                        Validate
                        <span className="ml-1 text-[10px] opacity-70">
                          {validateEnabled ? "On" : "Off"}
                        </span>
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="search" className="space-y-2.5">
                      <div
                        className={cn(
                          "space-y-2 rounded-md border border-border/70 bg-muted/20 p-2",
                          (fullPromptOverrideEnabled ||
                            !deepResearchSwitchEnabled) &&
                            "opacity-45",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs text-foreground/90">
                            Search during answer
                          </div>
                          <Switch
                            checked={searchEnabled}
                            disabled={
                              fullPromptOverrideEnabled || !deepResearchSwitchEnabled
                            }
                            onCheckedChange={handleSearchEnabledSwitchChange}
                          />
                        </div>
                        <div
                          className={cn(
                            "flex items-center justify-between gap-3",
                          )}
                        >
                          <div className="text-xs text-foreground/90">
                            Search all claims
                          </div>
                          <Switch
                            checked={searchAllClaimsEnabled}
                            disabled={
                              fullPromptOverrideEnabled ||
                              !deepResearchSwitchEnabled
                            }
                            onCheckedChange={handleSearchAllClaimsSwitchChange}
                          />
                        </div>
                      </div>
                      <div
                        className={cn(
                          "flex items-center justify-between gap-3",
                          (fullPromptOverrideEnabled ||
                            !deepResearchSwitchEnabled) &&
                            "opacity-45",
                        )}
                      >
                        <div className="flex items-center gap-1.5 text-xs text-foreground/90">
                          <span>Deeper Search</span>
                          <span
                            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground"
                            title="Deeper Search increases search breadth and cross-checking for difficult factual claims."
                            aria-label="Deeper Search explanation"
                          >
                            <CircleHelp className="h-3.5 w-3.5" />
                          </span>
                        </div>
                        <Switch
                          checked={highSearchComplexity}
                          disabled={
                            fullPromptOverrideEnabled ||
                            !deepResearchSwitchEnabled
                          }
                          onCheckedChange={(checked) =>
                            patchSubagentConfig({
                              searchComplexity: checked ? "deep" : "balanced",
                            })
                          }
                        />
                      </div>
                    </TabsContent>
                    <TabsContent value="validate" className="space-y-2.5">
                      <div
                        className={cn(
                          "space-y-2 rounded-md border border-border/70 bg-muted/20 p-2",
                          (fullPromptOverrideEnabled ||
                            !deepResearchSwitchEnabled) &&
                            "opacity-45",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs text-foreground/90">
                            Auto validate after answer
                          </div>
                          <Switch
                            checked={validateEnabled}
                            disabled={
                              fullPromptOverrideEnabled || !deepResearchSwitchEnabled
                            }
                            onCheckedChange={handleValidateEnabledSwitchChange}
                          />
                        </div>
                        <div
                          className={cn(
                            "flex items-center justify-between gap-3",
                          )}
                        >
                          <div className="text-xs text-foreground/90">
                            Validate all claims
                          </div>
                          <Switch
                            checked={validateAllClaimsEnabled}
                            disabled={
                              fullPromptOverrideEnabled ||
                              !deepResearchSwitchEnabled
                            }
                            onCheckedChange={handleValidateAllClaimsSwitchChange}
                          />
                        </div>
                      </div>
                      <div
                        className={cn(
                          "flex items-center justify-between gap-3",
                          (fullPromptOverrideEnabled ||
                            !deepResearchSwitchEnabled) &&
                            "opacity-45",
                        )}
                      >
                        <div className="flex items-center gap-1.5 text-xs text-foreground/90">
                          <span>Deeper Search</span>
                          <span
                            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground"
                            title="Deeper Search increases search breadth and cross-checking when validation evidence is weak or conflicting."
                            aria-label="Deeper Search explanation"
                          >
                            <CircleHelp className="h-3.5 w-3.5" />
                          </span>
                        </div>
                        <Switch
                          checked={highValidateSearchComplexity}
                          disabled={
                            fullPromptOverrideEnabled ||
                            !deepResearchSwitchEnabled
                          }
                          onCheckedChange={(checked) =>
                            patchValidateSubagentConfig({
                              searchComplexity: checked ? "deep" : "balanced",
                            })
                          }
                        />
                      </div>
                    </TabsContent>
                  </Tabs>
                  <div className="mt-2 rounded-md border border-border/70 bg-muted/20 p-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-foreground/90">
                        Search Skills
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 rounded-sm border border-border/70"
                          title="Refresh skills"
                          aria-label="Refresh skills"
                          onClick={(event) => {
                            event.stopPropagation();
                            void refreshSkillCatalog(true);
                          }}
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              skillsLoading && "animate-spin",
                            )}
                          />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 rounded-sm border border-border/70"
                          title="Open skills folder"
                          aria-label="Open skills folder"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleOpenSkillsDirectory();
                          }}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div
                      className="truncate text-[10px] text-muted-foreground"
                      title={skillsDirectory || undefined}
                    >
                      {skillsDirectory || "Skills directory not loaded yet."}
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                      Folders with names starting with <code>search-</code> are
                      treated as search skills. Add new <code>search-*</code>{" "}
                      skills in this folder, then click refresh.
                    </div>
                    {skillsError ? (
                      <div className="mt-1 text-[10px] text-destructive">
                        {skillsError}
                      </div>
                    ) : null}
                    <div className="mt-2 max-h-28 space-y-1 overflow-auto pr-1">
                      {searchSkillOptions.length === 0 ? (
                        <div className="text-[10px] text-muted-foreground">
                          No <code>search-*</code> skills found yet.
                        </div>
                      ) : (
                        searchSkillOptions.map((skill) => {
                          const selected = selectedSkillNames.includes(skill.name);
                          return (
                            <button
                              key={skill.name}
                              type="button"
                              className={cn(
                                "w-full rounded-md border px-2 py-1 text-left text-[11px] transition",
                                selected
                                  ? "border-primary/45 bg-primary/10 text-primary"
                                  : "border-border/70 bg-background/60 text-muted-foreground hover:text-foreground",
                              )}
                              title={`${skill.title}\n${skill.description}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleToggleSelectedSkill(skill.name);
                              }}
                            >
                              <div className="truncate font-medium">{skill.name}</div>
                              <div className="truncate text-[10px] opacity-80">
                                {skill.title}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="mt-2 h-7 w-full justify-center border border-border/70 text-[11px]"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeepResearchQuickOpen(false);
                      setAdvancedPanelOpen(true);
                    }}
                  >
                    More
                  </Button>
                </PopoverContent>
              </Popover>
            </div>
          </ChatToolbarUnderInput>
          <ChatToolbarAddonEnd>
            {canStopAsync ? (
              <Button
                size="icon"
                variant="outline"
                className="group relative h-8 w-8 rounded-md hover:border-destructive hover:text-destructive"
                onClick={() => {
                  onStopAsync?.();
                }}
                aria-label={asyncActionLabel}
                title={asyncActionLabel}
              >
                <>
                  <Loader2
                    className="animate-spin transition-opacity duration-150 group-hover:opacity-0"
                    style={{ animationDuration: "2.8s" }}
                  />
                  <Square className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                </>
              </Button>
            ) : null}
            <Button
              size="icon"
              variant={retryOnly ? "destructive" : "default"}
              className={`group relative h-8 w-8 rounded-md ${
                canStop
                  ? "hover:bg-destructive hover:text-destructive-foreground"
                  : ""
              }`}
              onClick={handlePrimaryAction}
              disabled={canStop ? false : busy || (!retryOnly && !hasInput)}
              aria-label={primaryActionLabel}
              title={primaryActionLabel}
            >
              {canStop ? (
                <>
                  <Loader2
                    className="animate-spin transition-opacity duration-150 group-hover:opacity-0"
                    style={{ animationDuration: "2.8s" }}
                  />
                  <Square className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                </>
              ) : retryOnly ? (
                <RotateCw />
              ) : (
                <Send />
              )}
            </Button>
          </ChatToolbarAddonEnd>
        </ChatToolbar>
        <Dialog open={advancedPanelOpen} onOpenChange={setAdvancedPanelOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>DeepResearch Advanced Settings</DialogTitle>
              <DialogDescription>
                Defaults are designed to stay close to the current prompt behavior.
                You can tune subagent strategy here or override full prompts.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-1">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Full Prompt Override</Label>
                  <div className="flex h-9 items-center justify-between rounded-md border border-border bg-muted/30 px-3">
                    <span className="text-xs text-foreground/90">
                      Enable to use full custom prompts instead of composed prompts.
                    </span>
                    <Switch
                      checked={fullPromptOverrideEnabled}
                      onCheckedChange={handleFullPromptOverrideToggle}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dr-skill-profile">Skill Recall Strategy</Label>
                  <Select
                    value={resolvedDeepResearchConfig.skillProfile}
                    onValueChange={(value) =>
                      patchDeepResearchConfig({
                        skillProfile: value as AgentSkillProfile,
                      })
                    }
                  >
                    <SelectTrigger id="dr-skill-profile">
                      <SelectValue placeholder="Select skill mode" />
                    </SelectTrigger>
                    <SelectContent>
                      {SKILL_PROFILE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Tabs
                value={advancedConfigTab}
                onValueChange={(value) =>
                  setAdvancedConfigTab(value as "search" | "validate")
                }
                className="space-y-4"
              >
                <TabsList className="grid h-9 w-full grid-cols-2">
                  <TabsTrigger value="search">
                    Search
                    <span className="ml-1 text-[10px] opacity-70">
                      {searchEnabled ? "On" : "Off"}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="validate">
                    Validate
                    <span className="ml-1 text-[10px] opacity-70">
                      {validateEnabled ? "On" : "Off"}
                    </span>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="search" className="space-y-3">
                  <div
                    className={cn(
                      "space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2",
                      (fullPromptOverrideEnabled ||
                        !deepResearchSwitchEnabled) &&
                        "opacity-45",
                    )}
                  >
                    <Label>Search strategy</Label>
                    <div className="text-xs text-foreground/90">
                      Choose when to run search during answer generation.
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={1}
                      value={searchPolicyIndex}
                      disabled={
                        fullPromptOverrideEnabled || !deepResearchSwitchEnabled
                      }
                      onChange={(event) =>
                        setSearchPolicy(
                          indexToSearchPolicy(
                            Number.parseInt(event.target.value, 10),
                          ),
                        )
                      }
                      className="h-1.5 w-full cursor-pointer accent-primary"
                    />
                    <div className="grid grid-cols-3 gap-1 text-[11px] text-muted-foreground">
                      {SEARCH_POLICY_OPTIONS.map((option) => (
                        <div
                          key={option.value}
                          className={cn(
                            "truncate text-center",
                            option.value === searchPolicy && "text-foreground",
                          )}
                          title={option.description}
                        >
                          {option.label}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div
                    className={cn(
                      "grid gap-3 sm:grid-cols-2",
                      !deepResearchSwitchEnabled && "opacity-45",
                    )}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-search-complexity">Search Complexity</Label>
                      <Select
                        value={resolvedDeepResearchConfig.subagent.searchComplexity}
                        disabled={
                          fullPromptOverrideEnabled ||
                          !deepResearchSwitchEnabled
                        }
                        onValueChange={(value) =>
                          patchSubagentConfig({
                            searchComplexity: value as SubagentSearchComplexity,
                          })
                        }
                      >
                        <SelectTrigger id="dr-search-complexity">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SEARCH_COMPLEXITY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-search-depth">Tavily Search Depth</Label>
                      <Select
                        value={resolvedDeepResearchConfig.subagent.tavilySearchDepth}
                        disabled={!deepResearchSwitchEnabled}
                        onValueChange={(value) =>
                          patchSubagentConfig({
                            tavilySearchDepth: value as TavilySearchDepth,
                          })
                        }
                      >
                        <SelectTrigger id="dr-search-depth">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TAVILY_SEARCH_DEPTH_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div
                    className={cn(
                      "grid gap-3 sm:grid-cols-2",
                      !deepResearchSwitchEnabled && "opacity-45",
                    )}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-max-search">Max Search Calls</Label>
                      <Input
                        id="dr-max-search"
                        type="number"
                        min={1}
                        max={20}
                        value={String(resolvedDeepResearchConfig.subagent.maxSearchCalls)}
                        onChange={(event) =>
                          handleNumericSubagentChange(
                            "maxSearchCalls",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-max-extract">Max Extract Calls</Label>
                      <Input
                        id="dr-max-extract"
                        type="number"
                        min={1}
                        max={40}
                        value={String(
                          resolvedDeepResearchConfig.subagent.maxExtractCalls,
                        )}
                        onChange={(event) =>
                          handleNumericSubagentChange(
                            "maxExtractCalls",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  </div>
                  <div
                    className={cn(
                      "grid gap-3 sm:grid-cols-2",
                      !deepResearchSwitchEnabled && "opacity-45",
                    )}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-repeat-search">
                        Max Repeat for Same Query
                      </Label>
                      <Input
                        id="dr-repeat-search"
                        type="number"
                        min={1}
                        max={10}
                        value={String(
                          resolvedDeepResearchConfig.subagent.maxRepeatSearchQuery,
                        )}
                        onChange={(event) =>
                          handleNumericSubagentChange(
                            "maxRepeatSearchQuery",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-repeat-url">
                        Max Repeat for Same URL
                      </Label>
                      <Input
                        id="dr-repeat-url"
                        type="number"
                        min={1}
                        max={10}
                        value={String(
                          resolvedDeepResearchConfig.subagent.maxRepeatExtractUrl,
                        )}
                        onChange={(event) =>
                          handleNumericSubagentChange(
                            "maxRepeatExtractUrl",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  </div>
                  {fullPromptOverrideEnabled ? (
                    <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                      Prompt-level subagent strategy fields are hidden while Full
                      Prompt Override is enabled. The depth and call-limit values
                      above stay active and can be injected into override templates.
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="dr-source-policy">
                          Source Selection Policy (Subagent)
                        </Label>
                        <Textarea
                          id="dr-source-policy"
                          rows={3}
                          value={
                            resolvedDeepResearchConfig.subagent.sourceSelectionPolicy
                          }
                          onChange={(event) =>
                            patchSubagentConfig({
                              sourceSelectionPolicy: event.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="dr-split-strategy">
                          Search Split Strategy (Subagent)
                        </Label>
                        <Textarea
                          id="dr-split-strategy"
                          rows={3}
                          value={resolvedDeepResearchConfig.subagent.splitStrategy}
                          onChange={(event) =>
                            patchSubagentConfig({
                              splitStrategy: event.target.value,
                            })
                          }
                        />
                      </div>
                    </>
                  )}
                </TabsContent>
                <TabsContent value="validate" className="space-y-3">
                  <div
                    className={cn(
                      "space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2",
                      (fullPromptOverrideEnabled || !deepResearchSwitchEnabled) &&
                        "opacity-45",
                    )}
                  >
                    <Label>Validate behavior</Label>
                    <div className="text-xs text-foreground/90">
                      Auto-run and strictness are configured independently. These settings are also used by manual validate.
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-foreground/90">
                        Auto validate after answer
                      </div>
                      <Switch
                        checked={validateEnabled}
                        disabled={
                          fullPromptOverrideEnabled || !deepResearchSwitchEnabled
                        }
                        onCheckedChange={handleValidateEnabledSwitchChange}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-foreground/90">
                        Validate all claims
                      </div>
                      <Switch
                        checked={validateAllClaimsEnabled}
                        disabled={
                          fullPromptOverrideEnabled || !deepResearchSwitchEnabled
                        }
                        onCheckedChange={handleValidateAllClaimsSwitchChange}
                      />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {validateAllClaimsEnabled
                        ? "Strictness: Every claim"
                        : "Strictness: Uncertain claims"}
                    </div>
                  </div>
                  <div
                    className={cn(
                      "grid gap-3 sm:grid-cols-2",
                      !deepResearchSwitchEnabled && "opacity-45",
                    )}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-validate-search-complexity">
                        Search Complexity
                      </Label>
                      <Select
                        value={
                          resolvedDeepResearchConfig.validate.subagent
                            .searchComplexity
                        }
                        disabled={
                          !deepResearchSwitchEnabled
                        }
                        onValueChange={(value) =>
                          patchValidateSubagentConfig({
                            searchComplexity: value as SubagentSearchComplexity,
                          })
                        }
                      >
                        <SelectTrigger id="dr-validate-search-complexity">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SEARCH_COMPLEXITY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-validate-search-depth">
                        Tavily Search Depth
                      </Label>
                      <Select
                        value={
                          resolvedDeepResearchConfig.validate.subagent
                            .tavilySearchDepth
                        }
                        disabled={!deepResearchSwitchEnabled}
                        onValueChange={(value) =>
                          patchValidateSubagentConfig({
                            tavilySearchDepth: value as TavilySearchDepth,
                          })
                        }
                      >
                        <SelectTrigger id="dr-validate-search-depth">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TAVILY_SEARCH_DEPTH_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div
                    className={cn(
                      "grid gap-3 sm:grid-cols-2",
                      !deepResearchSwitchEnabled && "opacity-45",
                    )}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-validate-max-search">
                        Max Search Calls
                      </Label>
                      <Input
                        id="dr-validate-max-search"
                        type="number"
                        min={1}
                        max={20}
                        value={String(
                          resolvedDeepResearchConfig.validate.subagent
                            .maxSearchCalls,
                        )}
                        onChange={(event) =>
                          handleNumericValidateSubagentChange(
                            "maxSearchCalls",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-validate-max-extract">
                        Max Extract Calls
                      </Label>
                      <Input
                        id="dr-validate-max-extract"
                        type="number"
                        min={1}
                        max={40}
                        value={String(
                          resolvedDeepResearchConfig.validate.subagent
                            .maxExtractCalls,
                        )}
                        onChange={(event) =>
                          handleNumericValidateSubagentChange(
                            "maxExtractCalls",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  </div>
                  <div
                    className={cn(
                      "grid gap-3 sm:grid-cols-2",
                      !deepResearchSwitchEnabled && "opacity-45",
                    )}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-validate-repeat-search">
                        Max Repeat for Same Query
                      </Label>
                      <Input
                        id="dr-validate-repeat-search"
                        type="number"
                        min={1}
                        max={10}
                        value={String(
                          resolvedDeepResearchConfig.validate.subagent
                            .maxRepeatSearchQuery,
                        )}
                        onChange={(event) =>
                          handleNumericValidateSubagentChange(
                            "maxRepeatSearchQuery",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dr-validate-repeat-url">
                        Max Repeat for Same URL
                      </Label>
                      <Input
                        id="dr-validate-repeat-url"
                        type="number"
                        min={1}
                        max={10}
                        value={String(
                          resolvedDeepResearchConfig.validate.subagent
                            .maxRepeatExtractUrl,
                        )}
                        onChange={(event) =>
                          handleNumericValidateSubagentChange(
                            "maxRepeatExtractUrl",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  </div>
                  {!fullPromptOverrideEnabled ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="dr-validate-source-policy">
                          Source Selection Policy
                        </Label>
                        <Textarea
                          id="dr-validate-source-policy"
                          rows={2}
                          value={
                            resolvedDeepResearchConfig.validate.subagent
                              .sourceSelectionPolicy
                          }
                          onChange={(event) =>
                            patchValidateSubagentConfig({
                              sourceSelectionPolicy: event.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="dr-validate-split-strategy">
                          Search Split Strategy
                        </Label>
                        <Textarea
                          id="dr-validate-split-strategy"
                          rows={2}
                          value={
                            resolvedDeepResearchConfig.validate.subagent
                              .splitStrategy
                          }
                          onChange={(event) =>
                            patchValidateSubagentConfig({
                              splitStrategy: event.target.value,
                            })
                          }
                        />
                      </div>
                    </>
                  ) : null}
                </TabsContent>
              </Tabs>
              {fullPromptOverrideEnabled ? (
                <>
                  <div
                    className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                    title={OVERRIDE_TEMPLATE_PLACEHOLDER_TITLES}
                  >
                    {OVERRIDE_TEMPLATE_PLACEHOLDER_HINT}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dr-main-prompt-override">
                      Main Agent Full Prompt Override
                    </Label>
                    <Textarea
                      id="dr-main-prompt-override"
                      rows={4}
                      placeholder="Generated from current prompt settings by default"
                      value={resolvedDeepResearchConfig.mainPromptOverride ?? ""}
                      onChange={(event) =>
                        patchDeepResearchConfig({
                          mainPromptOverride: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dr-subagent-system-override">
                      Subagent System Prompt Override
                    </Label>
                    <Textarea
                      id="dr-subagent-system-override"
                      rows={4}
                      placeholder="Generated from current prompt settings by default"
                      value={
                        resolvedDeepResearchConfig.subagent.systemPromptOverride ??
                        ""
                      }
                      onChange={(event) =>
                        patchSubagentConfig({
                          systemPromptOverride: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dr-subagent-prompt-override">
                      Subagent Runtime Prompt Override
                    </Label>
                    <Textarea
                      id="dr-subagent-prompt-override"
                      rows={4}
                      placeholder="Generated from current prompt settings by default"
                      value={
                        resolvedDeepResearchConfig.subagent.promptOverride ?? ""
                      }
                      onChange={(event) =>
                        patchSubagentConfig({
                          promptOverride: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dr-validate-subagent-system-override">
                      Validate Subagent System Prompt Override
                    </Label>
                    <Textarea
                      id="dr-validate-subagent-system-override"
                      rows={4}
                      placeholder="Generated from current validate prompt settings by default"
                      value={
                        resolvedDeepResearchConfig.validate.subagent
                          .systemPromptOverride ?? ""
                      }
                      onChange={(event) =>
                        patchValidateSubagentConfig({
                          systemPromptOverride: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dr-validate-subagent-prompt-override">
                      Validate Subagent Runtime Prompt Override
                    </Label>
                    <Textarea
                      id="dr-validate-subagent-prompt-override"
                      rows={4}
                      placeholder="Generated from current validate prompt settings by default"
                      value={
                        resolvedDeepResearchConfig.validate.subagent
                          .promptOverride ?? ""
                      }
                      onChange={(event) =>
                        patchValidateSubagentConfig({
                          promptOverride: event.target.value,
                        })
                      }
                    />
                  </div>
                </>
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </Chat>
    </div>
  );
}
