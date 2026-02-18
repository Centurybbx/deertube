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
  uri: reference.uri,
  url: reference.url,
  title: reference.title,
  validationRefContent: reference.validationRefContent,
  accuracy: reference.accuracy,
  sourceAuthority: reference.sourceAuthority,
  issueReason: reference.issueReason,
  correctFact: reference.correctFact,
});

export const toReferenceHighlightFromDeepSearchReference = (
  reference: DeepSearchReferencePayload,
): BrowserViewReferenceHighlight | null => {
  const text = stripLineNumberPrefix(reference.text).trim();
  if (!text) {
    return null;
  }
  const startLine =
    Number.isFinite(reference.startLine) && reference.startLine > 0
      ? Math.floor(reference.startLine)
      : 1;
  const normalizedEndLine =
    Number.isFinite(reference.endLine) && reference.endLine > 0
      ? Math.floor(reference.endLine)
      : startLine;
  const endLine =
    normalizedEndLine >= startLine ? normalizedEndLine : startLine;
  return {
    refId:
      Number.isFinite(reference.refId) && reference.refId > 0
        ? Math.floor(reference.refId)
        : 1,
    text,
    startLine,
    endLine,
    uri: reference.uri,
    url: reference.url,
    title: reference.title,
    validationRefContent: reference.validationRefContent,
    accuracy: reference.accuracy,
    sourceAuthority: reference.sourceAuthority,
    issueReason: reference.issueReason,
    correctFact: reference.correctFact,
  };
};

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

const getValidationSourceAuthorityPriority = (
  sourceAuthority: BrowserPageValidationRecord["sourceAuthority"],
): number => {
  if (sourceAuthority === "high") {
    return 4;
  }
  if (sourceAuthority === "medium") {
    return 3;
  }
  if (sourceAuthority === "low") {
    return 2;
  }
  if (sourceAuthority === "unknown") {
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
    const selectedAuthorityScore = getValidationSourceAuthorityPriority(
      selected.sourceAuthority,
    );
    const candidateAuthorityScore = getValidationSourceAuthorityPriority(
      candidate.sourceAuthority,
    );
    if (candidateAuthorityScore > selectedAuthorityScore) {
      selected = candidate;
      return;
    }
    if (candidateAuthorityScore < selectedAuthorityScore) {
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
      sourceAuthority: "unknown",
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
    referenceUri: selected.uri,
    referenceRefId:
      typeof selected.refId === "number" && selected.refId > 0
        ? selected.refId
        : undefined,
    accuracy: selected.accuracy,
    sourceAuthority: selected.sourceAuthority,
    validationRefContent: selected.validationRefContent,
    issueReason: selected.issueReason,
    correctFact: selected.correctFact,
    sourceCount,
    referenceCount: references.length,
  };
};

export const toValidationHighlightPayload = (
  validation: BrowserPageValidationRecord,
): BrowserViewReferenceHighlight | null => {
  const text = validation.text.trim();
  if (!text) {
    return null;
  }
  return {
    refId:
      typeof validation.referenceRefId === "number" && validation.referenceRefId > 0
        ? validation.referenceRefId
        : 1,
    text,
    startLine: validation.startLine,
    endLine: validation.endLine,
    uri: validation.referenceUri,
    url: validation.referenceUrl ?? validation.url,
    title: validation.referenceTitle ?? validation.title,
    validationRefContent: validation.validationRefContent,
    accuracy: validation.accuracy,
    sourceAuthority: validation.sourceAuthority,
    issueReason: validation.issueReason,
    correctFact: validation.correctFact,
  };
};
