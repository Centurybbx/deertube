import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type DeepResearchExtractionInput,
  type DeepResearchFinalizeInput,
  type DeepResearchPersistenceAdapter,
  type DeepResearchResolvedReference,
  type DeepResearchSearchRecord,
  type LineSelection,
  parseDeepResearchRefUri,
} from "../../src/shared/deepresearch";
import { ensureProjectStore } from "../trpc/routers/project";

interface DeepResearchPaths {
  rootDir: string;
  pagesDir: string;
  searchesDir: string;
}

interface StoredPageMeta {
  version: 1;
  projectId: string;
  searchId: string;
  pageId: string;
  query: string;
  url: string;
  title?: string;
  fetchedAt: string;
  lineCount: number;
  markdownFile: string;
}

interface StoredExtraction {
  version: 1;
  projectId: string;
  searchId: string;
  pageId: string;
  query: string;
  url: string;
  viewpoint: string;
  broken: boolean;
  inrelavate?: boolean;
  lineCount: number;
  selections: { start: number; end: number; text: string }[];
  rawModelOutput: string;
  error?: string;
  extractedAt: string;
}

const MARKDOWN_FILENAME = "jina.md";
const PAGE_META_FILENAME = "meta.json";
const EXTRACTION_FILENAME = "extraction.json";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const hasNodeErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const splitLines = (value: string): string[] => value.split(/\r?\n/);

const asSafeId = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "");

const normalizeCacheKey = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

const parseTimestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const parseLineSelection = (value: unknown): LineSelection | null => {
  if (!isRecord(value)) {
    return null;
  }
  const start = value.start;
  const end = value.end;
  const text = value.text;
  if (!isPositiveInteger(start) || !isPositiveInteger(end) || typeof text !== "string") {
    return null;
  }
  if (end < start) {
    return null;
  }
  return { start, end, text };
};

const parseStoredPageMeta = (value: unknown): StoredPageMeta | null => {
  if (!isRecord(value)) {
    return null;
  }
  const {
    version,
    projectId,
    searchId,
    pageId,
    query,
    url,
    title,
    fetchedAt,
    lineCount,
    markdownFile,
  } = value;
  if (
    version !== 1 ||
    typeof projectId !== "string" ||
    typeof searchId !== "string" ||
    typeof pageId !== "string" ||
    typeof query !== "string" ||
    typeof url !== "string" ||
    (title !== undefined && typeof title !== "string") ||
    typeof fetchedAt !== "string" ||
    !isNonNegativeInteger(lineCount) ||
    typeof markdownFile !== "string"
  ) {
    return null;
  }
  return {
    version,
    projectId,
    searchId,
    pageId,
    query,
    url,
    title,
    fetchedAt,
    lineCount,
    markdownFile,
  };
};

const parseStoredExtraction = (value: unknown): StoredExtraction | null => {
  if (!isRecord(value)) {
    return null;
  }
  const {
    version,
    projectId,
    searchId,
    pageId,
    query,
    url,
    viewpoint,
    broken,
    inrelavate,
    lineCount,
    selections,
    rawModelOutput,
    error,
    extractedAt,
  } = value;
  if (
    version !== 1 ||
    typeof projectId !== "string" ||
    typeof searchId !== "string" ||
    typeof pageId !== "string" ||
    typeof query !== "string" ||
    typeof url !== "string" ||
    typeof viewpoint !== "string" ||
    typeof broken !== "boolean" ||
    (inrelavate !== undefined && typeof inrelavate !== "boolean") ||
    !isNonNegativeInteger(lineCount) ||
    !Array.isArray(selections) ||
    typeof rawModelOutput !== "string" ||
    (error !== undefined && typeof error !== "string") ||
    typeof extractedAt !== "string"
  ) {
    return null;
  }

  const parsedSelections: LineSelection[] = [];
  for (const selection of selections) {
    const parsedSelection = parseLineSelection(selection);
    if (!parsedSelection) {
      return null;
    }
    parsedSelections.push(parsedSelection);
  }

  return {
    version,
    projectId,
    searchId,
    pageId,
    query,
    url,
    viewpoint,
    broken,
    inrelavate,
    lineCount,
    selections: parsedSelections,
    rawModelOutput,
    error,
    extractedAt,
  };
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
};

const writeJsonFile = async (filePath: string, data: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
};

