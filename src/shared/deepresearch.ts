import type {
  DeepResearchReferenceAccuracy,
  DeepResearchSourceAuthority,
} from "./deepresearch-config";

const DEERTUBE_PROTOCOL = "deertube:";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface LineSelection {
  start: number;
  end: number;
  text: string;
}

export interface DeepResearchReferenceRecord {
  refId: number;
  pageId: string;
  url: string;
  title?: string;
  viewpoint: string;
  startLine: number;
  endLine: number;
  text: string;
  uri: string;
  mode?: "search" | "validate";
  validationRefContent?: string;
  accuracy?: DeepResearchReferenceAccuracy;
  sourceAuthority?: DeepResearchSourceAuthority;
  issueReason?: string;
  correctFact?: string;
}

export interface DeepResearchSearchRecord {
  version: 1;
  projectId: string;
  searchId: string;
  query: string;
  createdAt: string;
  completedAt: string;
  llmPrompt: string;
  llmConclusionRaw: string;
  llmConclusionLinked: string;
  references: DeepResearchReferenceRecord[];
}

export interface DeepResearchResolvedReference {
  projectId: string;
  searchId: string;
  refId: number;
  uri: string;
  query: string;
  pageId: string;
  url: string;
  title?: string;
  viewpoint: string;
  startLine: number;
  endLine: number;
  text: string;
  mode?: "search" | "validate";
  validationRefContent?: string;
  accuracy?: DeepResearchReferenceAccuracy;
  sourceAuthority?: DeepResearchSourceAuthority;
  issueReason?: string;
  correctFact?: string;
}

export interface DeepResearchSearchSession {
  searchId: string;
  createdAt: string;
}

export interface DeepResearchPersistedPage {
  pageId: string;
  lineCount: number;
}

export interface DeepResearchCachedPage {
  searchId: string;
  pageId: string;
  query: string;
  url: string;
  title?: string;
  fetchedAt: string;
  lineCount: number;
  markdown: string;
}

export interface DeepResearchPageInput {
  searchId: string;
  query: string;
  url: string;
  title?: string;
  markdown: string;
  fetchedAt: string;
}

export interface DeepResearchExtractionInput {
  searchId: string;
  pageId: string;
  query: string;
  url: string;
  viewpoint: string;
  broken: boolean;
  inrelavate?: boolean;
  lineCount: number;
  selections: LineSelection[];
  rawModelOutput: string;
  error?: string;
  extractedAt: string;
}

export interface DeepResearchCachedExtraction {
  searchId: string;
  pageId: string;
  query: string;
  url: string;
  viewpoint: string;
  broken: boolean;
  inrelavate: boolean;
  lineCount: number;
  selections: LineSelection[];
  rawModelOutput: string;
  error?: string;
  extractedAt: string;
}

export interface DeepResearchFinalizeInput {
  searchId: string;
  query: string;
  llmPrompt: string;
  llmConclusionRaw: string;
  llmConclusionLinked: string;
  references: DeepResearchReferenceRecord[];
  createdAt: string;
  completedAt: string;
}

export interface DeepResearchPersistenceAdapter {
  projectId: string;
  createSearchSession(query: string): Promise<DeepResearchSearchSession>;
  findCachedPageByUrl(url: string): Promise<DeepResearchCachedPage | null>;
  findCachedExtractionByPageAndQuery(
    pageId: string,
    query: string,
  ): Promise<DeepResearchCachedExtraction | null>;
  savePage(input: DeepResearchPageInput): Promise<DeepResearchPersistedPage>;
  saveExtraction(input: DeepResearchExtractionInput): Promise<void>;
  finalizeSearch(input: DeepResearchFinalizeInput): Promise<void>;
}

export interface DeepResearchRefUriParts {
  projectId: string;
  searchId: string;
  refId: number;
}

const decodePathValue = (value: string): string => {
  return decodeURIComponent(value);
};

const parsePositiveInt = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const isSafeDeepResearchId = (value: string | null | undefined): value is string =>
  typeof value === "string" && SAFE_ID_PATTERN.test(value);

export const buildDeepResearchRefUri = (parts: DeepResearchRefUriParts): string =>
  `deertube://project/${encodeURIComponent(parts.projectId)}/search/${encodeURIComponent(parts.searchId)}/ref/${parts.refId}`;

export const parseDeepResearchRefUri = (value: string): DeepResearchRefUriParts | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!URL.canParse(trimmed)) {
    return null;
  }
  const parsed = new URL(trimmed);

  if (parsed.protocol !== DEERTUBE_PROTOCOL) {
    return null;
  }

  const host = parsed.hostname || parsed.host;
  const segments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(decodePathValue);

  if (host === "project" && segments.length >= 5 && segments[1] === "search" && segments[3] === "ref") {
    const projectId = segments[0];
    const searchId = segments[2];
    const refId = parsePositiveInt(segments[4]);
    if (!isSafeDeepResearchId(projectId) || !isSafeDeepResearchId(searchId) || refId === null) {
      return null;
    }
    return { projectId, searchId, refId };
  }

  if (host === "index.html" && segments.length >= 2 && segments[0] === "ref") {
    const refId = parsePositiveInt(segments[1]);
    const projectId = parsed.searchParams.get("projectId");
    const searchId = parsed.searchParams.get("searchId");
    if (!isSafeDeepResearchId(projectId) || !isSafeDeepResearchId(searchId) || refId === null) {
      return null;
    }
    return { projectId, searchId, refId };
  }

  return null;
};

export const isDeepResearchRefUri = (value: string): boolean =>
  parseDeepResearchRefUri(value) !== null;
