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
  return {
    refId: payload.refId,
    text:
      text.length > MAX_HIGHLIGHT_TEXT_LENGTH
        ? `${text.slice(0, MAX_HIGHLIGHT_TEXT_LENGTH)}...`
        : text,
    startLine: payload.startLine,
    endLine: payload.endLine,
  };
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

export function runReferenceHighlightScript(payload: { refId: number; text: string }) {
  const inlineMarkerAttribute = "data-deertube-inline-highlight";
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

  const excerpt = typeof payload.text === "string" ? payload.text : "";
  const sanitizedExcerpt = sanitizeExcerptForMatch(excerpt);
  const targetText = normalize(sanitizedExcerpt || excerpt);
  if (!targetText || !document.body) {
    return { ok: false, reason: "empty-target" };
  }

  ensureStyle();
  clearExistingHighlights();

  const tokens = tokenized(sanitizedExcerpt || excerpt);
  const primarySelector = "p,li,blockquote,pre,code,h1,h2,h3,h4,h5,h6,td,th";
  const fallbackSelector = "article,section,main,div";

  let bestMatch:
    | {
        element: HTMLElement;
        score: number;
        exact: boolean;
      }
    | null = null;
  const seenElements = new Set<HTMLElement>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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

    const exact = content.includes(targetText);
    let score = exact ? 1400 + Math.min(500, targetText.length) : 0;
    for (const token of tokens) {
      if (content.includes(token)) {
        score += 24;
      }
    }
    score -= Math.min(Math.abs(content.length - targetText.length) / 30, 130);
    score -= Math.min(content.length / 240, 50);
    if (score <= 0) {
      currentNode = walker.nextNode();
      continue;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        element: container,
        score,
        exact,
      };
    }

    currentNode = walker.nextNode();
  }

  if (!bestMatch) {
    return { ok: false, reason: "not-found" };
  }

  const target = bestMatch.element;
  const textNodes = collectTextNodes(target);
  const combinedText = textNodes.map((node) => node.textContent ?? "").join("");
  if (!combinedText.trim()) {
    return { ok: false, reason: "empty-element-text" };
  }

  const phraseCandidates = extractPhrases(sanitizedExcerpt || excerpt);
  const tokenCandidates = tokens.sort((a, b) => b.length - a.length);
  const range =
    findRangeInText(combinedText, phraseCandidates) ??
    findRangeInText(combinedText, tokenCandidates) ??
    {
      start: 0,
      end: Math.min(combinedText.length, Math.max(16, Math.min(120, excerpt.trim().length))),
      phrase: excerpt.trim().slice(0, 120),
    };

  const highlightedSegments = applyInlineHighlight(target, range.start, range.end);
  const firstInlineMark = target.querySelector<HTMLElement>(`mark[${inlineMarkerAttribute}="true"]`);
  (firstInlineMark ?? target).scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });

  return {
    ok: highlightedSegments > 0,
    refId: payload.refId,
    score: bestMatch.score,
    exact: bestMatch.exact,
    highlightedSegments,
  };
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
      `(${runReferenceHighlightScript.toString()})(${JSON.stringify({
        refId: payload.refId,
        text: payload.text,
      })})`,
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
    this.pendingHighlights.set(tabId, payload);
    return this.applyPendingHighlight(tabId);
  }
}

const browserViewController = new BrowserViewController();

export function getBrowserViewController() {
  return browserViewController;
}
