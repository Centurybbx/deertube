import type { UIMessageStreamWriter } from "ai";
import type { JsonObject, JsonValue } from "../../../types/json";
import { isJsonObject } from "../../../types/json";
import {
  buildDeepResearchRefUri,
  type LineSelection,
} from "../../../shared/deepresearch";
import type { TavilySearchDepth } from "../../../shared/deepresearch-config";
import { TavilyResponseSchema, type TavilySearchResult } from "./schemas";
import type {
  DeepSearchStreamPayload,
  DeepSearchReference,
  DeepSearchSource,
  ExtractedEvidence,
  SearchResult,
  SubagentStreamPayload,
  SubagentUIMessage,
} from "./types";

type LineSelectionBounds = Pick<LineSelection, "start" | "end">;

export const parseJson = (raw: string): JsonValue =>
  JSON.parse(raw) as JsonValue;

export const isRecord = (value: unknown): value is JsonObject =>
  isJsonObject(value);

export const writeSubagentStream = (
  writer: UIMessageStreamWriter | undefined,
  toolCallId: string | undefined,
  toolName: string | undefined,
  messages: SubagentUIMessage[],
  onStream?: (payload: SubagentStreamPayload) => void,
) => {
  if (!toolCallId) return;
  const payload: SubagentStreamPayload = { toolCallId, toolName, messages };
  onStream?.(payload);
  if (!writer) return;
  writer.write({
    type: "data-subagent-stream",
    id: toolCallId,
    data: payload,
  });
};

export const writeDeepSearchStream = (
  writer: UIMessageStreamWriter | undefined,
  toolCallId: string | undefined,
  toolName: string | undefined,
  payload: Omit<DeepSearchStreamPayload, "toolCallId" | "toolName">,
  done = false,
  onStream?: (payload: DeepSearchStreamPayload, done: boolean) => void,
) => {
  if (!toolCallId) return;
  const resolvedPayload: DeepSearchStreamPayload = {
    toolCallId,
    toolName,
    ...payload,
    complete: done || payload.complete,
  };
  onStream?.(resolvedPayload, done);
  if (!writer) return;
  writer.write({
    type: done ? "data-deepsearch-done" : "data-deepsearch-stream",
    id: toolCallId,
    data: resolvedPayload,
  });
};

type AnyUIMessagePart = NonNullable<SubagentUIMessage["parts"]>[number];

const isTextPart = (
  part: AnyUIMessagePart,
): part is AnyUIMessagePart & { text: string } =>
  part.type === "text" && "text" in part;

const isToolPart = (part: AnyUIMessagePart): boolean =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool";

const getToolName = (part: AnyUIMessagePart): string | undefined => {
  if (part.type.startsWith("tool-")) {
    return part.type.slice(5);
  }
  if (
    part.type === "dynamic-tool" &&
    "toolName" in part &&
    typeof part.toolName === "string"
  ) {
    return part.toolName;
  }
  return undefined;
};

export const extractText = (message: SubagentUIMessage): string => {
  if (!message.parts) return "";
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
};

export const collectToolOutputs = (
  message: SubagentUIMessage,
): { name?: string; output: unknown }[] => {
  if (!message.parts) return [];
  return message.parts.filter(isToolPart).flatMap((part) => {
    if (!("output" in part) || part.output === undefined) {
      return [];
    }
    return [
      {
        name: getToolName(part),
        output: part.output as unknown,
      },
    ];
  });
};

export const splitLines = (markdown: string): string[] =>
  markdown.split(/\r?\n/);

export const formatLineNumbered = (
  lines: string[],
  offset = 0,
  totalLines?: number,
): string => {
  const width = String(totalLines ?? lines.length + offset).length;
  return lines
    .map((line, index) => {
      const lineNumber = String(index + 1 + offset).padStart(width, "0");
      return `${lineNumber} | ${line}`;
    })
    .join("\n");
};