const getDeepResearchPaths = async (projectPath: string): Promise<DeepResearchPaths> => {
  const store = await ensureProjectStore(projectPath);
  const rootDir = path.join(store.baseDir, "deepresearch");
  const pagesDir = path.join(rootDir, "pages");
  const searchesDir = path.join(rootDir, "searches");
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.mkdir(searchesDir, { recursive: true });
  return {
    rootDir,
    pagesDir,
    searchesDir,
  };
};

export const buildDeepResearchProjectId = (projectPath: string): string => {
  const digest = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return `p_${digest}`;
};

export function createDeepResearchPersistenceAdapter(projectPath: string): DeepResearchPersistenceAdapter {
  const projectId = buildDeepResearchProjectId(projectPath);

  return {
    projectId,
    async createSearchSession(query: string) {
      const paths = await getDeepResearchPaths(projectPath);
      const searchId = `s_${asSafeId(randomUUID())}`;
      const createdAt = new Date().toISOString();
      const initialRecord: DeepResearchSearchRecord = {
        version: 1,
        projectId,
        searchId,
        query,
        createdAt,
        completedAt: createdAt,
        llmPrompt: "",
        llmConclusionRaw: "",
        llmConclusionLinked: "",
        references: [],
      };
      await writeJsonFile(path.join(paths.searchesDir, `${searchId}.json`), initialRecord);
      return { searchId, createdAt };
    },
    async findCachedPageByUrl(url: string) {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return null;
      }
      const paths = await getDeepResearchPaths(projectPath);
      const pageEntries = await fs.readdir(paths.pagesDir, { withFileTypes: true });
      let latestPage:
        | {
            pageDir: string;
            meta: StoredPageMeta;
            fetchedAtMs: number;
          }
        | null = null;
      for (const entry of pageEntries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const pageDir = path.join(paths.pagesDir, entry.name);
        const metaRaw = await readJsonFile<unknown>(
          path.join(pageDir, PAGE_META_FILENAME),
        );
        const meta = parseStoredPageMeta(metaRaw);
        if (!meta || meta.projectId !== projectId) {
          continue;
        }
        if (meta.url.trim() !== normalizedUrl) {
          continue;
        }
        const fetchedAtMs = parseTimestamp(meta.fetchedAt);
        if (!latestPage || fetchedAtMs >= latestPage.fetchedAtMs) {
          latestPage = {
            pageDir,
            meta,
            fetchedAtMs,
          };
        }
      }
      if (!latestPage) {
        return null;
      }
      const markdownPath = path.join(
        latestPage.pageDir,
        latestPage.meta.markdownFile || MARKDOWN_FILENAME,
      );
      let markdown: string;
      try {
        markdown = await fs.readFile(markdownPath, "utf-8");
      } catch (error) {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      }
      if (!markdown.trim()) {
        return null;
      }
      const resolvedLineCount =
        latestPage.meta.lineCount > 0
          ? latestPage.meta.lineCount
          : splitLines(markdown).length;
      return {
        searchId: latestPage.meta.searchId,
        pageId: latestPage.meta.pageId,
        query: latestPage.meta.query,
        url: latestPage.meta.url,
        title: latestPage.meta.title,
        fetchedAt: latestPage.meta.fetchedAt,
        lineCount: resolvedLineCount,
        markdown,
      };
    },
    async findCachedExtractionByPageAndQuery(pageId: string, query: string) {
      const normalizedPageId = pageId.trim();
      if (!normalizedPageId || !SAFE_ID_PATTERN.test(normalizedPageId)) {
        return null;
      }
      const normalizedQuery = normalizeCacheKey(query);
      if (!normalizedQuery) {
        return null;
      }
      const paths = await getDeepResearchPaths(projectPath);
      const extractionRaw = await readJsonFile<unknown>(
        path.join(paths.pagesDir, normalizedPageId, EXTRACTION_FILENAME),
      );
      const extraction = parseStoredExtraction(extractionRaw);
      if (!extraction || extraction.projectId !== projectId) {
        return null;
      }
      if (normalizeCacheKey(extraction.query) !== normalizedQuery) {
        return null;
      }
      return {
        searchId: extraction.searchId,
        pageId: extraction.pageId,
        query: extraction.query,
        url: extraction.url,
        viewpoint: extraction.viewpoint,
        broken: extraction.broken,
        inrelavate: extraction.inrelavate ?? false,
        lineCount: extraction.lineCount,
        selections: extraction.selections,
        rawModelOutput: extraction.rawModelOutput,
        error: extraction.error,
        extractedAt: extraction.extractedAt,
      };
    },
    async savePage(input) {
      const paths = await getDeepResearchPaths(projectPath);
      const pageId = `p_${asSafeId(randomUUID())}`;
      const pageDir = path.join(paths.pagesDir, pageId);
      await fs.mkdir(pageDir, { recursive: true });
      const lineCount = splitLines(input.markdown).length;
      const pageMeta: StoredPageMeta = {
        version: 1,
        projectId,
        searchId: input.searchId,
        pageId,
        query: input.query,
        url: input.url,
        title: input.title,
        fetchedAt: input.fetchedAt,
        lineCount,
        markdownFile: MARKDOWN_FILENAME,
      };
      await fs.writeFile(path.join(pageDir, MARKDOWN_FILENAME), input.markdown, "utf-8");
      await writeJsonFile(path.join(pageDir, PAGE_META_FILENAME), pageMeta);
      return { pageId, lineCount };
    },
    async saveExtraction(input: DeepResearchExtractionInput) {
      const paths = await getDeepResearchPaths(projectPath);
      const pageDir = path.join(paths.pagesDir, input.pageId);
      await fs.mkdir(pageDir, { recursive: true });
      const payload: StoredExtraction = {
        version: 1,
        projectId,
        searchId: input.searchId,
        pageId: input.pageId,
        query: input.query,
        url: input.url,
        viewpoint: input.viewpoint,
        broken: input.broken,
        inrelavate: input.inrelavate,
        lineCount: input.lineCount,
        selections: input.selections,
        rawModelOutput: input.rawModelOutput,
        error: input.error,
        extractedAt: input.extractedAt,
      };
      await writeJsonFile(path.join(pageDir, EXTRACTION_FILENAME), payload);
    },
    async finalizeSearch(input: DeepResearchFinalizeInput) {
      const paths = await getDeepResearchPaths(projectPath);
      const searchPath = path.join(paths.searchesDir, `${input.searchId}.json`);
      const payload: DeepResearchSearchRecord = {
        version: 1,
        projectId,
        searchId: input.searchId,
        query: input.query,
        createdAt: input.createdAt,
        completedAt: input.completedAt,
        llmPrompt: input.llmPrompt,
        llmConclusionRaw: input.llmConclusionRaw,
        llmConclusionLinked: input.llmConclusionLinked,
        references: input.references,
      };
      await writeJsonFile(searchPath, payload);
    },
  };
}

