import { z } from "zod";
import Mustache from "mustache";
import {
  AgentSkillProfileSchema,
  buildSkillRegistryPromptBlock,
  type AgentSkillProfile,
  type RuntimeAgentSkill,
} from "./agent-skills";

Mustache.escape = (value: string): string => value;

const OptionalStringSchema = z.string().optional();

export const DeepResearchStrictnessSchema = z.enum([
  "no-search",
  "all-claims",
  "uncertain-claims",
]);

export const DeepResearchReferenceAccuracySchema = z.enum([
  "high",
  "medium",
  "low",
  "conflicting",
  "insufficient",
]);

export const DeepResearchSourceAuthoritySchema = z.enum([
  "high",
  "medium",
  "low",
  "unknown",
]);

export const SubagentSearchComplexitySchema = z.enum([
  "standard",
  "balanced",
  "deep",
]);

export const TavilySearchDepthSchema = z.enum(["basic", "advanced"]);

export type DeepResearchStrictness = z.infer<typeof DeepResearchStrictnessSchema>;
export type DeepResearchReferenceAccuracy = z.infer<
  typeof DeepResearchReferenceAccuracySchema
>;
export type DeepResearchSourceAuthority = z.infer<
  typeof DeepResearchSourceAuthoritySchema
>;
export type SubagentSearchComplexity = z.infer<
  typeof SubagentSearchComplexitySchema
>;
export type TavilySearchDepth = z.infer<typeof TavilySearchDepthSchema>;

export const DEEP_RESEARCH_PROMPT_PLACEHOLDERS = [
  {
    key: "query",
    description: "Current user question text.",
  },
  {
    key: "strictness",
    description: "Current claim-support strictness mode.",
  },
  {
    key: "searchEnabled",
    description: "Whether search during answer generation is enabled.",
  },
  {
    key: "validateEnabled",
    description: "Whether async post-answer validation is enabled.",
  },
  {
    key: "validateStrictness",
    description: "Claim-support strictness mode for async validation.",
  },
  {
    key: "skillProfile",
    description: "Current skill recall strategy.",
  },
  {
    key: "selectedSkillNames",
    description: "Comma-separated selected skill names.",
  },
  {
    key: "searchComplexity",
    description: "Current subagent search complexity mode.",
  },
  {
    key: "tavilySearchDepth",
    description: "Current Tavily depth mode.",
  },
  {
    key: "maxSearchCalls",
    description: "Max allowed search calls for one run.",
  },
  {
    key: "maxExtractCalls",
    description: "Max allowed extract calls for one run.",
  },
  {
    key: "maxRepeatSearchQuery",
    description: "Max repeats allowed for the same search query.",
  },
  {
    key: "maxRepeatExtractUrl",
    description: "Max repeats allowed for the same extracted URL.",
  },
  {
    key: "sourceSelectionPolicy",
    description: "Source selection policy text.",
  },
  {
    key: "splitStrategy",
    description: "Search split strategy text.",
  },
  {
    key: "mode",
    description: "Subagent mode: search or validate.",
  },
  {
    key: "answerToValidate",
    description: "Assistant answer text to validate in validate mode.",
  },
] as const;

export const DEFAULT_SUBAGENT_SOURCE_SELECTION_POLICY =
  "Prefer high-credibility sources: established media with strong editorial standards and low misinformation history, official institutions, peer-reviewed journals, top conferences, and expert domain publications.";

export const DEFAULT_SUBAGENT_SPLIT_STRATEGY =
  "Split the work into a small set of distinct sub-tasks; avoid overlapping or redundant search tasks.";

export const DeepResearchSubagentConfigSchema = z.object({
  sourceSelectionPolicy: OptionalStringSchema,
  searchComplexity: SubagentSearchComplexitySchema.default("balanced"),
  tavilySearchDepth: TavilySearchDepthSchema.default("advanced"),
  maxSearchCalls: z.number().int().min(1).max(20).default(4),
  maxExtractCalls: z.number().int().min(1).max(40).default(10),
  maxRepeatSearchQuery: z.number().int().min(1).max(10).default(2),
  maxRepeatExtractUrl: z.number().int().min(1).max(10).default(2),
  splitStrategy: OptionalStringSchema,
  promptOverride: OptionalStringSchema,
  systemPromptOverride: OptionalStringSchema,
});

