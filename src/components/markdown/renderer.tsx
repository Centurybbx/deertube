import "katex/dist/katex.min.css";
import "@/assets/github-markdown.css";
import "@/assets/mdx-renderer.css";
import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { isValidElement } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Pluggable } from "unified";
import { MarkdownHooks } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypePrettyCode from "rehype-pretty-code";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";
import { mdxComponents } from "@/components/markdown/components/mdx-components";
import { rehypeHighlightExcerpt } from "@/components/markdown/rehype-highlight-excerpt";
import { rehypeLinkNodeExcerpts } from "@/components/markdown/rehype-link-node-excerpts";

export interface MarkdownReferencePreview {
  title?: string;
  url: string;
  text: string;
  startLine: number;
  endLine: number;
  validationRefContent?: string;
  accuracy?: "high" | "medium" | "low" | "conflicting" | "insufficient";
  issueReason?: string;
  correctFact?: string;
}

interface ReferenceTooltipLoadingState {
  status: "loading";
  uri: string;
  left: number;
  top: number;
}

interface ReferenceTooltipReadyState {
  status: "ready";
  uri: string;
  left: number;
  top: number;
  reference: MarkdownReferencePreview;
}

type ReferenceTooltipState = ReferenceTooltipLoadingState | ReferenceTooltipReadyState;

const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT = 184;
const TOOLTIP_MARGIN = 12;
const TOOLTIP_GAP = 10;
const TOOLTIP_HIDE_DELAY_MS = 160;

const resolveReferenceTitle = (reference: MarkdownReferencePreview): string => {
  const trimmed = reference.title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Reference";
};

const formatAccuracyLabel = (
  accuracy: MarkdownReferencePreview["accuracy"],
): string | null => {
  if (!accuracy) {
    return null;
  }
  if (accuracy === "high") return "High";
  if (accuracy === "medium") return "Medium";
  if (accuracy === "low") return "Low";
  if (accuracy === "conflicting") return "Conflicting";
  return "Insufficient";
};

const getAccuracyToneClass = (
  accuracy: MarkdownReferencePreview["accuracy"],
): string => {
  if (accuracy === "high") {
    return "text-emerald-600 dark:text-emerald-300";
  }
  if (accuracy === "medium") {
    return "text-amber-600 dark:text-amber-300";
  }
  if (accuracy === "low") {
    return "text-orange-600 dark:text-orange-300";
  }
  if (accuracy === "conflicting") {
    return "text-red-600 dark:text-red-300";
  }
  if (accuracy === "insufficient") {
    return "text-slate-600 dark:text-slate-300";
  }
  return "text-muted-foreground";
};

interface MarkdownRendererProps {
  source: string;
  className?: string;
  highlightExcerpt?: string;
  referenceAccuracyHints?: Record<string, MarkdownReferencePreview["accuracy"]>;
  onNodeLinkClick?: (nodeId: string) => void;
  onReferenceClick?: (url: string, label?: string) => void;
  resolveReferencePreview?: (
    uri: string,
  ) => Promise<MarkdownReferencePreview | null>;
  resolveNodeLabel?: (nodeId: string) => string | undefined;
  nodeExcerptRefs?: { id: string; text: string }[];
}

