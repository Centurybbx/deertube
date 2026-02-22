import type {
  DeepSearchReferencePayload,
  DeepSearchStreamPayload,
  SubagentStreamPayload,
} from "@/types/chat";
import type { BrowserPageValidationRecord } from "@/types/browserview";
import type { FlowEdge, FlowNode, InsightNodeData, SourceNodeData } from "@/types/flow";
import { stripLineNumberPrefix } from "./browser-utils";

const MAX_INSIGHT_EXCERPT_LENGTH = 560;
const MAX_SOURCE_SNIPPET_LENGTH = 380;
const VALIDATE_NODE_PREFIX = "validate-node-";
const SEARCH_NODE_PREFIX = "validate-search-node-";
const SOURCE_NODE_PREFIX = "validate-source-node-";
const ROOT_SEARCH_EDGE_PREFIX = "validate-edge-root-search-";
const SEARCH_SOURCE_EDGE_PREFIX = "validate-edge-search-source-";

type ValidationGraphRunStatus = "running" | "complete" | "failed" | "skipped";

interface ValidationGraphPageSeed {
  url: string;
  title?: string;
  viewpoint?: string;
  referenceUri?: string;
}

interface ValidationGraphPageState {
  urlKey: string;
  nodeId: string;
  url: string;
  title: string;
  viewpoint?: string;
  referenceUri?: string;
}

export interface ValidationGraphRunContext {
  runId: string;
  responseId: string;
  headline: string;
  validateNodeId: string;
  searchNodeId: string;
  anchorX: number;
  anchorY: number;
  status: ValidationGraphRunStatus;
  error?: string;
  searchQueries: string[];
  pageOrder: string[];
  pagesByUrlKey: Record<string, ValidationGraphPageState>;
  validationRecord?: BrowserPageValidationRecord;
}

interface CreateValidationGraphRunContextOptions {
  runId: string;
  baseNodes: FlowNode[];
  headline: string;
  initialQuery?: string;
}

interface ValidationGraphPatch {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const truncateText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const normalizeUrlKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!URL.canParse(trimmed)) {
    return trimmed;
  }
  const parsed = new URL(trimmed);
  parsed.hash = "";
  return parsed.toString();
};

const fallbackTitleFromUrl = (value: string): string => {
  if (!URL.canParse(value)) {
    return value;
  }
  return new URL(value).host;
};

const resolveDisplayTitle = (seed: ValidationGraphPageSeed): string => {
  const title = trimOrUndefined(seed.title);
  if (title) {
    return title;
  }
  return fallbackTitleFromUrl(seed.url);
};

const parsePossiblyJsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\""))
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

interface ToolPartLike {
  type: string;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
}

const isToolPartLike = (value: unknown): value is ToolPartLike => {
  if (!isObjectRecord(value) || typeof value.type !== "string") {
    return false;
  }
  return value.type.startsWith("tool-") || value.type === "dynamic-tool";
};

const resolveToolName = (part: ToolPartLike): string | undefined => {
  if (part.type.startsWith("tool-")) {
    const resolved = part.type.slice(5).trim();
    return resolved.length > 0 ? resolved : undefined;
  }
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
    const resolved = part.toolName.trim();
    return resolved.length > 0 ? resolved : undefined;
  }
  return undefined;
};

