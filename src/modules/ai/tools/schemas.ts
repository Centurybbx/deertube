import { z } from "zod";

const TavilyOptionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z
    .string()
    .optional()
    .describe(
      "Optional text field from Tavily; non-string values are ignored.",
    ),
);

const TavilyOptionalNullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" || value === null ? value : undefined),
  z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional nullable text from Tavily; null is preserved, non-string values are ignored.",
    ),
);

export const TavilySearchResultSchema = z
  .object({
    title: TavilyOptionalStringSchema.describe(
      "Result title as returned by Tavily.",
    ),
    url: TavilyOptionalStringSchema.describe(
      "Canonical result URL for retrieval and extraction.",
    ),
    content: TavilyOptionalStringSchema.describe(
      "Short content preview returned by Tavily.",
    ),
    raw_content: TavilyOptionalNullableStringSchema.describe(
      "Optional full raw content from Tavily; can be null or absent.",
    ),
    snippet: TavilyOptionalStringSchema.describe(
      "Alternative snippet field from Tavily.",
    ),
    description: TavilyOptionalStringSchema.describe(
      "Alternative summary/description for the result.",
    ),
  })
  .describe("Single Tavily search result item.");

export type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

export const TavilyResponseSchema = z
  .object({
    results: z
      .array(TavilySearchResultSchema)
      .optional()
      .describe("List of Tavily search results when the API call succeeds."),
  })
  .describe("Tavily search response payload.");

export const LineSelectionBoundsSchema = z
  .object({
    start: z
      .number()
      .int()
      .positive()
      .describe("Inclusive 1-based start line number."),
    end: z
      .number()
      .int()
      .positive()
      .describe("Inclusive 1-based end line number."),
  })
  .describe("Inclusive line span over line-numbered markdown.");

export const LineSelectionSchema = LineSelectionBoundsSchema.extend({
  text: z
    .string()
    .min(1)
    .describe(
      "Line-numbered markdown text cut from the corresponding selection span.",
    ),
}).describe("Extracted segment that includes line metadata and text.");

export const ExtractSubagentFinalSchema = z
  .object({
    viewpoint: z
      .string()
      .min(1)
      .describe("Single concise viewpoint. Keep it short and evidence-grounded."),
    broken: z
      .boolean()
      .default(false)
      .describe(
        "Whether markdown is unavailable/corrupted/blocked for this page.",
      ),
    inrelavate: z
      .boolean()
      .default(false)
      .describe("Whether the page is unrelated to the query."),
    selections: z
      .array(LineSelectionBoundsSchema)
      .default([])
      .describe("Relevant inclusive line spans."),
    error: z
      .string()
      .optional()
      .describe("Optional extraction error reason for this page."),
  })
  .describe("Final structured output of extract subagent.");

export const SearchSubagentFinalItemSchema = z
  .object({
    url: z
      .string()
      .optional()
      .describe("Source URL when available. Can be omitted for global errors."),
    viewpoint: z
      .string()
      .min(1)
      .describe(
        "Specific claim/viewpoint this evidence supports in the final answer (required).",
      ),
    content: z
      .string()
      .default("")
      .describe("Short evidence summary/quote aligned with selected spans."),
    selections: z
      .array(LineSelectionSchema)
      .default([])
      .describe("Relevant line selections for this URL."),
    validationRefContent: z
      .string()
      .optional()
      .describe(
        "Validate-mode only: concise reference-specific support/refutation summary for the answer being checked.",
      ),
    accuracy: z
      .enum(["high", "medium", "low", "conflicting", "insufficient"])
      .optional()
      .describe(
        "Validate-mode only: evidence accuracy grade for this reference item.",
      ),
    sourceAuthority: z
      .enum(["high", "medium", "low", "unknown"])
      .optional()
      .describe(
        "Validate-mode only: source-authority grade for this reference item.",
      ),
    issueReason: z
      .string()
      .optional()
      .describe(
        "Validate-mode only: why the checked claim/answer is wrong or risky according to this reference.",
      ),
    correctFact: z
      .string()
      .optional()
      .describe(
        "Validate-mode only: corrected fact/state according to this reference.",
      ),
    broken: z
      .boolean()
      .optional()
      .describe("Whether this URL is blocked/unavailable/corrupted."),
    inrelavate: z
      .boolean()
      .optional()
      .describe("Whether this URL is unrelated to the query."),
    error: z.string().optional().describe("Optional per-URL error reason."),
  })
  .describe("Single final output item of search subagent.");

export const SearchSubagentFinalSchema = z
  .object({
    results: z
      .array(SearchSubagentFinalItemSchema)
      .default([])
      .describe("Per-URL structured search-subagent results."),
    errors: z
      .array(
        z
          .string()
          .describe("Global error message for failed search/extract attempts."),
      )
      .default([])
      .describe("Global subagent errors not tied to a specific URL."),
  })
  .describe("Final structured output of search subagent.");