export async function resolveDeepResearchReference(
  projectPath: string,
  uri: string,
): Promise<DeepResearchResolvedReference | null> {
  const parsedUri = parseDeepResearchRefUri(uri);
  if (!parsedUri) {
    return null;
  }
  if (!SAFE_ID_PATTERN.test(parsedUri.searchId)) {
    return null;
  }

  const projectId = buildDeepResearchProjectId(projectPath);
  if (parsedUri.projectId !== projectId) {
    return null;
  }

  const paths = await getDeepResearchPaths(projectPath);
  const searchPath = path.join(paths.searchesDir, `${parsedUri.searchId}.json`);
  const record = await readJsonFile<DeepResearchSearchRecord>(searchPath);
  if (!record || !Array.isArray(record.references)) {
    return null;
  }

  const reference = record.references.find((item) => item.refId === parsedUri.refId);
  if (!reference) {
    return null;
  }
  if (!isRecord(reference)) {
    return null;
  }

  return {
    projectId,
    searchId: parsedUri.searchId,
    refId: reference.refId,
    uri: reference.uri,
    query: record.query,
    pageId: reference.pageId,
    url: reference.url,
    title: reference.title,
    viewpoint:
      typeof reference.viewpoint === "string"
        ? reference.viewpoint
        : "Viewpoint unavailable for this reference.",
    startLine: reference.startLine,
    endLine: reference.endLine,
    text: reference.text,
    validationRefContent:
      typeof reference.validationRefContent === "string"
        ? reference.validationRefContent
        : undefined,
    accuracy:
      reference.accuracy === "high" ||
      reference.accuracy === "medium" ||
      reference.accuracy === "low" ||
      reference.accuracy === "conflicting" ||
      reference.accuracy === "insufficient"
        ? reference.accuracy
        : undefined,
    issueReason:
      typeof reference.issueReason === "string"
        ? reference.issueReason
        : undefined,
    correctFact:
      typeof reference.correctFact === "string"
        ? reference.correctFact
        : undefined,
  };
}
