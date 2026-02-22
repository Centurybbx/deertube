export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ReferenceAccuracy =
  | "high"
  | "medium"
  | "low"
  | "conflicting"
  | "insufficient";
export type ReferenceSourceAuthority = "high" | "medium" | "low" | "unknown";

export type BrowserValidationStatus = "running" | "complete" | "failed";
export type BrowserValidationFailureReason = "failed" | "stopped";
export type CdpValidationStatus = "idle" | "running" | "complete" | "failed";

export interface BrowserPageValidationStatusRecord {
  status: BrowserValidationStatus;
  error?: string;
  failureReason?: BrowserValidationFailureReason;
  updatedAt: string;
}

export interface CdpBrowserValidateRequestPayload {
  sessionId: string;
  url: string;
  title?: string;
}

export interface CdpBrowserValidateStopRequestPayload {
  sessionId: string;
}

export interface BrowserValidationClaimSupport {
  viewpoint: string;
  referenceTitle?: string;
  referenceUrl: string;
  referenceUri?: string;
  referenceRefId?: number;
  text: string;
  startLine: number;
  endLine: number;
  accuracy?: ReferenceAccuracy;
  sourceAuthority?: ReferenceSourceAuthority;
  validationRefContent?: string;
  issueReason?: string;
  correctFact?: string;
}

export interface BrowserValidationClaimOrigin {
  type: "chat" | "browserview";
  url?: string;
  responseId?: string;
}

export interface BrowserValidationClaim {
  claimId: string;
  originalText: string;
  summary: string;
  origin: BrowserValidationClaimOrigin;
  accuracy?: ReferenceAccuracy;
  sourceAuthority?: ReferenceSourceAuthority;
  issueReason?: string;
  correctFact?: string;
  supports: BrowserValidationClaimSupport[];
}

export interface BrowserPageValidationRecord {
  url: string;
  title?: string;
  query: string;
  checkedAt: string;
  text: string;
  startLine: number;
  endLine: number;
  referenceTitle?: string;
  referenceUrl?: string;
  referenceUri?: string;
  referenceRefId?: number;
  accuracy?: ReferenceAccuracy;
  sourceAuthority?: ReferenceSourceAuthority;
  validationRefContent?: string;
  issueReason?: string;
  correctFact?: string;
  claims?: BrowserValidationClaim[];
  claimSupports?: BrowserValidationClaimSupport[];
  sourceCount: number;
  referenceCount: number;
}

export interface BrowserViewTabState {
  id: string;
  url: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  referenceHighlight?: BrowserViewReferenceHighlight;
  validationStatus?: BrowserValidationStatus;
  validationError?: string;
  validationFailureReason?: BrowserValidationFailureReason;
}

export interface BrowserViewSelection {
  tabId?: string;
  text: string;
  url: string;
  title?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  viewBounds?: BrowserViewBounds | null;
}

export interface BrowserViewStatePayload {
  tabId: string;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
}

export interface BrowserViewReferenceHighlight {
  refId: number;
  text: string;
  alternateTexts?: string[];
  append?: boolean;
  showMarker?: boolean;
  startLine?: number;
  endLine?: number;
  uri?: string;
  url?: string;
  title?: string;
  validationRefContent?: string;
  accuracy?: ReferenceAccuracy;
  sourceAuthority?: ReferenceSourceAuthority;
  issueReason?: string;
  correctFact?: string;
}
