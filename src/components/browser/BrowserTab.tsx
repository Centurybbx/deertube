import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  List,
  Loader2,
  MessageSquare,
  RotateCw,
  Square,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  BrowserValidationFailureReason,
  BrowserPageValidationRecord,
  BrowserValidationStatus,
  BrowserViewBounds,
  BrowserViewReferenceHighlight,
} from "@/types/browserview";
import { cn } from "@/lib/utils";
import type {
  DeepResearchStrictness,
  SubagentSearchComplexity,
  TavilySearchDepth,
} from "@/shared/deepresearch-config";

const formatAccuracyLabel = (
  accuracy: BrowserPageValidationRecord["accuracy"],
): string | null => {
  if (!accuracy) {
    return null;
  }
  if (accuracy === "high") {
    return "High";
  }
  if (accuracy === "medium") {
    return "Medium";
  }
  if (accuracy === "low") {
    return "Low";
  }
  if (accuracy === "conflicting") {
    return "Conflicting";
  }
  return "Insufficient";
};

const getAccuracyTextClass = (
  accuracy: BrowserPageValidationRecord["accuracy"],
): string => {
  if (accuracy === "high") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (accuracy === "medium") {
    return "text-amber-700 dark:text-amber-300";
  }
  if (accuracy === "low") {
    return "text-orange-700 dark:text-orange-300";
  }
  if (accuracy === "conflicting") {
    return "text-red-700 dark:text-red-300";
  }
  if (accuracy === "insufficient") {
    return "text-slate-700 dark:text-slate-300";
  }
  return "text-muted-foreground";
};

const formatSourceAuthorityLabel = (
  sourceAuthority: BrowserPageValidationRecord["sourceAuthority"],
): string | null => {
  if (!sourceAuthority) {
    return null;
  }
  if (sourceAuthority === "high") {
    return "High";
  }
  if (sourceAuthority === "medium") {
    return "Medium";
  }
  if (sourceAuthority === "low") {
    return "Low";
  }
  return "Unknown";
};

const getSourceAuthorityTextClass = (
  sourceAuthority: BrowserPageValidationRecord["sourceAuthority"],
): string => {
  if (sourceAuthority === "high") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (sourceAuthority === "medium") {
    return "text-amber-700 dark:text-amber-300";
  }
  if (sourceAuthority === "low") {
    return "text-red-700 dark:text-red-300";
  }
  if (sourceAuthority === "unknown") {
    return "text-slate-700 dark:text-slate-300";
  }
  return "text-muted-foreground";
};