export const DeepResearchValidateConfigSchema = z.object({
  strictness: DeepResearchStrictnessSchema.optional(),
  enabled: z.boolean().optional(),
  subagent: DeepResearchSubagentConfigSchema.optional(),
});

export const DeepResearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  strictness: DeepResearchStrictnessSchema.default("all-claims"),
  skillProfile: AgentSkillProfileSchema.default("auto"),
  selectedSkillNames: z.array(z.string()).default([]),
  fullPromptOverrideEnabled: z.boolean().default(false),
  mainPromptOverride: OptionalStringSchema,
  subagent: DeepResearchSubagentConfigSchema.optional(),
  validate: DeepResearchValidateConfigSchema.optional(),
});

export type DeepResearchSubagentConfigInput = z.input<
  typeof DeepResearchSubagentConfigSchema
>;
export type DeepResearchConfigInput = z.input<typeof DeepResearchConfigSchema>;

export interface DeepResearchSubagentConfig {
  sourceSelectionPolicy: string;
  searchComplexity: SubagentSearchComplexity;
  tavilySearchDepth: TavilySearchDepth;
  maxSearchCalls: number;
  maxExtractCalls: number;
  maxRepeatSearchQuery: number;
  maxRepeatExtractUrl: number;
  splitStrategy: string;
  promptOverride?: string;
  systemPromptOverride?: string;
}

export interface DeepResearchValidateConfig {
  strictness: DeepResearchStrictness;
  enabled: boolean;
  subagent: DeepResearchSubagentConfig;
}

export interface DeepResearchConfig {
  enabled: boolean;
  strictness: DeepResearchStrictness;
  skillProfile: AgentSkillProfile;
  selectedSkillNames: string[];
  fullPromptOverrideEnabled: boolean;
  mainPromptOverride?: string;
  subagent: DeepResearchSubagentConfig;
  validate: DeepResearchValidateConfig;
}

export const DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG: DeepResearchSubagentConfig =
  {
    sourceSelectionPolicy: DEFAULT_SUBAGENT_SOURCE_SELECTION_POLICY,
    searchComplexity: "balanced",
    tavilySearchDepth: "advanced",
    maxSearchCalls: 4,
    maxExtractCalls: 10,
    maxRepeatSearchQuery: 2,
    maxRepeatExtractUrl: 2,
    splitStrategy: DEFAULT_SUBAGENT_SPLIT_STRATEGY,
  };

export const DEFAULT_DEEP_RESEARCH_VALIDATE_CONFIG: DeepResearchValidateConfig =
  {
    strictness: "uncertain-claims",
    enabled: false,
    subagent: DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG,
  };

export const DEFAULT_DEEP_RESEARCH_CONFIG: DeepResearchConfig = {
  enabled: true,
  strictness: "all-claims",
  skillProfile: "auto",
  selectedSkillNames: [],
  fullPromptOverrideEnabled: false,
  subagent: DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG,
  validate: DEFAULT_DEEP_RESEARCH_VALIDATE_CONFIG,
};

const normalizeOptionalPrompt = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const normalizeSkillNames = (values: string[] | undefined): string[] => {
  const dedupe = new Set<string>();
  (values ?? []).forEach((value) => {
    const normalized = value.trim();
    if (normalized.length > 0) {
      dedupe.add(normalized);
    }
  });
  return Array.from(dedupe.values());
};

export const resolveDeepResearchSubagentConfig = (
  input?: DeepResearchSubagentConfigInput | null,
): DeepResearchSubagentConfig => {
  const parsed = DeepResearchSubagentConfigSchema.safeParse(input ?? {});
  const normalized = parsed.success ? parsed.data : undefined;
  return {
    sourceSelectionPolicy:
      normalizeOptionalPrompt(normalized?.sourceSelectionPolicy) ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.sourceSelectionPolicy,
    searchComplexity:
      normalized?.searchComplexity ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.searchComplexity,
    tavilySearchDepth:
      normalized?.tavilySearchDepth ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.tavilySearchDepth,
    maxSearchCalls:
      normalized?.maxSearchCalls ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.maxSearchCalls,
    maxExtractCalls:
      normalized?.maxExtractCalls ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.maxExtractCalls,
    maxRepeatSearchQuery:
      normalized?.maxRepeatSearchQuery ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.maxRepeatSearchQuery,
    maxRepeatExtractUrl:
      normalized?.maxRepeatExtractUrl ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.maxRepeatExtractUrl,
    splitStrategy:
      normalizeOptionalPrompt(normalized?.splitStrategy) ??
      DEFAULT_DEEP_RESEARCH_SUBAGENT_CONFIG.splitStrategy,
    promptOverride: normalizeOptionalPrompt(normalized?.promptOverride),
    systemPromptOverride: normalizeOptionalPrompt(
      normalized?.systemPromptOverride,
    ),
  };
};

