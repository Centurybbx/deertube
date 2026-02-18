import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  streamText,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { baseProcedure, createTRPCRouter } from "../init";
import type { DeertubeUIMessage } from "../../../src/modules/ai/tools";
import type {
  DeepSearchStreamPayload,
  SubagentStreamPayload,
} from "../../../src/modules/ai/tools/types";
import { createTools } from "../../../src/modules/ai/tools";
import {
  createDeepResearchPersistenceAdapter,
  resolveDeepResearchReference,
} from "../../deepresearch/store";
import {
  buildMainAgentSystemPrompt,
  DeepResearchConfigSchema,
  type DeepResearchStrictness,
  resolveDeepResearchConfig,
} from "../../../src/shared/deepresearch-config";
import { scanLocalAgentSkills } from "../../skills/registry";
import type { RuntimeAgentSkill } from "../../../src/shared/agent-skills";
import { runDeepSearchTool } from "../../../src/modules/ai/tools/runners/deepsearch-tool";

const noStepLimit = () => false;
const VALIDATE_LOG_PREFIX = "[validate][chat.router]";
const VALIDATE_LOG_DIR_ENV = "DEERTUBE_VALIDATE_LOG_DIR";

type ValidateLogLevel = "info" | "warn" | "error";

const resolveValidateLogDir = (projectPath: string): string => {
  const configured = process.env[VALIDATE_LOG_DIR_ENV]?.trim();
  if (!configured) {
    return path.resolve(projectPath, ".deertube", "validate-logs");
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(projectPath, configured);
};

const resolveValidateLogFilePath = (projectPath: string): string => {
  const dayStamp = new Date().toISOString().slice(0, 10);
  return path.join(resolveValidateLogDir(projectPath), `${dayStamp}.jsonl`);
};

const appendValidateLogFile = async ({
  projectPath,
  level,
  event,
  payload,
}: {
  projectPath: string;
  level: ValidateLogLevel;
  event: string;
  payload?: Record<string, unknown>;
}): Promise<void> => {
  try {
    const filePath = resolveValidateLogFilePath(projectPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      event,
      projectPath,
      pid: process.pid,
    };
    if (payload) {
      entry.payload = payload;
    }
    const serialized = JSON.stringify(entry);
    if (!serialized) {
      return;
    }
    await fs.appendFile(filePath, `${serialized}\n`, "utf-8");
  } catch (error) {
    console.warn(VALIDATE_LOG_PREFIX, "file-log-write-failed", {
      event,
      projectPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const logValidate = ({
  event,
  payload,
  projectPath,
  level = "info",
}: {
  event: string;
  payload?: Record<string, unknown>;
  projectPath?: string;
  level?: ValidateLogLevel;
}): void => {
  if (level === "warn") {
    if (payload) {
      console.warn(VALIDATE_LOG_PREFIX, event, payload);
    } else {
      console.warn(VALIDATE_LOG_PREFIX, event);
    }
  } else if (level === "error") {
    if (payload) {
      console.error(VALIDATE_LOG_PREFIX, event, payload);
    } else {
      console.error(VALIDATE_LOG_PREFIX, event);
    }
  } else if (payload) {
    console.log(VALIDATE_LOG_PREFIX, event, payload);
  } else {
    console.log(VALIDATE_LOG_PREFIX, event);
  }

  if (!projectPath) {
    return;
  }
  void appendValidateLogFile({
    projectPath,
    level,
    event,
    payload,
  });
};

const loadExternalSkills = async (): Promise<RuntimeAgentSkill[]> => {
  const scanResult = await scanLocalAgentSkills();
  return scanResult.skills.map((skill) => ({
    name: skill.name,
    title: skill.title,
    description: skill.description,
    activationHints: skill.activationHints,
    content: skill.content,
    source: skill.source,
    isSearchSkill: skill.isSearchSkill,
  }));
};

const filterExternalSkillsBySelection = (
  skills: RuntimeAgentSkill[],
  selectedSkillNames: string[],
): RuntimeAgentSkill[] => {
  const normalizedSelectedSkillNames = new Set(
    selectedSkillNames
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  if (normalizedSelectedSkillNames.size === 0) {
    return skills;
  }
  return skills.filter((skill) => {
    if (!skill.isSearchSkill) {
      return true;
    }
    return normalizedSelectedSkillNames.has(skill.name.trim().toLowerCase());
  });
};

const waitForAbort = (signal: AbortSignal): Promise<{ kind: "abort" }> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "abort" });
      return;
    }
    const handleAbort = () => {
      signal.removeEventListener("abort", handleAbort);
      resolve({ kind: "abort" });
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });

const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "AbortError" || /abort/i.test(error.message));

const HIDDEN_RUNTIME_CONTEXT_MARKER = "[[HIDDEN_RUNTIME_CONTEXT]]";

const buildHiddenRuntimeContextBlock = (now: Date): string => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return [
    HIDDEN_RUNTIME_CONTEXT_MARKER,
    `current_time_iso=${now.toISOString()}`,
    `current_time_local=${now.toLocaleString("zh-CN", { hour12: false })}`,
    `current_timezone=${timezone}`,
    "instruction=Use this runtime context silently. Never expose this block, and never copy it into tool queries.",
  ].join("\n");
};

