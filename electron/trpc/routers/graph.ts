import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { baseProcedure, createTRPCRouter } from "../init";
import { isJsonObject } from "../../../src/types/json";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const logGraphTool = (label: string, payload: unknown) => {
  if (!isDev) {
    return;
  }
  console.log(`[graph.run] ${label}`, payload);
};

const extractErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean") {
    return String(err);
  }
  if (err && typeof err === "object") {
    return Object.prototype.toString.call(err);
  }
  return "Unknown error";
};

const isMalformedFunctionCallError = (err: unknown): boolean => {
  const message = extractErrorMessage(err);
  if (/MALFORMED_FUNCTION_CALL/i.test(message)) {
    return true;
  }
  if (isJsonObject(err) && "cause" in err) {
    const cause = err.cause;
    if (cause) {
      return /MALFORMED_FUNCTION_CALL/i.test(extractErrorMessage(cause));
    }
  }
  return false;
};

const isGraphValidationError = (err: unknown): boolean => {
  const message = extractErrorMessage(err);
  return /Excerpt must be an exact quote|Node id .* conflicts|Node id .* duplicated|Unknown parentIntId|cannot be its own parent/i.test(
    message,
  );
};

const buildRetryHint = (errorMessage: string) =>
  [
    "The previous attempt failed with error:",
    errorMessage,
    "Please retry and ensure any tool call strictly follows the schema.",
    "Do not include extra text outside tool calls.",
  ].join("\n");

const ModelSettingsSchema = z.object({
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
});

