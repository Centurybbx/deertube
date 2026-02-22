import type { RuntimeSettingsPayload } from "@/lib/settings";
import type {
  DeepSearchReferencePayload,
  DeepSearchSourcePayload,
} from "@/types/chat";
import type {
  BrowserValidationFailureReason,
  BrowserPageValidationRecord,
  BrowserValidationStatus,
  BrowserViewTabState,
} from "@/types/browserview";
import type { DeepResearchConfig } from "@/shared/deepresearch-config";
import {
  buildBrowserValidationRecord,
  normalizeHttpUrl,
} from "./browser-utils";

interface ValidationSnapshot {
  text: string;
  url: string;
  title?: string;
}

interface CaptureValidationSnapshotResult {
  snapshot?: ValidationSnapshot | null;
}

interface ChatValidateResult {
  status: "complete" | "failed" | "skipped";
  query?: string;
  skipReason?: "disabled-by-config" | "no-fact-checkable-claims";
  searchId?: string;
  projectId?: string;
  claims?: string[];
  references?: DeepSearchReferencePayload[];
  sources?: DeepSearchSourcePayload[];
}

interface ExecuteBrowserValidationOptions {
  tab: BrowserViewTabState;
  normalizedTabUrl: string;
  projectPath: string;
  runtimeSettings: RuntimeSettingsPayload | undefined;
  deepResearchConfig: DeepResearchConfig;
  captureValidationSnapshot: () => Promise<CaptureValidationSnapshotResult>;
  validateAnswer: (input: {
    projectPath: string;
    query: string;
    answer: string;
    force?: boolean;
    validationTarget?: {
      url?: string;
      title?: string;
    };
    settings: RuntimeSettingsPayload | undefined;
    deepResearch: DeepResearchConfig;
  }, signal?: AbortSignal) => Promise<ChatValidateResult>;
  signal?: AbortSignal;
}

interface BrowserValidationResult {
  resolvedPageUrl: string;
  record: BrowserPageValidationRecord;
  query: string;
  searchId?: string;
  projectId?: string;
  references: DeepSearchReferencePayload[];
  sources: DeepSearchSourcePayload[];
}

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const resolveValidationQuery = ({
  pageText,
  snapshotTitle,
  tabTitle,
  resolvedPageUrl,
}: {
  pageText: string;
  snapshotTitle: string | undefined;
  tabTitle: string | undefined;
  resolvedPageUrl: string;
}): string => {
  const normalizedPageText = pageText.replace(/\s+/g, " ").trim();
  if (normalizedPageText.length > 0) {
    return normalizedPageText.length > 320
      ? normalizedPageText.slice(0, 320)
      : normalizedPageText;
  }
  const querySeed = snapshotTitle ?? tabTitle ?? resolvedPageUrl;
  return querySeed.length > 320 ? querySeed.slice(0, 320) : querySeed;
};

export const updateBrowserTabValidationState = ({
  tabs,
  tabId,
  status,
  error,
  failureReason,
}: {
  tabs: BrowserViewTabState[];
  tabId: string;
  status: BrowserValidationStatus;
  error?: string;
  failureReason?: BrowserValidationFailureReason;
}): BrowserViewTabState[] =>
  tabs.map((item) =>
    item.id === tabId
      ? {
          ...item,
          validationStatus: status,
          validationError: error,
          validationFailureReason:
            status === "failed" ? failureReason ?? "failed" : undefined,
        }
      : item,
  );

export const executeBrowserValidation = async ({
  tab,
  normalizedTabUrl,
  projectPath,
  runtimeSettings,
  deepResearchConfig,
  captureValidationSnapshot,
  validateAnswer,
  signal,
}: ExecuteBrowserValidationOptions): Promise<BrowserValidationResult> => {
  const snapshotResult = await captureValidationSnapshot();
  const snapshot = snapshotResult.snapshot;
  if (!snapshot) {
    throw new Error("Unable to capture page content for validation.");
  }

  const pageText = snapshot.text.trim();
  if (!pageText) {
    throw new Error("No page text available for validation.");
  }

  const resolvedPageUrl = normalizeHttpUrl(snapshot.url) ?? normalizedTabUrl;
  const snapshotTitle = trimOrUndefined(snapshot.title);
  const tabTitle = trimOrUndefined(tab.title);
  const query = resolveValidationQuery({
    pageText,
    snapshotTitle,
    tabTitle,
    resolvedPageUrl,
  });

  const validateResult = await validateAnswer({
    projectPath,
    query,
    answer: pageText,
    force: true,
    validationTarget: {
      url: resolvedPageUrl,
      title: snapshotTitle ?? tabTitle,
    },
    settings: runtimeSettings,
    deepResearch: deepResearchConfig,
  }, signal);
  if (validateResult.status === "failed") {
    throw new Error("Validation failed.");
  }

  const references = Array.isArray(validateResult.references)
    ? validateResult.references
    : [];
  const sources = Array.isArray(validateResult.sources)
    ? validateResult.sources
    : [];

  return {
    resolvedPageUrl,
    record: buildBrowserValidationRecord({
      url: resolvedPageUrl,
      title: snapshotTitle ?? tabTitle,
      query: validateResult.query ?? query,
      references,
      sourceCount: sources.length,
      claims: validateResult.claims,
    }),
    query: validateResult.query ?? query,
    searchId: validateResult.searchId,
    projectId: validateResult.projectId,
    references,
    sources,
  };
};