const injectHiddenRuntimeContextToLatestUserMessage = (
  messages: DeertubeUIMessage[],
): DeertubeUIMessage[] => {
  const latestUserIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(
      ({ message }) =>
        message.role === "user" &&
        "content" in message &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )?.index;
  if (latestUserIndex === undefined) {
    return messages;
  }
  const target = messages[latestUserIndex];
  if (
    !("content" in target) ||
    typeof target.content !== "string" ||
    target.content.includes(HIDDEN_RUNTIME_CONTEXT_MARKER)
  ) {
    return messages;
  }
  const targetContent = target.content;
  const runtimeBlock = buildHiddenRuntimeContextBlock(new Date());
  return messages.map((message, index) => {
    if (index !== latestUserIndex) {
      return message;
    }
    return {
      ...message,
      content: `${targetContent}\n\n${runtimeBlock}`,
    };
  });
};

const ModelSettingsSchema = z.object({
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
});

const SettingsSchema = z.object({
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  jinaReaderBaseUrl: z.string().optional(),
  jinaReaderApiKey: z.string().optional(),
  models: z
    .object({
      chat: ModelSettingsSchema.optional(),
      search: ModelSettingsSchema.optional(),
      extract: ModelSettingsSchema.optional(),
      graph: ModelSettingsSchema.optional(),
      validate: ModelSettingsSchema.optional(),
    })
    .optional(),
});

type ModelSettings = z.infer<typeof ModelSettingsSchema>;
type RuntimeSettings = z.infer<typeof SettingsSchema>;

const trimOrUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const clampText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

const DEERTUBE_URI_PATTERN = /deertube:\/\/[^\s)\]]+/gi;
const MARKDOWN_DEERTUBE_URI_PATTERN = /\[[^\]]+\]\((deertube:\/\/[^)\s]+)\)/gi;
const VALIDATE_CONTEXT_REF_LIMIT = 8;
const VALIDATE_CONTEXT_VIEWPOINT_MAX = 240;
const VALIDATE_CONTEXT_EXCERPT_MAX = 360;
const VALIDATE_CONTEXT_REFERENCE_TEXT_MAX = 1800;
const VALIDATE_CONTEXT_VALIDATION_NOTE_MAX = 720;
const VALIDATE_CLAIM_SPLIT_ANSWER_MAX = 20000;
const VALIDATE_CLAIM_QUERY_MAX = 3200;
const VALIDATE_CLAIM_MAX_COUNT = 12;
const VALIDATE_CLAIM_ITEM_MAX = 260;
const VALIDATE_NO_CLAIM_SENTINEL = "NO_CLAIM";

const normalizeInlineText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const hasNoClaimSentinel = (rawText: string): boolean =>
  rawText
    .split(/\r?\n/)
    .some(
      (line) =>
        normalizeInlineText(line).toUpperCase() === VALIDATE_NO_CLAIM_SENTINEL,
    );

const splitAnswerIntoSentenceLikeClaims = (answer: string): string[] => {
  const normalized = normalizeInlineText(answer);
  if (!normalized) {
    return [];
  }
  const candidates = normalized
    .split(/(?<=[.!?。！？；;])\s+/)
    .map((line) => normalizeInlineText(line))
    .filter((line) => line.length > 0);
  if (candidates.length > 0) {
    return candidates;
  }
  return [normalized];
};