export const resolveDeepResearchValidateConfig = (
  input?: z.input<typeof DeepResearchValidateConfigSchema> | null,
): DeepResearchValidateConfig => {
  const parsed = DeepResearchValidateConfigSchema.safeParse(input ?? {});
  const normalized = parsed.success ? parsed.data : undefined;
  const strictness =
    normalized?.strictness === "all-claims" ||
    normalized?.strictness === "uncertain-claims"
      ? normalized.strictness
      : DEFAULT_DEEP_RESEARCH_VALIDATE_CONFIG.strictness;
  const enabled =
    typeof normalized?.enabled === "boolean"
      ? normalized.enabled
      : typeof normalized?.strictness === "string"
        ? normalized.strictness !== "no-search"
      : DEFAULT_DEEP_RESEARCH_VALIDATE_CONFIG.enabled;
  return {
    strictness,
    enabled,
    subagent: resolveDeepResearchSubagentConfig(normalized?.subagent),
  };
};

const buildValidateStrictnessLines = (
  strictness: DeepResearchStrictness,
): string[] => {
  if (strictness !== "all-claims") {
    return [
      "Validate uncertain, contested, time-sensitive, and high-impact factual claims first.",
      "Skip purely subjective/preference claims unless the answer presents them as objective facts.",
      "For clearly deterministic claims, validate only when uncertainty remains.",
    ];
  }
  return [
    "Validate every material factual claim in the assistant answer.",
    "When one sentence has multiple factual sub-claims, check each sub-claim.",
  ];
};

export const resolveDeepResearchConfig = (
  input?: DeepResearchConfigInput | null,
): DeepResearchConfig => {
  const parsed = DeepResearchConfigSchema.safeParse(input ?? {});
  const normalized = parsed.success ? parsed.data : undefined;
  return {
    enabled:
      typeof normalized?.enabled === "boolean"
        ? normalized.enabled
        : DEFAULT_DEEP_RESEARCH_CONFIG.enabled,
    strictness:
      normalized?.strictness ?? DEFAULT_DEEP_RESEARCH_CONFIG.strictness,
    skillProfile:
      normalized?.skillProfile ?? DEFAULT_DEEP_RESEARCH_CONFIG.skillProfile,
    selectedSkillNames: normalizeSkillNames(normalized?.selectedSkillNames),
    fullPromptOverrideEnabled:
      normalized?.fullPromptOverrideEnabled ??
      DEFAULT_DEEP_RESEARCH_CONFIG.fullPromptOverrideEnabled,
    mainPromptOverride: normalizeOptionalPrompt(normalized?.mainPromptOverride),
    subagent: resolveDeepResearchSubagentConfig(normalized?.subagent),
    validate: resolveDeepResearchValidateConfig(normalized?.validate),
  };
};

const buildStrictnessLines = (strictness: DeepResearchStrictness): string[] => {
  if (strictness === "no-search") {
    return [
      "Search is disabled for this reply. Do not call `deepSearch`.",
      "Do not output deertube citation markers such as [1](deertube://...).",
      "Answer directly from current context and reasoning.",
    ];
  }
  if (strictness === "uncertain-claims") {
    return [
      "For uncertain, contested, time-sensitive, or recommendation/factual claims, call the `deepSearch` tool and ground the answer in retrieved evidence.",
      "For deterministic math/computation tasks and clearly stable facts, you may answer directly when confidence is high.",
      "If confidence is not high, run `deepSearch` before answering.",
    ];
  }
  return [
    "For most user questions, call the `deepSearch` tool and ground the answer in retrieved evidence.",
    "Skip a new `deepSearch` when the latest question is highly similar to a recently answered one and existing retrieved evidence is still sufficient; also skip for fixed deterministic math/computation tasks that do not depend on external facts.",
    "For any concept, entity, event, policy, recommendation, or factual claim, use `deepSearch` unless the high-similarity reuse rule clearly applies.",
    "Treat conceptual questions as search-required by default, even when they look like common knowledge.",
    "For conceptual content, never answer directly from memory; answer from retrieved evidence.",
  ];
};