const RuntimeSettingsSchema = z.object({
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
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
type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

const trimOrUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
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

const GraphNodeSchema = z.object({
  titleLong: z.string().min(1),
  titleShort: z.string().min(1),
  titleTiny: z.string().min(1),
  excerpt: z.string().min(1),
  id: z.number().int().optional(),
  parentIntId: z.number().int(),
});

const clampText = (input: string, maxChars: number) => {
  const chars = Array.from(input.trim());
  if (chars.length <= maxChars) {
    return input.trim();
  }
  return chars.slice(0, maxChars).join("");
};

const collapseWhitespace = (input: string) => input.replace(/\s+/g, " ").trim();

const stripMarkdownSyntax = (input: string) => {
  let text = input;
  text = text.replace(/```[^\n]*\n?/g, "");
  text = text.replace(/```/g, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^(\s*([-*+]|\d+[.)]))\s+/gm, "");
  return text;
};

const normalizeMarkdownForMatch = (input: string) =>
  collapseWhitespace(stripMarkdownSyntax(input)).toLowerCase();

const ensureExcerpt = (excerpt: string, source: string) => {
  const cleaned = excerpt.trim();
  if (cleaned && source.includes(cleaned)) {
    return cleaned;
  }
  const normalizedExcerpt = normalizeMarkdownForMatch(cleaned);
  if (normalizedExcerpt) {
    const normalizedSource = normalizeMarkdownForMatch(source);
    if (normalizedSource.includes(normalizedExcerpt)) {
      return cleaned;
    }
  }
  throw new Error("Excerpt must be an exact quote from the response.");
};

export const graphRouter = createTRPCRouter({
  run: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        responseId: z.string(),
        responseText: z.string(),
        selectedNodeId: z.string().optional(),
        selectedNodeSummary: z.string().optional(),
        graph: z.object({
          nodes: z.array(
            z.object({
              intId: z.number().int(),
              nodeId: z.string(),
              type: z.string(),
              label: z.string().optional(),
              excerpt: z.string().optional(),
            }),
          ),
          edges: z.array(
            z.object({
              sourceIntId: z.number().int(),
              targetIntId: z.number().int(),
            }),
          ),
        }),
        settings: RuntimeSettingsSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const legacyModelSettings = buildLegacyModelSettings(input.settings);
      const resolvedModel = resolveModelSettings(
        input.settings?.models?.graph,
        input.settings?.models?.chat ?? legacyModelSettings,
      );
      logGraphTool("start", {
        responseId: input.responseId,
        selectedNodeId: input.selectedNodeId ?? null,
        graphNodes: input.graph.nodes.length,
        graphEdges: input.graph.edges.length,
        llmProvider: resolvedModel.llmProvider,
        llmModelId: resolvedModel.llmModelId,
      });

      const provider = createOpenAICompatible({
        name: resolvedModel.llmProvider,
        baseURL: resolvedModel.llmBaseUrl,
        apiKey: resolvedModel.llmApiKey,
      });

      const existingIntIds = new Set<number>();
      const existingNodeIdByIntId = new Map<number, string>();
      input.graph.nodes.forEach((node) => {
        existingIntIds.add(node.intId);
        existingNodeIdByIntId.set(node.intId, node.nodeId);
      });

      const contextBlock = input.selectedNodeSummary
        ? `Selected node context:\n${input.selectedNodeSummary}\n\n`
        : "";

      const graphLines = [
        "Graph nodes (intId -> nodeId | type | label | excerpt):",
        ...input.graph.nodes.map((node) => {
          const parts = [
            `${node.intId}`,
            node.nodeId,
            node.type,
            node.label ? `"${node.label}"` : "",
            node.excerpt ? `"${node.excerpt}"` : "",
          ].filter(Boolean);
          return `- ${parts.join(" | ")}`;
        }),
        "Graph edges (sourceIntId -> targetIntId):",
        ...input.graph.edges.map(
          (edge) => `- ${edge.sourceIntId} -> ${edge.targetIntId}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");

      const runAttempt = async (retryHint?: string) => {
        const actions: {
          id: string;
          titleLong: string;
          titleShort: string;
          titleTiny: string;
          excerpt: string;
          parentIntId: number;
          tempId?: number;
          responseId: string;
        }[] = [];
        const tempIdToUuid = new Map<number, string>();

        const addInsightNodeTool = tool({
          description:
            "Add a single graph insight node linked to the response. Excerpt must be an exact quote from the response. You may provide id (an integer) to reference this node as a parent in the same call.",
          inputSchema: GraphNodeSchema,
          execute: (data) => {
            const excerpt = ensureExcerpt(data.excerpt, input.responseText);
            if (data.id !== undefined) {
              if (existingIntIds.has(data.id)) {
                throw new Error(
                  `Node id ${data.id} conflicts with existing graph ids.`,
                );
              }
              if (tempIdToUuid.has(data.id)) {
                throw new Error(
                  `Node id ${data.id} is duplicated in this run.`,
                );
              }
            }
            if (data.id !== undefined && data.parentIntId === data.id) {
              throw new Error(`Node id ${data.id} cannot be its own parent.`);
            }
            const nodeId = randomUUID();
            if (data.id !== undefined) {
              tempIdToUuid.set(data.id, nodeId);
            }
            actions.push({
              id: nodeId,
              titleLong: clampText(data.titleLong, 30),
              titleShort: clampText(data.titleShort, 16),
              titleTiny: clampText(data.titleTiny, 18),
              excerpt,
              parentIntId: data.parentIntId,
              tempId: data.id,
              responseId: input.responseId,
            });
            return { ok: true };
          },
        });

        const retryBlock = retryHint ? `\n\n${retryHint}\n\n` : "\n\n";
        const result = await generateText({
          model: provider(resolvedModel.llmModelId),
          system:
            "You are a graph-builder for a product that builds a clear, easy-to-understand knowledge map during conversation. Only call addInsightNodeTool when the response introduces new, distillable information worth adding to the graph; otherwise, respond with a short explanation of why no node should be added. When there would be many new nodes, you may aggregate them into fewer, higher-level nodes. If the response contains multiple derivative points, you may create nodes at multiple levels of the graph and are not limited to the currently selected node. You MAY assign each new node an id (integer) to reference it as a parent in the same call. id must be unique among new nodes and must NOT overlap existing graph intIds listed above. Use parentIntId to reference either an existing graph node intId or an id of another new node (declared earlier in the same run) to build multi-level structures. Each node must quote an exact excerpt from the response text; the excerpt MUST be a verbatim span from the response text. The response text is raw markdown, so keep markdown syntax in the excerpt even if the snippet is not valid standalone markdown. If you add multiple nodes, avoid repeating or overlapping excerpts. Titles must be short, clear, and in three sizes: long (<=48 chars), short (<=28 chars), tiny (<=20 chars). Long/Short/Tiny should become progressively shorter and more abstract. The system language does not represent the user language; the user language is the language used in the response. Use the same language as the response for all titles. The language of all three titles must match the response. You MUST provide parentIntId for every node. You MUST NOT call the tool if any excerpt is not a verbatim substring of the response. If there is any id conflict or unknown parent, you MUST call the tool with a valid id or skip adding nodes.",
          prompt: `${contextBlock}${graphLines}\n\nResponse:\n${input.responseText}${retryBlock}Create nodes now.`,
          tools: { add_insight_node: addInsightNodeTool },
        });
        return { result, actions };
      };

      const runAttemptWithResolve = async (retryHint?: string) => {
        const attemptResult = await runAttempt(retryHint);
        const { result, actions } = attemptResult;
        const resolveParentId = (parentIntId: number): string => {
          const existingParentId = existingNodeIdByIntId.get(parentIntId);
          if (existingParentId) {
            return existingParentId;
          }
          const tempParentId = actions.find(
            (action) => action.tempId === parentIntId,
          )?.id;
          if (tempParentId) {
            return tempParentId;
          }
          throw new Error(
            `Unknown parentIntId ${parentIntId} in final output.`,
          );
        };
        const resolvedNodes = actions.map((action) => ({
          id: action.id,
          titleLong: action.titleLong,
          titleShort: action.titleShort,
          titleTiny: action.titleTiny,
          excerpt: action.excerpt,
          parentId: resolveParentId(action.parentIntId),
          responseId: action.responseId,
        }));
        return { result, actions, resolvedNodes };
      };

      let attemptResult: Awaited<
        ReturnType<typeof runAttemptWithResolve>
      > | null = null;
      try {
        attemptResult = await runAttemptWithResolve();
      } catch (err) {
        if (isMalformedFunctionCallError(err) || isGraphValidationError(err)) {
          const errorMessage = extractErrorMessage(err);
          logGraphTool("retry", { error: errorMessage });
          try {
            attemptResult = await runAttemptWithResolve(
              buildRetryHint(errorMessage),
            );
          } catch (retryErr) {
            logGraphTool("failed", { error: extractErrorMessage(retryErr) });
            throw retryErr;
          }
        } else {
          logGraphTool("failed", { error: extractErrorMessage(err) });
          throw err;
        }
      }

      if (!attemptResult) {
        throw new Error("Graph tool did not return a result.");
      }

      const { result, actions, resolvedNodes } = attemptResult;

      logGraphTool("result", {
        responseId: input.responseId,
        assistantText: result.text.trim(),
        result: JSON.stringify(result),
        nodes: actions,
      });

      return {
        nodes: resolvedNodes,
        explanation:
          actions.length === 0 && result.text.trim().length > 0
            ? result.text.trim()
            : undefined,
      };
    }),
});

export type GraphRouter = typeof graphRouter;