const parseClaimLines = (rawText: string): string[] => {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[).:-])\s*/, "").trim())
    .filter((line) => line.length > 0);
  const dedupe = new Set<string>();
  lines.forEach((line) => {
    const normalized = normalizeInlineText(line);
    if (!normalized) {
      return;
    }
    if (normalized === VALIDATE_NO_CLAIM_SENTINEL) {
      return;
    }
    if (/^(claims?|output|json)\s*:/i.test(normalized)) {
      return;
    }
    dedupe.add(clampText(normalized, VALIDATE_CLAIM_ITEM_MAX));
  });
  return Array.from(dedupe.values()).slice(0, VALIDATE_CLAIM_MAX_COUNT);
};

const buildValidationClaimScopePrompt = ({
  answer,
  strictness,
}: {
  answer: string;
  strictness: DeepResearchStrictness;
}): string => {
  const strictnessLines =
    strictness === "all-claims"
      ? [
          "Mode: all-claims.",
          "Extract every material factual claim from the answer text.",
        ]
      : [
          "Mode: uncertain-claims.",
          "Extract only uncertain, contested, time-sensitive, or high-impact factual claims.",
        ];
  return [
    "You are a validation claim splitter.",
    "Use only the provided answer text as claim scope.",
    "Do not use or infer from the original user question.",
    ...strictnessLines,
    `Output one claim per line. If no fact-checkable claim exists, output exactly ${VALIDATE_NO_CLAIM_SENTINEL}.`,
    "No markdown. No JSON. No explanation.",
    "",
    "Answer text:",
    answer,
  ].join("\n");
};

