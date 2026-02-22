import type { DeepSearchReferencePayload } from "@/types/chat";
import type {
  BrowserValidationClaim,
  BrowserValidationClaimSupport,
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

const normalizeClaimViewpoint = (
  reference: DeepSearchReferencePayload,
): string | undefined => {
  const normalizedViewpoint = reference.viewpoint?.replace(/\s+/g, " ").trim();
  if (normalizedViewpoint && normalizedViewpoint.length > 0) {
    return normalizedViewpoint;
  }
  const normalizedTitle = reference.title?.replace(/\s+/g, " ").trim();
  if (normalizedTitle && normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  const excerpt = stripLineNumberPrefix(reference.text).replace(/\s+/g, " ").trim();
  if (!excerpt) {
    return undefined;
  }
  return excerpt.length > 240 ? `${excerpt.slice(0, 237)}...` : excerpt;
};

const normalizeClaimText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const normalizeClaimHints = (claims: string[] | undefined): string[] => {
  if (!Array.isArray(claims)) {
    return [];
  }
  const dedupe = new Set<string>();
  claims.forEach((claim) => {
    const normalized = normalizeClaimText(claim);
    if (normalized.length === 0) {
      return;
    }
    dedupe.add(normalized);
  });
  return Array.from(dedupe.values());
};

const toClaimComparable = (value: string): string =>
  normalizeClaimText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");

const tokenizeClaimComparable = (value: string): string[] => {
  const normalized = toClaimComparable(value);
  const latinTokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  const cjkTokens = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return Array.from(new Set([...latinTokens, ...cjkTokens]));
};

const scoreClaimMatch = (left: string, right: string): number => {
  const leftComparable = toClaimComparable(left).replace(/\s+/g, " ").trim();
  const rightComparable = toClaimComparable(right).replace(/\s+/g, " ").trim();
  if (!leftComparable || !rightComparable) {
    return 0;
  }
  if (leftComparable === rightComparable) {
    return 1;
  }
  let score = 0;
  if (
    leftComparable.includes(rightComparable) ||
    rightComparable.includes(leftComparable)
  ) {
    score += 0.58;
  }
  const leftTokens = tokenizeClaimComparable(leftComparable);
  const rightTokens = tokenizeClaimComparable(rightComparable);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return Math.min(1, score);
  }
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  const overlapRatio = overlap / Math.max(leftTokens.length, rightTokens.length);
  score += overlapRatio * 0.5;
  return Math.min(1, score);
};

const toValidationClaimSupport = ({
  reference,
  viewpoint,
}: {
  reference: DeepSearchReferencePayload;
  viewpoint: string;
}): BrowserValidationClaimSupport | null => {
  const referenceUrl = reference.url?.trim();
  if (!referenceUrl) {
    return null;
  }
  const text = stripLineNumberPrefix(
    reference.text?.trim() ?? reference.validationRefContent ?? "",
  ).trim();
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
  const referenceRefId =
    Number.isFinite(reference.refId) && reference.refId > 0
      ? Math.floor(reference.refId)
      : undefined;
  return {
    viewpoint,
    referenceTitle: reference.title?.trim(),
    referenceUrl,
    referenceUri: reference.uri?.trim(),
    referenceRefId,
    text,
    startLine,
    endLine,
    accuracy: reference.accuracy,
    sourceAuthority: reference.sourceAuthority,
    validationRefContent: reference.validationRefContent,
    issueReason: reference.issueReason,
    correctFact: reference.correctFact,
  };
};

interface ValidationClaimBucket {
  originalText: string;
  summary: string;
  supports: BrowserValidationClaimSupport[];
}

const findBestClaimBucketIndex = ({
  buckets,
  candidateText,
}: {
  buckets: ValidationClaimBucket[];
  candidateText: string;
}): number => {
  if (buckets.length === 0) {
    return -1;
  }
  let selectedIndex = -1;
  let selectedScore = 0;
  buckets.forEach((bucket, index) => {
    const score = Math.max(
      scoreClaimMatch(candidateText, bucket.originalText),
      scoreClaimMatch(candidateText, bucket.summary),
    );
    if (score > selectedScore) {
      selectedScore = score;
      selectedIndex = index;
    }
  });
  return selectedScore >= 0.36 ? selectedIndex : -1;
};

const aggregateClaimSupportAccuracy = (
  supports: BrowserValidationClaimSupport[],
): BrowserPageValidationRecord["accuracy"] => {
  let selected: BrowserPageValidationRecord["accuracy"] | undefined;
  let selectedScore = 0;
  supports.forEach((support) => {
    const candidate = support.accuracy;
    const candidateScore = getValidationAccuracyPriority(candidate);
    if (candidateScore > selectedScore) {
      selected = candidate;
      selectedScore = candidateScore;
    }
  });
  return selected;
};

const aggregateClaimSupportSourceAuthority = (
  supports: BrowserValidationClaimSupport[],
): BrowserPageValidationRecord["sourceAuthority"] => {
  let selected: BrowserPageValidationRecord["sourceAuthority"] | undefined;
  let selectedScore = 0;
  supports.forEach((support) => {
    const candidate = support.sourceAuthority;
    const candidateScore = getValidationSourceAuthorityPriority(candidate);
    if (candidateScore > selectedScore) {
      selected = candidate;
      selectedScore = candidateScore;
    }
  });
  return selected;
};

const pickClaimIssueReason = (
  supports: BrowserValidationClaimSupport[],
): string | undefined => {
  const sorted = [...supports].sort(
    (left, right) =>
      getValidationAccuracyPriority(right.accuracy) -
      getValidationAccuracyPriority(left.accuracy),
  );
  return sorted.find((support) => support.issueReason)?.issueReason;
};

const pickClaimCorrectFact = (
  supports: BrowserValidationClaimSupport[],
): string | undefined => {
  const sorted = [...supports].sort(
    (left, right) =>
      getValidationAccuracyPriority(right.accuracy) -
      getValidationAccuracyPriority(left.accuracy),
  );
  return sorted.find((support) => support.correctFact)?.correctFact;
};

const buildValidationClaims = ({
  references,
  claimHints,
  originUrl,
}: {
  references: DeepSearchReferencePayload[],
  claimHints: string[];
  originUrl: string;
}): BrowserValidationClaim[] => {
  const buckets: ValidationClaimBucket[] = claimHints.map((claim) => ({
    originalText: claim,
    summary: claim,
    supports: [],
  }));
  references.forEach((reference) => {
    const normalizedViewpoint = normalizeClaimViewpoint(reference);
    if (!normalizedViewpoint) {
      return;
    }
    const candidateClaimText = normalizeClaimText(normalizedViewpoint);
    const supportCandidate = toValidationClaimSupport({
      reference,
      viewpoint: candidateClaimText,
    });
    if (!supportCandidate) {
      return;
    }
    const bucketIndex = findBestClaimBucketIndex({
      buckets,
      candidateText: candidateClaimText,
    });
    const targetBucket =
      bucketIndex >= 0
        ? buckets[bucketIndex]
        : (() => {
            const created: ValidationClaimBucket = {
              originalText: candidateClaimText,
              summary: candidateClaimText,
              supports: [],
            };
            buckets.push(created);
            return created;
          })();
    if (
      targetBucket.summary === targetBucket.originalText &&
      candidateClaimText !== targetBucket.originalText
    ) {
      targetBucket.summary = candidateClaimText;
    }
    targetBucket.supports.push({
      ...supportCandidate,
      viewpoint: targetBucket.summary,
    });
  });
  return buckets
    .filter((bucket) => bucket.supports.length > 0)
    .map((bucket, index) => {
      const originalText = normalizeClaimText(bucket.originalText);
      const summary = normalizeClaimText(bucket.summary) || originalText;
      return {
        claimId: `claim-${index + 1}`,
        originalText,
        summary,
        origin: {
          type: "browserview",
          url: originUrl,
        },
        accuracy: aggregateClaimSupportAccuracy(bucket.supports),
        sourceAuthority: aggregateClaimSupportSourceAuthority(bucket.supports),
        issueReason: pickClaimIssueReason(bucket.supports),
        correctFact: pickClaimCorrectFact(bucket.supports),
        supports: bucket.supports,
      };
    });
};

const buildFallbackClaimsFromHints = ({
  claimHints,
  originUrl,
}: {
  claimHints: string[];
  originUrl: string;
}): BrowserValidationClaim[] =>
  claimHints.map((claim, index) => ({
    claimId: `claim-${index + 1}`,
    originalText: claim,
    summary: claim,
    origin: {
      type: "browserview",
      url: originUrl,
    },
    accuracy: "insufficient",
    sourceAuthority: "unknown",
    supports: [],
  }));

const flattenValidationClaimSupports = (
  claims: BrowserValidationClaim[],
): BrowserValidationClaimSupport[] => {
  const supports: BrowserValidationClaimSupport[] = [];
  claims.forEach((claim) => {
    claim.supports.forEach((support) => {
      supports.push({
        ...support,
        viewpoint: claim.summary,
      });
    });
  });
  return supports;
};

const pickRecordIssueReason = (
  claims: BrowserValidationClaim[],
): string | undefined =>
  claims.find((claim) => claim.issueReason)?.issueReason;

const pickRecordCorrectFact = (
  claims: BrowserValidationClaim[],
): string | undefined =>
  claims.find((claim) => claim.correctFact)?.correctFact;

const pickRecordValidationRefContent = (
  claims: BrowserValidationClaim[],
): string | undefined => {
  for (const claim of claims) {
    const supportWithNote = claim.supports.find(
      (support) =>
        typeof support.validationRefContent === "string" &&
        support.validationRefContent.trim().length > 0,
    );
    if (supportWithNote?.validationRefContent) {
      return supportWithNote.validationRefContent;
    }
  }
  return undefined;
};

const aggregateValidationAccuracy = (
  references: DeepSearchReferencePayload[],
): BrowserPageValidationRecord["accuracy"] => {
  let selected: BrowserPageValidationRecord["accuracy"] | undefined;
  let selectedScore = 0;
  references.forEach((reference) => {
    const candidate = reference.accuracy;
    const candidateScore = getValidationAccuracyPriority(candidate);
    if (candidateScore > selectedScore) {
      selected = candidate;
      selectedScore = candidateScore;
    }
  });
  return selected;
};

const aggregateValidationSourceAuthority = (
  references: DeepSearchReferencePayload[],
): BrowserPageValidationRecord["sourceAuthority"] => {
  let selected: BrowserPageValidationRecord["sourceAuthority"] | undefined;
  let selectedScore = 0;
  references.forEach((reference) => {
    const candidate = reference.sourceAuthority;
    const candidateScore = getValidationSourceAuthorityPriority(candidate);
    if (candidateScore > selectedScore) {
      selected = candidate;
      selectedScore = candidateScore;
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
  claims,
}: {
  url: string;
  title?: string;
  query: string;
  references: DeepSearchReferencePayload[];
  sourceCount: number;
  claims?: string[];
}): BrowserPageValidationRecord => {
  const checkedAt = new Date().toISOString();
  const claimHints = normalizeClaimHints(claims);
  const validationClaims =
    references.length > 0
      ? buildValidationClaims({
          references,
          claimHints,
          originUrl: url,
        })
      : buildFallbackClaimsFromHints({
          claimHints,
          originUrl: url,
        });
  const claimSupports = flattenValidationClaimSupports(validationClaims);
  if (references.length === 0) {
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
      claims: validationClaims.length > 0 ? validationClaims : undefined,
      claimSupports: claimSupports.length > 0 ? claimSupports : undefined,
      sourceCount,
      referenceCount: 0,
    };
  }

  const text =
    validationClaims.length > 0
      ? "Validated claims and references are available. Select a claim to highlight the original statement."
      : "Validated references were returned, but no claim records could be derived for this page.";

  return {
    url,
    title,
    query,
    checkedAt,
    text,
    startLine: 1,
    endLine: 1,
    accuracy: aggregateValidationAccuracy(references),
    sourceAuthority: aggregateValidationSourceAuthority(references),
    validationRefContent: pickRecordValidationRefContent(validationClaims),
    issueReason: pickRecordIssueReason(validationClaims),
    correctFact: pickRecordCorrectFact(validationClaims),
    claims: validationClaims.length > 0 ? validationClaims : undefined,
    claimSupports: claimSupports.length > 0 ? claimSupports : undefined,
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
