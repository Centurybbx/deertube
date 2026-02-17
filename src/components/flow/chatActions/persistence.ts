import {
  resolveDeepResearchConfig,
  type DeepResearchConfig,
  type DeepResearchConfigInput,
} from "@/shared/deepresearch-config";

const DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY =
  "deertube:deepResearchConfigByProject";
const GRAPH_AUTOGEN_BY_PROJECT_KEY = "deertube:graphAutoGenByProject";

const readLocalStorageJson = <T,>(key: string, fallback: T): T => {
  if (typeof window === "undefined" || !window.localStorage) {
    return fallback;
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw) as T;
};

export const loadDeepResearchConfig = (projectPath: string): DeepResearchConfig => {
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY,
    {},
  );
  return resolveDeepResearchConfig(
    (mapping[projectPath] as DeepResearchConfigInput | null | undefined) ??
      undefined,
  );
};

export const saveDeepResearchConfig = (
  projectPath: string,
  config: DeepResearchConfig,
) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY,
    {},
  );
  mapping[projectPath] = config;
  window.localStorage.setItem(
    DEEP_RESEARCH_CONFIG_BY_PROJECT_KEY,
    JSON.stringify(mapping),
  );
};

export const loadGraphAutoGenerationEnabled = (projectPath: string): boolean => {
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    GRAPH_AUTOGEN_BY_PROJECT_KEY,
    {},
  );
  const value = mapping[projectPath];
  return typeof value === "boolean" ? value : true;
};

export const saveGraphAutoGenerationEnabled = (
  projectPath: string,
  enabled: boolean,
) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  const mapping = readLocalStorageJson<Record<string, unknown>>(
    GRAPH_AUTOGEN_BY_PROJECT_KEY,
    {},
  );
  mapping[projectPath] = enabled;
  window.localStorage.setItem(
    GRAPH_AUTOGEN_BY_PROJECT_KEY,
    JSON.stringify(mapping),
  );
};