export const buildMainAgentSystemPrompt = (
  contextLines: string[],
  input?: DeepResearchConfigInput | null,
  options?: { query?: string; availableSkills?: RuntimeAgentSkill[] },
): string => {
  const config = resolveDeepResearchConfig(input);
  const skillRegistryPrompt = buildSkillRegistryPromptBlock({
    query: options?.query ?? "",
    profile: config.skillProfile,
    selectedSkillNames: config.selectedSkillNames,
    externalSkills: options?.availableSkills,
    discoverToolName: "discoverSkills",
    loadToolName: "loadSkill",
    executeToolName: "executeSkill",
  });
  const promptOverride =
    config.fullPromptOverrideEnabled
      ? normalizeOptionalPrompt(config.mainPromptOverride)
      : undefined;
  if (config.fullPromptOverrideEnabled && promptOverride) {
    const renderedOverride = applyPromptTemplate(
      promptOverride,
      buildMainPromptTemplateVariables(config, options?.query),
    );
    return [renderedOverride, skillRegistryPrompt, ...contextLines]
      .filter(Boolean)
      .join("\n\n");
  }

  const baseLines = [
    "You are a concise assistant. Answer clearly and directly. Use short paragraphs when helpful.",
    "Always answer in the same language as the user's latest question.",
    "Unless the user explicitly requests translation, keep the response language identical to the user's question language.",
  ];

  if (!config.enabled) {
    return [...baseLines, skillRegistryPrompt, ...contextLines]
      .filter(Boolean)
      .join("\n\n");
  }

  if (config.strictness === "no-search") {
    return [
      ...baseLines,
      ...buildStrictnessLines(config.strictness),
      skillRegistryPrompt,
      ...contextLines,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const strictnessLines = buildStrictnessLines(config.strictness);
  return [
    ...baseLines,
    "You are given numbered references built from source excerpts. Use those references as evidence context for your final answer.",
    ...strictnessLines,
    "Prefer serial search planning: run one `deepSearch`, inspect sources/references, then decide the next query.",
    "Keep total `deepSearch` calls per user turn within about 1-5 whenever possible.",
    "Only exceed 5 searches when task complexity is very high and prior subagent evidence is still insufficient.",
    "If evidence is insufficient, continue searching based on gaps/conflicts from the previous search results instead of restarting blindly.",
    "If you need citations, you must run `deepSearch` first. Never cite without search.",
    "Write a concise answer and cite evidence inline using markdown links like [1](deertube://...).",
    "Do not invent citation markers or URLs. Every citation must come from `deepSearch` output.",
    "If `deepSearch` returns zero references, do not output any citation markers such as [1](deertube://...), [2](deertube://...), and do not output a `References` section.",
    "If `deepSearch` returns references, inline citations must use markdown links from `references[].uri`: format `[n](deertube://...)`.",
    "When citations are used, every marker [n](deertube://...) must map to an existing `refId` and its matching `uri` from the same `deepSearch` result.",
    "When multiple references support equivalent content, prefer citing higher-accuracy and higher-source-authority references first.",
    "Only cite provided indices. Do not invent new indices and do not output footnotes.",
    "**Do not** merge citations like [1,2] or [1-2]. Only use separate markers: [1](deertube://...), [2](deertube://...).",
    "Every citation link must use the deertube URI for that reference ID. Do not use external URLs in citation links, only use deertube://... link",
    skillRegistryPrompt,
    ...contextLines,
  ]
    .filter(Boolean)
    .join("\n\n");
};

const buildComplexityInstruction = (
  complexity: SubagentSearchComplexity,
): string => {
  if (complexity === "standard") {
    return "Use a focused strategy with minimal branching. Expand search breadth only when evidence is clearly insufficient.";
  }
  if (complexity === "deep") {
    return "Use a broad and deep strategy with active cross-checking across multiple viewpoints while respecting tool budgets.";
  }
  return "Balance precision and coverage; iterate with focused follow-up queries when evidence gaps remain.";
};

const buildSubagentPromptTemplateVariables = (
  config: DeepResearchSubagentConfig,
  options?: {
    query?: string;
    strictness?: DeepResearchStrictness;
    validateStrictness?: DeepResearchStrictness;
    skillProfile?: AgentSkillProfile;
    selectedSkillNames?: string[];
    mode?: "search" | "validate";
    answerToValidate?: string;
  },
): Record<string, string> => ({
  query: options?.query ?? "",
  mode: options?.mode ?? "search",
  answerToValidate: options?.answerToValidate ?? "",
  strictness: options?.strictness ?? "",
  validateStrictness: options?.validateStrictness ?? "",
  skillProfile: options?.skillProfile ?? "",
  selectedSkillNames: normalizeSkillNames(options?.selectedSkillNames).join(", "),
  searchComplexity: config.searchComplexity,
  tavilySearchDepth: config.tavilySearchDepth,
  maxSearchCalls: String(config.maxSearchCalls),
  maxExtractCalls: String(config.maxExtractCalls),
  maxRepeatSearchQuery: String(config.maxRepeatSearchQuery),
  maxRepeatExtractUrl: String(config.maxRepeatExtractUrl),
  sourceSelectionPolicy: config.sourceSelectionPolicy,
  splitStrategy: config.splitStrategy,
});

const buildMainPromptTemplateVariables = (
  config: DeepResearchConfig,
  query?: string,
): Record<string, string> => ({
  ...buildSubagentPromptTemplateVariables(config.subagent, {
    query,
    strictness: config.strictness,
    validateStrictness: config.validate.strictness,
    skillProfile: config.skillProfile,
    selectedSkillNames: config.selectedSkillNames,
  }),
  searchEnabled: String(config.strictness !== "no-search"),
  validateEnabled: String(config.validate.enabled),
});

const applyPromptTemplate = (
  template: string,
  variables: Record<string, string>,
  options?: { appendQueryWhenMissing?: boolean },
): string => {
  const placeholderMatches = template.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) ?? [];
  const renderedVariables: Record<string, string> = { ...variables };
  placeholderMatches.forEach((entry) => {
    const keyMatch = entry.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/);
    const key = keyMatch?.[1];
    if (!key) {
      return;
    }
    if (typeof renderedVariables[key] !== "string") {
      // Preserve unknown placeholders instead of replacing with empty strings.
      renderedVariables[key] = `{{${key}}}`;
    }
  });
  const replaced = Mustache.render(template, renderedVariables);
  const query = variables.query?.trim() ?? "";
  if (
    options?.appendQueryWhenMissing &&
    query.length > 0 &&
    !/\{\{\s*query\s*\}\}/.test(template)
  ) {
    return `${replaced}\n\nUser question: ${query}`.trim();
  }
  return replaced.trim();
};

