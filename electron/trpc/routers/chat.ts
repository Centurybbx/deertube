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
  resolveDeepResearchConfig,
} from "../../../src/shared/deepresearch-config";
import { scanLocalAgentSkills } from "../../skills/registry";
import type { RuntimeAgentSkill } from "../../../src/shared/agent-skills";
import { runDeepSearchTool } from "../../../src/modules/ai/tools/runners/deepsearch-tool";

const noStepLimit = () => false;
const VALIDATE_LOG_PREFIX = "[validate][chat.router]";

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
          console.warn(VALIDATE_LOG_PREFIX, {
            status: "resolve-reference-failed",
            uri,
            message: error instanceof Error ? error.message : String(error),
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
      const excerpt = trimOrUndefined(
        reference.validationRefContent ?? reference.text,
      );
      const excerptLine = excerpt
        ? clampText(excerpt, VALIDATE_CONTEXT_EXCERPT_MAX)
        : "No excerpt.";
      return [
        `[${index + 1}] ${title}`,
        `URI: ${reference.uri}`,
        `URL: ${reference.url}`,
        `Viewpoint: ${clampText(reference.viewpoint, VALIDATE_CONTEXT_VIEWPOINT_MAX)}`,
        `Excerpt: ${excerptLine}`,
      ].join("\n");
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

interface ValidateResult {
  status: "complete" | "skipped";
  mode: "validate";
  query: string;
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
  const effectiveDeepResearchConfig = forceValidate
    ? {
        ...deepResearchConfig,
        enabled: true,
        validate: {
          ...deepResearchConfig.validate,
          enabled: true,
          strictness:
            deepResearchConfig.validate.strictness === "no-search"
              ? "all-claims"
              : deepResearchConfig.validate.strictness,
        },
      }
    : deepResearchConfig;
  const query = input.query.trim();
  const answer = input.answer.trim();
  const existingRefContext = await resolveReferencedContextForValidation(
    input.projectPath,
    answer,
  );
  const validateTargetAnswer = existingRefContext.context
    ? `${answer}\n\n${existingRefContext.context}`
    : answer;
  console.log(VALIDATE_LOG_PREFIX, {
    query: query.slice(0, 180),
    validateEnabled:
      deepResearchConfig.enabled && deepResearchConfig.validate.enabled,
    forced: forceValidate,
    aborted: Boolean(abortSignal?.aborted),
    answerRefsResolved: existingRefContext.resolvedCount,
  });
  if (
    !forceValidate &&
    (!deepResearchConfig.enabled || !deepResearchConfig.validate.enabled)
  ) {
    return {
      status: "skipped",
      mode: "validate",
      query,
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
  console.log(VALIDATE_LOG_PREFIX, {
    query: query.slice(0, 180),
    status: "complete",
    sources: result.sources.length,
    references: result.references.length,
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