export const buildSelectionsFromBounds = (
  lines: string[],
  bounds: LineSelectionBounds[],
): LineSelection[] => {
  const unique = new Map<string, LineSelection>();
  bounds.forEach((selection) => {
    const text = formatLineNumbered(
      lines.slice(selection.start - 1, selection.end),
      selection.start - 1,
      lines.length,
    ).trim();
    if (!text) {
      return;
    }
    const key = `${selection.start}:${selection.end}:${text}`;
    unique.set(key, {
      start: selection.start,
      end: selection.end,
      text,
    });
  });
  return Array.from(unique.values());
};

export const parseLineSelections = (value: unknown): LineSelection[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const dedupe = new Map<string, LineSelection>();
  value.forEach((entry) => {
    if (!isRecord(entry)) {
      return;
    }
    const start = Number(entry.start);
    const end = Number(entry.end);
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
      return;
    }
    const normalizedStart = Math.max(1, Math.floor(start));
    const normalizedEnd = Math.max(1, Math.floor(end));
    if (normalizedEnd < normalizedStart) {
      return;
    }
    const selection: LineSelection = {
      start: normalizedStart,
      end: normalizedEnd,
      text,
    };
    dedupe.set(
      `${selection.start}:${selection.end}:${selection.text}`,
      selection,
    );
  });
  return Array.from(dedupe.values());
};

const isSelectionContainedBy = (
  candidate: LineSelectionBounds,
  container: LineSelectionBounds,
): boolean =>
  candidate.start >= container.start && candidate.end <= container.end;

export const intersectSelectionBounds = (
  left: LineSelectionBounds,
  right: LineSelectionBounds,
): LineSelectionBounds | null => {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  if (end < start) {
    return null;
  }
  return { start, end };
};

export const deriveNumberedContentForSelection = (
  target: LineSelectionBounds,
  contentsBySelection: Map<string, string>,
): string | undefined => {
  const exact = contentsBySelection.get(`${target.start}:${target.end}`);
  if (exact && exact.trim().length > 0) {
    return exact.trim();
  }
  for (const [key, content] of contentsBySelection.entries()) {
    const [startRaw, endRaw] = key.split(":");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    if (!isSelectionContainedBy(target, { start, end })) {
      continue;
    }
    const selectedLines = content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .filter((line) => {
        const match = line.match(/^(\d+)\s+\|/);
        if (!match) {
          return false;
        }
        const lineNo = Number(match[1]);
        return (
          Number.isFinite(lineNo) &&
          lineNo >= target.start &&
          lineNo <= target.end
        );
      });
    if (selectedLines.length > 0) {
      return selectedLines.join("\n");
    }
  }
  return undefined;
};

export const summarizeSelections = (
  selections: LineSelectionBounds[],
  limit = 6,
): string[] =>
  selections
    .slice(0, limit)
    .map((selection) => `${selection.start}-${selection.end}`);

export const clampText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;

export const summarizeContentsPreview = (
  contents: string[],
  limit = 2,
): string[] =>
  contents.slice(0, limit).map((content) => clampText(content, 180));

export async function fetchTavilySearch(
  query: string,
  maxResults: number,
  apiKey?: string,
  searchDepth: TavilySearchDepth = "advanced",
  abortSignal?: AbortSignal,
): Promise<TavilySearchResult[]> {
  const resolvedKey = apiKey ?? process.env.TAVILY_API_KEY;
  if (!resolvedKey) {
    throw new Error("TAVILY_API_KEY is not set");
  }
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolvedKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_raw_content: false,
      search_depth: searchDepth,
    }),
    signal: abortSignal,
  });
  const raw = await response.text();
  if (!response.ok) {
    console.warn("[tavily.search.error]", {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    });
    throw new Error(`Tavily search failed: ${response.status}`);
  }
  let parsedJson: JsonValue;
  try {
    parsedJson = JSON.parse(raw) as JsonValue;
  } catch (error) {
    console.warn("[tavily.search.parse]", {
      query,
      status: response.status,
      error: error instanceof Error ? error.message : "unknown",
      bodyPreview: raw.slice(0, 400),
    });
    throw new Error("Tavily search response parse failed.");
  }
  const parsed = TavilyResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    console.warn("[tavily.search.schema]", {
      query,
      status: response.status,
      issue: firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "invalid",
      bodyPreview: raw.slice(0, 400),
    });
    throw new Error("Tavily search response schema invalid.");
  }
  const results = parsed.data.results ?? [];
  if (results.length === 0) {
    console.warn("[tavily.search.empty]", {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    });
  }
  return results;
}

