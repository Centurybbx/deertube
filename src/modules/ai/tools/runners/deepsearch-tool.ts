import { type LanguageModel, type UIMessageStreamWriter } from "ai";
import type {
  DeepResearchPersistenceAdapter,
  DeepResearchReferenceRecord,
} from "../../../../shared/deepresearch";
import type { DeepResearchConfig } from "../../../../shared/deepresearch-config";
import type { RuntimeAgentSkill } from "../../../../shared/agent-skills";
import {
  buildDeepSearchReferences,
  buildDeepSearchSources,
  writeDeepSearchStream,
} from "../helpers";
import type {
  DeepSearchReference,
  DeepSearchSource,
  DeepSearchStreamPayload,
  SubagentStreamPayload,
} from "../types";
import { runSearchSubagent } from "./search-subagent";

export async function runDeepSearchTool({
  query,
  searchModel,
  extractModel,
  writer,
  toolCallId,
  toolName,
  abortSignal,
  tavilyApiKey,
  jinaReaderBaseUrl,
  jinaReaderApiKey,
  deepResearchStore,
  deepResearchConfig,
  externalSkills,
  mode = "search",
  validateTargetAnswer = "",
  onSubagentStream,
  onDeepSearchStream,
}: {
  query: string;
  searchModel: LanguageModel;
  extractModel?: LanguageModel;
  writer?: UIMessageStreamWriter;
  toolCallId?: string;
  toolName?: string;
  abortSignal?: AbortSignal;
  tavilyApiKey?: string;
  jinaReaderBaseUrl?: string;
  jinaReaderApiKey?: string;
  deepResearchStore?: DeepResearchPersistenceAdapter;
  deepResearchConfig?: DeepResearchConfig;
  externalSkills?: RuntimeAgentSkill[];
  mode?: "search" | "validate";
  validateTargetAnswer?: string;
  onSubagentStream?: (payload: SubagentStreamPayload) => void;
  onDeepSearchStream?: (
    payload: DeepSearchStreamPayload,
    done: boolean,
  ) => void;
}): Promise<{
  conclusion?: string;
  sources: DeepSearchSource[];
  references: DeepSearchReference[];
  searchId: string;
  projectId?: string;
  prompt?: string;
}> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    const message = "Query is empty after trimming.";
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        query: normalizedQuery,
        status: "failed",
        error: message,
        complete: true,
      },
      true,
      onDeepSearchStream,
    );
    throw new Error(message);
  }
  const fallbackCreatedAt = new Date().toISOString();
  const searchSession = deepResearchStore
    ? await deepResearchStore.createSearchSession(normalizedQuery)
    : { searchId: `local-${Date.now()}`, createdAt: fallbackCreatedAt };
  const searchId = searchSession.searchId;
  const searchCreatedAt = searchSession.createdAt ?? fallbackCreatedAt;
  const projectId = deepResearchStore?.projectId;
  writeDeepSearchStream(
    writer,
    toolCallId,
    toolName,
    {
      mode,
      query: normalizedQuery,
      projectId,
      searchId,
      status: "running",
    },
    false,
    onDeepSearchStream,
  );

  try {
    const subagentConfig =
      mode === "validate"
        ? deepResearchConfig?.validate.subagent
        : deepResearchConfig?.subagent;
    const strictness =
      mode === "validate"
        ? deepResearchConfig?.validate.strictness
        : deepResearchConfig?.strictness;
    const results = await runSearchSubagent({
      query: normalizedQuery,
      searchId,
      model: searchModel,
      extractModel,
      writer,
      toolCallId,
      toolName: "search",
      abortSignal,
      tavilyApiKey,
      jinaReaderBaseUrl,
      jinaReaderApiKey,
      deepResearchStore,
      subagentConfig,
      skillProfile: deepResearchConfig?.skillProfile,
      selectedSkillNames: deepResearchConfig?.selectedSkillNames,
      externalSkills,
      fullPromptOverrideEnabled:
        deepResearchConfig?.fullPromptOverrideEnabled ?? false,
      strictness,
      mode,
      answerToValidate: validateTargetAnswer,
      onSubagentStream,
    });
    const references = buildDeepSearchReferences(results, projectId, searchId, {
      includeValidationFields: mode === "validate",
    });
    const sources = buildDeepSearchSources(results, references);
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        mode,
        query: normalizedQuery,
        projectId,
        searchId,
        sources,
        references,
        status: "running",
      },
      false,
      onDeepSearchStream,
    );

    const sourceErrors = Array.from(
      new Set(
        results
          .map((item) =>
            typeof item.error === "string" ? item.error.trim() : "",
          )
          .filter((error) => error.length > 0),
      ),
    );
    const noReferenceError =
      references.length === 0 && sourceErrors.length > 0
        ? sourceErrors.join("\n")
        : undefined;
    const prompt = "";
    const finalConclusionRaw = "";
    const finalConclusionLinked = "";
    if (deepResearchStore) {
      const persistedReferences: DeepResearchReferenceRecord[] = references.map(
        (reference) => ({
          refId: reference.refId,
          uri: reference.uri,
          pageId: reference.pageId,
          url: reference.url,
          title: reference.title,
          viewpoint: reference.viewpoint,
          startLine: reference.startLine,
          endLine: reference.endLine,
          text: reference.text,
          validationRefContent: reference.validationRefContent,
          accuracy: reference.accuracy,
          issueReason: reference.issueReason,
          correctFact: reference.correctFact,
        }),
      );
      await deepResearchStore.finalizeSearch({
        searchId,
        query: normalizedQuery,
        llmPrompt: prompt,
        llmConclusionRaw: finalConclusionRaw,
        llmConclusionLinked: finalConclusionLinked,
        references: persistedReferences,
        createdAt: searchCreatedAt,
        completedAt: new Date().toISOString(),
      });
    }
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        mode,
        query: normalizedQuery,
        projectId,
        searchId,
        sources,
        references,
        error: noReferenceError,
        status: "complete",
        complete: true,
      },
      true,
      onDeepSearchStream,
    );

    return {
      sources,
      references,
      searchId,
      projectId,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Deep search failed.";
    writeDeepSearchStream(
      writer,
      toolCallId,
      toolName,
      {
        mode,
        query: normalizedQuery,
        projectId,
        searchId,
        status: "failed",
        error: message,
        complete: true,
      },
      true,
      onDeepSearchStream,
    );
    throw error instanceof Error ? error : new Error(message);
  }
}