export const buildSearchSubagentSystemPrompt = (
  options?: {
    subagentConfig?: DeepResearchSubagentConfigInput | null;
    query?: string;
    strictness?: DeepResearchStrictness;
    skillProfile?: AgentSkillProfile;
    selectedSkillNames?: string[];
    availableSkills?: RuntimeAgentSkill[];
    fullPromptOverrideEnabled?: boolean;
    mode?: "search" | "validate";
    answerToValidate?: string;
  },
): string => {
  const config = resolveDeepResearchSubagentConfig(options?.subagentConfig);
  const mode = options?.mode ?? "search";
  const answerToValidate = options?.answerToValidate ?? "";
  const strictness = options?.strictness ?? "all-claims";
  const isValidateMode = mode === "validate";
  const skillRegistryPrompt = buildSkillRegistryPromptBlock({
    query: options?.query ?? "",
    profile: options?.skillProfile ?? "auto",
    selectedSkillNames: normalizeSkillNames(options?.selectedSkillNames),
    externalSkills: options?.availableSkills,
    discoverToolName: "discoverSkills",
    loadToolName: "loadSkill",
    executeToolName: "executeSkill",
  });
  if (
    options?.fullPromptOverrideEnabled &&
    config.systemPromptOverride
  ) {
    const renderedOverride = applyPromptTemplate(
      config.systemPromptOverride,
      buildSubagentPromptTemplateVariables(config, {
        query: options?.query,
        strictness,
        validateStrictness: isValidateMode ? strictness : undefined,
        skillProfile: options?.skillProfile,
        selectedSkillNames: options?.selectedSkillNames,
        mode,
        answerToValidate,
      }),
    );
    return [renderedOverride, skillRegistryPrompt]
      .filter(Boolean)
      .join("\n\n");
  }
  const modeSpecificLines = isValidateMode
    ? [
        "Validation target:",
        answerToValidate.trim().length > 0
          ? answerToValidate
          : "(No answer text provided; validate against the user query only.)",
        ...buildValidateStrictnessLines(strictness),
      ]
    : [];
  return [
    isValidateMode
      ? "You are the DeepResearch validation subagent. Verify whether an existing assistant answer is well-supported by web evidence."
      : "You are the DeepResearch subagent. Your task is to collect structured evidence through web search and page extraction.",
    ...modeSpecificLines,
    isValidateMode
      ? "Claim scope rule: derive validation claims only from the answer-to-validate content. Do not use the original user question to define validation scope."
      : "",
    "Available tools:",
    "- discoverSkills: List available domain skills and activation hints.",
    "- loadSkill: Load full guidance for a specific skill.",
    "- executeSkill: Apply a skill to a concrete task and return tailored guidance.",
    "- search: Use Tavily to find candidate pages.",
    "- extract: Extract query-relevant passages from a specific URL.",
    "- writeResults: Submit the final payload { results, errors }.",
    "Source quality policy:",
    `- ${config.sourceSelectionPolicy}`,
    "- Avoid low-credibility or rumor-heavy sources unless they are necessary for contrast and clearly labeled.",
    "- For duplicated/equivalent claims across sources, prefer high-authority and high-confidence sources first.",
    "- Do not extract every duplicate source. Start with a minimal high-confidence set, and only expand to lower-confidence sources when extracted evidence is still insufficient or conflicting.",
    "Search strategy:",
    "- Start search in the original user-question language.",
    "- Only try English or other languages when single-language results are missing, weak, off-topic, or otherwise insufficient.",
    `- ${config.splitStrategy}`,
    "- Do not let off-topic result trends redirect your judgment. If results drift from the intended topic, reformulate and continue searching.",
    "- If one search is insufficient, iterate with alternative keywords, synonyms, and related concepts.",
    "- If no reasonable results are found, proactively try multiple new keyword combinations before concluding failure.",
    "- You may launch additional focused search/extract rounds based on collected evidence gaps to fill missing evidence or verify conflicts, within budget.",
    "- Prefer serial search rounds: inspect each search result set before deciding the next search query.",
    "- Control extraction cost: extract only URLs that are likely to add new evidence.",
    "- If a page/source appears highly similar or redundant to already extracted evidence, skip extracting it unless it can add clearly new information.",
    "- When multiple candidates share near-identical content, prioritize extraction on higher-authority candidates before lower-authority ones.",
    `- Search complexity mode: ${config.searchComplexity}. ${buildComplexityInstruction(config.searchComplexity)}`,
    `- Tavily search depth mode: ${config.tavilySearchDepth}.`,
    "- Respect the search/extract call limits provided in the runtime prompt.",
    "Workflow:",
    "1) Decompose into distinct sub-tasks, then call search to gather candidates (<=6 per query, multiple query rounds allowed).",
    "2) Select relevant high-quality and non-redundant URLs, then call extract(url, query) for each.",
    "3) Extraction is mandatory. Do not stop after search-only results.",
    isValidateMode
      ? "4) First identify key claims from the answer-to-validate; then select only the smallest sufficient evidence for each claim."
      : "4) First decide your answer claims; then choose only the smallest sufficient evidence for each claim.",
    "5) Finalization is mandatory: call writeResults exactly once with { results, errors }.",
    isValidateMode
      ? "6) In writeResults input, each result item should include: url, viewpoint, content, selections, validationRefContent, accuracy, sourceAuthority, issueReason, correctFact."
      : "6) In writeResults input, each result item should include: url, viewpoint, content, selections, accuracy, sourceAuthority.",
    isValidateMode
      ? "6.1) In validate mode, do not leave `accuracy` and `sourceAuthority` empty when evidence exists."
      : "",
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
    "17) Score each item on two axes: `accuracy` (high|medium|low|conflicting|insufficient) and `sourceAuthority` (high|medium|low|unknown).",
    isValidateMode
      ? "18) In validate mode, for low/conflicting/insufficient accuracy, include `issueReason` and `correctFact` when evidence allows."
      : "",
    "Output rule: finalize via writeResults only. Do not output final JSON in plain text.",
    skillRegistryPrompt,
  ].join("\n");
};