export async function fetchJinaReaderMarkdown(
  url: string,
  baseUrl?: string,
  apiKey?: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const normalizedBase =
    baseUrl && baseUrl.trim().length > 0
      ? baseUrl.trim()
      : "https://r.jina.ai/";
  const readerUrl = `${normalizedBase}${url}`;
  const response = await fetch(readerUrl, {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: abortSignal,
  });
  if (!response.ok) {
    throw new Error(`Jina reader failed: ${response.status}`);
  }
  const raw = await response.text();
  const compact = raw.trim();
  if (!compact.startsWith("{")) {
    return raw;
  }
  let parsed: JsonValue;
  try {
    parsed = parseJson(raw);
  } catch (error) {
    throw new Error(
      `Jina response JSON parse failed for ${url}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }
  if (typeof parsed === "string") {
    return parsed;
  }
  if (typeof parsed === "object") {
    const obj = parsed as JsonObject;
    if (typeof obj.content === "string") {
      return obj.content;
    }
    const nested = obj.data;
    if (nested && typeof nested === "object") {
      const nestedContent = (nested as JsonObject).content;
      if (typeof nestedContent === "string") {
        return nestedContent;
      }
    }
    return JSON.stringify(obj, null, 2);
  }
  return raw;
}

export const normalizeSearchResults = (raw: JsonValue): SearchResult[] => {
  if (!Array.isArray(raw)) {
    throw new Error("Search subagent output must be a JSON array.");
  }
  const normalized: SearchResult[] = [];
  raw.forEach((item) => {
    if (!isRecord(item)) {
      return;
    }
    const url = typeof item.url === "string" ? item.url : "";
    const title = typeof item.title === "string" ? item.title : undefined;
    const rawViewpoint =
      typeof item.viewpoint === "string" ? item.viewpoint.trim() : "";
    const content =
      typeof item.content === "string" ? item.content.trim() : undefined;
    const validationRefContent =
      typeof item.validationRefContent === "string" &&
      item.validationRefContent.trim().length > 0
        ? item.validationRefContent.trim()
        : undefined;
    const issueReason =
      typeof item.issueReason === "string" &&
      item.issueReason.trim().length > 0
        ? item.issueReason.trim()
        : undefined;
    const correctFact =
      typeof item.correctFact === "string" &&
      item.correctFact.trim().length > 0
        ? item.correctFact.trim()
        : undefined;
    const accuracy =
      item.accuracy === "high" ||
      item.accuracy === "medium" ||
      item.accuracy === "low" ||
      item.accuracy === "conflicting" ||
      item.accuracy === "insufficient"
        ? item.accuracy
        : undefined;
    const sourceAuthority =
      item.sourceAuthority === "high" ||
      item.sourceAuthority === "medium" ||
      item.sourceAuthority === "low" ||
      item.sourceAuthority === "unknown"
        ? item.sourceAuthority
        : undefined;
    const selections = parseLineSelections(item.selections);
    const broken = typeof item.broken === "boolean" ? item.broken : undefined;
    const inrelavate =
      typeof item.inrelavate === "boolean" ? item.inrelavate : undefined;
    const error = typeof item.error === "string" ? item.error : undefined;
    const viewpoint =
      rawViewpoint.length > 0
        ? rawViewpoint
        : error && error.trim().length > 0
          ? `Source processing error: ${clampText(error.trim(), 120)}`
          : "No explicit viewpoint was returned for this source; evidence remains provisional.";
    if (
      !url ||
      (selections.length === 0 &&
        broken !== true &&
        inrelavate !== true &&
        !error)
    ) {
      return;
    }
    normalized.push({
      url,
      title,
      viewpoint,
      content,
      validationRefContent,
      accuracy,
      sourceAuthority,
      issueReason,
      correctFact,
      selections,
      broken,
      inrelavate,
      error,
    });
  });
  return normalized;
};

export const dedupeSearchResults = (
  results: SearchResult[],
): SearchResult[] => {
  const normalizeViewpointKey = (viewpoint: string): string =>
    viewpoint.replace(/\s+/g, " ").trim().toLowerCase();
  const resolveSourceAuthorityScore = (
    sourceAuthority: SearchResult["sourceAuthority"],
  ): number => {
    if (sourceAuthority === "high") return 4;
    if (sourceAuthority === "medium") return 3;
    if (sourceAuthority === "unknown") return 2;
    if (sourceAuthority === "low") return 1;
    return 0;
  };
  const resolveAccuracyScore = (
    accuracy: SearchResult["accuracy"],
  ): number => {
    if (accuracy === "high") return 5;
    if (accuracy === "medium") return 4;
    if (accuracy === "insufficient") return 3;
    if (accuracy === "low") return 2;
    if (accuracy === "conflicting") return 1;
    return 0;
  };
  const score = (item: SearchResult): number => {
    const hasUsableEvidence =
      !(item.broken ?? false) &&
      !(item.inrelavate ?? false) &&
      !item.error &&
      item.selections.length > 0;
    let value = hasUsableEvidence ? 10 : 0;
    value += Math.min(item.selections.length, 5);
    if (item.content && item.content.trim().length > 0) value += 1;
    value += resolveSourceAuthorityScore(item.sourceAuthority) * 3;
    value += resolveAccuracyScore(item.accuracy) * 2;
    return value;
  };
  const mergeSelectionSets = (
    left: LineSelection[],
    right: LineSelection[],
  ): LineSelection[] => {
    const selectionMap = new Map<string, LineSelection>();
    [...left, ...right].forEach((selection) => {
      selectionMap.set(
        `${selection.start}:${selection.end}:${selection.text}`,
        selection,
      );
    });
    return Array.from(selectionMap.values()).sort((a, b) =>
      a.start === b.start ? a.end - b.end : a.start - b.start,
    );
  };

  const map = new Map<string, SearchResult>();
  for (const item of results) {
    const key = normalizeViewpointKey(item.viewpoint);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...item,
        selections: [...item.selections],
      });
    } else {
      const sameUrl = existing.url === item.url;
      const preferred = score(item) > score(existing) ? item : existing;
      const secondary = preferred === item ? existing : item;
      const mergedSelections = sameUrl
        ? mergeSelectionSets(existing.selections, item.selections)
        : [...preferred.selections];
      const hasResolvedContent = mergedSelections.length > 0;
      map.set(key, {
        ...preferred,
        title: preferred.title ?? secondary.title,
        content:
          preferred.content && preferred.content.length > 0
            ? preferred.content
            : secondary.content,
        validationRefContent:
          preferred.validationRefContent &&
          preferred.validationRefContent.length > 0
            ? preferred.validationRefContent
            : secondary.validationRefContent,
        accuracy: preferred.accuracy ?? secondary.accuracy,
        sourceAuthority: preferred.sourceAuthority ?? secondary.sourceAuthority,
        issueReason:
          preferred.issueReason && preferred.issueReason.length > 0
            ? preferred.issueReason
            : secondary.issueReason,
        correctFact:
          preferred.correctFact && preferred.correctFact.length > 0
            ? preferred.correctFact
            : secondary.correctFact,
        pageId: preferred.pageId ?? secondary.pageId,
        lineCount: preferred.lineCount ?? secondary.lineCount,
        selections: mergedSelections,
        broken: hasResolvedContent
          ? undefined
          : (preferred.broken ?? secondary.broken),
        inrelavate: hasResolvedContent
          ? undefined
          : (preferred.inrelavate ?? secondary.inrelavate),
        error: hasResolvedContent
          ? undefined
          : (preferred.error ?? secondary.error),
      });
    }
  }
  return Array.from(map.values());
};

export const validateNormalizedSearchResultsAgainstExtractedContents = (
  query: string,
  normalized: SearchResult[],
  extractedEvidenceByUrl: Map<string, ExtractedEvidence>,
): SearchResult[] =>
  normalized.flatMap((item) => {
    if (item.broken ?? false) {
      return [
        {
          ...item,
          selections: [],
        },
      ];
    }
    if (item.inrelavate ?? false) {
      return [
        {
          ...item,
          selections: [],
        },
      ];
    }
    const evidence = extractedEvidenceByUrl.get(item.url);
    if (!evidence || evidence.selections.length === 0) {
      if (item.selections.length === 0) {
        return [
          {
            ...item,
            selections: [],
          },
        ];
      }
      console.warn("[subagent.search.validate.drop.noEvidence]", {
        query,
        url: item.url,
        selections: item.selections.length,
      });
      return [];
    }
    if (item.selections.length === 0) {
      return [
        {
          ...item,
          selections: [],
        },
      ];
    }
    const selectionKey = (selection: LineSelectionBounds): string =>
      `${selection.start}:${selection.end}`;
    const convergedSelectionMap = new Map<string, LineSelectionBounds>();
    item.selections.forEach((selection) => {
      evidence.selections.forEach((evidenceSelection) => {
        const overlap = intersectSelectionBounds(selection, evidenceSelection);
        if (!overlap) {
          return;
        }
        convergedSelectionMap.set(selectionKey(overlap), overlap);
      });
    });
    const convergedSelections = Array.from(convergedSelectionMap.values()).sort(
      (a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start),
    );
    if (convergedSelections.length === 0) {
      console.warn("[subagent.search.validate.drop.noOverlap]", {
        query,
        url: item.url,
        requestedSelections: item.selections.map((selection) => ({
          start: selection.start,
          end: selection.end,
        })),
        evidenceSelections: evidence.selections.map((selection) => ({
          start: selection.start,
          end: selection.end,
        })),
      });
      return [];
    }
    const selectionByBounds = new Map<string, LineSelection>();
    evidence.selections.forEach((selection) => {
      selectionByBounds.set(selectionKey(selection), selection);
    });
    const resolvedSelectionsMap = new Map<string, LineSelection>();
    convergedSelections.forEach((selectionBounds) => {
      const key = selectionKey(selectionBounds);
      const selection = selectionByBounds.get(key);
      const numberedContent = deriveNumberedContentForSelection(
        selectionBounds,
        evidence.contentsBySelection,
      );
      if (!selection) {
        if (numberedContent) {
          resolvedSelectionsMap.set(
            `${selectionBounds.start}:${selectionBounds.end}:${numberedContent}`,
            {
              start: selectionBounds.start,
              end: selectionBounds.end,
              text: numberedContent,
            },
          );
        }
        return;
      }
      resolvedSelectionsMap.set(
        `${selection.start}:${selection.end}:${selection.text}`,
        selection,
      );
    });
    const resolvedSelections = Array.from(resolvedSelectionsMap.values());
    if (resolvedSelections.length === 0) {
      console.warn("[subagent.search.validate.drop.noResolvedContent]", {
        query,
        url: item.url,
        convergedSelections,
      });
      return [];
    }
    return [
      {
        ...item,
        selections: resolvedSelections,
      },
    ];
  });

const stripLineNumberPrefix = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\d+\s+\|\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join("\n")
    .trim();

const normalizeExcerpts = (entries: string[]): string[] => {
  const cleaned = entries
    .map((entry) => stripLineNumberPrefix(entry))
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0);
  const limited: string[] = [];
  let total = 0;
  for (const entry of cleaned) {
    const slice = clampText(entry, 900);
    if (total + slice.length > 3200) break;
    limited.push(slice);
    total += slice.length;
    if (limited.length >= 6) break;
  }
  return limited;
};

export const deriveSourceTitle = (url: string, fallback?: string): string => {
  if (!URL.canParse(url)) {
    return fallback ?? url;
  }
  const parsed = new URL(url);
  return parsed.hostname || (fallback ?? url);
};

const buildSnippet = (contents: string[]): string => {
  if (contents.length === 0) return "";
  return clampText(contents.join("\n"), 400);
};

export const buildDeepSearchSources = (
  results: SearchResult[],
  references: DeepSearchReference[],
): DeepSearchSource[] => {
  const referenceIdsByUrl = new Map<string, number[]>();
  references.forEach((reference) => {
    const current = referenceIdsByUrl.get(reference.url) ?? [];
    current.push(reference.refId);
    referenceIdsByUrl.set(reference.url, current);
  });
  return results
    .filter((item) => {
      const referenceIds = referenceIdsByUrl.get(item.url) ?? [];
      return referenceIds.length > 0;
    })
    .map((item) => {
      const referenceIds = referenceIdsByUrl.get(item.url) ?? [];
      const viewpoint =
        typeof item.viewpoint === "string" && item.viewpoint.trim().length > 0
          ? clampText(item.viewpoint.trim(), 240)
          : undefined;
      if (item.error) {
        const title = item.title ?? deriveSourceTitle(item.url, item.url);
        return {
          url: item.url,
          title,
          snippet: `Extraction error: ${clampText(item.error, 260)}`,
          error: item.error,
          excerpts: [],
          referenceIds,
          viewpoint,
        };
      }
      const excerpts = normalizeExcerpts(
        item.selections.map((selection) => selection.text),
      );
      const snippet = buildSnippet(excerpts);
      const title =
        item.title ?? deriveSourceTitle(item.url, snippet.split("\n")[0]);
      return {
        url: item.url,
        title,
        snippet,
        excerpts,
        referenceIds,
        viewpoint,
        error: item.error,
      };
    });
};

const normalizeKeyText = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

export const buildDeepSearchReferences = (
  results: SearchResult[],
  projectId: string | undefined,
  searchId: string,
  options?: { includeValidationFields?: boolean; mode?: "search" | "validate" },
): DeepSearchReference[] => {
  const includeValidationFields = options?.includeValidationFields ?? false;
  const referenceMode = options?.mode;
  const references: DeepSearchReference[] = [];
  const dedupe = new Set<string>();

  for (const result of results) {
    if ((result.broken ?? false) || (result.inrelavate ?? false)) {
      continue;
    }
    const candidates = result.selections
      .map((selection) => ({
        start: Math.max(1, selection.start),
        end: Math.max(1, selection.end),
        text: clampText(selection.text.trim(), 1200),
      }))
      .filter((selection) => selection.text.length > 0)
      .slice(0, 3);

    for (const candidate of candidates) {
      const dedupeKey = `${result.url}::${normalizeKeyText(result.viewpoint)}::${normalizeKeyText(candidate.text)}`;
      if (dedupe.has(dedupeKey)) {
        continue;
      }
      dedupe.add(dedupeKey);
      const refId = references.length + 1;
      const uri =
        projectId && searchId
          ? buildDeepResearchRefUri({ projectId, searchId, refId })
          : "";
      references.push({
        refId,
        uri,
        pageId: result.pageId ?? "",
        url: result.url,
        title: result.title,
        viewpoint: result.viewpoint,
        startLine: candidate.start,
        endLine: candidate.end,
        text: candidate.text,
        mode: referenceMode,
        validationRefContent: includeValidationFields
          ? result.validationRefContent
          : undefined,
        accuracy: result.accuracy,
        sourceAuthority: result.sourceAuthority,
        issueReason: includeValidationFields ? result.issueReason : undefined,
        correctFact: includeValidationFields ? result.correctFact : undefined,
      });
    }
  }

  return references;
};

export const buildDeepSearchContext = (
  query: string,
  references: DeepSearchReference[],
): string => {
  const context = references
    .map((reference) => {
      const title = reference.title ?? deriveSourceTitle(reference.url);
      return [
        `[${reference.refId}] ${title}`,
        `URL: ${reference.url}`,
        `Viewpoint: ${reference.viewpoint}`,
        `Lines: ${reference.startLine}-${reference.endLine}`,
        "Excerpt:",
        reference.text,
      ].join("\n");
    })
    .join("\n\n");
  return [
    `Question: ${query}`,
    "Answer using the numbered references below, each derived from source excerpts.",
    "Every supported claim must include one or more citations like [1](deertube://...).",
    "",
    context,
  ].join("\n");
};

export const linkifyCitationMarkers = (
  value: string,
  references: DeepSearchReference[],
): string => {
  const uriById = new Map<number, string>();
  references.forEach((reference) => {
    if (reference.uri) {
      uriById.set(reference.refId, reference.uri);
    }
  });
  if (uriById.size === 0) {
    return value;
  }
  const expandCitationGroup = (group: string): number[] => {
    const compact = group.trim();
    if (!compact) {
      return [];
    }
    const tokens = compact
      .split(/[\s,，、;；]+/)
      .filter((token) => token.length > 0);
    const ids: number[] = [];
    tokens.forEach((token) => {
      const rangeMatch = token.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = Number.parseInt(rangeMatch[1], 10);
        const end = Number.parseInt(rangeMatch[2], 10);
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          end >= start &&
          end - start <= 8
        ) {
          for (let index = start; index <= end; index += 1) {
            ids.push(index);
          }
        }
        return;
      }
      if (/^\d+$/.test(token)) {
        ids.push(Number.parseInt(token, 10));
      }
    });
    return ids;
  };
  const toDeertubeLinks = (ids: number[]): string[] =>
    ids
      .map((refId) => {
        const uri = uriById.get(refId);
        if (!uri) {
          return null;
        }
        return `[${refId}](${uri})`;
      })
      .filter((entry): entry is string => entry !== null);
  const canonicalizedLinkedGroups = value.replace(
    /\[([\d\s,，、;；-]+)\]\(([^)]+)\)/g,
    (full, rawGroup: string) => {
      const ids = expandCitationGroup(rawGroup);
      if (ids.length === 0) {
        return full;
      }
      const linked = toDeertubeLinks(ids);
      if (linked.length === 0) {
        return full;
      }
      return linked.join(", ");
    },
  );
  const linkifiedGroups = canonicalizedLinkedGroups.replace(
    /\[([\d\s,，、;；-]+)\](?!\()/g,
    (full, rawGroup: string) => {
      const ids = expandCitationGroup(rawGroup);
      if (ids.length === 0) {
        return full;
      }
      const linked = toDeertubeLinks(ids);
      if (linked.length === 0) {
        return full;
      }
      return linked.join(", ");
    },
  );
  const linkifiedSingle = linkifiedGroups.replace(
    /\[(\d+)\](?!\()/g,
    (full, rawRefId: string) => {
      const refId = Number.parseInt(rawRefId, 10);
      const uri = uriById.get(refId);
      if (!uri) {
        return full;
      }
      return `[${refId}](${uri})`;
    },
  );
  return linkifiedSingle.replace(/\[\^(\d+)\]/g, (full, rawRefId: string) => {
    const refId = Number.parseInt(rawRefId, 10);
    const uri = uriById.get(refId);
    if (!uri) {
      return full;
    }
    return `[${refId}](${uri})`;
  });
};