const parseSubagentProgress = (
  payload: SubagentStreamPayload,
): { queries: string[]; pageSeeds: ValidationGraphPageSeed[] } => {
  const querySet = new Set<string>();
  const pageByUrl = new Map<string, ValidationGraphPageSeed>();

  payload.messages.forEach((message) => {
    if (
      !isObjectRecord(message) ||
      !("parts" in message) ||
      !Array.isArray(message.parts)
    ) {
      return;
    }

    (message.parts as unknown[]).forEach((partRaw) => {
      if (!isToolPartLike(partRaw)) {
        return;
      }
      const toolName = resolveToolName(partRaw);
      if (!toolName) {
        return;
      }
      const input = parsePossiblyJsonValue(partRaw.input);
      const output = parsePossiblyJsonValue(partRaw.output);

      if (toolName === "search" && isObjectRecord(input)) {
        if (typeof input.query === "string" && input.query.trim().length > 0) {
          querySet.add(input.query.trim());
        }
        return;
      }

      if (toolName !== "extract" || !isObjectRecord(output)) {
        return;
      }

      const url = typeof output.url === "string" ? output.url.trim() : "";
      if (!url) {
        return;
      }
      const selections = Array.isArray(output.selections)
        ? output.selections.length
        : 0;
      if (selections <= 0 || output.broken === true || output.inrelavate === true) {
        return;
      }

      const urlKey = normalizeUrlKey(url);
      if (!urlKey) {
        return;
      }
      const seed: ValidationGraphPageSeed = {
        url,
        title: typeof output.title === "string" ? output.title.trim() : undefined,
        viewpoint:
          typeof output.viewpoint === "string"
            ? stripLineNumberPrefix(output.viewpoint.trim())
            : undefined,
      };
      pageByUrl.set(urlKey, seed);
    });
  });

  return {
    queries: Array.from(querySet.values()),
    pageSeeds: Array.from(pageByUrl.values()),
  };
};

const parseDeepSearchPageSeeds = (
  payload: DeepSearchStreamPayload,
): ValidationGraphPageSeed[] => {
  const seedsByUrl = new Map<string, ValidationGraphPageSeed>();
  const references = Array.isArray(payload.references) ? payload.references : [];

  const referenceByUrl = new Map<string, DeepSearchReferencePayload>();
  references.forEach((reference) => {
    const url = trimOrUndefined(reference.url);
    if (!url) {
      return;
    }
    const key = normalizeUrlKey(url);
    if (!key || referenceByUrl.has(key)) {
      return;
    }
    referenceByUrl.set(key, reference);
  });

  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  sources.forEach((source) => {
    const url = trimOrUndefined(source.url);
    if (!url) {
      return;
    }
    const urlKey = normalizeUrlKey(url);
    if (!urlKey) {
      return;
    }
    const matchedReference = referenceByUrl.get(urlKey);
    const hasReferenceIds =
      Array.isArray(source.referenceIds) && source.referenceIds.length > 0;
    const sourceViewpoint = trimOrUndefined(source.viewpoint);
    if (!matchedReference && !hasReferenceIds && !sourceViewpoint) {
      return;
    }
    seedsByUrl.set(urlKey, {
      url,
      title: trimOrUndefined(source.title) ?? trimOrUndefined(matchedReference?.title),
      viewpoint:
        sourceViewpoint ??
        trimOrUndefined(matchedReference?.viewpoint) ??
        trimOrUndefined(matchedReference?.validationRefContent),
      referenceUri: trimOrUndefined(matchedReference?.uri),
    });
  });

  references.forEach((reference) => {
    const url = trimOrUndefined(reference.url);
    if (!url) {
      return;
    }
    const urlKey = normalizeUrlKey(url);
    if (!urlKey || seedsByUrl.has(urlKey)) {
      return;
    }
    seedsByUrl.set(urlKey, {
      url,
      title: trimOrUndefined(reference.title),
      viewpoint:
        trimOrUndefined(reference.viewpoint) ??
        trimOrUndefined(reference.validationRefContent),
      referenceUri: trimOrUndefined(reference.uri),
    });
  });

  return Array.from(seedsByUrl.values());
};

const mergeSearchQueries = (
  current: string[],
  nextCandidates: string[],
): string[] => {
  const dedupe = new Set(current);
  nextCandidates.forEach((candidate) => {
    if (!candidate || candidate.trim().length === 0) {
      return;
    }
    dedupe.add(candidate.trim());
  });
  return Array.from(dedupe.values());
};

