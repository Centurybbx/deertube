import { BrowserWindow, WebContentsView, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { JsonValue } from "../src/types/json";
import { isJsonObject } from "../src/types/json";
import type { BrowserViewReferenceHighlight } from "../src/types/browserview";

interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserViewSelectionPayload {
  text?: JsonValue;
  url?: JsonValue;
  title?: JsonValue;
  rect?: JsonValue;
}

interface BrowserViewValidationSnapshotPayload {
  text?: JsonValue;
  url?: JsonValue;
  title?: JsonValue;
}

interface BrowserViewValidationSnapshot {
  text: string;
  url: string;
  title?: string;
}

interface BrowserViewState {
  tabId: string;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_PRELOAD = path.join(__dirname, "preload.mjs");
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_SELECTION_LENGTH = 5000;
const MAX_HIGHLIGHT_TEXT_LENGTH = 4000;
const MAX_VALIDATION_TEXT_LENGTH = 18000;

const isAllowedUrl = (value: string) => {
  if (!URL.canParse(value)) {
    return false;
  }
  const parsed = new URL(value);
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
};

const sanitizeSelection = (payload: BrowserViewSelectionPayload) => {
  const text = typeof payload.text === "string" ? payload.text : "";
  const url = typeof payload.url === "string" ? payload.url : "";
  const title = typeof payload.title === "string" ? payload.title : undefined;
  const rectRaw = payload.rect;
  const rect =
    rectRaw &&
    isJsonObject(rectRaw) &&
    "x" in rectRaw &&
    "y" in rectRaw &&
    "width" in rectRaw &&
    "height" in rectRaw
      ? {
          x: Number(rectRaw.x),
          y: Number(rectRaw.y),
          width: Number(rectRaw.width),
          height: Number(rectRaw.height),
        }
      : undefined;

  return {
    text: text.length > MAX_SELECTION_LENGTH ? `${text.slice(0, MAX_SELECTION_LENGTH)}...` : text,
    url,
    title,
    rect,
  };
};

const sanitizeReferenceHighlight = (
  payload: BrowserViewReferenceHighlight,
): BrowserViewReferenceHighlight => {
  const text = payload.text.trim();
  const alternateTexts = Array.isArray(payload.alternateTexts)
    ? Array.from(
        new Set(
          payload.alternateTexts
            .filter((candidate): candidate is string => typeof candidate === "string")
            .map((candidate) => candidate.trim())
            .filter(
              (candidate) =>
                candidate.length > 0 &&
                candidate !== text,
            )
            .map((candidate) =>
              candidate.length > MAX_HIGHLIGHT_TEXT_LENGTH
                ? `${candidate.slice(0, MAX_HIGHLIGHT_TEXT_LENGTH)}...`
                : candidate,
            ),
        ),
      ).slice(0, 6)
    : undefined;
  const title =
    typeof payload.title === "string" && payload.title.trim().length > 0
      ? payload.title.trim()
      : undefined;
  const url =
    typeof payload.url === "string" && payload.url.trim().length > 0
      ? payload.url.trim()
      : undefined;
  const uri =
    typeof payload.uri === "string" && payload.uri.trim().length > 0
      ? payload.uri.trim()
      : undefined;
  const validationRefContent =
    typeof payload.validationRefContent === "string" &&
    payload.validationRefContent.trim().length > 0
      ? payload.validationRefContent.trim()
      : undefined;
  const issueReason =
    typeof payload.issueReason === "string" && payload.issueReason.trim().length > 0
      ? payload.issueReason.trim()
      : undefined;
  const correctFact =
    typeof payload.correctFact === "string" && payload.correctFact.trim().length > 0
      ? payload.correctFact.trim()
      : undefined;
  return {
    refId: payload.refId,
    text:
      text.length > MAX_HIGHLIGHT_TEXT_LENGTH
        ? `${text.slice(0, MAX_HIGHLIGHT_TEXT_LENGTH)}...`
        : text,
    alternateTexts:
      alternateTexts && alternateTexts.length > 0 ? alternateTexts : undefined,
    append: payload.append === true,
    showMarker: payload.showMarker !== false,
    startLine: payload.startLine,
    endLine: payload.endLine,
    uri,
    url,
    title,
    validationRefContent,
    accuracy: payload.accuracy,
    sourceAuthority: payload.sourceAuthority,
    issueReason,
    correctFact,
  };
};

const normalizeComparableHighlightUrl = (value: string | undefined): string | null => {
  if (!value || !isAllowedUrl(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
};

const sanitizeValidationSnapshot = (
  payload: BrowserViewValidationSnapshotPayload,
  fallbackUrl: string,
): BrowserViewValidationSnapshot | null => {
  const url =
    typeof payload.url === "string" && payload.url.trim().length > 0
      ? payload.url.trim()
      : fallbackUrl;
  if (!isAllowedUrl(url)) {
    return null;
  }
  const textRaw = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!textRaw) {
    return null;
  }
  const title =
    typeof payload.title === "string" && payload.title.trim().length > 0
      ? payload.title.trim()
      : undefined;
  return {
    url,
    title,
    text:
      textRaw.length > MAX_VALIDATION_TEXT_LENGTH
        ? `${textRaw.slice(0, MAX_VALIDATION_TEXT_LENGTH)}...`
        : textRaw,
  };
};

function runValidationSnapshotScript(maxLength: number) {
  const toCompactMultilineText = (value: string): string =>
    value
      .replace(/\u00A0/g, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n")
      .trim();

  const articleText = toCompactMultilineText(
    document.querySelector("article")?.innerText ?? "",
  );
  const mainText = toCompactMultilineText(
    document.querySelector("main")?.innerText ?? "",
  );
  const bodyText = toCompactMultilineText(document.body?.innerText ?? "");
  const preferredText = articleText || mainText || bodyText;
  const resolvedMaxLength =
    Number.isFinite(maxLength) && maxLength > 1000 ? Math.floor(maxLength) : 12000;
  const text =
    preferredText.length > resolvedMaxLength
      ? `${preferredText.slice(0, resolvedMaxLength)}...`
      : preferredText;

  return {
    url: window.location.href,
    title: document.title,
    text,
  };
}

export function runReferenceHighlightScript(payload: BrowserViewReferenceHighlight) {
  const inlineMarkerAttribute = "data-deertube-inline-highlight";
  const inlineRefMarkerAttribute = "data-deertube-ref-marker";
  const inlineRefTooltipId = "deertube-ref-tooltip";
  const styleId = "deertube-ref-highlight-style";
  const lineNumberPrefix = /^\s*\d+\s+\|\s?/;
  const markdownHorizontalRule = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/;
  const markdownSymbolSet = new Set([
    "\\",
    "`",
    "*",
    "_",
    "~",
    "[",
    "]",
    "(",
    ")",
    "{",
    "}",
    "<",
    ">",
    "#",
    "+",
    "=",
    "|",
    "!",
    "-",
  ]);
  const punctuationMap: Record<string, string> = {
    "’": "'",
    "‘": "'",
    "ʼ": "'",
    "＇": "'",
    "“": "\"",
    "”": "\"",
    "„": "\"",
    "–": "-",
    "—": "-",
    "‑": "-",
    "−": "-",
  };
  const stripLineNumberPrefix = (value: string): string =>
    value
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(lineNumberPrefix);
        return match ? line.replace(lineNumberPrefix, "") : line;
      })
      .join("\n");
  const stripMarkdownSyntax = (value: string): string => {
    let text = value;
    text = text.replace(/```[\s\S]*?```/g, " ");
    text = text.replace(/`([^`]+)`/g, "$1");
    text = text.replace(/!\[([^\]]*)\]\((?:[^)\\]|\\.)*\)/g, "$1");
    text = text.replace(/\[([^\]]+)\]\((?:[^)\\]|\\.)*\)/g, "$1");
    text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
    text = text.replace(/\bhttps?:\/\/[^\s)]+/gi, " ");
    text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
    text = text.replace(/(\*|_)(.*?)\1/g, "$2");
    text = text.replace(/~~(.*?)~~/g, "$1");
    text = text.replace(/^>\s?/gm, "");
    text = text.replace(/^(\s*([-*+]|\d+[.)]))\s+/gm, "");
    return text;
  };
  const sanitizeExcerptForMatch = (value: string): string => {
    const withoutLineNumbers = stripLineNumberPrefix(value);
    const withoutMarkdown = stripMarkdownSyntax(withoutLineNumbers);
    const withoutTags = withoutMarkdown.replace(/<[^>]+>/g, " ");
    const cleanedLines = withoutTags
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
      .filter((line) => line.length > 0 && !markdownHorizontalRule.test(line));
    return cleanedLines.join("\n").trim();
  };
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/\s+/g, " ").trim();
  const collapseWhitespace = (value: string): string =>
    value.replace(/\s+/g, " ").trim();
  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizeCharacter = (value: string): string =>
    punctuationMap[value] ?? value;
  const normalizeComparableChar = (value: string): string => {
    const normalized = normalizeCharacter(value).normalize("NFKC").toLowerCase();
    if (markdownSymbolSet.has(normalized)) {
      return "";
    }
    if (/\p{L}|\p{N}/u.test(normalized)) {
      return normalized;
    }
    if (/\s/.test(normalized)) {
      return " ";
    }
    return " ";
  };
  const normalizeWithMap = (input: string, compact: boolean): { normalized: string; map: number[] } => {
    const map: number[] = [];
    let normalized = "";
    let sawContent = false;
    let inSpace = false;
    for (let index = 0; index < input.length; index += 1) {
      const char = normalizeComparableChar(input[index]);
      if (!char) {
        continue;
      }
      if (/\s/.test(char)) {
        if (compact) {
          continue;
        }
        if (!sawContent || inSpace) {
          continue;
        }
        normalized += " ";
        map.push(index);
        inSpace = true;
        continue;
      }
      sawContent = true;
      inSpace = false;
      normalized += char;
      map.push(index);
    }
    if (!compact && normalized.endsWith(" ")) {
      normalized = normalized.slice(0, -1);
      map.pop();
    }
    return { normalized, map };
  };
  const normalizeNeedle = (input: string, compact: boolean): string =>
    compact
      ? sanitizeExcerptForMatch(input)
        .replace(/\s+/g, "")
        .split("")
        .map((char) => normalizeComparableChar(char))
        .filter((char) => char.length > 0 && !/\s/.test(char))
        .join("")
      : collapseWhitespace(
        sanitizeExcerptForMatch(input)
          .split("")
          .map((char) => normalizeComparableChar(char))
          .filter((char) => char.length > 0)
          .join(""),
      );
  const findMappedRange = (
    text: string,
    candidate: string,
    compact: boolean,
  ): { start: number; end: number } | null => {
    const { normalized, map } = normalizeWithMap(text, compact);
    const target = normalizeNeedle(candidate, compact);
    const minLength = compact ? 6 : 4;
    if (!target || target.length < minLength) {
      return null;
    }
    const matchIndex = normalized.indexOf(target);
    if (matchIndex < 0) {
      return null;
    }
    const endIndex = matchIndex + target.length - 1;
    if (matchIndex >= map.length || endIndex >= map.length) {
      return null;
    }
    return {
      start: map[matchIndex],
      end: map[endIndex] + 1,
    };
  };
  const findRangeForCandidate = (
    text: string,
    candidate: string,
  ): { start: number; end: number; phrase: string } | null => {
    const phrase = candidate.trim();
    if (phrase.length < 4) {
      return null;
    }
    const exactRegex = new RegExp(
      escapeRegex(phrase).replace(/\s+/g, "\\s+"),
      "i",
    );
    const exactMatch = exactRegex.exec(text);
    if (exactMatch && typeof exactMatch.index === "number") {
      return {
        start: exactMatch.index,
        end: exactMatch.index + exactMatch[0].length,
        phrase,
      };
    }
    const normalized = findMappedRange(text, phrase, false);
    if (normalized) {
      return {
        start: normalized.start,
        end: normalized.end,
        phrase,
      };
    }
    const compact = findMappedRange(text, phrase, true);
    if (compact) {
      return {
        start: compact.start,
        end: compact.end,
        phrase,
      };
    }
    return null;
  };
  const tokenized = (value: string): string[] => {
    const normalized = normalize(sanitizeExcerptForMatch(value));
    const latinTokens = normalized
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    const cjkTokens = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    return Array.from(new Set([...latinTokens, ...cjkTokens])).slice(0, 36);
  };
  const extractPhrases = (excerpt: string): string[] => {
    const normalizedExcerpt = sanitizeExcerptForMatch(excerpt);
    const lines = normalizedExcerpt
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 8);
    const sentenceParts = normalizedExcerpt
      .split(/[。！？!?;；]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 10);
    const merged = [normalizedExcerpt.trim(), ...lines, ...sentenceParts]
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter((item) => item.length >= 8);
    const unique = Array.from(new Set(merged));
    unique.sort((a, b) => b.length - a.length);
    return unique.slice(0, 12);
  };
  const ensureStyle = () => {
    if (document.getElementById(styleId)) {
      return;
    }
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      mark[${inlineMarkerAttribute}="true"] {
        background: rgba(0, 245, 255, 0.62) !important;
        color: #00121a !important;
        border-radius: 0.18em !important;
        padding: 0 0.08em !important;
        box-shadow: 0 0 0 1px rgba(0, 220, 255, 0.7) inset !important;
      }
      span[${inlineRefMarkerAttribute}="true"] {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin-left: 0.35em !important;
        border-radius: 999px !important;
        border: 1px solid rgba(2, 132, 199, 0.52) !important;
        background: rgba(2, 132, 199, 0.14) !important;
        color: #075985 !important;
        font-size: 0.72em !important;
        font-weight: 700 !important;
        line-height: 1 !important;
        padding: 0.12em 0.44em !important;
        vertical-align: baseline !important;
        cursor: pointer !important;
      }
      #${inlineRefTooltipId} {
        position: fixed !important;
        z-index: 2147483647 !important;
        width: min(340px, calc(100vw - 24px)) !important;
        max-height: min(280px, calc(100vh - 24px)) !important;
        overflow-y: auto !important;
        border-radius: 10px !important;
        border: 1px solid rgba(15, 23, 42, 0.22) !important;
        background: rgba(255, 255, 255, 0.98) !important;
        color: #0f172a !important;
        box-shadow: 0 18px 40px rgba(2, 6, 23, 0.3) !important;
        padding: 10px !important;
        backdrop-filter: blur(6px) !important;
      }
      #${inlineRefTooltipId}[data-hidden="true"] {
        display: none !important;
      }
      #${inlineRefTooltipId} .deertube-ref-tooltip-title {
        font-size: 12px !important;
        font-weight: 700 !important;
        line-height: 1.3 !important;
        word-break: break-word !important;
      }
      #${inlineRefTooltipId} .deertube-ref-tooltip-meta {
        margin-top: 4px !important;
        font-size: 11px !important;
        color: rgba(15, 23, 42, 0.72) !important;
        line-height: 1.4 !important;
        word-break: break-word !important;
      }
      #${inlineRefTooltipId} .deertube-ref-tooltip-badge {
        margin-top: 6px !important;
        font-size: 10px !important;
        letter-spacing: 0.11em !important;
        text-transform: uppercase !important;
      }
      #${inlineRefTooltipId} .deertube-ref-tooltip-panel {
        margin-top: 8px !important;
        border-radius: 7px !important;
        padding: 6px 7px !important;
        font-size: 11px !important;
        line-height: 1.45 !important;
        word-break: break-word !important;
      }
      #${inlineRefTooltipId} .deertube-ref-tooltip-panel.warn {
        border: 1px solid rgba(220, 38, 38, 0.32) !important;
        background: rgba(254, 226, 226, 0.7) !important;
        color: #991b1b !important;
      }
      #${inlineRefTooltipId} .deertube-ref-tooltip-panel.good {
        border: 1px solid rgba(16, 185, 129, 0.32) !important;
        background: rgba(209, 250, 229, 0.72) !important;
        color: #065f46 !important;
      }
      #${inlineRefTooltipId} .deertube-ref-tooltip-panel.note {
        border: 1px solid rgba(148, 163, 184, 0.4) !important;
        background: rgba(241, 245, 249, 0.85) !important;
        color: #1e293b !important;
      }
    `;
    document.head.appendChild(style);
  };
  const clearExistingHighlights = () => {
    const marks = document.querySelectorAll<HTMLElement>(`mark[${inlineMarkerAttribute}="true"]`);
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) {
        return;
      }
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    });
    const markers = document.querySelectorAll<HTMLElement>(
      `span[${inlineRefMarkerAttribute}="true"]`,
    );
    markers.forEach((marker) => {
      marker.remove();
    });
    const tooltip = document.getElementById(inlineRefTooltipId);
    if (tooltip) {
      tooltip.remove();
    }
  };
  const collectTextNodes = (element: HTMLElement): Text[] => {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }
          const tag = parent.tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "noscript" || tag === "textarea") {
            return NodeFilter.FILTER_REJECT;
          }
          if (!node.textContent || node.textContent.trim().length === 0) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }
    return textNodes;
  };
  const findRangeInText = (
    text: string,
  candidates: string[],
  ): { start: number; end: number; phrase: string } | null => {
    for (const candidate of candidates) {
      const match = findRangeForCandidate(text, candidate);
      if (match) {
        return match;
      }
    }
    return null;
  };
  const applyInlineHighlight = (
    element: HTMLElement,
    start: number,
    end: number,
  ): number => {
    if (start < 0 || end <= start) {
      return 0;
    }
    const textNodes = collectTextNodes(element);
    if (textNodes.length === 0) {
      return 0;
    }
    let cursor = 0;
    let wrapped = 0;
    textNodes.forEach((textNode) => {
      const text = textNode.textContent ?? "";
      if (!text) {
        return;
      }
      const nodeStart = cursor;
      const nodeEnd = cursor + text.length;
      cursor = nodeEnd;
      if (end <= nodeStart || start >= nodeEnd) {
        return;
      }
      const overlapStart = Math.max(start, nodeStart);
      const overlapEnd = Math.min(end, nodeEnd);
      const localStart = overlapStart - nodeStart;
      const localEnd = overlapEnd - nodeStart;
      if (localEnd <= localStart) {
        return;
      }
      let workingNode: Text = textNode;
      if (localStart > 0) {
        workingNode = workingNode.splitText(localStart);
      }
      if (localEnd - localStart < workingNode.length) {
        workingNode.splitText(localEnd - localStart);
      }
      const parent = workingNode.parentNode;
      if (!parent) {
        return;
      }
      const mark = document.createElement("mark");
      mark.setAttribute(inlineMarkerAttribute, "true");
      parent.replaceChild(mark, workingNode);
      mark.appendChild(workingNode);
      wrapped += 1;
    });
    return wrapped;
  };
  const normalizeOptionalText = (value: unknown): string | null => {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const formatAccuracyLabel = (value: unknown): string | null => {
    if (value === "high") return "High";
    if (value === "medium") return "Medium";
    if (value === "low") return "Low";
    if (value === "conflicting") return "Conflicting";
    if (value === "insufficient") return "Insufficient";
    return null;
  };
  const formatSourceAuthorityLabel = (value: unknown): string | null => {
    if (value === "high") return "High";
    if (value === "medium") return "Medium";
    if (value === "low") return "Low";
    if (value === "unknown") return "Unknown";
    return null;
  };
  const getTooltipTextColor = (
    accuracy: string | null,
    sourceAuthority: string | null,
  ): string => {
    if (accuracy === "Conflicting" || accuracy === "Low") {
      return "#b91c1c";
    }
    if (sourceAuthority === "Low") {
      return "#b91c1c";
    }
    if (accuracy === "High" && sourceAuthority === "High") {
      return "#047857";
    }
    if (accuracy === "Medium" || sourceAuthority === "Medium") {
      return "#b45309";
    }
    return "rgba(15, 23, 42, 0.82)";
  };
  const createTooltipContainer = (): HTMLDivElement => {
    const existing = document.getElementById(inlineRefTooltipId);
    if (existing instanceof HTMLDivElement) {
      return existing;
    }
    const tooltip = document.createElement("div");
    tooltip.id = inlineRefTooltipId;
    tooltip.dataset.hidden = "true";
    document.body.appendChild(tooltip);
    return tooltip;
  };
  const setTooltipContent = (
    tooltip: HTMLDivElement,
    details: {
      title: string;
      url: string | null;
      lineLabel: string | null;
      accuracy: string | null;
      sourceAuthority: string | null;
      validationRefContent: string | null;
      issueReason: string | null;
      correctFact: string | null;
      excerpt: string;
    },
  ) => {
    tooltip.innerHTML = "";
    const titleNode = document.createElement("div");
    titleNode.className = "deertube-ref-tooltip-title";
    titleNode.textContent = details.title;
    tooltip.appendChild(titleNode);

    if (details.url) {
      const urlNode = document.createElement("div");
      urlNode.className = "deertube-ref-tooltip-meta";
      urlNode.textContent = details.url;
      tooltip.appendChild(urlNode);
    }
    if (details.lineLabel) {
      const linesNode = document.createElement("div");
      linesNode.className = "deertube-ref-tooltip-meta";
      linesNode.textContent = details.lineLabel;
      tooltip.appendChild(linesNode);
    }
    if (details.accuracy ?? details.sourceAuthority) {
      const badgeNode = document.createElement("div");
      badgeNode.className = "deertube-ref-tooltip-badge";
      badgeNode.style.color = getTooltipTextColor(
        details.accuracy,
        details.sourceAuthority,
      );
      badgeNode.textContent = [
        details.accuracy ? `Accuracy ${details.accuracy}` : null,
        details.sourceAuthority
          ? `Source Authority ${details.sourceAuthority}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      tooltip.appendChild(badgeNode);
    }
    if (details.issueReason) {
      const issueNode = document.createElement("div");
      issueNode.className = "deertube-ref-tooltip-panel warn";
      issueNode.textContent = `Why wrong: ${details.issueReason}`;
      tooltip.appendChild(issueNode);
    }
    if (details.correctFact) {
      const correctNode = document.createElement("div");
      correctNode.className = "deertube-ref-tooltip-panel good";
      correctNode.textContent = `Correct fact: ${details.correctFact}`;
      tooltip.appendChild(correctNode);
    }
    if (details.validationRefContent) {
      const validationNode = document.createElement("div");
      validationNode.className = "deertube-ref-tooltip-panel note";
      validationNode.textContent = details.validationRefContent;
      tooltip.appendChild(validationNode);
    }
    const excerptNode = document.createElement("div");
    excerptNode.className = "deertube-ref-tooltip-panel note";
    excerptNode.textContent = details.excerpt;
    tooltip.appendChild(excerptNode);
  };
  const positionTooltipNearAnchor = (
    tooltip: HTMLDivElement,
    anchor: HTMLElement,
  ) => {
    const margin = 12;
    const gap = 10;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(
      Math.max(260, tooltip.offsetWidth || 320),
      window.innerWidth - margin * 2,
    );
    const height = Math.min(
      Math.max(120, tooltip.offsetHeight || 190),
      window.innerHeight - margin * 2,
    );
    let left = rect.left - width - gap;
    if (left < margin) {
      const rightCandidate = rect.right + gap;
      if (rightCandidate + width <= window.innerWidth - margin) {
        left = rightCandidate;
      } else {
        left = Math.max(
          margin,
          Math.min(window.innerWidth - width - margin, left),
        );
      }
    }
    let top = rect.top + rect.height / 2 - height / 2;
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  };

  const excerptCandidates = Array.from(
    new Set(
      [
        typeof payload.text === "string" ? payload.text : "",
        ...(Array.isArray(payload.alternateTexts)
          ? payload.alternateTexts.filter(
              (candidate): candidate is string => typeof candidate === "string",
            )
          : []),
      ]
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0),
    ),
  );
  const rootElement = document.body;
  if (excerptCandidates.length === 0 || !rootElement) {
    return { ok: false, reason: "empty-target" };
  }

  interface HighlightMatchProfile {
    excerpt: string;
    sanitizedExcerpt: string;
    targetText: string;
    tokens: string[];
    phraseCandidates: string[];
    normalizedPhraseCandidates: string[];
    tokenCandidates: string[];
  }

  const matchProfiles = excerptCandidates
    .map((excerpt) => {
      const sanitizedExcerpt = sanitizeExcerptForMatch(excerpt);
      const normalizedExcerpt = sanitizedExcerpt || excerpt;
      const targetText = normalize(normalizedExcerpt);
      if (!targetText) {
        return null;
      }
      const tokens = tokenized(normalizedExcerpt);
      const phraseCandidates = extractPhrases(normalizedExcerpt);
      const normalizedPhraseCandidates = phraseCandidates
        .map((candidate) => normalize(candidate))
        .filter((candidate) => candidate.length >= 8);
      const shortExcerpt = collapseWhitespace(normalizedExcerpt).length <= 64;
      const tokenCandidates = shortExcerpt
        ? [...tokens].sort((left, right) => right.length - left.length)
        : [];
      return {
        excerpt,
        sanitizedExcerpt,
        targetText,
        tokens,
        phraseCandidates,
        normalizedPhraseCandidates,
        tokenCandidates,
      };
    })
    .filter((profile): profile is HighlightMatchProfile => profile !== null);
  if (matchProfiles.length === 0) {
    return { ok: false, reason: "empty-target" };
  }

  ensureStyle();
  if (payload.append !== true) {
    clearExistingHighlights();
  }

  const primarySelector = "p,li,blockquote,pre,code,h1,h2,h3,h4,h5,h6,td,th";
  const fallbackSelector = "article,section,main,div";

  const findBestMatchForProfile = ({
    profile,
    allowTokenFallback,
  }: {
    profile: HighlightMatchProfile;
    allowTokenFallback: boolean;
  }):
    | {
        selectedMatch: {
          element: HTMLElement;
          score: number;
          exact: boolean;
        };
        selectedRange: { start: number; end: number; phrase: string };
      }
    | null => {
    const candidateMatches: {
      element: HTMLElement;
      score: number;
      exact: boolean;
    }[] = [];
    const seenElements = new Set<HTMLElement>();
    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);
    let currentNode: Node | null = walker.nextNode();

    while (currentNode) {
      const parent = currentNode.parentElement;
      if (!parent) {
        currentNode = walker.nextNode();
        continue;
      }
      const tag = parent.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "textarea") {
        currentNode = walker.nextNode();
        continue;
      }
      const container =
        parent.closest<HTMLElement>(primarySelector) ??
        parent.closest<HTMLElement>(fallbackSelector) ??
        parent;
      if (seenElements.has(container)) {
        currentNode = walker.nextNode();
        continue;
      }
      seenElements.add(container);

      const content = normalize(container.innerText || container.textContent || "");
      if (!content) {
        currentNode = walker.nextNode();
        continue;
      }

      const exact = content.includes(profile.targetText);
      let score = exact ? 1400 + Math.min(500, profile.targetText.length) : 0;
      for (const phraseCandidate of profile.normalizedPhraseCandidates) {
        if (content.includes(phraseCandidate)) {
          score += 760 + Math.min(240, phraseCandidate.length * 2);
          break;
        }
      }
      for (const token of profile.tokens) {
        if (content.includes(token)) {
          score += 14;
        }
      }
      score -= Math.min(
        Math.abs(content.length - profile.targetText.length) / 30,
        130,
      );
      score -= Math.min(content.length / 240, 50);
      if (score <= 0) {
        currentNode = walker.nextNode();
        continue;
      }

      candidateMatches.push({
        element: container,
        score,
        exact,
      });

      currentNode = walker.nextNode();
    }

    if (candidateMatches.length === 0) {
      return null;
    }

    const sortedCandidateMatches = [...candidateMatches]
      .sort((left, right) => right.score - left.score)
      .slice(0, 16);
    for (const candidate of sortedCandidateMatches) {
      const textNodes = collectTextNodes(candidate.element);
      const combinedText = textNodes
        .map((node) => node.textContent ?? "")
        .join("");
      if (!combinedText.trim()) {
        continue;
      }
      const phraseRange = findRangeInText(combinedText, profile.phraseCandidates);
      const tokenRange =
        allowTokenFallback &&
        phraseRange === null &&
        profile.tokenCandidates.length > 0
          ? findRangeInText(combinedText, profile.tokenCandidates)
          : null;
      const range = phraseRange ?? tokenRange;
      if (!range) {
        continue;
      }
      return {
        selectedMatch: candidate,
        selectedRange: range,
      };
    }
    return null;
  };

  let selectedMatch:
    | {
        element: HTMLElement;
        score: number;
        exact: boolean;
      }
    | undefined;
  let selectedRange: { start: number; end: number; phrase: string } | null =
    null;
  let selectedProfile: HighlightMatchProfile | null = null;
  for (const profile of matchProfiles) {
    const selected = findBestMatchForProfile({
      profile,
      allowTokenFallback: false,
    });
    if (!selected) {
      continue;
    }
    selectedMatch = selected.selectedMatch;
    selectedRange = selected.selectedRange;
    selectedProfile = profile;
    break;
  }
  if (!selectedMatch || !selectedRange || !selectedProfile) {
    for (const profile of matchProfiles) {
      const selected = findBestMatchForProfile({
        profile,
        allowTokenFallback: true,
      });
      if (!selected) {
        continue;
      }
      selectedMatch = selected.selectedMatch;
      selectedRange = selected.selectedRange;
      selectedProfile = profile;
      break;
    }
  }
  if (!selectedMatch || !selectedRange || !selectedProfile) {
    return { ok: false, reason: "range-not-found" };
  }
  const target = selectedMatch.element;
  const range = selectedRange;

  const highlightedSegments = applyInlineHighlight(target, range.start, range.end);
  const firstInlineMark = target.querySelector<HTMLElement>(`mark[${inlineMarkerAttribute}="true"]`);
  const shouldShowMarker = payload.showMarker !== false;
  let markerAttached = false;
  if (firstInlineMark && shouldShowMarker) {
    const marker = document.createElement("span");
    marker.setAttribute(inlineRefMarkerAttribute, "true");
    marker.textContent = `[${payload.refId}]`;
    const tooltip = createTooltipContainer();
    const title =
      normalizeOptionalText(payload.title) ??
      normalizeOptionalText(payload.url) ??
      `Reference ${payload.refId}`;
    const lineLabel =
      typeof payload.startLine === "number" && typeof payload.endLine === "number"
        ? `Lines ${payload.startLine}-${payload.endLine}`
        : null;
    const accuracy = formatAccuracyLabel(payload.accuracy);
    const sourceAuthority = formatSourceAuthorityLabel(payload.sourceAuthority);
    const validationRefContent = normalizeOptionalText(payload.validationRefContent);
    const issueReason = normalizeOptionalText(payload.issueReason);
    const correctFact = normalizeOptionalText(payload.correctFact);
    const tooltipUrl = normalizeOptionalText(payload.url);
    const excerptText =
      normalizeOptionalText(selectedProfile.sanitizedExcerpt) ??
      normalizeOptionalText(selectedProfile.excerpt) ??
      "No excerpt available.";

    let hideTimer: number | null = null;
    const clearHideTimer = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const showTooltip = () => {
      clearHideTimer();
      setTooltipContent(tooltip, {
        title,
        url: tooltipUrl,
        lineLabel,
        accuracy,
        sourceAuthority,
        validationRefContent,
        issueReason,
        correctFact,
        excerpt: excerptText,
      });
      tooltip.dataset.hidden = "false";
      positionTooltipNearAnchor(tooltip, marker);
    };
    const scheduleHide = () => {
      clearHideTimer();
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        tooltip.dataset.hidden = "true";
      }, 130);
    };

    marker.addEventListener("mouseenter", showTooltip);
    marker.addEventListener("mouseleave", scheduleHide);
    marker.addEventListener("focus", showTooltip);
    marker.addEventListener("blur", scheduleHide);
    marker.tabIndex = 0;
    marker.style.userSelect = "none";

    tooltip.addEventListener("mouseenter", showTooltip);
    tooltip.addEventListener("mouseleave", scheduleHide);

    firstInlineMark.insertAdjacentElement("afterend", marker);
    markerAttached = true;
  }
  (firstInlineMark ?? target).scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });

  return {
    ok: highlightedSegments > 0,
    refId: payload.refId,
    score: selectedMatch.score,
    exact: selectedMatch.exact,
    highlightedSegments,
    markerAttached,
  };
}

function runClearReferenceHighlightScript() {
  const inlineMarkerAttribute = "data-deertube-inline-highlight";
  const inlineRefMarkerAttribute = "data-deertube-ref-marker";
  const inlineRefTooltipId = "deertube-ref-tooltip";
  const markedNodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      `mark[${inlineMarkerAttribute}="true"]`,
    ),
  );
  markedNodes.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  });
  document
    .querySelectorAll<HTMLElement>(`[${inlineRefMarkerAttribute}="true"]`)
    .forEach((node) => node.remove());
  const tooltip = document.getElementById(inlineRefTooltipId);
  if (tooltip) {
    tooltip.remove();
  }
  return { ok: true };
}

class BrowserViewController {
  private window: BrowserWindow | null = null;
  private views = new Map<string, WebContentsView>();
  private viewState = new Map<string, { url: string | null; bounds: BrowserViewBounds | null }>();
  private pendingHighlights = new Map<string, BrowserViewReferenceHighlight>();
  private senderToTab = new Map<number, string>();
  private listenersRegistered = false;

  attachWindow(window: BrowserWindow) {
    this.window = window;
  }

  private ensureView(tabId: string) {
    if (!this.window) {
      return null;
    }
    const existing = this.views.get(tabId);
    if (existing) {
      return existing;
    }
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: BROWSER_PRELOAD,
      },
    });
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.registerWebContentsHandlers(tabId, view);
    this.views.set(tabId, view);
    this.viewState.set(tabId, { url: null, bounds: null });
    return view;
  }

  private registerWebContentsHandlers(tabId: string, view: WebContentsView) {
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    view.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedUrl(url)) {
        event.preventDefault();
        return;
      }
      const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
      this.viewState.set(tabId, { ...state, url });
      this.sendState(tabId);
    });

    const handleNav = (_event: Electron.Event, url: string) => {
      if (isAllowedUrl(url)) {
        const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
        this.viewState.set(tabId, { ...state, url });
      }
      this.sendState(tabId);
    };

    view.webContents.on("did-navigate", handleNav);
    view.webContents.on("did-navigate-in-page", handleNav);
    view.webContents.on("did-start-loading", () => {
      this.sendState(tabId, { isLoading: true });
    });
    view.webContents.on("did-stop-loading", () => {
      this.sendState(tabId, { isLoading: false });
    });
    view.webContents.on("did-finish-load", () => {
      this.sendState(tabId);
      void this.applyPendingHighlight(tabId);
    });
    view.webContents.on("page-title-updated", (_event, title) => {
      this.sendState(tabId, { title });
    });

    this.senderToTab.set(view.webContents.id, tabId);

    if (this.listenersRegistered) {
      return;
    }
    this.listenersRegistered = true;
    ipcMain.on("browserview-selection", (event, payload) => {
      const senderId = event.sender.id;
      const selectionTabId = this.senderToTab.get(senderId);
      if (!selectionTabId) {
        return;
      }
      const viewForSender = this.views.get(selectionTabId);
      if (!viewForSender || event.sender !== viewForSender.webContents) {
        return;
      }
      if (!this.window) {
        return;
      }
      const selection = sanitizeSelection(payload as BrowserViewSelectionPayload);
      const state = this.viewState.get(selectionTabId);
      this.window.webContents.send("browserview-selection", {
        ...selection,
        tabId: selectionTabId,
        viewBounds: state?.bounds ?? null,
      });
    });
  }

  private sendState(tabId: string, partial?: Partial<BrowserViewState>) {
    if (!this.window) {
      return;
    }
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    const state = this.viewState.get(tabId);
    const payload: BrowserViewState = {
      tabId,
      url: state?.url ?? view.webContents.getURL(),
      title: view.webContents.getTitle(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
      isLoading: view.webContents.isLoadingMainFrame(),
      ...partial,
    };
    this.window.webContents.send("browserview-state", payload);
  }

  private async applyPendingHighlight(tabId: string): Promise<boolean> {
    const view = this.views.get(tabId);
    if (!view) {
      return false;
    }
    const payload = this.pendingHighlights.get(tabId);
    if (!payload) {
      return false;
    }
    if (view.webContents.isLoadingMainFrame()) {
      return false;
    }
    const result: unknown = await view.webContents.executeJavaScript(
      `(${runReferenceHighlightScript.toString()})(${JSON.stringify(payload)})`,
      true,
    );
    const ok = isJsonObject(result) && result.ok === true;
    if (ok) {
      this.pendingHighlights.delete(tabId);
    }
    return ok;
  }

  async captureValidationSnapshot(
    tabId: string,
  ): Promise<BrowserViewValidationSnapshot | null> {
    const view = this.views.get(tabId);
    if (!view) {
      return null;
    }
    const fallbackUrl = view.webContents.getURL();
    if (!isAllowedUrl(fallbackUrl)) {
      return null;
    }
    const result: unknown = await view.webContents.executeJavaScript(
      `(${runValidationSnapshotScript.toString()})(${MAX_VALIDATION_TEXT_LENGTH})`,
      true,
    );
    if (!isJsonObject(result)) {
      return null;
    }
    return sanitizeValidationSnapshot(
      result as BrowserViewValidationSnapshotPayload,
      fallbackUrl,
    );
  }

  async open(tabId: string, url: string, bounds: BrowserViewBounds) {
    if (!isAllowedUrl(url)) {
      return false;
    }
    const view = this.ensureView(tabId);
    if (!view) {
      return false;
    }
    const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
    const previousUrl = state.url;
    this.viewState.set(tabId, { url, bounds });
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    view.setVisible(true);
    if (previousUrl !== url) {
      await view.webContents.loadURL(url);
    } else {
      this.sendState(tabId);
      void this.applyPendingHighlight(tabId);
    }
    return true;
  }

  updateBounds(tabId: string, bounds: BrowserViewBounds) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
    this.viewState.set(tabId, { ...state, bounds });
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    view.setVisible(true);
  }

  hide() {
    this.views.forEach((view) => {
      view.setVisible(false);
    });
  }

  hideTab(tabId: string) {
    const view = this.views.get(tabId);
    if (view) {
      view.setVisible(false);
    }
  }

  reload(tabId: string) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    view.webContents.reload();
  }

  goBack(tabId: string) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    if (view.webContents.canGoBack()) {
      view.webContents.goBack();
    }
  }

  goForward(tabId: string) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    if (view.webContents.canGoForward()) {
      view.webContents.goForward();
    }
  }

  close(tabId: string) {
    const view = this.views.get(tabId);
    if (!view || !this.window) {
      return;
    }
    this.window.contentView.removeChildView(view);
    this.senderToTab.delete(view.webContents.id);
    this.views.delete(tabId);
    this.viewState.delete(tabId);
    this.pendingHighlights.delete(tabId);
  }

  closeAll() {
    const window = this.window;
    this.views.forEach((view, tabId) => {
      view.setVisible(false);
      if (window) {
        window.contentView.removeChildView(view);
      }
      this.senderToTab.delete(view.webContents.id);
      this.pendingHighlights.delete(tabId);
    });
    this.views.clear();
    this.viewState.clear();
    this.pendingHighlights.clear();
  }

  openExternal(url: string) {
    if (isAllowedUrl(url)) {
      void shell.openExternal(url);
    }
  }

  async highlightReference(tabId: string, reference: BrowserViewReferenceHighlight) {
    const view = this.views.get(tabId);
    if (!view) {
      return false;
    }
    const payload = sanitizeReferenceHighlight(reference);
    if (!payload.text) {
      return false;
    }
    const expectedUrl = normalizeComparableHighlightUrl(payload.url);
    const currentUrl = normalizeComparableHighlightUrl(view.webContents.getURL());
    if (expectedUrl && currentUrl && expectedUrl !== currentUrl) {
      return false;
    }
    this.pendingHighlights.set(tabId, payload);
    return this.applyPendingHighlight(tabId);
  }

  async clearReferenceHighlight(tabId: string): Promise<boolean> {
    const view = this.views.get(tabId);
    if (!view) {
      return false;
    }
    if (view.webContents.isLoadingMainFrame()) {
      return false;
    }
    const result: unknown = await view.webContents.executeJavaScript(
      `(${runClearReferenceHighlightScript.toString()})()`,
      true,
    );
    return isJsonObject(result) && result.ok === true;
  }
}

const browserViewController = new BrowserViewController();

export function getBrowserViewController() {
  return browserViewController;
}