export const MarkdownRenderer = memo(
  ({
    source,
    className,
    highlightExcerpt,
    referenceAccuracyHints,
    onNodeLinkClick,
    onReferenceClick,
    resolveReferencePreview,
    resolveNodeLabel,
    nodeExcerptRefs = [],
  }: MarkdownRendererProps) => {
    const referencePreviewCacheRef = useRef<Map<string, MarkdownReferencePreview | null>>(
      new Map(),
    );
    const referencePreviewTokenRef = useRef(0);
    const tooltipScrollRef = useRef<HTMLDivElement | null>(null);
    const tooltipScrollTargetRef = useRef<number | null>(null);
    const tooltipScrollRafRef = useRef<number | null>(null);
    const tooltipHideTimerRef = useRef<number | null>(null);
    const hoveredReferenceUriRef = useRef<string | null>(null);
    const lastReferenceActivationRef = useRef<{
      href: string;
      timestamp: number;
    } | null>(null);
    const [referenceTooltip, setReferenceTooltip] =
      useState<ReferenceTooltipState | null>(null);
    const [referenceAccuracyByUri, setReferenceAccuracyByUri] = useState<
      Record<string, MarkdownReferencePreview["accuracy"]>
    >({});
    const mergedReferenceAccuracyByUri = useMemo(
      () => ({
        ...(referenceAccuracyHints ?? {}),
        ...referenceAccuracyByUri,
      }),
      [referenceAccuracyByUri, referenceAccuracyHints],
    );

    const clearTooltipHideTimer = useCallback(() => {
      if (tooltipHideTimerRef.current !== null) {
        window.clearTimeout(tooltipHideTimerRef.current);
        tooltipHideTimerRef.current = null;
      }
    }, []);

    const stopTooltipScrollAnimation = useCallback(() => {
      if (tooltipScrollRafRef.current !== null) {
        window.cancelAnimationFrame(tooltipScrollRafRef.current);
        tooltipScrollRafRef.current = null;
      }
      tooltipScrollTargetRef.current = null;
    }, []);

    useEffect(() => {
      if (!referenceTooltip || referenceTooltip.status !== "ready") {
        stopTooltipScrollAnimation();
        return;
      }

      const handleWheel = (event: WheelEvent) => {
        const scrollContainer = tooltipScrollRef.current;
        if (!scrollContainer) {
          return;
        }

        const hoveringReference = hoveredReferenceUriRef.current === referenceTooltip.uri;
        const insideTooltip =
          event.clientX >= referenceTooltip.left &&
          event.clientX <= referenceTooltip.left + TOOLTIP_WIDTH &&
          event.clientY >= referenceTooltip.top &&
          event.clientY <= referenceTooltip.top + TOOLTIP_HEIGHT;
        if (!insideTooltip && !hoveringReference) {
          return;
        }

        let delta = event.deltaY;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          delta *= 16;
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          delta *= Math.max(1, scrollContainer.clientHeight);
        }
        if (delta === 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        if (maxScrollTop <= 0) {
          return;
        }

        const currentTarget = tooltipScrollTargetRef.current ?? scrollContainer.scrollTop;
        const softenedDelta = delta * 0.35;
        const nextTarget = Math.min(maxScrollTop, Math.max(0, currentTarget + softenedDelta));
        tooltipScrollTargetRef.current = nextTarget;

        if (tooltipScrollRafRef.current !== null) {
          return;
        }

        const animate = () => {
          const activeContainer = tooltipScrollRef.current;
          if (!activeContainer) {
            stopTooltipScrollAnimation();
            return;
          }
          const maxTop = Math.max(0, activeContainer.scrollHeight - activeContainer.clientHeight);
          const target = Math.min(
            maxTop,
            Math.max(0, tooltipScrollTargetRef.current ?? activeContainer.scrollTop),
          );
          const current = activeContainer.scrollTop;
          const diff = target - current;
          if (Math.abs(diff) < 0.4) {
            activeContainer.scrollTop = target;
            tooltipScrollRafRef.current = null;
            return;
          }
          activeContainer.scrollTop = current + diff * 0.22;
          tooltipScrollRafRef.current = window.requestAnimationFrame(animate);
        };

        tooltipScrollRafRef.current = window.requestAnimationFrame(animate);
      };

      window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
      return () => {
        window.removeEventListener("wheel", handleWheel, true);
      };
    }, [referenceTooltip, stopTooltipScrollAnimation]);

    const resolveTooltipPosition = useCallback((anchor: HTMLElement) => {
      const rect = anchor.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      let left = rect.right + TOOLTIP_GAP;
      if (left + TOOLTIP_WIDTH > window.innerWidth - TOOLTIP_MARGIN) {
        left = rect.left - TOOLTIP_WIDTH - TOOLTIP_GAP;
      }
      if (left < TOOLTIP_MARGIN) {
        left = TOOLTIP_MARGIN;
      }
      let top = centerY - TOOLTIP_HEIGHT / 2;
      const maxTop = window.innerHeight - TOOLTIP_HEIGHT - TOOLTIP_MARGIN;
      if (top > maxTop) {
        top = maxTop;
      }
      if (top < TOOLTIP_MARGIN) {
        top = TOOLTIP_MARGIN;
      }
      return { left, top };
    }, []);

    const scheduleHideReferenceTooltip = useCallback(() => {
      clearTooltipHideTimer();
      tooltipHideTimerRef.current = window.setTimeout(() => {
        tooltipHideTimerRef.current = null;
        referencePreviewTokenRef.current += 1;
        setReferenceTooltip(null);
      }, TOOLTIP_HIDE_DELAY_MS);
    }, [clearTooltipHideTimer]);

    useEffect(() => {
      return () => {
        clearTooltipHideTimer();
        stopTooltipScrollAnimation();
      };
    }, [clearTooltipHideTimer, stopTooltipScrollAnimation]);

    const showReferenceTooltip = useCallback(
      async (uri: string, anchor: HTMLElement) => {
        if (!resolveReferencePreview) {
          return;
        }
        clearTooltipHideTimer();
        const { left, top } = resolveTooltipPosition(anchor);
        const cached = referencePreviewCacheRef.current.get(uri);
        if (cached !== undefined) {
          if (!cached) {
            setReferenceTooltip(null);
            return;
          }
          if (cached.accuracy) {
            setReferenceAccuracyByUri((previous) => ({
              ...previous,
              [uri]: cached.accuracy,
            }));
          }
          setReferenceTooltip({
            status: "ready",
            uri,
            left,
            top,
            reference: cached,
          });
          return;
        }

        const token = referencePreviewTokenRef.current + 1;
        referencePreviewTokenRef.current = token;
        setReferenceTooltip({
          status: "loading",
          uri,
          left,
          top,
        });

        const resolved = await resolveReferencePreview(uri);
        referencePreviewCacheRef.current.set(uri, resolved);
        if (referencePreviewTokenRef.current !== token) {
          return;
        }
        if (!resolved) {
          setReferenceTooltip(null);
          return;
        }
        if (resolved.accuracy) {
          setReferenceAccuracyByUri((previous) => ({
            ...previous,
            [uri]: resolved.accuracy,
          }));
        }
        setReferenceTooltip({
          status: "ready",
          uri,
          left,
          top,
          reference: resolved,
        });
      },
      [clearTooltipHideTimer, resolveReferencePreview, resolveTooltipPosition],
    );

    const remarkPlugins = useMemo<Pluggable[]>(() => [remarkGfm, remarkMath], []);
    const rehypePlugins = useMemo<Pluggable[]>(() => {
      const plugins: Pluggable[] = [];
      plugins.push(rehypeKatex, [
        rehypePrettyCode,
        { theme: "vitesse-dark", keepBackground: false },
      ]);
      const excerpt = highlightExcerpt?.trim();
      if (excerpt) {
        plugins.push(() => rehypeHighlightExcerpt(excerpt));
      }
      if (nodeExcerptRefs.length > 0) {
        plugins.push(() => rehypeLinkNodeExcerpts(nodeExcerptRefs, excerpt));
      }
      return plugins;
    }, [highlightExcerpt, nodeExcerptRefs]);
    const urlTransform = useCallback((href: string) => href, []);
    const resolvedSource = useMemo(() => {
      if (!source) {
        return source;
      }
      return source.replace(
        /\[\[node:([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_match, nodeId, label) => {
          const nodeIdText = String(nodeId);
          const fallback =
            (resolveNodeLabel ? resolveNodeLabel(nodeIdText) : undefined) ??
            `Node ${nodeIdText.slice(0, 6)}`;
          const labelText =
            label !== undefined && label !== null ? String(label).trim() : "";
          const text = labelText || fallback;
          return `[${text}](node:${nodeIdText})`;
        },
      );
    }, [resolveNodeLabel, source]);

    const components = useMemo(() => {
      const parseNodeHref = (href?: string | null) => {
        if (!href) {
          return null;
        }
        const trimmed = href.trim();
        if (trimmed.startsWith("node://")) {
          return trimmed.slice("node://".length);
        }
        if (trimmed.startsWith("node:")) {
          return trimmed.slice("node:".length);
        }
        if (trimmed.startsWith("deertube://node/")) {
          return trimmed.slice("deertube://node/".length);
        }
        return null;
      };

      const normalizeHref = (href: unknown): string | null => {
        if (typeof href === "string") {
          const trimmed = href.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        if (href instanceof URL) {
          return href.toString();
        }
        if (href === null || href === undefined) {
          return null;
        }
        const casted = String(href).trim();
        return casted.length > 0 ? casted : null;
      };

      const isHttpUrl = (href?: string | null) => {
        if (!href) {
          return false;
        }
        if (!URL.canParse(href)) {
          return false;
        }
        const parsed = new URL(href);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      };

      const isDeertubeUrl = (href?: string | null) => {
        if (!href) {
          return false;
        }
        if (href.toLowerCase().startsWith("deertube://")) {
          return true;
        }
        if (!URL.canParse(href)) {
          return false;
        }
        const parsed = new URL(href);
        return parsed.protocol === "deertube:";
      };

      const flattenText = (children: ReactNode): string => {
        const stack: ReactNode[] = [children];
        const fragments: string[] = [];
        let guard = 0;
        while (stack.length > 0 && guard < 6000) {
          guard += 1;
          const current = stack.pop();
          if (typeof current === "string" || typeof current === "number") {
            fragments.push(String(current));
            continue;
          }
          if (Array.isArray(current)) {
            for (let index = current.length - 1; index >= 0; index -= 1) {
              stack.push(current[index] as ReactNode);
            }
            continue;
          }
          if (isValidElement<{ children?: ReactNode }>(current)) {
            const child = current.props?.children;
            if (child !== current) {
              stack.push(child);
            }
          }
        }
        return fragments.join("");
      };

      const markdownLinkClassName = "markdown-link";
      const nodeLinkClassName = "markdown-link markdown-node-link";
      const activateReference = (
        normalizedHref: string,
        labelText: string,
      ) => {
        const now = Date.now();
        const last = lastReferenceActivationRef.current;
        if (
          last &&
          last.href === normalizedHref &&
          now - last.timestamp < 260
        ) {
          return;
        }
        lastReferenceActivationRef.current = {
          href: normalizedHref,
          timestamp: now,
        };
        onReferenceClick?.(normalizedHref, labelText);
      };

      return {
        ...mdxComponents,
        a: (
          props: AnchorHTMLAttributes<HTMLAnchorElement> & {
            node?: { url?: string; properties?: { href?: string } };
          },
        ) => {
          const nodeProp = props.node;
          const { node: _node, children, ...restProps } = props;
          const rawHref =
            props.href ??
            (nodeProp && typeof nodeProp === "object" && "url" in nodeProp
              ? String(nodeProp.url ?? "")
              : undefined) ??
            (nodeProp &&
            typeof nodeProp === "object" &&
            "properties" in nodeProp &&
            nodeProp.properties?.href
              ? String(nodeProp.properties?.href)
              : undefined);
          const normalizedHref = normalizeHref(rawHref);
          const nodeId = parseNodeHref(normalizedHref);
          const isDeertubeReference = isDeertubeUrl(normalizedHref);

          if (nodeId) {
            const labelText = flattenText(children);
            const label =
              (labelText.length > 0 ? labelText : undefined) ??
              (resolveNodeLabel ? resolveNodeLabel(nodeId) : undefined) ??
              `Node ${nodeId.slice(0, 6)}`;
            return (
              <button
                type="button"
                onClick={() => onNodeLinkClick?.(nodeId)}
                className={nodeLinkClassName}
                title={`Focus node ${label}`}
                disabled={!onNodeLinkClick}
              >
                {label}
              </button>
            );
          }

          if ((isHttpUrl(normalizedHref) || isDeertubeUrl(normalizedHref)) && onReferenceClick) {
            const labelText = flattenText(children);
            const referenceAccuracy =
              normalizedHref && isDeertubeReference
                ? mergedReferenceAccuracyByUri[normalizedHref]
                : undefined;
            return (
              <a
                {...restProps}
                href={normalizedHref ?? undefined}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!normalizedHref) {
                    return;
                  }
                  activateReference(normalizedHref, labelText);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!normalizedHref) {
                    return;
                  }
                  activateReference(normalizedHref, labelText);
                }}
                onMouseEnter={(event) => {
                  if (!normalizedHref || !isDeertubeReference || !resolveReferencePreview) {
                    return;
                  }
                  hoveredReferenceUriRef.current = normalizedHref;
                  clearTooltipHideTimer();
                  void showReferenceTooltip(normalizedHref, event.currentTarget);
                }}
                onMouseLeave={() => {
                  if (isDeertubeReference) {
                    hoveredReferenceUriRef.current = null;
                    scheduleHideReferenceTooltip();
                  }
                }}
                onBlur={() => {
                  if (isDeertubeReference) {
                    hoveredReferenceUriRef.current = null;
                    scheduleHideReferenceTooltip();
                  }
                }}
                className={markdownLinkClassName}
                data-ref-accuracy={referenceAccuracy ?? undefined}
              >
                {children}
              </a>
            );
          }

          if (isDeertubeUrl(normalizedHref)) {
            return <span className={markdownLinkClassName}>{children}</span>;
          }

          return (
            <a
              {...restProps}
              target="_blank"
              rel="noopener noreferrer"
              className={markdownLinkClassName}
            >
              {children}
            </a>
          );
        },
      };
    }, [
      onNodeLinkClick,
      onReferenceClick,
      clearTooltipHideTimer,
      resolveNodeLabel,
      resolveReferencePreview,
      mergedReferenceAccuracyByUri,
      scheduleHideReferenceTooltip,
      showReferenceTooltip,
    ]);

    useEffect(() => {
      if (!import.meta.env.DEV) {
        return;
      }
      const hasTable =
        source.includes("<table") ||
        source.includes("</table>") ||
        /(^|\n)\s*\|.+\|\s*$/m.test(source);
      if (!hasTable) {
        return;
      }
      console.log("[markdown.render.input]", {
        source,
        sourceLength: source.length,
        highlightExcerpt,
        highlightExcerptLength: highlightExcerpt?.length ?? 0,
        nodeExcerptRefsCount: nodeExcerptRefs.length,
        nodeExcerptRefs: nodeExcerptRefs.map((item) => ({
          id: item.id,
          textLength: item.text.length,
          textPreview: item.text.slice(0, 220),
        })),
      });
    }, [highlightExcerpt, nodeExcerptRefs, source]);

    const handleArticleClick = useCallback(
      (event: React.MouseEvent<HTMLElement>) => {
        if (!onNodeLinkClick) {
          return;
        }
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const ref = target.closest<HTMLElement>("[data-node-ref]");
        const nodeId = ref?.dataset.nodeRef;
        if (!nodeId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onNodeLinkClick(nodeId);
      },
      [onNodeLinkClick],
    );

    const handleArticleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLElement>) => {
        if (!onNodeLinkClick) {
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const ref = target.closest<HTMLElement>("[data-node-ref]");
        const nodeId = ref?.dataset.nodeRef;
        if (!nodeId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onNodeLinkClick(nodeId);
      },
      [onNodeLinkClick],
    );

    return (
      <article
        className={cn("markdown-body text-sm leading-relaxed", className)}
        onClick={handleArticleClick}
        onKeyDown={handleArticleKeyDown}
        onMouseLeave={scheduleHideReferenceTooltip}
      >
        <MarkdownHooks
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={urlTransform}
          components={components}
        >
          {resolvedSource.trimStart()}
        </MarkdownHooks>
        {referenceTooltip && typeof document !== "undefined"
          ? createPortal(
              <div
                className="fixed z-[2147483000] h-[184px] w-[320px] overflow-hidden rounded-lg border border-border/80 bg-popover/95 p-3 shadow-2xl backdrop-blur"
                style={{
                  left: `${referenceTooltip.left}px`,
                  top: `${referenceTooltip.top}px`,
                }}
              >
                {referenceTooltip.status === "loading" ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading reference...
                  </div>
                ) : (
                  <div className="flex h-full flex-col">
                    <div className="truncate text-xs font-semibold text-foreground">
                      {resolveReferenceTitle(referenceTooltip.reference)}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {referenceTooltip.reference.url}
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      Lines {referenceTooltip.reference.startLine}-{referenceTooltip.reference.endLine}
                    </div>
                    {referenceTooltip.reference.accuracy ? (
                      <div
                        className={cn(
                          "mt-1 text-[10px] uppercase tracking-[0.12em]",
                          getAccuracyToneClass(referenceTooltip.reference.accuracy),
                        )}
                      >
                        Accuracy {formatAccuracyLabel(referenceTooltip.reference.accuracy)}
                      </div>
                    ) : null}
                    <div
                      ref={tooltipScrollRef}
                      className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap pr-1 text-xs leading-relaxed text-foreground/90"
                    >
                      {referenceTooltip.reference.issueReason ? (
                        <div className="mb-2 rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
                          Why wrong: {referenceTooltip.reference.issueReason}
                        </div>
                      ) : null}
                      {referenceTooltip.reference.correctFact ? (
                        <div className="mb-2 rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                          Correct fact: {referenceTooltip.reference.correctFact}
                        </div>
                      ) : null}
                      {referenceTooltip.reference.validationRefContent ? (
                        <div className="mb-2 rounded border border-border/60 bg-card/40 px-2 py-1 text-[11px] leading-relaxed text-foreground/90">
                          {referenceTooltip.reference.validationRefContent}
                        </div>
                      ) : null}
                      {referenceTooltip.reference.text}
                    </div>
                  </div>
                )}
              </div>,
              document.body,
            )
          : null}
      </article>
    );
  },
);

MarkdownRenderer.displayName = "MarkdownRenderer";