const mergePageSeeds = (
  context: ValidationGraphRunContext,
  seeds: ValidationGraphPageSeed[],
): ValidationGraphRunContext => {
  if (seeds.length === 0) {
    return context;
  }

  const nextPagesByUrlKey = {
    ...context.pagesByUrlKey,
  };
  const nextPageOrder = [...context.pageOrder];

  seeds.forEach((seed) => {
    const url = seed.url.trim();
    if (!url) {
      return;
    }
    const urlKey = normalizeUrlKey(url);
    if (!urlKey) {
      return;
    }
    const existing = nextPagesByUrlKey[urlKey];
    if (!existing) {
      nextPageOrder.push(urlKey);
    }
    nextPagesByUrlKey[urlKey] = {
      urlKey,
      nodeId:
        existing?.nodeId ??
        `${SOURCE_NODE_PREFIX}${context.runId}-${hashString(urlKey)}`,
      url,
      title:
        trimOrUndefined(seed.title) ??
        existing?.title ??
        resolveDisplayTitle(seed),
      viewpoint:
        trimOrUndefined(seed.viewpoint) ??
        existing?.viewpoint,
      referenceUri:
        trimOrUndefined(seed.referenceUri) ??
        existing?.referenceUri,
    };
  });

  return {
    ...context,
    pagesByUrlKey: nextPagesByUrlKey,
    pageOrder: nextPageOrder,
  };
};

const buildValidationMetricsSummary = (
  validation: BrowserPageValidationRecord | undefined,
): string[] => {
  if (!validation) {
    return [];
  }
  const lines: string[] = [];
  if (validation.accuracy) {
    lines.push(`Accuracy: ${validation.accuracy}`);
  }
  if (validation.sourceAuthority) {
    lines.push(`Source authority: ${validation.sourceAuthority}`);
  }
  if (validation.issueReason) {
    lines.push(`Issue: ${validation.issueReason}`);
  }
  if (validation.correctFact) {
    lines.push(`Correct: ${validation.correctFact}`);
  }
  const summaryText = trimOrUndefined(validation.text);
  if (summaryText) {
    lines.push(stripLineNumberPrefix(summaryText));
  }
  return lines;
};

const formatStatusLabel = (status: ValidationGraphRunStatus): string => {
  if (status === "complete") {
    return "Complete";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "skipped") {
    return "Skipped";
  }
  return "Running";
};

const buildValidateExcerpt = (context: ValidationGraphRunContext): string => {
  const lines: string[] = [];
  lines.push(`Status: ${formatStatusLabel(context.status)}`);
  const latestQuery = context.searchQueries.at(-1);
  if (latestQuery) {
    lines.push(`Query: ${truncateText(latestQuery, 240)}`);
  }
  lines.push(`Extracted pages: ${context.pageOrder.length}`);
  lines.push(...buildValidationMetricsSummary(context.validationRecord));
  if (context.error) {
    lines.push(`Error: ${truncateText(context.error, 260)}`);
  }
  return truncateText(lines.join("\n"), MAX_INSIGHT_EXCERPT_LENGTH);
};

const buildSearchExcerpt = (context: ValidationGraphRunContext): string => {
  const lines: string[] = [];
  lines.push(`Status: ${formatStatusLabel(context.status)}`);
  const queries = context.searchQueries.slice(-6);
  if (queries.length > 0) {
    lines.push("Queries:");
    queries.forEach((query) => {
      lines.push(`- ${truncateText(query, 220)}`);
    });
  } else {
    lines.push("Queries: pending...");
  }
  lines.push(`Extracted pages: ${context.pageOrder.length}`);
  if (context.error) {
    lines.push(`Error: ${truncateText(context.error, 220)}`);
  }
  return truncateText(lines.join("\n"), MAX_INSIGHT_EXCERPT_LENGTH);
};

const buildSourceSnippet = (page: ValidationGraphPageState): string => {
  const viewpoint = trimOrUndefined(page.viewpoint);
  if (!viewpoint) {
    return "Viewpoint is not available yet.";
  }
  return truncateText(stripLineNumberPrefix(viewpoint), MAX_SOURCE_SNIPPET_LENGTH);
};