const getValidationButtonToneClass = ({
  status,
  accuracy,
  hasError,
}: {
  status?: BrowserValidationStatus;
  accuracy?: BrowserPageValidationRecord["accuracy"];
  hasError: boolean;
}): string => {
  if (status === "running") {
    return "text-sky-700 dark:text-sky-300";
  }
  if (status === "complete" && !hasError) {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (hasError || status === "failed") {
    return "text-red-700 dark:text-red-300";
  }
  if (accuracy === "high") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (accuracy === "medium") {
    return "text-amber-700 dark:text-amber-300";
  }
  if (accuracy === "low") {
    return "text-orange-700 dark:text-orange-300";
  }
  if (accuracy === "conflicting") {
    return "text-red-700 dark:text-red-300";
  }
  if (accuracy === "insufficient") {
    return "text-slate-700 dark:text-slate-300";
  }
  return "text-muted-foreground";
};

const formatValidateStrictnessLabel = (
  strictness: DeepResearchStrictness,
): string => {
  if (strictness === "all-claims") {
    return "All claims";
  }
  if (strictness === "uncertain-claims") {
    return "Uncertain claims";
  }
  return "No search";
};

const formatSearchComplexityLabel = (
  complexity: SubagentSearchComplexity,
): string => {
  if (complexity === "balanced") {
    return "Balanced";
  }
  if (complexity === "deep") {
    return "Deep";
  }
  return "Standard";
};

const formatTavilyDepthLabel = (depth: TavilySearchDepth): string =>
  depth === "advanced" ? "Advanced" : "Basic";

const truncateText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

interface BrowserValidateConfigSummary {
  enabled: boolean;
  strictness: DeepResearchStrictness;
  searchComplexity: SubagentSearchComplexity;
  tavilySearchDepth: TavilySearchDepth;
  maxSearchCalls: number;
  maxExtractCalls: number;
}

interface BrowserTabProps {
  tabId: string;
  url: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  validation?: BrowserPageValidationRecord;
  validateConfig?: BrowserValidateConfigSummary;
  validationChatId?: string;
  validationStatus?: BrowserValidationStatus;
  validationError?: string;
  validationFailureReason?: BrowserValidationFailureReason;
  onBoundsChange: (tabId: string, bounds: BrowserViewBounds) => void;
  onRequestBack: (tabId: string) => void;
  onRequestForward: (tabId: string) => void;
  onRequestReload: (tabId: string) => void;
  onRequestValidate: (tabId: string) => void;
  onRequestOpenValidationChat?: (tabId: string) => void;
  onRequestHighlightReference?: (
    tabId: string,
    reference: BrowserViewReferenceHighlight,
  ) => void;
  onRequestOpenReference?: (target: string, label?: string) => void;
  onRequestOpenCdp: (tabId: string, url: string) => void;
  onRequestOpenExternal: (url: string) => void;
  onRequestNavigate: (tabId: string, url: string) => void;
}

export function BrowserTab({
  tabId,
  url,
  canGoBack,
  canGoForward,
  validation,
  validateConfig,
  validationChatId,
  validationStatus,
  validationError,
  validationFailureReason,
  onBoundsChange,
  onRequestBack,
  onRequestForward,
  onRequestReload,
  onRequestValidate,
  onRequestOpenValidationChat,
  onRequestHighlightReference,
  onRequestOpenReference,
  onRequestOpenCdp,
  onRequestOpenExternal,
  onRequestNavigate,
}: BrowserTabProps) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [address, setAddress] = useState(url);
  const [isEditing, setIsEditing] = useState(false);
  const [validationPanelOpen, setValidationPanelOpen] = useState(false);
  const [validationActionsOpen, setValidationActionsOpen] = useState(false);
  const validationFailed =
    validationStatus === "failed" || Boolean(validationError);
  const validationCompletedSuccessfully =
    validationStatus === "complete" && !validationFailed && Boolean(validation);
  const validationStopped =
    validationFailureReason === "stopped" ||
    /stopped by user|abort/i.test(validationError ?? "");
  const hasValidationContext =
    validationStatus === "running" ||
    validationStatus === "complete" ||
    validationStatus === "failed" ||
    Boolean(validation) ||
    Boolean(validationChatId);
  const shouldShowValidationActionsPopover = hasValidationContext;
  const hasValidationChatButton = Boolean(
    onRequestOpenValidationChat && hasValidationContext,
  );
  const validationChatButtonTitle = validationChatId
    ? "Focus validation chat"
    : "Create and open validation chat";
  const hasValidationPanelContent =
    validationStatus === "running" ||
    validationFailed ||
    Boolean(validation) ||
    Boolean(validationChatId);
  const hasValidationDetailsButton = hasValidationPanelContent;
  const failureTitle = validationStopped
    ? "Validation Stopped"
    : "Validation Failed";
  const failureDescription = validationError
    ? validationError
    : validationStopped
      ? "Validation stopped by user."
      : "Validation failed. Check logs for details.";
  const accuracyLabel = formatAccuracyLabel(validation?.accuracy);
  const sourceAuthorityLabel = formatSourceAuthorityLabel(
    validation?.sourceAuthority,
  );
  const validationClaims = validation?.claims ?? [];
  const claimSupports = validation?.claimSupports ?? [];
  const supportsForDisplay =
    validationClaims.length > 0
      ? validationClaims.flatMap((claim) => claim.supports)
      : claimSupports;
  const checkedAtLabel = useMemo(() => {
    if (!validation?.checkedAt) {
      return null;
    }
    const timestamp = Date.parse(validation.checkedAt);
    if (!Number.isFinite(timestamp)) {
      return validation.checkedAt;
    }
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(timestamp);
  }, [validation?.checkedAt]);
  const validateButtonToneClass = getValidationButtonToneClass({
    status: validationStatus,
    accuracy: validation?.accuracy,
    hasError: validationFailed,
  });
  const validateRunButtonTitle =
    validationStatus === "running"
      ? "Stop page validation"
      : validationCompletedSuccessfully
        ? "Rerun page validation"
        : "Validate page content";
  const showValidatedConfig =
    validationCompletedSuccessfully && Boolean(validateConfig);

  const emitBounds = useCallback(() => {
    const node = viewRef.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    onBoundsChange(tabId, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, [onBoundsChange, tabId]);

  useLayoutEffect(() => {
    emitBounds();
  }, [emitBounds, url]);

  useEffect(() => {
    if (!url || isEditing) {
      return;
    }
    setAddress(url);
  }, [isEditing, url]);

  useEffect(() => {
    setValidationPanelOpen(false);
    setValidationActionsOpen(false);
  }, [url]);

  useEffect(() => {
    if (validationFailed || validationStatus === "running") {
      setValidationPanelOpen(true);
    }
  }, [validationFailed, validationStatus]);

  useEffect(() => {
    const handle = () => {
      requestAnimationFrame(() => emitBounds());
    };
    const observer = new ResizeObserver(handle);
    if (viewRef.current) {
      observer.observe(viewRef.current);
    }
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("resize", handle);
      observer.disconnect();
    };
  }, [emitBounds]);

  const commitAddress = () => {
    const raw = address.trim();
    if (!raw) {
      return;
    }
    const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
    const nextUrl = hasProtocol ? raw : `https://${raw}`;
    if (nextUrl !== url) {
      onRequestNavigate(tabId, nextUrl);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/70 bg-card/70 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center">
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitAddress();
                setIsEditing(false);
              }
            }}
            onFocus={() => setIsEditing(true)}
            onBlur={() => {
              commitAddress();
              setIsEditing(false);
            }}
            placeholder="Enter URL"
            className="h-7 w-full rounded-md border border-border/60 bg-background/80 px-2 text-[11px] text-foreground shadow-inner shadow-black/10 focus:border-border focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7 text-muted-foreground")}
            onClick={() => onRequestBack(tabId)}
            disabled={!canGoBack}
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7 text-muted-foreground")}
            onClick={() => onRequestForward(tabId)}
            disabled={!canGoForward}
            title="Forward"
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7 text-muted-foreground")}
            onClick={() => onRequestReload(tabId)}
            disabled={!url}
            title="Reload"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={() => onRequestOpenExternal(url)}
            disabled={!url}
            title="Open in browser"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={() => onRequestOpenCdp(tabId, url)}
            disabled={!url}
            title="Open in CDP browser"
          >
            CDP
          </Button>
          {shouldShowValidationActionsPopover ? (
            <Popover
              open={validationActionsOpen}
              onOpenChange={setValidationActionsOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn("h-7 w-7", validateButtonToneClass)}
                  disabled={!url}
                  title="Validation actions"
                  aria-label="Validation actions"
                >
                  {validationStatus === "running" ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : validationFailed ? (
                    <AlertCircle className="h-3.5 w-3.5" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                avoidCollisions={false}
                sideOffset={6}
                className="w-[280px] max-w-[92vw] p-1.5"
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                }}
              >
                <div className="space-y-1">
                  {showValidatedConfig && validateConfig ? (
                    <div className="space-y-0.5 text-[10px] leading-tight text-foreground/90">
                      <div className="truncate">
                        <span className="text-muted-foreground">Validated:</span>{" "}
                        {formatValidateStrictnessLabel(
                          validateConfig.strictness,
                        )}{" "}
                        ·{" "}
                        {formatSearchComplexityLabel(
                          validateConfig.searchComplexity,
                        )}{" "}
                        /{" "}
                        {formatTavilyDepthLabel(
                          validateConfig.tavilySearchDepth,
                        )}
                      </div>
                      <div className="truncate">
                        <span className="text-muted-foreground">Limits:</span> S
                        {validateConfig.maxSearchCalls} · E
                        {validateConfig.maxExtractCalls} ·{" "}
                        {validateConfig.enabled ? "Enabled" : "Disabled"}
                      </div>
                    </div>
                  ) : null}
                  {showValidatedConfig ? (
                    <div
                      className="truncate text-[9px] leading-tight text-muted-foreground"
                      title="Set validate config in DeepResearch, then click rerun."
                    >
                      Tip: set validate in DeepResearch, then click rerun.
                    </div>
                  ) : null}
                  <div className="flex items-center justify-start gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        onRequestValidate(tabId);
                        setValidationActionsOpen(false);
                      }}
                      disabled={!url}
                      title={validateRunButtonTitle}
                      aria-label={validateRunButtonTitle}
                    >
                      {validationStatus === "running" ? (
                        <Square className="h-3.5 w-3.5" />
                      ) : (
                        <RotateCw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        onRequestOpenValidationChat?.(tabId);
                        setValidationActionsOpen(false);
                      }}
                      disabled={!hasValidationChatButton}
                      title={validationChatButtonTitle}
                      aria-label={validationChatButtonTitle}
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setValidationPanelOpen((previous) => !previous);
                        setValidationActionsOpen(false);
                      }}
                      disabled={!hasValidationDetailsButton}
                      title={
                        validationPanelOpen
                          ? "Hide validation details"
                          : "Show validation details"
                      }
                      aria-label={
                        validationPanelOpen
                          ? "Hide validation details"
                          : "Show validation details"
                      }
                      aria-expanded={validationPanelOpen}
                    >
                      <List className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("h-7 w-7", validateButtonToneClass)}
              disabled={!url}
              onClick={() => {
                onRequestValidate(tabId);
                setValidationActionsOpen(false);
              }}
              title="Validate page content"
              aria-label="Validate page content"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      {validationPanelOpen && hasValidationPanelContent ? (
        <div className="border-b border-border/60 bg-card/50 px-3 py-2">
          {validationStatus === "running" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Validating current page...
              </div>
              <div className="text-[11px] text-muted-foreground">
                Click Validate again to stop.
              </div>
            </div>
          ) : validationFailed ? (
            <div className="rounded border border-red-400/45 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
              <div className="font-semibold">{failureTitle}</div>
              <div className="mt-1 leading-relaxed">{failureDescription}</div>
            </div>
          ) : validation ? (
            <div className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
              {validationClaims.length > 0 ? (
                <div className="space-y-1.5 rounded border border-border/60 bg-card/40 p-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Claims & refs
                  </div>
                  {validationClaims.map((claim, claimIndex) => {
                    const claimAccuracyLabel = formatAccuracyLabel(claim.accuracy);
                    const claimSourceAuthorityLabel = formatSourceAuthorityLabel(
                      claim.sourceAuthority,
                    );
                    const claimText = claim.originalText.trim();
                    return (
                      <div
                        key={claim.claimId}
                        className="space-y-1 rounded border border-border/50 bg-background/60 px-2 py-1"
                      >
                        <button
                          type="button"
                          className="w-full space-y-0.5 text-left transition-colors hover:bg-accent/40"
                          onClick={() => {
                            if (!claimText) {
                              return;
                            }
                            onRequestHighlightReference?.(tabId, {
                              refId: claimIndex + 1,
                              text: claimText,
                              url: claim.origin.url ?? validation.url,
                              title: claim.summary || claimText,
                              accuracy: claim.accuracy,
                              sourceAuthority: claim.sourceAuthority,
                              issueReason: claim.issueReason,
                              correctFact: claim.correctFact,
                              showMarker: false,
                            });
                          }}
                          title="Highlight claim original text"
                        >
                          <div className="text-[11px] font-medium leading-relaxed text-foreground">
                            {truncateText(claim.summary, 180)}
                          </div>
                          <div className="text-[11px] leading-relaxed text-foreground/85">
                            {truncateText(claimText, 280)}
                          </div>
                          {claimAccuracyLabel ? (
                            <div
                              className={cn(
                                "text-[10px] uppercase tracking-[0.12em]",
                                getAccuracyTextClass(claim.accuracy),
                              )}
                            >
                              Accuracy {claimAccuracyLabel}
                            </div>
                          ) : null}
                          {claimSourceAuthorityLabel ? (
                            <div
                              className={cn(
                                "text-[10px] uppercase tracking-[0.12em]",
                                getSourceAuthorityTextClass(
                                  claim.sourceAuthority,
                                ),
                              )}
                            >
                              Source Authority {claimSourceAuthorityLabel}
                            </div>
                          ) : null}
                        </button>
                        {claim.supports.length > 0 ? (
                          <div className="space-y-1">
                            {claim.supports.map((support, supportIndex) => {
                              const supportRefId =
                                typeof support.referenceRefId === "number" &&
                                support.referenceRefId > 0
                                  ? support.referenceRefId
                                  : supportIndex + 1;
                              const supportAccuracyLabel = formatAccuracyLabel(
                                support.accuracy,
                              );
                              const supportSourceAuthorityLabel =
                                formatSourceAuthorityLabel(
                                  support.sourceAuthority,
                                );
                              const trimmedReferenceUri =
                                support.referenceUri?.trim();
                              const referenceOpenTarget =
                                trimmedReferenceUri &&
                                trimmedReferenceUri.length > 0
                                  ? trimmedReferenceUri
                                  : support.referenceUrl;
                              return (
                                <div
                                  key={`${claim.claimId}:${support.referenceRefId ?? supportIndex}`}
                                  className="rounded border border-border/50 bg-background/50 px-2 py-1"
                                >
                                  <div className="flex items-start gap-1">
                                    <div className="min-w-0 flex-1 space-y-0.5">
                                      <div className="truncate text-[10px] text-muted-foreground">
                                        [{supportRefId}] {support.referenceUrl}
                                      </div>
                                      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                        Lines {support.startLine}-{support.endLine}
                                      </div>
                                      {supportAccuracyLabel ? (
                                        <div
                                          className={cn(
                                            "text-[10px] uppercase tracking-[0.12em]",
                                            getAccuracyTextClass(support.accuracy),
                                          )}
                                        >
                                          Accuracy {supportAccuracyLabel}
                                        </div>
                                      ) : null}
                                      {supportSourceAuthorityLabel ? (
                                        <div
                                          className={cn(
                                            "text-[10px] uppercase tracking-[0.12em]",
                                            getSourceAuthorityTextClass(
                                              support.sourceAuthority,
                                            ),
                                          )}
                                        >
                                          Source Authority {supportSourceAuthorityLabel}
                                        </div>
                                      ) : null}
                                      <div className="text-[11px] leading-relaxed text-foreground/85">
                                        {truncateText(support.text, 240)}
                                      </div>
                                    </div>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                      onClick={() =>
                                        onRequestOpenReference?.(
                                          referenceOpenTarget,
                                          support.referenceTitle ?? claim.summary,
                                        )
                                      }
                                      disabled={
                                        !onRequestOpenReference || !referenceOpenTarget
                                      }
                                      title="Open reference in new page"
                                      aria-label="Open reference in new page"
                                    >
                                      <ExternalLink className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-[11px] leading-relaxed text-muted-foreground">
                            No supporting references were returned for this claim.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : claimSupports.length > 0 ? (
                <div className="space-y-1.5 rounded border border-border/60 bg-card/40 p-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Claims & refs
                  </div>
                  {claimSupports.map((support, index) => {
                    const supportAccuracyLabel = formatAccuracyLabel(
                      support.accuracy,
                    );
                    const supportSourceAuthorityLabel =
                      formatSourceAuthorityLabel(support.sourceAuthority);
                    const refId =
                      typeof support.referenceRefId === "number" &&
                      support.referenceRefId > 0
                        ? support.referenceRefId
                        : index + 1;
                    const trimmedReferenceUri = support.referenceUri?.trim();
                    const referenceOpenTarget =
                      trimmedReferenceUri && trimmedReferenceUri.length > 0
                        ? trimmedReferenceUri
                        : support.referenceUrl;
                    return (
                      <div
                        key={`${support.viewpoint}:${support.referenceRefId ?? index}`}
                        className="rounded border border-border/50 bg-background/60 px-2 py-1"
                      >
                        <div className="flex items-start gap-1">
                          <button
                            type="button"
                            className="min-w-0 flex-1 space-y-0.5 text-left transition-colors hover:bg-accent/40"
                            onClick={() => {
                              onRequestHighlightReference?.(tabId, {
                                refId,
                                text: support.text,
                                startLine: support.startLine,
                                endLine: support.endLine,
                                uri: support.referenceUri,
                                url: support.referenceUrl,
                                title: support.referenceTitle,
                                accuracy: support.accuracy,
                                sourceAuthority: support.sourceAuthority,
                              });
                            }}
                            title="Scroll to this cited segment"
                          >
                            <div className="text-[11px] font-medium leading-relaxed text-foreground">
                              {truncateText(support.viewpoint, 180)}
                            </div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              {support.referenceUrl}
                            </div>
                            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                              Lines {support.startLine}-{support.endLine}
                            </div>
                            {supportAccuracyLabel ? (
                              <div
                                className={cn(
                                  "text-[10px] uppercase tracking-[0.12em]",
                                  getAccuracyTextClass(support.accuracy),
                                )}
                              >
                                Accuracy {supportAccuracyLabel}
                              </div>
                            ) : null}
                            {supportSourceAuthorityLabel ? (
                              <div
                                className={cn(
                                  "text-[10px] uppercase tracking-[0.12em]",
                                  getSourceAuthorityTextClass(
                                    support.sourceAuthority,
                                  ),
                                )}
                              >
                                Source Authority {supportSourceAuthorityLabel}
                              </div>
                            ) : null}
                            <div className="text-[11px] leading-relaxed text-foreground/85">
                              {truncateText(support.text, 240)}
                            </div>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              onRequestOpenReference?.(
                                referenceOpenTarget,
                                support.referenceTitle ?? support.viewpoint,
                              )
                            }
                            disabled={!onRequestOpenReference || !referenceOpenTarget}
                            title="Open reference in new page"
                            aria-label="Open reference in new page"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {checkedAtLabel ? (
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  Checked {checkedAtLabel}
                </div>
              ) : null}
              {accuracyLabel ? (
                <div
                  className={cn(
                    "text-[10px] uppercase tracking-[0.12em]",
                    getAccuracyTextClass(validation.accuracy),
                  )}
                >
                  Accuracy {accuracyLabel}
                </div>
              ) : null}
              {sourceAuthorityLabel ? (
                <div
                  className={cn(
                    "text-[10px] uppercase tracking-[0.12em]",
                    getSourceAuthorityTextClass(validation.sourceAuthority),
                  )}
                >
                  Source Authority {sourceAuthorityLabel}
                </div>
              ) : null}
              {supportsForDisplay.length > 0 ? (
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  Select a claim above to highlight the original statement.
                </div>
              ) : (
                <>
                  {validation.issueReason ? (
                    <div className="rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
                      Why wrong: {validation.issueReason}
                    </div>
                  ) : null}
                  {validation.correctFact ? (
                    <div className="rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                      Correct fact: {validation.correctFact}
                    </div>
                  ) : null}
                  {validation.validationRefContent ? (
                    <div className="rounded border border-border/60 bg-card/40 px-2 py-1 text-[11px] leading-relaxed text-foreground/90">
                      {validation.validationRefContent}
                    </div>
                  ) : null}
                  <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                    {validation.text}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No validation result yet.
            </div>
          )}
        </div>
      ) : null}
      <div ref={viewRef} className="relative flex-1 bg-muted/20">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {url ? "Loading page..." : "Enter a URL to start"}
        </div>
      </div>
    </div>
  );
}