export const SEARCH_SUBAGENT_SYSTEM = [
  "You are the DeepResearch subagent. Your task is to collect structured evidence through web search and page extraction.",
  "Available tools:",
  "- search: Use Tavily to find candidate pages.",
  "- extract: Extract query-relevant passages from a specific URL.",
  "- writeResults: Submit the final payload { results, errors }.",
  "Source quality policy:",
  "- Prefer high-credibility sources: established media with strong editorial standards and low misinformation history, official institutions, peer-reviewed journals, top conferences, and expert domain publications.",
  "- Avoid low-credibility or rumor-heavy sources unless they are necessary for contrast and clearly labeled.",
  "Search strategy:",
  "- Start search in the original user-question language.",
  "- Only try English or other languages when single-language results are missing, weak, off-topic, or otherwise insufficient.",
  "- Split the work into a small set of distinct sub-tasks; avoid overlapping or redundant search tasks.",
  "- Do not let off-topic result trends redirect your judgment. If results drift from the intended topic, reformulate and continue searching.",
  "- If one search is insufficient, iterate with alternative keywords, synonyms, and related concepts.",
  "- If no reasonable results are found, proactively try multiple new keyword combinations before concluding failure.",
  "- You may launch additional focused search/extract rounds based on collected evidence gaps to fill missing evidence or verify conflicts, within budget.",
  "- Prefer serial search rounds: inspect each search result set before deciding the next search query.",
  "- Control extraction cost: extract only URLs that are likely to add new evidence.",
  "- If a page/source appears highly similar or redundant to already extracted evidence, skip extracting it unless it can add clearly new information.",
  "- Respect the search/extract call limits provided in the runtime prompt.",
  "Workflow:",
  "1) Decompose into distinct sub-tasks, then call search to gather candidates (<=6 per query, multiple query rounds allowed).",
  "2) Select relevant high-quality and non-redundant URLs, then call extract(url, query) for each.",
  "3) Extraction is mandatory. Do not stop after search-only results.",
  "4) First decide your answer claims; then choose only the smallest sufficient evidence for each claim.",
  "5) Finalization is mandatory: call writeResults exactly once with { results, errors }.",
  "6) In writeResults input, each result item should include: url, viewpoint, content, selections.",
  "7) `extract` returns line-numbered selections. All chosen selections must map to those numbered lines.",
  "8) Prefer small precise spans (typically 2-12 lines). Avoid broad/full-page spans unless strictly necessary.",
  "9) The same source can support multiple claims: keep multiple selections for one URL when needed.",
  "10) Every returned selection must come from the corresponding extract result for the same URL.",
  "11) If a URL is unrelated, mark `inrelavate=true` and return `selections=[]` for that URL.",
  "12) Merge duplicate/equivalent viewpoints into a single consolidated result item.",
  "13) If all attempted search calls fail, or all attempted extract calls fail, put those reasons in `errors`.",
  "14) Fatal tool failure rule: if every search call fails (e.g. Tavily errors) or every extract call fails (e.g. Jina errors), include clear reasons in `errors` so the outer agent can surface the failure to the user.",
  "15) Strict final-step rule: your very last action must be exactly one writeResults call.",
  "16) If writeResults is omitted at the end, the run is treated as failed.",
  "Output rule: finalize via writeResults only. Do not output final JSON in plain text.",
].join("\n");

export const EXTRACT_SUBAGENT_SYSTEM = [
  "You are the Extract subagent.",
  "Input: query + line-numbered markdown.",
  "Goal: select the most relevant line spans for the query.",
  "Available tools: grep, readLines, writeExtractResult.",
  "Output must be submitted via writeExtractResult({ viewpoint, broken, inrelavate, selections, error? }).",
  "You must provide one concise `viewpoint`.",
  "Rules:",
  "- Line numbers start from 1. start/end are inclusive.",
  "- No matter what, call writeExtractResult; use selections=[] when needed.",
  "- Keep selected spans coherent and avoid oversized spans.",
  "- If content is unavailable or clearly corrupted(e.g. blocked by cloudflare or need a Verification code), return broken=true and selections=[].",
  "- If the page is unrelated to query, return inrelavate=true and selections=[].",
  "- When using grep, prefer 5-10 matches per call unless a wider sweep is necessary.",
  "- Efficiency rule: when inspecting independent hypotheses/spans, prefer issuing multiple tool calls in the same round when possible.",
  "- For large markdown, prioritize the grep/readLines tools to explore before deciding selections.",
  "- Keep `viewpoint` specific, evidence-grounded, and short.",
  "Finalize by calling writeExtractResult exactly once.",
].join("\n");