export const createValidationGraphRunContext = ({
  runId,
  baseNodes,
  headline,
  initialQuery,
}: CreateValidationGraphRunContextOptions): ValidationGraphRunContext => {
  const maxX = baseNodes.reduce(
    (currentMax, node) => Math.max(currentMax, node.position.x),
    0,
  );
  const maxY = baseNodes.reduce(
    (currentMax, node) => Math.max(currentMax, node.position.y),
    0,
  );
  const existingValidateNodes = baseNodes.filter((node) =>
    node.id.startsWith(VALIDATE_NODE_PREFIX),
  ).length;

  return {
    runId,
    responseId: `validate:${runId}`,
    headline: headline.trim().length > 0 ? headline.trim() : "Validation",
    validateNodeId: `${VALIDATE_NODE_PREFIX}${runId}`,
    searchNodeId: `${SEARCH_NODE_PREFIX}${runId}`,
    anchorX: maxX + 320,
    anchorY: maxY + 100 + existingValidateNodes * 180,
    status: "running",
    searchQueries:
      initialQuery && initialQuery.trim().length > 0 ? [initialQuery.trim()] : [],
    pageOrder: [],
    pagesByUrlKey: {},
  };
};

export const applySubagentStreamToValidationGraphRun = ({
  context,
  payload,
}: {
  context: ValidationGraphRunContext;
  payload: SubagentStreamPayload;
}): ValidationGraphRunContext => {
  const progress = parseSubagentProgress(payload);
  const nextQueries = mergeSearchQueries(context.searchQueries, progress.queries);
  const nextContext = {
    ...context,
    searchQueries: nextQueries,
  };
  return mergePageSeeds(nextContext, progress.pageSeeds);
};

export const applyDeepSearchStreamToValidationGraphRun = ({
  context,
  payload,
}: {
  context: ValidationGraphRunContext;
  payload: DeepSearchStreamPayload;
}): ValidationGraphRunContext => {
  const queryCandidates = [
    typeof payload.query === "string" ? payload.query : "",
  ];
  const nextQueries = mergeSearchQueries(context.searchQueries, queryCandidates);
  const statusFromPayload =
    payload.status === "complete" ||
    payload.status === "failed" ||
    payload.status === "running" ||
    payload.status === "skipped"
      ? payload.status
      : context.status;
  const normalizedError =
    typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error.trim()
      : context.error;
  const nextContext = mergePageSeeds(
    {
      ...context,
      searchQueries: nextQueries,
      status:
        payload.complete === true && statusFromPayload === "running"
          ? "complete"
          : statusFromPayload,
      error: normalizedError,
    },
    parseDeepSearchPageSeeds(payload),
  );
  return nextContext;
};

const toValidationReferenceSeeds = (
  validation: BrowserPageValidationRecord,
  references: DeepSearchReferencePayload[],
): ValidationGraphPageSeed[] => {
  if (references.length > 0) {
    return references.map((reference, index) => ({
      title:
        trimOrUndefined(reference.title) ??
        `Support ${typeof reference.refId === "number" ? reference.refId : index + 1}`,
      url: trimOrUndefined(reference.url) ?? validation.url,
      viewpoint:
        trimOrUndefined(reference.viewpoint) ??
        trimOrUndefined(reference.validationRefContent) ??
        trimOrUndefined(reference.text),
      referenceUri: trimOrUndefined(reference.uri),
    }));
  }
  const fallbackUrl = trimOrUndefined(validation.referenceUrl) ?? validation.url;
  return [
    {
      title:
        trimOrUndefined(validation.referenceTitle) ??
        trimOrUndefined(validation.title) ??
        "Support 1",
      url: fallbackUrl,
      viewpoint:
        trimOrUndefined(validation.validationRefContent) ??
        trimOrUndefined(validation.text),
      referenceUri: trimOrUndefined(validation.referenceUri),
    },
  ];
};

export const applyValidationRecordToValidationGraphRun = ({
  context,
  validation,
  references,
}: {
  context: ValidationGraphRunContext;
  validation: BrowserPageValidationRecord;
  references: DeepSearchReferencePayload[];
}): ValidationGraphRunContext => {
  const nextQueries = mergeSearchQueries(context.searchQueries, [validation.query]);
  return mergePageSeeds(
    {
      ...context,
      status: "complete",
      error: undefined,
      searchQueries: nextQueries,
      validationRecord: validation,
    },
    toValidationReferenceSeeds(validation, references),
  );
};

