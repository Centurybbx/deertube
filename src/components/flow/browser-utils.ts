import type { DeepSearchReferencePayload } from "@/types/chat";
import type {
  BrowserPageValidationRecord,
  BrowserViewReferenceHighlight,
} from "@/types/browserview";
import type { DeepResearchResolvedReference } from "@/shared/deepresearch";

export const normalizeHttpUrl = (value: string): string | null => {
  if (!URL.canParse(value)) {
    return null;
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed.toString();
};

export const isHttpUrl = (value: string): boolean =>
  normalizeHttpUrl(value) !== null;

export const stripLineNumberPrefix = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\d+\s+\|\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join("\n")
    .trim();

export const normalizeBrowserLabel = (label?: string): string | undefined => {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export const truncateLabel = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return ".".repeat(Math.max(0, maxLength));
  }
  return `${value.slice(0, maxLength - 3)}...`;
};

export const toReferenceHighlightPayload = (
  reference: DeepResearchResolvedReference,
): BrowserViewReferenceHighlight => ({
  refId: reference.refId,
  text: reference.text,
  startLine: reference.startLine,
  endLine: reference.endLine,
});

const getValidationAccuracyPriority = (
  accuracy: BrowserPageValidationRecord["accuracy"],
): number => {
  if (accuracy === "conflicting") {
    return 5;
  }
  if (accuracy === "low") {
    return 4;
  }
  if (accuracy === "insufficient") {
    return 3;
  }
  if (accuracy === "medium") {
    return 2;
  }
  if (accuracy === "high") {
    return 1;
  }
  return 0;
};

const pickPrimaryValidationReference = (
  references: DeepSearchReferencePayload[],
): DeepSearchReferencePayload | null => {
  if (references.length === 0) {
    return null;
  }
  let selected: DeepSearchReferencePayload = references[0];
  let selectedScore = getValidationAccuracyPriority(selected.accuracy);
  references.slice(1).forEach((candidate) => {
    const candidateScore = getValidationAccuracyPriority(candidate.accuracy);
    if (candidateScore > selectedScore) {
      selected = candidate;
      selectedScore = candidateScore;
      return;
    }
    if (candidateScore !== selectedScore) {
      return;
    }
    if (candidate.validationRefContent && !selected.validationRefContent) {
      selected = candidate;
      return;
    }
    if (candidate.issueReason && !selected.issueReason) {
      selected = candidate;
    }
  });
  return selected;
};

export const buildBrowserValidationRecord = ({
  url,
  title,
  query,
  references,
  sourceCount,
}: {
  url: string;
  title?: string;
  query: string;
  references: DeepSearchReferencePayload[];
  sourceCount: number;
}): BrowserPageValidationRecord => {
  const checkedAt = new Date().toISOString();
  const selected = pickPrimaryValidationReference(references);
  if (!selected) {
    return {
      url,
      title,
      query,
      checkedAt,
      text: "No validated reference returned for this page.",
      startLine: 1,
      endLine: 1,
      accuracy: "insufficient",
      sourceCount,
      referenceCount: 0,
    };
  }

  const startLine = selected.startLine > 0 ? selected.startLine : 1;
  const endLine = selected.endLine >= startLine ? selected.endLine : startLine;
  const text = stripLineNumberPrefix(selected.text).trim();

  return {
    url,
    title,
    query,
    checkedAt,
    text: text.length > 0 ? text : "No validated reference excerpt available.",
    startLine,
    endLine,
    referenceTitle: selected.title,
    referenceUrl: selected.url,
    accuracy: selected.accuracy,
    validationRefContent: selected.validationRefContent,
    issueReason: selected.issueReason,
    correctFact: selected.correctFact,
    sourceCount,
    referenceCount: references.length,
  };
};
