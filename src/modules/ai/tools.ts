import { InferUITools, UIMessage, type UIMessageStreamWriter, tool } from "ai";
import { z } from "zod";
import { runDeepSearchTool } from "./tools/runner";
import { getAgentSkill, listAgentSkills } from "../../shared/agent-skills";
import type {
  DeepSearchReference,
  DeepSearchSource,
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  ToolConfig,
} from "./tools/types";

export type {
  DeepSearchReference,
  DeepSearchSource,
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  ToolConfig,
};

export type DeertubeUITools = InferUITools<ReturnType<typeof createTools>>;

export type DeertubeUIMessage = UIMessage<
  DeertubeMessageMetadata,
  DeertubeUIDataTypes,
  DeertubeUITools
>;

export function createTools(
  writer: UIMessageStreamWriter,
  config: ToolConfig = {},
) {
  const availableSkills = listAgentSkills({
    externalSkills: config.externalSkills,
  });
  return {
    discoverSkills: tool({
      description:
        "List available domain skills with activation hints so the agent can decide whether to load one.",
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
    }),
    loadSkill: tool({
      description:
        "Load one domain skill by exact name and return its full guidance markdown.",
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
        const matched = getAgentSkill(name, {
          externalSkills: config.externalSkills,
        });
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
    }),
    executeSkill: tool({
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
        const matched = getAgentSkill(name, {
          externalSkills: config.externalSkills,
        });
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
    }),
    deepSearch: tool({
      description:
        "Run deep research via network search and a subagent, returning structured references for citation. For citations, use references[].uri as inline markdown links like [1](deertube://...).",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("User research question to answer with cited evidence."),
      }).describe("Input payload for the deepSearch tool."),
      outputSchema: z.object({
        conclusion: z
          .string()
          .optional()
          .describe("Optional synthesized answer text (disabled by default)."),
        answer: z
          .string()
          .optional()
          .describe("Optional alias of conclusion for compatibility."),
        references: z.array(
          z.object({
            refId: z
              .number()
              .int()
              .positive()
              .describe("Sequential reference number used in inline citations."),
            uri: z.string().describe("Canonical URI for locating highlighted range."),
            pageId: z
              .string()
              .describe("Persisted page identifier for deep-research page record."),
            url: z.string().describe("Original page URL."),
            title: z
              .string()
              .optional()
              .describe("Page title for display."),
            viewpoint: z
              .string()
              .describe("Viewpoint this reference supports."),
            startLine: z
              .number()
              .int()
              .positive()
              .describe("Inclusive 1-based start line for highlighted reference."),
            endLine: z
              .number()
              .int()
              .positive()
              .describe("Inclusive 1-based end line for highlighted reference."),
            text: z.string().describe("Reference text shown to end users."),
            validationRefContent: z
              .string()
              .optional()
              .describe(
                "Validate-mode only: concise support/refutation note for this reference.",
              ),
            accuracy: z
              .enum(["high", "medium", "low", "conflicting", "insufficient"])
              .optional()
              .describe("Validate-mode only: evidence accuracy grade."),
            sourceAuthority: z
              .enum(["high", "medium", "low", "unknown"])
              .optional()
              .describe(
                "Validate-mode only: source-authority grade for this reference.",
              ),
            issueReason: z
              .string()
              .optional()
              .describe(
                "Validate-mode only: why the checked claim/answer is wrong or risky based on this reference.",
              ),
            correctFact: z
              .string()
              .optional()
              .describe(
                "Validate-mode only: corrected fact/state from this reference.",
              ),
          }).describe("Resolved citation reference entry."),
        ).describe("All numbered references that can be cited as [n]."),
        searchId: z.string().describe("Unique identifier of this deep-search run."),
        projectId: z
          .string()
          .optional()
          .describe("Optional project identifier when search is project-scoped."),
        prompt: z
          .string()
          .optional()
          .describe("Optional synthesis prompt (empty when synthesis is disabled)."),
      }).describe("Structured deep-search result returned to the caller."),
      execute: async ({ query }, options) => {
        if (config.deepSearchExecutionMode === "disabled") {
          return {
            conclusion: undefined,
            answer: undefined,
            references: [],
            searchId: `disabled-${Date.now()}`,
            projectId: undefined,
            prompt: "",
          };
        }
        const searchModel = config.searchModel ?? config.model;
        const extractModel = config.extractModel ?? config.searchModel ?? config.model;
        if (!searchModel) {
          throw new Error("DeepSearch tool is not configured with a model.");
        }
        const result = await runDeepSearchTool({
          query,
          searchModel,
          extractModel,
          writer,
          toolCallId: options.toolCallId,
          toolName: "deepSearch",
          abortSignal: options.abortSignal,
          tavilyApiKey: config.tavilyApiKey,
          jinaReaderBaseUrl: config.jinaReaderBaseUrl,
          jinaReaderApiKey: config.jinaReaderApiKey,
          deepResearchStore: config.deepResearchStore,
          deepResearchConfig: config.deepResearchConfig,
          externalSkills: config.externalSkills,
          mode: "search",
        });
        return {
          conclusion: result.conclusion,
          answer: result.conclusion,
          references: result.references,
          searchId: result.searchId,
          projectId: result.projectId,
          prompt: result.prompt,
        };
      },
    }),
  };
}