const deriveValidationClaimsFromAnswer = async ({
  model,
  answer,
  strictness,
  projectPath,
  abortSignal,
}: {
  model: ReturnType<typeof buildLanguageModel>["model"];
  answer: string;
  strictness: DeepResearchStrictness;
  projectPath?: string;
  abortSignal?: AbortSignal;
}): Promise<{
  claims: string[];
  method: "llm" | "llm-no-claim" | "fallback" | "fallback-skip" | "raw-answer";
}> => {
  const trimmedAnswer = answer.trim();
  if (!trimmedAnswer) {
    return { claims: [], method: "raw-answer" };
  }
  const scopedAnswer = clampText(trimmedAnswer, VALIDATE_CLAIM_SPLIT_ANSWER_MAX);
  let llmFailed = false;
  try {
    const result = await generateText({
      model,
      prompt: buildValidationClaimScopePrompt({
        answer: scopedAnswer,
        strictness,
      }),
      abortSignal,
    });
    if (hasNoClaimSentinel(result.text)) {
      return { claims: [], method: "llm-no-claim" };
    }
    const claims = parseClaimLines(result.text);
    if (claims.length > 0) {
      return { claims, method: "llm" };
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    llmFailed = true;
    logValidate({
      event: "claim-split-fallback",
      projectPath,
      level: "warn",
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
  const fallbackClaims = splitAnswerIntoSentenceLikeClaims(scopedAnswer)
    .map((line) => clampText(line, VALIDATE_CLAIM_ITEM_MAX))
    .slice(0, VALIDATE_CLAIM_MAX_COUNT);
  if (fallbackClaims.length > 0) {
    return { claims: fallbackClaims, method: "fallback" };
  }
  if (!llmFailed && strictness !== "all-claims") {
    return { claims: [], method: "fallback-skip" };
  }
  return { claims: [], method: "raw-answer" };
};

const buildValidationQueryFromClaims = ({
  claims,
  strictness,
  answer,
  fallbackQuery,
}: {
  claims: string[];
  strictness: DeepResearchStrictness;
  answer: string;
  fallbackQuery: string;
}): string => {
  if (claims.length === 0) {
    const normalizedAnswer = normalizeInlineText(answer);
    if (normalizedAnswer.length > 0) {
      return clampText(normalizedAnswer, VALIDATE_CLAIM_QUERY_MAX);
    }
    return clampText(
      normalizeInlineText(fallbackQuery),
      VALIDATE_CLAIM_QUERY_MAX,
    );
  }
  const modeLabel =
    strictness === "all-claims" ? "all-claims" : "uncertain-claims";
  const lines = [
    `Validation claim scope (${modeLabel}) from answer content:`,
    ...claims.map((claim, index) => `${index + 1}. ${claim}`),
    "Claim scope source: answer-to-validate only. Do not rescope from original question.",
  ];
  return clampText(lines.join("\n"), VALIDATE_CLAIM_QUERY_MAX);
};

const extractDeertubeUrisFromText = (input: string): string[] => {
  const dedupe = new Set<string>();
  for (const markdownMatch of input.matchAll(MARKDOWN_DEERTUBE_URI_PATTERN)) {
    const normalized = trimOrUndefined(markdownMatch[1]);
    if (normalized) {
      dedupe.add(normalized);
    }
  }
  for (const rawMatch of input.matchAll(DEERTUBE_URI_PATTERN)) {
    const normalized = trimOrUndefined(rawMatch[0]);
    if (normalized) {
      dedupe.add(normalized);
    }
  }
  return Array.from(dedupe.values());
};

const resolveReferencedContextForValidation = async (
  projectPath: string,
  answer: string,
): Promise<{ context: string; resolvedCount: number }> => {
  const uris = extractDeertubeUrisFromText(answer).slice(
    0,
    VALIDATE_CONTEXT_REF_LIMIT,
  );
  if (uris.length === 0) {
    return { context: "", resolvedCount: 0 };
  }
  const resolvedReferences = (
    await Promise.all(
      uris.map(async (uri) => {
        try {
          return await resolveDeepResearchReference(projectPath, uri);
        } catch (error) {
          logValidate({
            event: "resolve-reference-failed",
            projectPath,
            level: "warn",
            payload: {
            uri,
            message: error instanceof Error ? error.message : String(error),
            },
          });
          return null;
        }
      }),
    )
  ).filter(
    (reference): reference is NonNullable<typeof reference> =>
      reference !== null,
  );
  if (resolvedReferences.length === 0) {
    return { context: "", resolvedCount: 0 };
  }
  const contextLines = [
    "Answer-cited references (reuse before launching extra validation search):",
    ...resolvedReferences.map((reference, index) => {
      const title = trimOrUndefined(reference.title) ?? reference.url;
      const viewpointLine = clampText(
        reference.viewpoint,
        VALIDATE_CONTEXT_VIEWPOINT_MAX,
      );
      const selectedPassage = trimOrUndefined(reference.text);
      const selectedPassageLine = selectedPassage
        ? clampText(selectedPassage, VALIDATE_CONTEXT_REFERENCE_TEXT_MAX)
        : "No selected passage text.";
      const validationNote = trimOrUndefined(reference.validationRefContent);
      const validationNoteLine = validationNote
        ? clampText(validationNote, VALIDATE_CONTEXT_VALIDATION_NOTE_MAX)
        : null;
      const excerpt = trimOrUndefined(reference.validationRefContent);
      const excerptLine = excerpt
        ? clampText(excerpt, VALIDATE_CONTEXT_EXCERPT_MAX)
        : null;
      const accuracyLine = reference.accuracy
        ? `Accuracy: ${reference.accuracy}`
        : null;
      const sourceAuthorityLine = reference.sourceAuthority
        ? `Source authority: ${reference.sourceAuthority}`
        : null;
      return [
        `[${index + 1}] ${title}`,
        `URI: ${reference.uri}`,
        `URL: ${reference.url}`,
        `Viewpoint: ${viewpointLine}`,
        `Selected passage lines: ${reference.startLine}-${reference.endLine}`,
        `Selected passage text: ${selectedPassageLine}`,
        validationNoteLine ? `Validation note: ${validationNoteLine}` : null,
        accuracyLine,
        sourceAuthorityLine,
        excerptLine ? `Legacy excerpt: ${excerptLine}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    }),
  ];
  return {
    context: contextLines.join("\n\n"),
    resolvedCount: resolvedReferences.length,
  };
};

const buildLegacyModelSettings = (
  settings: RuntimeSettings | undefined,
): ModelSettings | undefined => {
  if (!settings) {
    return undefined;
  }
  const llmProvider = trimOrUndefined(settings.llmProvider);
  const llmModelId = trimOrUndefined(settings.llmModelId);
  const llmApiKey = trimOrUndefined(settings.llmApiKey);
  const llmBaseUrl = trimOrUndefined(settings.llmBaseUrl);
  if (!llmProvider && !llmModelId && !llmApiKey && !llmBaseUrl) {
    return undefined;
  }
  return {
    llmProvider,
    llmModelId,
    llmApiKey,
    llmBaseUrl,
  };
};

const resolveModelSettings = (
  preferred: ModelSettings | undefined,
  fallback: ModelSettings | undefined,
) => {
  const llmProvider =
    trimOrUndefined(preferred?.llmProvider) ??
    trimOrUndefined(fallback?.llmProvider) ??
    "openai";
  const llmModelId =
    trimOrUndefined(preferred?.llmModelId) ??
    trimOrUndefined(fallback?.llmModelId) ??
    "gpt-4o-mini";
  const llmApiKey =
    trimOrUndefined(preferred?.llmApiKey) ??
    trimOrUndefined(fallback?.llmApiKey);
  const llmBaseUrl =
    trimOrUndefined(preferred?.llmBaseUrl) ??
    trimOrUndefined(fallback?.llmBaseUrl) ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1";
  return {
    llmProvider,
    llmModelId,
    llmApiKey,
    llmBaseUrl,
  };
};

const buildLanguageModel = (
  preferred: ModelSettings | undefined,
  fallback: ModelSettings | undefined,
) => {
  const resolved = resolveModelSettings(preferred, fallback);
  const provider = createOpenAICompatible({
    name: resolved.llmProvider,
    baseURL: resolved.llmBaseUrl,
    apiKey: resolved.llmApiKey,
  });
  return {
    model: provider(resolved.llmModelId),
    resolved,
  };
};

const ValidateInputSchema = z.object({
  projectPath: z.string(),
  query: z.string().min(1),
  answer: z.string().min(1),
  toolCallId: z.string().optional(),
  force: z.boolean().optional(),
  settings: SettingsSchema.optional(),
  deepResearch: DeepResearchConfigSchema.optional(),
});

type ValidateInput = z.infer<typeof ValidateInputSchema>;

const ValidateUiEventInputSchema = z.object({
  projectPath: z.string(),
  event: z.string().min(1),
  chatId: z.string().optional(),
  responseId: z.string().optional(),
  payload: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
});

interface ValidateResult {
  status: "complete" | "skipped";
  mode: "validate";
  query: string;
  skipReason?: "disabled-by-config" | "no-fact-checkable-claims";
  searchId?: string;
  projectId?: string;
  references: Awaited<ReturnType<typeof runDeepSearchTool>>["references"];
  sources: Awaited<ReturnType<typeof runDeepSearchTool>>["sources"];
}

type ValidateStreamProgressEvent =
  | {
      type: "subagent-stream";
      payload: SubagentStreamPayload;
    }
  | {
      type: "deepsearch-stream";
      payload: DeepSearchStreamPayload;
    }
  | {
      type: "deepsearch-done";
      payload: DeepSearchStreamPayload;
    };

interface ValidateStreamResultEvent {
  type: "result";
  payload: ValidateResult;
}

type ValidateStreamEvent = ValidateStreamProgressEvent | ValidateStreamResultEvent;

const runValidateForInput = async (
  input: ValidateInput,
  abortSignal?: AbortSignal,
  onStreamEvent?: (event: ValidateStreamProgressEvent) => void,
): Promise<ValidateResult> => {
  const deepResearchConfig = resolveDeepResearchConfig(input.deepResearch);
  const forceValidate = input.force === true;
  const forcedValidateStrictness: "all-claims" | "uncertain-claims" =
    deepResearchConfig.validate.strictness === "all-claims"
      ? "all-claims"
      : "uncertain-claims";
  const effectiveDeepResearchConfig = forceValidate
    ? {
        ...deepResearchConfig,
        enabled: true,
        validate: {
          ...deepResearchConfig.validate,
          enabled: true,
          strictness: forcedValidateStrictness,
        },
      }
    : deepResearchConfig;
  const incomingQuery = input.query.trim();
  const answer = input.answer.trim();
  const existingRefContext = await resolveReferencedContextForValidation(
    input.projectPath,
    answer,
  );
  const validateTargetAnswer = existingRefContext.context
    ? `${answer}\n\n${existingRefContext.context}`
    : answer;
  logValidate({
    event: "start",
    projectPath: input.projectPath,
    payload: {
    logFilePath: resolveValidateLogFilePath(input.projectPath),
    query: incomingQuery.slice(0, 180),
    validateEnabled:
      deepResearchConfig.enabled && deepResearchConfig.validate.enabled,
    forced: forceValidate,
    aborted: Boolean(abortSignal?.aborted),
    answerRefsResolved: existingRefContext.resolvedCount,
    },
  });
  if (
    !forceValidate &&
    (!deepResearchConfig.enabled || !deepResearchConfig.validate.enabled)
  ) {
    logValidate({
      event: "skip-disabled-config",
      projectPath: input.projectPath,
      payload: {
        query: incomingQuery.slice(0, 180),
      },
    });
    return {
      status: "skipped",
      mode: "validate",
      query: incomingQuery,
      skipReason: "disabled-by-config",
      searchId: undefined,
      projectId: undefined,
      references: [],
      sources: [],
    };
  }
  const externalSkills = filterExternalSkillsBySelection(
    await loadExternalSkills(),
    effectiveDeepResearchConfig.selectedSkillNames,
  );
  const legacyModel = buildLegacyModelSettings(input.settings);
  const validateModelConfig = buildLanguageModel(
    input.settings?.models?.validate,
    input.settings?.models?.search ??
      input.settings?.models?.chat ??
      legacyModel,
  );
  const extractModelConfig = buildLanguageModel(
    input.settings?.models?.extract,
    input.settings?.models?.validate ??
      input.settings?.models?.search ??
      input.settings?.models?.chat ??
      legacyModel,
  );
  const deepResearchStore = createDeepResearchPersistenceAdapter(input.projectPath);
  const tavilyApiKey = trimOrUndefined(input.settings?.tavilyApiKey);
  const jinaReaderBaseUrl = trimOrUndefined(input.settings?.jinaReaderBaseUrl);
  const jinaReaderApiKey = trimOrUndefined(input.settings?.jinaReaderApiKey);
  const claimSplit = await deriveValidationClaimsFromAnswer({
    model: validateModelConfig.model,
    answer,
    strictness: effectiveDeepResearchConfig.validate.strictness,
    projectPath: input.projectPath,
    abortSignal,
  });
  if (claimSplit.claims.length === 0) {
    logValidate({
      event: "skip-no-fact-checkable-claims",
      projectPath: input.projectPath,
      payload: {
      incomingQueryPreview: incomingQuery.slice(0, 120),
      claimScopeMethod: claimSplit.method,
      strictness: effectiveDeepResearchConfig.validate.strictness,
      },
    });
    return {
      status: "skipped",
      mode: "validate",
      query: incomingQuery,
      skipReason: "no-fact-checkable-claims",
      searchId: undefined,
      projectId: undefined,
      references: [],
      sources: [],
    };
  }
  const query = buildValidationQueryFromClaims({
    claims: claimSplit.claims,
    strictness: effectiveDeepResearchConfig.validate.strictness,
    answer,
    fallbackQuery: incomingQuery,
  });
  logValidate({
    event: "claim-scope-derived",
    projectPath: input.projectPath,
    payload: {
    incomingQueryPreview: incomingQuery.slice(0, 120),
    derivedQueryPreview: query.slice(0, 180),
    claimCount: claimSplit.claims.length,
    claimScopeMethod: claimSplit.method,
    strictness: effectiveDeepResearchConfig.validate.strictness,
    },
  });
  const result = await runDeepSearchTool({
    query,
    searchModel: validateModelConfig.model,
    extractModel: extractModelConfig.model,
    toolCallId: trimOrUndefined(input.toolCallId),
    toolName: "validate.run",
    abortSignal,
    tavilyApiKey,
    jinaReaderBaseUrl,
    jinaReaderApiKey,
    deepResearchStore,
    deepResearchConfig: effectiveDeepResearchConfig,
    externalSkills,
    mode: "validate",
    validateTargetAnswer,
    onSubagentStream: (payload) => {
      onStreamEvent?.({
        type: "subagent-stream",
        payload,
      });
    },
    onDeepSearchStream: (payload, done) => {
      onStreamEvent?.({
        type: done ? "deepsearch-done" : "deepsearch-stream",
        payload,
      });
    },
  });
  logValidate({
    event: "complete",
    projectPath: input.projectPath,
    payload: {
    query: query.slice(0, 180),
    sources: result.sources.length,
    references: result.references.length,
    },
  });
  return {
    status: "complete",
    mode: "validate",
    query,
    searchId: result.searchId,
    projectId: result.projectId,
    references: result.references,
    sources: result.sources,
  };
};

export const chatRouter = createTRPCRouter({
  send: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        messages: z.array(z.custom<DeertubeUIMessage>()),
        context: z
          .object({
            selectedNodeSummary: z.string().optional(),
            selectedPathSummary: z.string().optional(),
          })
          .optional(),
        settings: SettingsSchema.optional(),
        deepResearch: DeepResearchConfigSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const deepResearchConfig = resolveDeepResearchConfig(input.deepResearch);
      const externalSkills = filterExternalSkillsBySelection(
        await loadExternalSkills(),
        deepResearchConfig.selectedSkillNames,
      );
      const legacyModel = buildLegacyModelSettings(input.settings);
      const chatModelConfig = buildLanguageModel(
        input.settings?.models?.chat,
        legacyModel,
      );

      const contextLines: string[] = [];
      if (input.context?.selectedNodeSummary) {
        contextLines.push(input.context.selectedNodeSummary);
      }
      if (input.context?.selectedPathSummary) {
        contextLines.push(
          `Root-to-selected context:\n${input.context.selectedPathSummary}`,
        );
      }
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const lastUserContent =
        lastUserMessage &&
        "content" in lastUserMessage &&
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content
          : "";
      const systemPrompt = buildMainAgentSystemPrompt(
        contextLines,
        deepResearchConfig,
        { query: lastUserContent, availableSkills: externalSkills },
      );
      const modelInputMessages = injectHiddenRuntimeContextToLatestUserMessage(
        input.messages,
      );

      const lastUserText = lastUserContent.slice(0, 200);
      console.log("[chat.send]", {
        messageCount: input.messages.length,
        lastUserText,
        provider: chatModelConfig.resolved.llmProvider,
        model: chatModelConfig.resolved.llmModelId,
        deepResearchEnabled: deepResearchConfig.enabled,
        searchEnabled:
          deepResearchConfig.enabled &&
          deepResearchConfig.strictness !== "no-search",
        validateEnabled: deepResearchConfig.validate.enabled,
      });
      const result = await generateText({
        model: chatModelConfig.model,
        system: systemPrompt,
        messages: await convertToModelMessages(modelInputMessages, {
          ignoreIncompleteToolCalls: true,
        }),
      });

      return { text: result.text };
    }),
  validate: baseProcedure
    .input(ValidateInputSchema)
    .mutation(async ({ input }) => runValidateForInput(input)),
  validateUiEvent: baseProcedure
    .input(ValidateUiEventInputSchema)
    .mutation(({ input }) => {
      logValidate({
        event: `ui.${input.event}`,
        projectPath: input.projectPath,
        payload: {
          chatId: input.chatId,
          responseId: input.responseId,
          ...(input.payload ?? {}),
        },
      });
      return {
        ok: true,
        logFilePath: resolveValidateLogFilePath(input.projectPath),
      };
    }),
  validateStream: baseProcedure
    .input(ValidateInputSchema)
    .subscription(async function* ({ input, signal }) {
      const abortController = new AbortController();
      const handleAbort = () => {
        abortController.abort();
      };
      if (signal) {
        signal.addEventListener("abort", handleAbort, { once: true });
      }
      const queuedEvents: ValidateStreamEvent[] = [];
      const waitingResolvers = new Set<() => void>();
      let queueClosed = false;
      const notifyWaitingReaders = () => {
        waitingResolvers.forEach((resolve) => resolve());
        waitingResolvers.clear();
      };
      const pushEvent = (event: ValidateStreamEvent) => {
        if (queueClosed) {
          return;
        }
        queuedEvents.push(event);
        notifyWaitingReaders();
      };
      const waitForEventOrClose = async () => {
        if (queuedEvents.length > 0 || queueClosed) {
          return;
        }
        await new Promise<void>((resolve) => {
          waitingResolvers.add(resolve);
        });
      };
      try {
        let runnerError: unknown;
        const runner = runValidateForInput(
          input,
          abortController.signal,
          (event) => {
            pushEvent(event);
          },
        )
          .then((result) => {
            pushEvent({
              type: "result",
              payload: result,
            });
          })
          .catch((error) => {
            runnerError = error;
          })
          .finally(() => {
            queueClosed = true;
            notifyWaitingReaders();
          });
        while (true) {
          await waitForEventOrClose();
          while (queuedEvents.length > 0) {
            const next = queuedEvents.shift();
            if (!next) {
              continue;
            }
            if ((signal?.aborted ?? false) || abortController.signal.aborted) {
              return;
            }
            yield next;
          }
          if (queueClosed) {
            break;
          }
        }
        await runner;
        if (runnerError) {
          if (isAbortError(runnerError) || (signal?.aborted ?? false)) {
            return;
          }
          throw runnerError;
        }
      } catch (error) {
        if (
          abortController.signal.aborted ||
          (signal?.aborted ?? false) ||
          isAbortError(error)
        ) {
          return;
        }
        throw error;
      } finally {
        queueClosed = true;
        notifyWaitingReaders();
        if (signal) {
          signal.removeEventListener("abort", handleAbort);
        }
      }
    }),
  stream: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        messages: z.array(z.custom<DeertubeUIMessage>()),
        context: z
          .object({
            selectedNodeSummary: z.string().optional(),
            selectedPathSummary: z.string().optional(),
          })
          .optional(),
        settings: SettingsSchema.optional(),
        deepResearch: DeepResearchConfigSchema.optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      const deepResearchConfig = resolveDeepResearchConfig(input.deepResearch);
      const externalSkills = filterExternalSkillsBySelection(
        await loadExternalSkills(),
        deepResearchConfig.selectedSkillNames,
      );
      const legacyModel = buildLegacyModelSettings(input.settings);
      const chatModelConfig = buildLanguageModel(
        input.settings?.models?.chat,
        legacyModel,
      );
      const searchModelConfig = deepResearchConfig.enabled
        ? buildLanguageModel(
            input.settings?.models?.search,
            input.settings?.models?.chat ?? legacyModel,
          )
        : null;
      const extractModelConfig = deepResearchConfig.enabled
        ? buildLanguageModel(
            input.settings?.models?.extract,
            input.settings?.models?.search ??
              input.settings?.models?.chat ??
              legacyModel,
          )
        : null;

      const contextLines: string[] = [];
      if (input.context?.selectedNodeSummary) {
        contextLines.push(input.context.selectedNodeSummary);
      }
      if (input.context?.selectedPathSummary) {
        contextLines.push(
          `Root-to-selected context:\n${input.context.selectedPathSummary}`,
        );
      }
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const lastUserContent =
        lastUserMessage &&
        "content" in lastUserMessage &&
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content
          : "";
      const systemPrompt = buildMainAgentSystemPrompt(
        contextLines,
        deepResearchConfig,
        { query: lastUserContent, availableSkills: externalSkills },
      );
      const modelInputMessages = injectHiddenRuntimeContextToLatestUserMessage(
        input.messages,
      );

      const lastUserText = lastUserContent.slice(0, 200);
      console.log("[chat.stream]", {
        messageCount: input.messages.length,
        lastUserText,
        provider: chatModelConfig.resolved.llmProvider,
        model: chatModelConfig.resolved.llmModelId,
        searchModel: searchModelConfig?.resolved.llmModelId,
        extractModel: extractModelConfig?.resolved.llmModelId,
        deepResearchEnabled: deepResearchConfig.enabled,
        searchEnabled:
          deepResearchConfig.enabled &&
          deepResearchConfig.strictness !== "no-search",
        validateEnabled: deepResearchConfig.validate.enabled,
      });
      const stream = createUIMessageStream<DeertubeUIMessage>({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
          const modelMessages = await convertToModelMessages(modelInputMessages, {
            ignoreIncompleteToolCalls: true,
          });
          const useDeepResearchTools =
            deepResearchConfig.enabled &&
            deepResearchConfig.strictness !== "no-search";
          if (!useDeepResearchTools) {
            const result = streamText({
              model: chatModelConfig.model,
              system: systemPrompt,
              messages: modelMessages,
              abortSignal: signal,
            });
            writer.merge(result.toUIMessageStream());
            return;
          }
          const deepResearchStore = createDeepResearchPersistenceAdapter(
            input.projectPath,
          );
          const tools = createTools(writer, {
            model: searchModelConfig?.model,
            searchModel: searchModelConfig?.model,
            extractModel: extractModelConfig?.model,
            deepSearchExecutionMode: "enabled",
            tavilyApiKey: input.settings?.tavilyApiKey,
            jinaReaderBaseUrl: input.settings?.jinaReaderBaseUrl,
            jinaReaderApiKey: input.settings?.jinaReaderApiKey,
            deepResearchStore,
            deepResearchConfig,
            externalSkills,
          });
          const result = streamText({
            model: chatModelConfig.model,
            system: systemPrompt,
            messages: modelMessages,
            tools,
            toolChoice: "auto",
            stopWhen: noStepLimit,
            abortSignal: signal,
          });
          writer.merge(result.toUIMessageStream());
        },
      });

      const reader = stream.getReader();
      const abortPromise = signal ? waitForAbort(signal) : null;

      try {
        while (true) {
          const next = abortPromise
            ? await Promise.race([
                reader
                  .read()
                  .then((result) => ({ kind: "chunk" as const, result })),
                abortPromise,
              ])
            : {
                kind: "chunk" as const,
                result: await reader.read(),
              };
          if (next.kind === "abort") {
            await reader.cancel("chat stream aborted");
            break;
          }
          const { done, value } = next.result;
          if (done) {
            break;
          }
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }),
});

export type ChatRouter = typeof chatRouter;