export const markValidationGraphRunFailed = ({
  context,
  message,
}: {
  context: ValidationGraphRunContext;
  message: string;
}): ValidationGraphRunContext => ({
  ...context,
  status: "failed",
  error: message.trim().length > 0 ? message.trim() : context.error,
});

const toValidationNode = (context: ValidationGraphRunContext): FlowNode => {
  const data: InsightNodeData = {
    titleLong: `Validate · ${context.headline}`,
    titleShort: "Validate",
    titleTiny: "V",
    excerpt: buildValidateExcerpt(context),
    responseId: context.responseId,
  };
  return {
    id: context.validateNodeId,
    type: "insight",
    position: {
      x: context.anchorX,
      y: context.anchorY,
    },
    data,
  };
};

const toSearchNode = (context: ValidationGraphRunContext): FlowNode => {
  const data: InsightNodeData = {
    titleLong: "Search",
    titleShort: "Search",
    titleTiny: "S",
    excerpt: buildSearchExcerpt(context),
    responseId: context.responseId,
  };
  return {
    id: context.searchNodeId,
    type: "insight",
    position: {
      x: context.anchorX + 280,
      y: context.anchorY,
    },
    data,
  };
};

const toSourceNodes = (context: ValidationGraphRunContext): FlowNode[] => {
  const nodes: FlowNode[] = [];
  context.pageOrder.forEach((urlKey, index) => {
    const page = context.pagesByUrlKey[urlKey];
    if (!page) {
      return;
    }
    const data: SourceNodeData = {
      title: page.title,
      url: page.url,
      snippet: buildSourceSnippet(page),
      referenceUri: page.referenceUri,
      disableHoverPreview: true,
    };
    const sourceNode: FlowNode = {
      id: page.nodeId,
      type: "source",
      position: {
        x: context.anchorX + 560,
        y: context.anchorY + index * 140,
      },
      data,
    };
    nodes.push(sourceNode);
  });
  return nodes;
};

const buildValidationEdges = (context: ValidationGraphRunContext): FlowEdge[] => {
  const edges: FlowEdge[] = [
    {
      id: `${ROOT_SEARCH_EDGE_PREFIX}${context.runId}`,
      source: context.validateNodeId,
      target: context.searchNodeId,
      data: {
        relationType: "support",
      },
      style: {
        strokeDasharray: "4 3",
      },
    },
  ];
  context.pageOrder.forEach((urlKey) => {
    const page = context.pagesByUrlKey[urlKey];
    if (!page) {
      return;
    }
    edges.push({
      id: `${SEARCH_SOURCE_EDGE_PREFIX}${context.runId}-${hashString(urlKey)}`,
      source: context.searchNodeId,
      target: page.nodeId,
      data: {
        relationType: "support",
      },
      style: {
        strokeDasharray: "4 3",
      },
    });
  });
  return edges;
};

export const buildValidationGraphPatch = (
  context: ValidationGraphRunContext,
): ValidationGraphPatch => ({
  nodes: [toValidationNode(context), toSearchNode(context), ...toSourceNodes(context)],
  edges: buildValidationEdges(context),
});

export const upsertFlowNodesById = (
  baseNodes: FlowNode[],
  nextNodes: FlowNode[],
): FlowNode[] => {
  if (nextNodes.length === 0) {
    return baseNodes;
  }
  const byId = new Map(baseNodes.map((node) => [node.id, node] as const));
  nextNodes.forEach((node) => {
    byId.set(node.id, node);
  });
  return Array.from(byId.values());
};

export const upsertFlowEdgesById = (
  baseEdges: FlowEdge[],
  nextEdges: FlowEdge[],
): FlowEdge[] => {
  if (nextEdges.length === 0) {
    return baseEdges;
  }
  const byId = new Map(baseEdges.map((edge) => [edge.id, edge] as const));
  nextEdges.forEach((edge) => {
    byId.set(edge.id, edge);
  });
  return Array.from(byId.values());
};