export const buildSearchSubagentRuntimePrompt = ({
  query,
  subagentConfig,
  strictness = "all-claims",
  fullPromptOverrideEnabled = false,
  mode = "search",
  answerToValidate = "",
}: {
  query: string;
  subagentConfig?: DeepResearchSubagentConfigInput | null;
  strictness?: DeepResearchStrictness;
  fullPromptOverrideEnabled?: boolean;
  mode?: "search" | "validate";
  answerToValidate?: string;
}): string => {
  const config = resolveDeepResearchSubagentConfig(subagentConfig);
  const isValidateMode = mode === "validate";
  const promptTemplateVariables = buildSubagentPromptTemplateVariables(config, {
    query,
    strictness,
    validateStrictness: isValidateMode ? strictness : undefined,
    mode,
    answerToValidate,
  });
  if (fullPromptOverrideEnabled && config.promptOverride) {
    return applyPromptTemplate(config.promptOverride, promptTemplateVariables, {
      appendQueryWhenMissing: true,
    });
  }
  return [
    `User question: ${query}`,
    isValidateMode
      ? "Validation mode: verify the provided answer, then output only evidence needed to support/refute its key claims."
      : "Plan the final answer first, then output only the evidence references needed to support it.",
    isValidateMode
      ? `Answer to validate: ${
          answerToValidate.trim().length > 0
            ? answerToValidate
            : "(empty; validate against question only)"
        }`
      : "",
    ...(isValidateMode ? buildValidateStrictnessLines(strictness) : []),
    isValidateMode
      ? "Claim scope rule: split claims only from the Answer to validate. Do not re-scope claims from the original user question."
      : "",
    `${config.splitStrategy}`,
    "Prefer serial search: run one search call, inspect its results, then decide the next query.",
    "Language fallback strategy: start in the user-question language; only try English/other languages when results are empty, weak, or off-topic.",
    "When multiple sources provide equivalent content, prefer high-authority/high-confidence sources first.",
    "Do not extract all duplicates. Extract the minimal high-confidence subset first; only then backfill with lower-confidence sources if evidence is still insufficient or conflicting.",
    isValidateMode
      ? "Each result item must include: url, viewpoint, content, selections, validationRefContent, accuracy, sourceAuthority, issueReason, correctFact."
      : "Each result item must include: url, viewpoint, content, selections, accuracy, sourceAuthority.",
    isValidateMode
      ? "In validate mode, `accuracy` and `sourceAuthority` should be populated for each evidence item whenever evidence is available."
      : "",
    "Selections must be precise and minimal. Avoid broad/full-page spans unless strictly necessary.",
    "When one source supports multiple points, keep multiple small selections under the same URL.",
    "Merge duplicate viewpoints into one consolidated result item; do not repeat equivalent viewpoints.",
    "You may run additional focused search/extract rounds based on collected evidence to fill gaps or resolve conflicts.",
    "The extract tool returns line-numbered selections. Your returned selections must be anchored to those line numbers.",
    "Control extraction usage: extract only pages that add novel evidence; skip highly similar/redundant pages unless they add clear new signal.",
    `Search complexity mode: ${config.searchComplexity}. ${buildComplexityInstruction(config.searchComplexity)}`,
    `Tavily search depth mode: ${config.tavilySearchDepth}.`,
    `Budget: at most ${config.maxSearchCalls} search calls and ${config.maxExtractCalls} extract calls.`,
    "Stay conservative with call usage and prioritize quality over quantity.",
    `Do not repeat the same search query more than ${config.maxRepeatSearchQuery} times.`,
    `Do not extract the same URL more than ${config.maxRepeatExtractUrl} times.`,
    "Finalization rule (strict): your very last step must be exactly one `writeResults` call.",
    "If `writeResults` is not called at the end, the run is treated as failed.",
    "Accuracy rubric: high (directly and strongly supported), medium (mostly supported with minor gaps), low (weakly supported), conflicting (evidence conflicts), insufficient (not enough evidence). Source authority rubric: high (primary official/peer-reviewed/high editorial accountability), medium (credible but secondary or partially indirect), low (weak provenance, rumor-prone, unverified), unknown (authority cannot be confidently determined).",
    isValidateMode
      ? "For low/conflicting/insufficient outcomes in validate mode, provide `issueReason` and `correctFact` whenever the evidence is sufficient to state them."
      : "",
    "When evidence is sufficient, call `writeResults` exactly once with { results, errors }.",
  ].join("\n");
};
