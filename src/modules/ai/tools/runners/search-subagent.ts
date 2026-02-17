import {
  hasToolCall,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";
import type { JsonValue } from "../../../../types/json";
import type {
  DeepResearchPersistenceAdapter,
  LineSelection,
} from "../../../../shared/deepresearch";
import {
  LineSelectionSchema,
  SearchSubagentFinalSchema,
  TavilySearchResultSchema,
} from "../schemas";
import {
  buildSearchSubagentRuntimePrompt,
  buildSearchSubagentSystemPrompt,
  type DeepResearchSubagentConfigInput,
  type DeepResearchStrictness,
  resolveDeepResearchSubagentConfig,
} from "../../../../shared/deepresearch-config";
import {
  getAgentSkill,
  listAgentSkills,
  type AgentSkillProfile,
  type RuntimeAgentSkill,
} from "../../../../shared/agent-skills";
import {
  clampText,
  collectToolOutputs,
  deriveNumberedContentForSelection,
  dedupeSearchResults,
  fetchJinaReaderMarkdown,
  fetchTavilySearch,
  intersectSelectionBounds,
  isRecord,
  normalizeSearchResults,
  parseLineSelections,
  splitLines,
  summarizeContentsPreview,
  summarizeSelections,
  validateNormalizedSearchResultsAgainstExtractedContents,
  writeSubagentStream,
} from "../helpers";
import type {
  ExtractedEvidence,
  SearchResult,
  SubagentStreamPayload,
  SubagentUIMessage,
} from "../types";
import { runExtractSubagent } from "./extract-subagent";

const SEARCH_SUBAGENT_MAX_STEPS = 16;
const ABORT_ERROR_NAME = "AbortError";
const MAX_VALIDATE_ANSWER_CHARS = 5000;

const normalizeToolKey = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

const SEARCH_VIEWPOINT_FALLBACK =
  "Insufficient validated evidence from this source to form a reliable query-grounded viewpoint.";

const normalizeSearchViewpoint = (
  value: string | undefined,
  fallback = SEARCH_VIEWPOINT_FALLBACK,
): string => {
  const compact = (value ?? "").replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : fallback;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === ABORT_ERROR_NAME;

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("Operation aborted.");
  error.name = ABORT_ERROR_NAME;
  throw error;
};

const resolveAbortSignal = (
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined => signals.find((candidate) => candidate !== undefined);

type SearchSubagentFinalPayload = z.infer<typeof SearchSubagentFinalSchema>;
interface ExtractedUrlMeta {
  title?: string;
  pageId?: string;
  lineCount?: number;
  viewpoint?: string;
  validationRefContent?: string;
  accuracy?: SearchResult["accuracy"];
  broken?: boolean;
  inrelavate?: boolean;
  error?: string;
}
const uniqueTrimmedStrings = (values: string[]): string[] => {
  const dedupe = new Set<string>();
  values.forEach((value) => {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return;
    }
    dedupe.add(normalized);
  });
  return Array.from(dedupe.values());
};

export async function runSearchSubagent({
  query,
  searchId,
  model,
  extractModel,
  writer,
  toolCallId,
  toolName,
  abortSignal,
  tavilyApiKey,
  jinaReaderBaseUrl,
  jinaReaderApiKey,
  deepResearchStore,
  subagentConfig,
  skillProfile,
  selectedSkillNames,
  externalSkills,
  fullPromptOverrideEnabled = false,
  strictness = "all-claims",
  mode = "search",
  answerToValidate = "",
  onSubagentStream,
}: {
  query: string;
  searchId: string;
  model: LanguageModel;
  extractModel?: LanguageModel;
  writer?: UIMessageStreamWriter;
  toolCallId?: string;
  toolName?: string;
  abortSignal?: AbortSignal;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
  deepResearchStore?: DeepResearchPersistenceAdapter;
  subagentConfig?: DeepResearchSubagentConfigInput;
  skillProfile?: AgentSkillProfile;
  selectedSkillNames?: string[];
  externalSkills?: RuntimeAgentSkill[];
  fullPromptOverrideEnabled?: boolean;
  strictness?: DeepResearchStrictness;
  mode?: "search" | "validate";
  answerToValidate?: string;
  onSubagentStream?: (payload: SubagentStreamPayload) => void;
}): Promise<SearchResult[]> {
  console.log("[subagent.runSearch]", {
    query,
    toolCallId,
    mode,
    strictness,
  });
  const resolvedSubagentConfig =
    resolveDeepResearchSubagentConfig(subagentConfig);
  const availableSkills = listAgentSkills({ externalSkills });
  const accumulatedMessages: SubagentUIMessage[] = [];
  const searchToolErrors: string[] = [];
  const extractToolErrors: string[] = [];
  let searchToolCallCount = 0;
  let searchToolErrorCount = 0;
  let extractToolCallCount = 0;
  let extractToolErrorCount = 0;
  let writeResultsCallCount = 0;
  let collectedFinalPayload: SearchSubagentFinalPayload | undefined;
  const searchCallCountByQuery = new Map<string, number>();
  const extractCallCountByUrl = new Map<string, number>();
  const extractedEvidenceByUrl = new Map<string, ExtractedEvidence>();
  const extractedMetaByUrl = new Map<string, ExtractedUrlMeta>();
  const searchLookup = new Map<string, { title?: string; snippet?: string }>();

  const searchTool = tool({
    description:
      "Search the web via Tavily and return ranked candidate results.",
    inputSchema: z
      .object({
        query: z.string().min(1).describe("Natural-language web search query."),
      })
      .describe("Input payload for Tavily web search."),
    outputSchema: z
      .object({
        results: z
          .array(TavilySearchResultSchema)
          .describe("Ranked Tavily search results."),
        error: z
          .string()
          .optional()
          .describe("Search error reason when this tool call fails."),
      })
      .describe("Tavily search tool output."),
    execute: async ({ query: inputQuery }, options) => {
      searchToolCallCount += 1;
      const requestAbortSignal = resolveAbortSignal(
        options.abortSignal,
        abortSignal,
      );
      const normalizedQuery = normalizeToolKey(inputQuery);
      const repeatedSearchCalls =
        (searchCallCountByQuery.get(normalizedQuery) ?? 0) + 1;
      searchCallCountByQuery.set(normalizedQuery, repeatedSearchCalls);
      if (searchToolCallCount > resolvedSubagentConfig.maxSearchCalls) {
        const message = `search call budget exceeded (${resolvedSubagentConfig.maxSearchCalls}).`;
        searchToolErrorCount += 1;
        searchToolErrors.push(message);
        throw new Error(message);
      }
      if (
        repeatedSearchCalls > resolvedSubagentConfig.maxRepeatSearchQuery
      ) {
        const message = `repeated search query blocked (${resolvedSubagentConfig.maxRepeatSearchQuery}x max): ${inputQuery}`;
        searchToolErrorCount += 1;
        searchToolErrors.push(message);
        throw new Error(message);
      }
      console.log("[subagent.search]", {
        query: inputQuery,
        maxResults: 20,
      });
      try {
        throwIfAborted(requestAbortSignal);
        const results = await fetchTavilySearch(
          inputQuery,
          20,
          tavilyApiKey,
          resolvedSubagentConfig.tavilySearchDepth,
          requestAbortSignal,
        );
        throwIfAborted(requestAbortSignal);
        results.forEach((item) => {
          const url = item.url?.trim();
          if (!url) {
            return;
          }
          searchLookup.set(url, {
            title: item.title ?? item.description ?? undefined,
            snippet: item.content ?? item.snippet ?? undefined,
          });
        });
        console.log("[subagent.search.results]", {
          count: results.length,
          top: results
            .slice(0, 3)
            .map((item) => item.url ?? item.title ?? "unknown"),
        });
        return { results };
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        searchToolErrorCount += 1;
        searchToolErrors.push(message);
        console.error("[subagent.search.error]", {
          query: inputQuery,
          error: clampText(message, 260),
        });
        throw error instanceof Error ? error : new Error(message);
      }
    },
  });

  const ExtractToolOutputSchema = z
    .object({
      url: z.string().min(1).describe("Source URL that was extracted."),
      title: z
        .string()
        .optional()
        .describe("Resolved page title when available."),
      pageId: z
        .string()
        .optional()
        .describe("Persisted page identifier in DeepResearch storage."),
      lineCount: z
        .number()
        .int()
        .nonnegative()
        .describe("Total line count of fetched markdown."),
      broken: z
        .boolean()
        .describe("Whether page content is unavailable/corrupted/blocked."),
      inrelavate: z
        .boolean()
        .describe("Whether the page is judged unrelated to query."),
      viewpoint: z
        .string()
        .min(1)
        .describe(
          "Extracted source-level viewpoint for this URL. Should stay concise.",
        ),
      selections: z
        .array(LineSelectionSchema)
        .describe(
          "Selections with start/end line metadata and line-numbered markdown text.",
        ),
      error: z
        .string()
        .optional()
        .describe(
          "Extraction error message when this URL cannot be extracted.",
        ),
      rawModelOutput: z
        .string()
        .describe("Raw text output returned by extract subagent model."),
    })
    .describe("Extraction result for one URL.");

  const extractTool = tool({
    description:
      "Fetch markdown from a URL and extract passages relevant to the query.",
    inputSchema: z
      .object({
        url: z
          .string()
          .min(1)
          .describe("Target page URL to fetch and extract from."),
        query: z
          .string()
          .min(1)
          .describe("User query used to locate relevant passages."),
      })
      .describe("Input payload for single-URL extraction."),
    outputSchema: ExtractToolOutputSchema,
    execute: async (
      { url, query: extractQuery },
      options,
    ): Promise<z.infer<typeof ExtractToolOutputSchema>> => {
      extractToolCallCount += 1;
      const requestAbortSignal = resolveAbortSignal(
        options.abortSignal,
        abortSignal,
      );
      const normalizedUrl = normalizeToolKey(url);
      const repeatedExtractCalls =
        (extractCallCountByUrl.get(normalizedUrl) ?? 0) + 1;
      extractCallCountByUrl.set(normalizedUrl, repeatedExtractCalls);
      if (extractToolCallCount > resolvedSubagentConfig.maxExtractCalls) {
        const errorMessage = `extract call budget exceeded (${resolvedSubagentConfig.maxExtractCalls}).`;
        extractToolErrorCount += 1;
        extractToolErrors.push(errorMessage);
        throw new Error(errorMessage);
      }
      if (
        repeatedExtractCalls > resolvedSubagentConfig.maxRepeatExtractUrl
      ) {
        const errorMessage = `repeated extract URL blocked (${resolvedSubagentConfig.maxRepeatExtractUrl}x max): ${url}`;
        extractToolErrorCount += 1;
        extractToolErrors.push(errorMessage);
        throw new Error(errorMessage);
      }
      const extractStartedAt = Date.now();
      let stage = "init";
      const lookup = searchLookup.get(url);
      let pageTitle = lookup?.title;
      let pageId: string | undefined;
      let lineCount = 0;
      let rawModelOutput = "";
      let lines: string[] = [];
      throwIfAborted(requestAbortSignal);
      console.log("[subagent.extract]", {
        url: clampText(url, 220),
        query: clampText(extractQuery, 160),
      });
      try {
        if (deepResearchStore) {
          throwIfAborted(requestAbortSignal);
          stage = "load-page-cache";
          const cachedPage = await deepResearchStore.findCachedPageByUrl(url);
          if (cachedPage) {
            lines = splitLines(cachedPage.markdown);
            pageId = cachedPage.pageId;
            lineCount = cachedPage.lineCount > 0 ? cachedPage.lineCount : lines.length;
            pageTitle = pageTitle ?? cachedPage.title;
            console.log("[subagent.extract.cache.pageHit]", {
              url: clampText(url, 220),
              pageId,
              lineCount,
              cachedFetchedAt: cachedPage.fetchedAt,
            });
          }
        }

        if (lines.length === 0) {
          throwIfAborted(requestAbortSignal);
          stage = "fetch-markdown";
          const markdownFetchStartedAt = Date.now();
          console.log("[subagent.extract.fetch.start]", {
            url: clampText(url, 220),
            query: clampText(extractQuery, 160),
          });
          const markdown = await fetchJinaReaderMarkdown(
            url,
            jinaReaderBaseUrl,
            jinaReaderApiKey,
            requestAbortSignal,
          );
          throwIfAborted(requestAbortSignal);
          console.log("[subagent.extract.fetch.done]", {
            url: clampText(url, 220),
            elapsedMs: Date.now() - markdownFetchStartedAt,
            markdownCharCount: markdown.length,
          });
          if (!markdown.trim()) {
            throw new Error("Jina content unavailable.");
          }
          const fetchedAt = new Date().toISOString();
          lines = splitLines(markdown);
          lineCount = lines.length;
          console.log("[subagent.extract.markdown]", {
            url: clampText(url, 220),
            lineCount: lines.length,
            markdownCharCount: markdown.length,
            markdownPreview: clampText(markdown, 240),
          });
          if (deepResearchStore) {
            throwIfAborted(requestAbortSignal);
            stage = "save-page";
            const persistedPage = await deepResearchStore.savePage({
              searchId,
              query: extractQuery,
              url,
              title: pageTitle,
              markdown,
              fetchedAt,
            });
            pageId = persistedPage.pageId;
            lineCount = persistedPage.lineCount;
            console.log("[subagent.extract.pageSaved]", {
              url: clampText(url, 220),
              pageId,
              lineCount,
            });
          }
        }

        if (deepResearchStore && pageId) {
          throwIfAborted(requestAbortSignal);
          stage = "load-extraction-cache";
          const cachedExtraction =
            await deepResearchStore.findCachedExtractionByPageAndQuery(
              pageId,
              extractQuery,
            );
          if (cachedExtraction) {
            rawModelOutput = cachedExtraction.rawModelOutput;
            lineCount =
              cachedExtraction.lineCount > 0
                ? cachedExtraction.lineCount
                : lineCount;
            console.log("[subagent.extract.cache.extractionHit]", {
              url: clampText(url, 220),
              pageId,
              selections: cachedExtraction.selections.length,
              extractedAt: cachedExtraction.extractedAt,
            });
            return {
              url,
              title: pageTitle,
              pageId,
              lineCount,
              broken: cachedExtraction.broken,
              inrelavate: cachedExtraction.inrelavate,
              viewpoint: cachedExtraction.viewpoint,
              selections: cachedExtraction.selections,
              error: cachedExtraction.error,
              rawModelOutput,
            };
          }
        }

        stage = "extract-agent";
        const {
          viewpoint,
          broken: extractedBroken,
          inrelavate,
          error: extractedError,
          selections,
          rawModelOutput: extractRawModelOutput,
        } = await runExtractSubagent({
          query: extractQuery,
          sourceUrl: url,
          lines,
          model: extractModel ?? model,
          abortSignal: requestAbortSignal,
        });
        rawModelOutput = extractRawModelOutput;
        if (deepResearchStore && pageId) {
          throwIfAborted(requestAbortSignal);
          stage = "save-extraction";
          await deepResearchStore.saveExtraction({
            searchId,
            pageId,
            query: extractQuery,
            url,
            viewpoint,
            broken: extractedBroken,
            inrelavate,
            lineCount,
            selections,
            rawModelOutput,
            error: extractedError,
            extractedAt: new Date().toISOString(),
          });
          console.log("[subagent.extract.extractionSaved]", {
            url: clampText(url, 220),
            pageId,
            selections: selections.length,
          });
        }
        console.log("[subagent.extract.done]", {
          url: clampText(url, 220),
          viewpoint: clampText(viewpoint, 120),
          broken: extractedBroken,
          inrelavate,
          error: extractedError ? clampText(extractedError, 220) : undefined,
          selections: selections.length,
          selectionSummary: summarizeSelections(selections),
          selectionsPreview: summarizeContentsPreview(
            selections.map((selection) => selection.text),
          ),
          elapsedMs: Date.now() - extractStartedAt,
        });
        const result = {
          url,
          title: pageTitle,
          pageId,
          lineCount,
          broken: extractedBroken,
          inrelavate,
          viewpoint,
          selections,
          error: extractedError,
          rawModelOutput,
        };
        console.log("[subagent.extract.result]", {
          url: clampText(url, 220),
          title: pageTitle ? clampText(pageTitle, 140) : undefined,
          pageId,
          lineCount,
          viewpoint: clampText(viewpoint, 120),
          broken: extractedBroken,
          inrelavate,
          selections: selections.length,
          error: extractedError ? clampText(extractedError, 220) : undefined,
        });
        return result;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const errorMessage = `${stage}: ${message}`;
        extractToolErrorCount += 1;
        extractToolErrors.push(errorMessage);
        console.error("[subagent.extract.error]", {
          url: clampText(url, 220),
          query: clampText(extractQuery, 160),
          stage,
          elapsedMs: Date.now() - extractStartedAt,
          error: clampText(errorMessage, 300),
        });
        throw error instanceof Error ? error : new Error(errorMessage);
      }
    },
  });

  const discoverSkillsTool = tool({
    description:
      "List available domain skills with activation hints so the agent can pick one before search planning.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      skills: z.array(
        z.object({
          name: z.string(),
          title: z.string(),
          description: z.string(),
          activationHints: z.array(z.string()),
        }),
      ),
    }),
    execute: () => ({
      skills: availableSkills.map((skill) => ({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        activationHints: skill.activationHints,
      })),
    }),
  });

  const loadSkillTool = tool({
    description:
      "Load one domain skill by exact name and return full guidance markdown.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .describe(
          `Exact skill name. Available: ${availableSkills.map((skill) => skill.name).join(", ")}`,
        ),
    }),
    outputSchema: z.object({
      name: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: ({ name }) => {
      const matched = getAgentSkill(name, { externalSkills });
      if (!matched) {
        return {
          name,
          error: `Unknown skill "${name}".`,
        };
      }
      return {
        name: matched.name,
        title: matched.title,
        content: matched.content,
      };
    },
  });

  const executeSkillTool = tool({
    description:
      "Apply one loaded skill to a concrete task and return task-specific guidance text.",
    inputSchema: z.object({
      name: z.string().min(1),
      task: z.string().min(1),
    }),
    outputSchema: z.object({
      name: z.string(),
      task: z.string(),
      guidance: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: ({ name, task }) => {
      const matched = getAgentSkill(name, { externalSkills });
      if (!matched) {
        return {
          name,
          task,
          error: `Unknown skill "${name}".`,
        };
      }
      return {
        name: matched.name,
        task,
        guidance: [
          `Apply skill "${matched.title}" to the task below.`,
          "",
          `Task: ${task}`,
          "",
          matched.content,
        ].join("\n"),
      };
    },
  });

  const writeResultsTool = tool({
    description:
      "Write the final search-subagent payload with per-URL results and global errors.",
    inputSchema: SearchSubagentFinalSchema.describe(
      "Final search result payload. Call once when evidence collection is complete.",
    ),
    outputSchema: z
      .object({
        recorded: z.literal(true),
        callCount: z.number().int().positive(),
        resultCount: z.number().int().nonnegative(),
        errorCount: z.number().int().nonnegative(),
      })
      .describe("Acknowledgement for stored final search payload."),
    execute: ({ results, errors }) => {
      writeResultsCallCount += 1;
      const mergedResults = collectedFinalPayload
        ? [...collectedFinalPayload.results, ...results]
        : [...results];
      const mergedErrors = collectedFinalPayload
        ? uniqueTrimmedStrings([...collectedFinalPayload.errors, ...errors])
        : uniqueTrimmedStrings(errors);
      const dedupeByKey = new Map<
        string,
        SearchSubagentFinalPayload["results"][number]
      >();
      mergedResults.forEach((item) => {
        const url = typeof item.url === "string" ? item.url : "";
        const key = `${url}|${item.viewpoint}|${item.content}|${item.selections
          .map((selection) => `${selection.start}:${selection.end}:${selection.text}`)
          .join(",")}|${item.validationRefContent ?? ""}|${item.accuracy ?? ""}|${
          item.issueReason ?? ""
        }|${item.correctFact ?? ""}|${String(item.broken)}|${String(
          item.inrelavate,
        )}|${item.error ?? ""}`;
        dedupeByKey.set(key, item);
      });
      collectedFinalPayload = {
        results: Array.from(dedupeByKey.values()),
        errors: mergedErrors,
      };
      console.log("[subagent.runSearch.writeResults]", {
        callCount: writeResultsCallCount,
        inputResultCount: results.length,
        inputErrorCount: errors.length,
        mergedResultCount: collectedFinalPayload.results.length,
        mergedErrorCount: collectedFinalPayload.errors.length,
        sampleUrls: collectedFinalPayload.results
          .slice(0, 5)
          .map((item) => item.url ?? "unknown"),
      });
      return {
        recorded: true,
        callCount: writeResultsCallCount,
        resultCount: collectedFinalPayload.results.length,
        errorCount: collectedFinalPayload.errors.length,
      };
    },
  });

  const searchSubagentPrompt = buildSearchSubagentRuntimePrompt({
    query,
    subagentConfig: resolvedSubagentConfig,
    strictness,
    fullPromptOverrideEnabled,
    mode,
    answerToValidate: clampText(answerToValidate, MAX_VALIDATE_ANSWER_CHARS),
  });
  const searchSubagentSystemPrompt = buildSearchSubagentSystemPrompt({
    subagentConfig: resolvedSubagentConfig,
    query,
    strictness,
    skillProfile: skillProfile ?? "auto",
    selectedSkillNames,
    availableSkills: externalSkills,
    fullPromptOverrideEnabled,
    mode,
    answerToValidate: clampText(answerToValidate, MAX_VALIDATE_ANSWER_CHARS),
  });

  throwIfAborted(abortSignal);
  const result = streamText({
    model,
    system: searchSubagentSystemPrompt,
    prompt: searchSubagentPrompt,
    tools: {
      discoverSkills: discoverSkillsTool,
      loadSkill: loadSkillTool,
      executeSkill: executeSkillTool,
      search: searchTool,
      extract: extractTool,
      writeResults: writeResultsTool,
    },
    toolChoice: "auto",
    stopWhen: [
      hasToolCall("writeResults"),
      stepCountIs(SEARCH_SUBAGENT_MAX_STEPS),
    ],
    abortSignal,
  });

  const stream = result.toUIMessageStream<SubagentUIMessage>();
  const uiMessages = readUIMessageStream<SubagentUIMessage>({ stream });

  for await (const uiMessage of uiMessages) {
    const existingIndex = accumulatedMessages.findIndex(
      (item) => item.id === uiMessage.id,
    );
    if (existingIndex >= 0) {
      accumulatedMessages[existingIndex] = uiMessage;
    } else {
      accumulatedMessages.push(uiMessage);
    }
    writeSubagentStream(
      writer,
      toolCallId,
      toolName,
      accumulatedMessages,
      onSubagentStream,
    );
    if (uiMessage.role === "assistant") {
      const outputs = collectToolOutputs(uiMessage);
      outputs.forEach((output) => {
        if (output.name === "search") {
          if (isRecord(output.output)) {
            const errorMessage =
              typeof output.output.error === "string"
                ? output.output.error.trim()
                : "";
            if (errorMessage.length > 0) {
              searchToolErrors.push(errorMessage);
            }
          }
          return;
        }
        if (output.name !== "extract") return;
        if (!isRecord(output.output)) return;
        const url =
          typeof output.output.url === "string" ? output.output.url : "";
        const selections = parseLineSelections(output.output.selections);
        const viewpoint =
          typeof output.output.viewpoint === "string"
            ? normalizeSearchViewpoint(output.output.viewpoint)
            : undefined;
        const errorMessage =
          typeof output.output.error === "string"
            ? output.output.error.trim()
            : undefined;
        const title =
          typeof output.output.title === "string" &&
          output.output.title.trim().length > 0
            ? output.output.title.trim()
            : undefined;
        const pageId =
          typeof output.output.pageId === "string" &&
          output.output.pageId.trim().length > 0
            ? output.output.pageId.trim()
            : undefined;
        const lineCount =
          typeof output.output.lineCount === "number" &&
          Number.isFinite(output.output.lineCount) &&
          output.output.lineCount >= 0
            ? Math.floor(output.output.lineCount)
            : undefined;
        const broken =
          typeof output.output.broken === "boolean"
            ? output.output.broken
            : undefined;
        const inrelavate =
          typeof output.output.inrelavate === "boolean"
            ? output.output.inrelavate
            : undefined;
        if (url) {
          const existingMeta = extractedMetaByUrl.get(url) ?? {};
          extractedMetaByUrl.set(url, {
            title: existingMeta.title ?? title ?? searchLookup.get(url)?.title,
            pageId: existingMeta.pageId ?? pageId,
            lineCount: existingMeta.lineCount ?? lineCount,
            viewpoint: existingMeta.viewpoint ?? viewpoint,
            broken: (existingMeta.broken ?? false) || (broken ?? false),
            inrelavate:
              (existingMeta.inrelavate ?? false) || (inrelavate ?? false),
            error: existingMeta.error ?? errorMessage,
          });
        }
        if (errorMessage && errorMessage.trim().length > 0) {
          extractToolErrors.push(errorMessage.trim());
        }
        if (!url || (selections.length === 0 && !errorMessage)) {
          return;
        }
        const existingEvidence = extractedEvidenceByUrl.get(url) ?? {
          selections: [],
          contentsBySelection: new Map<string, string>(),
        };
        const mergedSelectionMap = new Map<string, LineSelection>();
        [...existingEvidence.selections, ...selections].forEach((selection) => {
          mergedSelectionMap.set(
            `${selection.start}:${selection.end}:${selection.text}`,
            selection,
          );
        });
        selections.forEach((selection) => {
          const key = `${selection.start}:${selection.end}`;
          existingEvidence.contentsBySelection.set(key, selection.text);
        });
        extractedEvidenceByUrl.set(url, {
          selections: Array.from(mergedSelectionMap.values()),
          contentsBySelection: existingEvidence.contentsBySelection,
        });
      });
    }
  }

  if (!collectedFinalPayload) {
    console.warn("[subagent.runSearch.missingFinalToolCall]", {
      query,
      searchToolCallCount,
      extractToolCallCount,
    });
    throw new Error(
      "search subagent did not call writeResults before finishing.",
    );
  }
  const parsed = collectedFinalPayload;

  const enforceWriteResultsConsistency = (
    candidate: SearchResult[],
  ): { normalized: SearchResult[]; errors: string[] } => {
    const errors: string[] = [];
    const extractedUrls = new Set<string>([
      ...Array.from(extractedEvidenceByUrl.keys()),
      ...Array.from(extractedMetaByUrl.keys()),
    ]);
    const normalized = candidate.flatMap((item) => {
      if (!extractedUrls.has(item.url)) {
        errors.push(
          `writeResults returned URL that was never extracted: ${item.url}`,
        );
        return [];
      }
      if ((item.broken ?? false) || (item.inrelavate ?? false)) {
        return [item];
      }
      const evidence = extractedEvidenceByUrl.get(item.url);
      if (!evidence || evidence.selections.length === 0) {
        errors.push(
          `writeResults returned selections but no extracted selections exist for URL: ${item.url}`,
        );
        return [];
      }
      if (item.selections.length === 0) {
        return [item];
      }
      const selectionMap = new Map<string, LineSelection>();
      item.selections.forEach((candidateSelection) => {
        evidence.selections.forEach((extractedSelection) => {
          const overlap = intersectSelectionBounds(
            candidateSelection,
            extractedSelection,
          );
          if (!overlap) {
            return;
          }
          const exact = evidence.contentsBySelection.get(
            `${overlap.start}:${overlap.end}`,
          );
          const text =
            exact ??
            deriveNumberedContentForSelection(
              overlap,
              evidence.contentsBySelection,
            );
          if (!text || text.trim().length === 0) {
            return;
          }
          selectionMap.set(`${overlap.start}:${overlap.end}:${text}`, {
            start: overlap.start,
            end: overlap.end,
            text,
          });
        });
      });
      if (selectionMap.size === 0) {
        errors.push(
          `writeResults returned non-overlapping selections for URL: ${item.url}; dropped this result item.`,
        );
        return [];
      }
      const intersectedSelections = Array.from(selectionMap.values()).sort(
        (a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start),
      );
      if (intersectedSelections.length !== item.selections.length) {
        errors.push(
          `writeResults selections clipped to extracted subset for URL: ${item.url}`,
        );
      }
      return [{ ...item, selections: intersectedSelections }];
    });
    return { normalized, errors };
  };

  let toolResultsNormalized: SearchResult[] = [];
  try {
    toolResultsNormalized = normalizeSearchResults(
      parsed.results as unknown as JsonValue,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`writeResults payload parse failed: ${message}`);
  }
  const {
    normalized: checkedToolResults,
    errors: writeResultsConsistencyErrors,
  } = enforceWriteResultsConsistency(toolResultsNormalized);
  const normalizedGlobalErrors = [
    ...parsed.errors
      .map((error) => error.trim())
      .filter((error) => error.length > 0),
    ...writeResultsConsistencyErrors,
    ...searchToolErrors,
    ...extractToolErrors,
  ];
  const globalErrorResults = normalizedGlobalErrors.map((error, index) => ({
    url: `search://subagent-error/${index + 1}`,
    title: "Search subagent",
    viewpoint: normalizeSearchViewpoint(
      `Subagent tool failure #${index + 1} during evidence collection.`,
    ),
    selections: [],
    broken: true,
    inrelavate: false,
    error,
  })) satisfies SearchResult[];
  const normalized = validateNormalizedSearchResultsAgainstExtractedContents(
    query,
    checkedToolResults,
    extractedEvidenceByUrl,
  ).map((item) => {
    const lookup = searchLookup.get(item.url);
    const extractedMeta = extractedMetaByUrl.get(item.url);
    return {
      ...item,
      viewpoint: normalizeSearchViewpoint(
        item.viewpoint,
        extractedMeta?.viewpoint ?? SEARCH_VIEWPOINT_FALLBACK,
      ),
      title: item.title ?? extractedMeta?.title ?? lookup?.title,
      pageId: item.pageId ?? extractedMeta?.pageId,
      lineCount: item.lineCount ?? extractedMeta?.lineCount,
      broken: item.broken ?? extractedMeta?.broken,
      inrelavate: item.inrelavate ?? extractedMeta?.inrelavate,
      error: item.error ?? extractedMeta?.error,
    };
  });
  const mergedResults = dedupeSearchResults([
    ...normalized,
    ...globalErrorResults,
  ]);
  const hasUsableEvidence = mergedResults.some(
    (item) =>
      !item.error &&
      !(item.broken ?? false) &&
      !(item.inrelavate ?? false) &&
      item.selections.length > 0,
  );
  const allSearchCallsFailed =
    searchToolCallCount > 0 && searchToolErrorCount === searchToolCallCount;
  const allExtractCallsFailed =
    extractToolCallCount > 0 && extractToolErrorCount === extractToolCallCount;
  if (allSearchCallsFailed && allExtractCallsFailed && !hasUsableEvidence) {
    const fatalErrors = Array.from(
      new Set(
        [...normalizedGlobalErrors]
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    );
    console.warn("[subagent.runSearch.fatalToolFailure]", {
      query,
      allSearchCallsFailed,
      allExtractCallsFailed,
      fatalErrors: fatalErrors.map((entry) => clampText(entry, 180)),
    });
    throw new Error(
      fatalErrors.join("\n") || "All tool calls failed during evidence collection.",
    );
  }
  if (mergedResults.length > 0) {
    console.log("[subagent.runSearch.done]", {
      query,
      mode,
      results: mergedResults.length,
    });
    return mergedResults;
  }
  console.log("[subagent.runSearch.done]", {
    query,
    mode,
    results: 0,
  });
  return [];
}
