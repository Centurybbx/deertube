import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { runReferenceHighlightScript } from "./browserview";
import { isJsonObject, type JsonValue } from "../src/types/json";
import type { BrowserViewReferenceHighlight } from "../src/types/browserview";

interface CdpTargetDescriptor {
  id: string;
  webSocketDebuggerUrl: string;
  url?: string;
  title?: string;
}

interface CdpCommandPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CdpSession {
  id: string;
  targetId: string;
  socket: WebSocket;
  nextCommandId: number;
  pending: Map<number, CdpCommandPending>;
  pendingHighlight?: BrowserViewReferenceHighlight;
  referenceHighlight?: BrowserViewReferenceHighlight;
  controlsUiScriptInstalled: boolean;
  lastSelectionSignature: string;
}

interface CdpSelectionBridgePayload {
  text?: JsonValue;
  url?: JsonValue;
  title?: JsonValue;
  rect?: JsonValue;
}

interface SanitizedSelectionPayload {
  text: string;
  url: string;
  title?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface CdpInPageActionPayload {
  type?: JsonValue;
  url?: JsonValue;
  title?: JsonValue;
}

interface CdpValidationSnapshotPayload {
  text?: JsonValue;
  url?: JsonValue;
  title?: JsonValue;
}

interface CdpValidationSnapshot {
  text: string;
  url: string;
  title?: string;
}

type CdpValidationIndicatorState = "idle" | "running" | "complete" | "failed";

type CdpProfileMode = "shared" | "shared-first" | "isolated";
type CdpEndpointLaunchMode =
  | "attached-existing"
  | "spawned-shared-profile"
  | "spawned-isolated-profile";

const CDP_ENDPOINT_ORIGIN = "http://127.0.0.1:9222";
const CDP_ENDPOINT_VERSION_PATH = "/json/version";
const CDP_ENDPOINT_LIST_PATH = "/json/list";
const CDP_READY_TIMEOUT_MS = 12000;
const CDP_REQUEST_TIMEOUT_MS = 2500;
const CDP_COMMAND_TIMEOUT_MS = 12000;
const CDP_SELECTION_BINDING_NAME = "__deertubeEmitSelection";
const CDP_ACTION_BINDING_NAME = "__deertubeAction";
const MAX_SELECTION_LENGTH = 5000;
const SELECTION_THROTTLE_MS = 180;
const MAX_HIGHLIGHT_TEXT_LENGTH = 4000;
const MAX_VALIDATION_TEXT_LENGTH = 18000;
const MAX_HIGHLIGHT_RETRY_ATTEMPTS = 18;
const DEFAULT_CDP_PROFILE_MODE: CdpProfileMode = "shared-first";
const CDP_PROFILE_MODE_ENV_KEY = "DEERTUBE_CDP_PROFILE_MODE";
const CDP_DEBUG_ENABLED = process.env.DEERTUBE_CDP_DEBUG !== "0";
const CDP_LOG_PREFIX = "[cdp-browser]";
const CDP_VALIDATE_LOG_PREFIX = "[validate][cdp]";

const normalizeHttpUrl = (value: string): string | null => {
  if (!URL.canParse(value)) {
    return null;
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed.toString();
};

const toError = (error: unknown, fallbackMessage: string): Error =>
  error instanceof Error ? error : new Error(fallbackMessage);

const hasNodeErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const parseJsonString = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw toError(error, "Failed to parse JSON payload.");
  }
};

const isExpectedEndpointCheckError = (error: unknown): boolean => {
  if (error instanceof TypeError) {
    return true;
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error instanceof Error) {
    return error.name === "AbortError";
  }
  return false;
};

const cdpDebugLog = (...parts: unknown[]) => {
  if (!CDP_DEBUG_ENABLED) {
    return;
  }
  console.info(CDP_LOG_PREFIX, ...parts);
};

const cdpWarnLog = (...parts: unknown[]) => {
  console.warn(CDP_LOG_PREFIX, ...parts);
};

const cdpErrorLog = (...parts: unknown[]) => {
  console.error(CDP_LOG_PREFIX, ...parts);
};

const cdpValidateLog = (
  event: string,
  payload?: Record<string, unknown>,
) => {
  if (payload) {
    console.info(CDP_VALIDATE_LOG_PREFIX, event, payload);
    return;
  }
  console.info(CDP_VALIDATE_LOG_PREFIX, event);
};

const fetchJson = async (
  url: string,
  init?: RequestInit,
  timeoutMs = CDP_REQUEST_TIMEOUT_MS,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
};

const fetchOk = async (
  url: string,
  init?: RequestInit,
  timeoutMs = CDP_REQUEST_TIMEOUT_MS,
): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

const readCdpProfileMode = (): CdpProfileMode => {
  const value = process.env[CDP_PROFILE_MODE_ENV_KEY]?.trim().toLowerCase();
  if (value === "shared") {
    return "shared";
  }
  if (value === "isolated") {
    return "isolated";
  }
  return DEFAULT_CDP_PROFILE_MODE;
};

const toMessageText = (data: unknown): string | null => {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf-8");
  }
  if (
    Array.isArray(data) &&
    data.every(
      (item) =>
        Buffer.isBuffer(item) || item instanceof ArrayBuffer || ArrayBuffer.isView(item),
    )
  ) {
    const buffers = data.map((item) => {
      if (Buffer.isBuffer(item)) {
        return item;
      }
      if (item instanceof ArrayBuffer) {
        return Buffer.from(item);
      }
      return Buffer.from(item.buffer, item.byteOffset, item.byteLength);
    });
    return Buffer.concat(buffers).toString("utf-8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(
      "utf-8",
    );
  }
  return null;
};

const sanitizeSelectionPayload = (
  payload: CdpSelectionBridgePayload,
): SanitizedSelectionPayload => {
  const textRaw = typeof payload.text === "string" ? payload.text : "";
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
  const text =
    textRaw.length > MAX_SELECTION_LENGTH
      ? `${textRaw.slice(0, MAX_SELECTION_LENGTH)}...`
      : textRaw;
  return { text, url, title, rect };
};

const sanitizeReferenceHighlight = (
  payload: BrowserViewReferenceHighlight,
): BrowserViewReferenceHighlight => {
  const text = payload.text.trim();
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

const buildSelectionBridgeScript = (): string => `
(() => {
  const bindingName = ${JSON.stringify(CDP_SELECTION_BINDING_NAME)};
  const installedKey = "__deertubeSelectionBridgeInstalled";
  if (window[installedKey]) {
    return;
  }
  window[installedKey] = true;
  const maxSelectionLength = ${MAX_SELECTION_LENGTH};
  const throttleMs = ${SELECTION_THROTTLE_MS};
  let lastText = "";
  let lastUrl = "";
  let scheduled = false;
  const emitPayload = (payload) => {
    const binding = window[bindingName];
    if (typeof binding !== "function") {
      return;
    }
    binding(JSON.stringify(payload));
  };
  const buildPayload = () => {
    const selection = window.getSelection();
    const rawText = selection ? selection.toString() : "";
    const text =
      rawText.length > maxSelectionLength
        ? rawText.slice(0, maxSelectionLength) + "..."
        : rawText;
    let rect;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const bounds = range.getBoundingClientRect();
      if (bounds && (bounds.width > 0 || bounds.height > 0)) {
        rect = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      }
    }
    return {
      text,
      url: window.location.href,
      title: document.title,
      rect,
    };
  };
  const sendSelection = () => {
    const payload = buildPayload();
    if (payload.text === lastText && payload.url === lastUrl) {
      return;
    }
    lastText = payload.text;
    lastUrl = payload.url;
    emitPayload(payload);
  };
  const scheduleSend = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      sendSelection();
    }, throttleMs);
  };
  document.addEventListener("selectionchange", scheduleSend);
  document.addEventListener("mouseup", sendSelection);
  document.addEventListener("keyup", scheduleSend);
  window.addEventListener("blur", () => {
    emitPayload({
      text: "",
      url: window.location.href,
      title: document.title,
    });
  });
})();
`;

const sanitizeValidationSnapshot = (
  payload: CdpValidationSnapshotPayload,
  fallbackUrl: string,
): CdpValidationSnapshot | null => {
  const url =
    typeof payload.url === "string" && payload.url.trim().length > 0
      ? payload.url.trim()
      : fallbackUrl;
  const normalizedUrl = normalizeHttpUrl(url);
  if (!normalizedUrl) {
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
    url: normalizedUrl,
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

const buildInPageControlsScript = (
  reference?: BrowserViewReferenceHighlight,
): string => `
(() => {
  const styleId = "deertube-cdp-controls-style";
  const rootId = "deertube-cdp-controls-root";
  const locateButtonId = "deertube-cdp-locate-button";
  const validateButtonId = "deertube-cdp-validate-button";
  const stopValidateButtonId = "deertube-cdp-stop-validate-button";
  const openChatButtonId = "deertube-cdp-open-chat-button";
  const applyStateFnName = "__deertubeApplyValidationState";
  const actionBindingName = ${JSON.stringify(CDP_ACTION_BINDING_NAME)};
  const refPayload = ${JSON.stringify(
    reference ?? null,
  )};
  const runHighlight = ${runReferenceHighlightScript.toString()};
  const log = (...args) => {
    console.info("[cdp-page]", ...args);
  };
  const ensureStyle = () => {
    if (document.getElementById(styleId)) {
      return;
    }
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = \`
      #\${rootId} {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #\${rootId} .deertube-cdp-btn {
        border: 1px solid rgba(15, 23, 42, 0.24);
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        line-height: 1;
        font-weight: 600;
        color: #0f172a;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 6px 18px rgba(2, 6, 23, 0.18);
        backdrop-filter: blur(6px);
        cursor: pointer;
        transition: transform 120ms ease, box-shadow 120ms ease, background 140ms ease;
      }
      #\${rootId} .deertube-cdp-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 9px 20px rgba(2, 6, 23, 0.24);
      }
      #\${rootId} .deertube-cdp-btn:disabled {
        opacity: 0.58;
        cursor: not-allowed;
        transform: none;
      }
      #\${rootId} .deertube-cdp-btn[data-state="running"] {
        background: rgba(14, 165, 233, 0.2);
        color: #0c4a6e;
      }
      #\${rootId} .deertube-cdp-btn[data-state="complete"] {
        background: rgba(16, 185, 129, 0.2);
        color: #065f46;
      }
      #\${rootId} .deertube-cdp-btn[data-state="failed"] {
        background: rgba(239, 68, 68, 0.2);
        color: #7f1d1d;
      }
      #\${rootId} .deertube-cdp-btn[data-variant="stop"] {
        border-color: rgba(220, 38, 38, 0.35);
        color: #7f1d1d;
        background: rgba(248, 113, 113, 0.18);
      }
    \`;
    document.head.appendChild(style);
  };
  const ensureRoot = () => {
    const existing = document.getElementById(rootId);
    if (existing instanceof HTMLDivElement) {
      return existing;
    }
    const root = document.createElement("div");
    root.id = rootId;
    const mountTarget = document.body ?? document.documentElement;
    mountTarget.appendChild(root);
    return root;
  };
  const ensureButton = (root, buttonId, label, title) => {
    const existing = document.getElementById(buttonId);
    if (existing instanceof HTMLButtonElement) {
      return existing;
    }
    const button = document.createElement("button");
    button.id = buttonId;
    button.type = "button";
    button.className = "deertube-cdp-btn";
    button.textContent = label;
    button.title = title;
    button.setAttribute("data-state", "idle");
    root.appendChild(button);
    return button;
  };
  const setButtonState = (button, state, label, title) => {
    button.setAttribute("data-state", state);
    button.textContent = label;
    button.title = title;
  };
  const emitAction = (payload) => {
    const binding = window[actionBindingName];
    if (typeof binding !== "function") {
      log("action-binding:missing");
      return;
    }
    binding(JSON.stringify(payload));
  };
  const applyValidationState = (input) => {
    const state = typeof input?.status === "string" ? input.status : "idle";
    const message = typeof input?.message === "string" ? input.message : "";
    const validateButton = document.getElementById(validateButtonId);
    const stopButton = document.getElementById(stopValidateButtonId);
    if (!(validateButton instanceof HTMLButtonElement)) {
      return;
    }
    if (!(stopButton instanceof HTMLButtonElement)) {
      return;
    }
    if (state === "running") {
      setButtonState(
        validateButton,
        "running",
        "Validating...",
        "Validating current page content...",
      );
      stopButton.disabled = false;
      setButtonState(stopButton, "failed", "Stop", "Stop current page validation");
      return;
    }
    if (state === "complete") {
      setButtonState(
        validateButton,
        "complete",
        "Validated",
        message || "Validation completed",
      );
      stopButton.disabled = true;
      setButtonState(stopButton, "idle", "Stop", "Stop current page validation");
      return;
    }
    if (state === "failed") {
      const stoppedByUser = /stopped by user|abort/i.test(message);
      setButtonState(
        validateButton,
        "failed",
        stoppedByUser ? "Validation Stopped" : "Validate Failed",
        message || (stoppedByUser ? "Validation stopped by user" : "Validation failed"),
      );
      stopButton.disabled = true;
      setButtonState(stopButton, "idle", "Stop", "Stop current page validation");
      return;
    }
    setButtonState(
      validateButton,
      "idle",
      "Validate",
      "Validate current page content",
    );
    stopButton.disabled = true;
    setButtonState(stopButton, "idle", "Stop", "Stop current page validation");
  };
  window[applyStateFnName] = applyValidationState;

  ensureStyle();
  const root = ensureRoot();
  const locateButton = ensureButton(
    root,
    locateButtonId,
    "Locate Ref",
    "Scroll and highlight reference",
  );
  const validateButton = ensureButton(
    root,
    validateButtonId,
    "Validate",
    "Validate current page content",
  );
  const stopValidateButton = ensureButton(
    root,
    stopValidateButtonId,
    "Stop",
    "Stop current page validation",
  );
  stopValidateButton.setAttribute("data-variant", "stop");
  const openChatButton = ensureButton(
    root,
    openChatButtonId,
    "Open Chat",
    "Open validation chat",
  );

  if (!refPayload || typeof refPayload.text !== "string" || !refPayload.text.trim()) {
    locateButton.style.display = "none";
    locateButton.onclick = null;
  } else {
    locateButton.style.display = "";
    locateButton.disabled = false;
    locateButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setButtonState(locateButton, "running", "Locating...", "Locating reference...");
      const result = runHighlight(refPayload);
      const ok = Boolean(result && typeof result === "object" && result.ok === true);
      setButtonState(
        locateButton,
        ok ? "complete" : "failed",
        ok ? "Located" : "Not Found",
        ok ? "Reference located in page" : "Reference text not found in current page",
      );
      window.setTimeout(() => {
        setButtonState(
          locateButton,
          "idle",
          "Locate Ref",
          "Scroll and highlight reference",
        );
      }, ok ? 1200 : 1600);
      log("locate-button:result", { ok });
    };
  }

  validateButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyValidationState({ status: "running" });
    emitAction({
      type: "validate",
      url: window.location.href,
      title: document.title,
    });
  };
  stopValidateButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    emitAction({
      type: "validate-stop",
      url: window.location.href,
      title: document.title,
    });
  };
  openChatButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    emitAction({
      type: "open-validation-chat",
      url: window.location.href,
      title: document.title,
    });
  };

  applyValidationState({ status: "idle" });
  log("controls-script:ready", {
    href: window.location.href,
    hasReference: Boolean(refPayload && typeof refPayload.text === "string" && refPayload.text.trim()),
  });
})();
`;

const buildApplyValidationIndicatorScript = (input: {
  status: CdpValidationIndicatorState;
  message?: string;
}): string => `
(() => {
  const applyState = window.__deertubeApplyValidationState;
  if (typeof applyState !== "function") {
    return { ok: false, reason: "apply-state-missing" };
  }
  applyState(${JSON.stringify({
    status: input.status,
    message: input.message,
  })});
  return { ok: true };
})();
`;

const tryCandidatePaths = async (candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
        continue;
      }
      throw error;
    }
  }
  return null;
};

const getChromeExecutableCandidates = (): string[] => {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
};

class CdpBrowserController {
  private window: BrowserWindow | null = null;
  private chromeProcesses = new Set<ChildProcess>();
  private sessions = new Map<string, CdpSession>();

  attachWindow(window: BrowserWindow) {
    this.window = window;
    cdpDebugLog("attachWindow", { windowId: window.id });
  }

  private async isEndpointReady(): Promise<boolean> {
    try {
      await fetchJson(`${CDP_ENDPOINT_ORIGIN}${CDP_ENDPOINT_VERSION_PATH}`);
      return true;
    } catch (error) {
      if (isExpectedEndpointCheckError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async resolveChromeExecutable(): Promise<string | null> {
    const fromEnv = process.env.DEERTUBE_CHROME_PATH?.trim();
    if (fromEnv) {
      const found = await tryCandidatePaths([fromEnv]);
      if (found) {
        return found;
      }
    }
    return tryCandidatePaths(getChromeExecutableCandidates());
  }

  private async launchChromeProcess(mode: "shared" | "isolated"): Promise<void> {
    const executablePath = await this.resolveChromeExecutable();
    if (!executablePath) {
      throw new Error("Chrome executable not found for CDP mode.");
    }
    const args: string[] = [
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (mode === "isolated") {
      const userDataDir = path.join(app.getPath("userData"), "cdp-chrome-profile");
      await fs.mkdir(userDataDir, { recursive: true });
      args.push(`--user-data-dir=${userDataDir}`);
    }
    const processRef = spawn(executablePath, args, {
      stdio: "ignore",
      detached: false,
    });
    cdpWarnLog("launchChromeProcess", {
      mode,
      executablePath,
      args,
      pid: processRef.pid ?? null,
    });
    processRef.unref();
    processRef.once("exit", () => {
      this.chromeProcesses.delete(processRef);
    });
    this.chromeProcesses.add(processRef);
  }

  private async waitForEndpointReady(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isEndpointReady()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    return false;
  }

  private async ensureEndpointReady(): Promise<CdpEndpointLaunchMode> {
    cdpDebugLog("ensureEndpointReady:start");
    if (await this.isEndpointReady()) {
      cdpDebugLog("ensureEndpointReady:attached-existing");
      return "attached-existing";
    }
    const profileMode = readCdpProfileMode();
    cdpWarnLog("ensureEndpointReady:missing-endpoint", {
      profileMode,
      endpoint: CDP_ENDPOINT_ORIGIN,
    });
    if (profileMode === "shared") {
      throw new Error(
        "CDP shared-profile mode requires an existing Chrome started with --remote-debugging-port=9222.",
      );
    }
    // shared-first: only attach when endpoint already exists; otherwise avoid
    // mutating user's live browser session and start an isolated debugging Chrome.
    await this.launchChromeProcess("isolated");
    if (await this.waitForEndpointReady(CDP_READY_TIMEOUT_MS)) {
      cdpWarnLog("ensureEndpointReady:spawned-isolated-profile");
      return "spawned-isolated-profile";
    }
    cdpErrorLog("ensureEndpointReady:timeout", {
      endpoint: CDP_ENDPOINT_ORIGIN,
    });
    throw new Error("CDP endpoint is not reachable at http://127.0.0.1:9222.");
  }

  private parseTargetDescriptor(value: unknown): CdpTargetDescriptor | null {
    if (!isJsonObject(value)) {
      return null;
    }
    const id = typeof value.id === "string" ? value.id : null;
    const webSocketDebuggerUrl =
      typeof value.webSocketDebuggerUrl === "string"
        ? value.webSocketDebuggerUrl
        : null;
    if (!id || !webSocketDebuggerUrl) {
      return null;
    }
    return {
      id,
      webSocketDebuggerUrl,
      url: typeof value.url === "string" ? value.url : undefined,
      title: typeof value.title === "string" ? value.title : undefined,
    };
  }

  private async createTarget(url: string): Promise<CdpTargetDescriptor> {
    const encodedUrl = encodeURIComponent(url);
    const attempts: { init: RequestInit; path: string }[] = [
      { init: { method: "PUT" }, path: `/json/new?${encodedUrl}` },
      { init: { method: "GET" }, path: `/json/new?${encodedUrl}` },
      { init: { method: "PUT" }, path: `/json/new?url=${encodedUrl}` },
      { init: { method: "GET" }, path: `/json/new?url=${encodedUrl}` },
    ];
    let lastError: Error | null = null;
    for (const attempt of attempts) {
      try {
        cdpDebugLog("createTarget:attempt", {
          path: attempt.path,
          method: attempt.init.method,
          url,
        });
        const raw = await fetchJson(
          `${CDP_ENDPOINT_ORIGIN}${attempt.path}`,
          attempt.init,
        );
        const target = this.parseTargetDescriptor(raw);
        if (target) {
          cdpDebugLog("createTarget:success", {
            targetId: target.id,
            targetUrl: target.url ?? null,
          });
          return target;
        }
      } catch (error) {
        lastError = toError(error, "Failed to create CDP target.");
        cdpWarnLog("createTarget:attempt-failed", {
          path: attempt.path,
          method: attempt.init.method,
          message: lastError.message,
        });
      }
    }
    const listRaw = await fetchJson(`${CDP_ENDPOINT_ORIGIN}${CDP_ENDPOINT_LIST_PATH}`);
    if (Array.isArray(listRaw)) {
      for (const item of listRaw) {
        const target = this.parseTargetDescriptor(item);
        if (!target) {
          continue;
        }
        if (target.url === url) {
          cdpDebugLog("createTarget:matched-existing", {
            targetId: target.id,
          });
          return target;
        }
      }
    }
    throw lastError ?? new Error("Unable to create CDP browser target.");
  }

  private async activateTarget(targetId: string): Promise<void> {
    const encodedTargetId = encodeURIComponent(targetId);
    const attempts: RequestInit[] = [
      { method: "GET" },
      { method: "PUT" },
      { method: "POST" },
    ];
    let lastError: Error | null = null;
    for (const init of attempts) {
      try {
        await fetchOk(
          `${CDP_ENDPOINT_ORIGIN}/json/activate/${encodedTargetId}`,
          init,
        );
        cdpDebugLog("activateTarget:success", {
          targetId,
          method: init.method,
        });
        return;
      } catch (error) {
        lastError = toError(error, "Failed to activate CDP target.");
        cdpWarnLog("activateTarget:attempt-failed", {
          targetId,
          method: init.method,
          message: lastError.message,
        });
      }
    }
    throw lastError ?? new Error(`Failed to activate CDP target ${targetId}.`);
  }

  private async createSocketConnection(webSocketUrl: string): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Timed out while connecting to CDP target."));
      }, 8000);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        cdpDebugLog("socket:open", { webSocketUrl });
        resolve(socket);
      };
      const handleError = (error: Error) => {
        cleanup();
        cdpErrorLog("socket:error", { webSocketUrl, message: error.message });
        reject(new Error("Failed to connect websocket for CDP target."));
      };
      socket.on("open", handleOpen);
      socket.on("error", handleError);
    });
  }

  private handleSocketClosed(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const pendingError = new Error("CDP session closed.");
    session.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(pendingError);
    });
    session.pending.clear();
    cdpWarnLog("session:closed", {
      sessionId,
      targetId: session.targetId,
      pendingCommands: session.pending.size,
    });
    this.sessions.delete(sessionId);
  }

  private handleSelectionBinding(session: CdpSession, params: unknown) {
    if (!isJsonObject(params)) {
      return;
    }
    const name = typeof params.name === "string" ? params.name : "";
    const payloadString = typeof params.payload === "string" ? params.payload : "";
    if (name !== CDP_SELECTION_BINDING_NAME || !payloadString) {
      return;
    }
    const parsed = parseJsonString(payloadString);
    const selection = sanitizeSelectionPayload(
      (parsed as CdpSelectionBridgePayload | null) ?? {},
    );
    if (!this.window) {
      return;
    }
    const signature = `${selection.url}::${selection.text}`;
    if (signature === session.lastSelectionSignature) {
      return;
    }
    session.lastSelectionSignature = signature;
    cdpDebugLog("selection", {
      sessionId: session.id,
      url: selection.url,
      textLength: selection.text.length,
    });
    this.window.webContents.send("browserview-selection", {
      ...selection,
      tabId: `cdp:${session.id}`,
      viewBounds: null,
    });
  }

  private handleActionBinding(session: CdpSession, params: unknown) {
    if (!isJsonObject(params)) {
      return;
    }
    const name = typeof params.name === "string" ? params.name : "";
    const payloadString = typeof params.payload === "string" ? params.payload : "";
    if (name !== CDP_ACTION_BINDING_NAME || !payloadString) {
      return;
    }
    const parsed = parseJsonString(payloadString);
    if (!isJsonObject(parsed)) {
      return;
    }
    const actionPayload = parsed as CdpInPageActionPayload;
    const actionType =
      typeof actionPayload.type === "string" ? actionPayload.type : "";
    if (
      actionType !== "validate" &&
      actionType !== "validate-stop" &&
      actionType !== "open-validation-chat"
    ) {
      return;
    }
    cdpValidateLog("action", {
      sessionId: session.id,
      actionType,
    });
    if (!this.window) {
      return;
    }
    if (actionType === "validate-stop") {
      cdpValidateLog("send-stop-request", {
        sessionId: session.id,
      });
      this.window.webContents.send("cdp-browser-validate-stop-request", {
        sessionId: session.id,
      });
      return;
    }
    const resolvedUrl =
      typeof actionPayload.url === "string"
        ? normalizeHttpUrl(actionPayload.url)
        : null;
    const title =
      typeof actionPayload.title === "string" &&
      actionPayload.title.trim().length > 0
        ? actionPayload.title.trim()
        : undefined;
    if (actionType === "open-validation-chat") {
      cdpValidateLog("send-open-chat-request", {
        sessionId: session.id,
        url: resolvedUrl,
      });
      this.window.webContents.send("cdp-browser-open-validation-chat-request", {
        sessionId: session.id,
        url: resolvedUrl ?? "",
        title,
      });
      return;
    }
    cdpValidateLog("send-validate-request", {
      sessionId: session.id,
      url: resolvedUrl,
      title,
    });
    this.window.webContents.send("cdp-browser-validate-request", {
      sessionId: session.id,
      url: resolvedUrl ?? "",
      title,
    });
  }

  private handleSocketMessage(session: CdpSession, rawText: string) {
    const message = parseJsonString(rawText);
    if (!isJsonObject(message)) {
      return;
    }
    const responseId =
      typeof message.id === "number" && Number.isFinite(message.id)
        ? message.id
        : null;
    if (responseId !== null) {
      const pending = session.pending.get(responseId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      session.pending.delete(responseId);
      if (isJsonObject(message.error)) {
        const errorMessage =
          typeof message.error.message === "string"
            ? message.error.message
            : "CDP command failed.";
        pending.reject(new Error(errorMessage));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    if (!method) {
      return;
    }
    if (method === "Runtime.bindingCalled") {
      this.handleSelectionBinding(session, message.params);
      this.handleActionBinding(session, message.params);
      return;
    }
    if (
      method === "Page.domContentEventFired" ||
      method === "Page.loadEventFired" ||
      method === "Page.frameStoppedLoading"
    ) {
      cdpDebugLog("page:event", { sessionId: session.id, method });
      void this.ensureInPageControls(session.id);
      void this.applyPendingHighlight(session.id);
      return;
    }
    if (method === "Page.lifecycleEvent") {
      const params = message.params;
      if (!isJsonObject(params)) {
        return;
      }
      const eventName = typeof params.name === "string" ? params.name : "";
      if (
        eventName === "init" ||
        eventName === "DOMContentLoaded" ||
        eventName === "firstContentfulPaint" ||
        eventName === "networkAlmostIdle" ||
        eventName === "networkIdle" ||
        eventName === "load"
      ) {
        cdpDebugLog("page:lifecycle", {
          sessionId: session.id,
          eventName,
        });
        void this.ensureInPageControls(session.id);
        void this.applyPendingHighlight(session.id);
      }
    }
  }

  private async sendCommand(
    session: CdpSession,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (session.socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP socket is not open.");
    }
    const commandId = session.nextCommandId;
    session.nextCommandId += 1;
    const payload = JSON.stringify({
      id: commandId,
      method,
      params: params ?? {},
    });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(commandId);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      session.pending.set(commandId, { resolve, reject, timer });
      cdpDebugLog("cdp:send", {
        sessionId: session.id,
        commandId,
        method,
      });
      try {
        session.socket.send(payload);
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(commandId);
        reject(
          error instanceof Error
            ? error
            : new Error(`Failed to send CDP command: ${method}`),
        );
      }
    });
  }

  private async installSessionScripts(session: CdpSession): Promise<void> {
    const selectionScript = buildSelectionBridgeScript();
    await this.sendCommand(session, "Runtime.enable");
    await this.sendCommand(session, "Page.enable");
    await this.sendCommand(session, "Page.setLifecycleEventsEnabled", {
      enabled: true,
    });
    await this.sendCommand(session, "Runtime.addBinding", {
      name: CDP_SELECTION_BINDING_NAME,
    });
    await this.sendCommand(session, "Runtime.addBinding", {
      name: CDP_ACTION_BINDING_NAME,
    });
    await this.sendCommand(session, "Page.addScriptToEvaluateOnNewDocument", {
      source: selectionScript,
    });
    await this.sendCommand(session, "Runtime.evaluate", {
      expression: selectionScript,
      returnByValue: true,
    });
    cdpDebugLog("installSessionScripts:done", {
      sessionId: session.id,
      targetId: session.targetId,
    });
  }

  private readRuntimeEvaluateValue(result: unknown): unknown {
    if (!isJsonObject(result)) {
      return undefined;
    }
    const runtimeResult = result.result;
    if (!isJsonObject(runtimeResult)) {
      return undefined;
    }
    return "value" in runtimeResult ? runtimeResult.value : undefined;
  }

  async captureValidationSnapshot(
    sessionId: string,
  ): Promise<CdpValidationSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`CDP session not found: ${sessionId}`);
    }
    cdpValidateLog("capture-snapshot:start", {
      sessionId,
    });
    const urlResult = await this.sendCommand(session, "Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    });
    const value = this.readRuntimeEvaluateValue(urlResult);
    const fallbackUrl = typeof value === "string" ? value : "";
    const normalizedFallbackUrl = normalizeHttpUrl(fallbackUrl);
    if (!normalizedFallbackUrl) {
      throw new Error("CDP validation snapshot URL is not a valid http(s) page.");
    }
    const evaluateResult = await this.sendCommand(session, "Runtime.evaluate", {
      expression: `(${runValidationSnapshotScript.toString()})(${MAX_VALIDATION_TEXT_LENGTH})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const snapshotValue = this.readRuntimeEvaluateValue(evaluateResult);
    if (!isJsonObject(snapshotValue)) {
      cdpValidateLog("capture-snapshot:empty", {
        sessionId,
      });
      return null;
    }
    const sanitized = sanitizeValidationSnapshot(
      snapshotValue as CdpValidationSnapshotPayload,
      normalizedFallbackUrl,
    );
    cdpValidateLog("capture-snapshot:done", {
      sessionId,
      url: sanitized?.url ?? normalizedFallbackUrl,
      textLength: sanitized?.text.length ?? 0,
    });
    return sanitized;
  }

  async setValidationIndicator(input: {
    sessionId: string;
    status: CdpValidationIndicatorState;
    message?: string;
  }): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error(`CDP session not found: ${input.sessionId}`);
    }
    await this.ensureInPageControls(input.sessionId);
    await this.sendCommand(session, "Runtime.evaluate", {
      expression: buildApplyValidationIndicatorScript({
        status: input.status,
        message: input.message,
      }),
      awaitPromise: true,
      returnByValue: true,
    });
    cdpValidateLog("indicator", {
      sessionId: input.sessionId,
      status: input.status,
      hasMessage: Boolean(input.message && input.message.trim().length > 0),
      message: input.message,
    });
  }

  private async ensureInPageControls(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`CDP session not found: ${sessionId}`);
    }
    const expression = buildInPageControlsScript(session.referenceHighlight);
    if (!session.controlsUiScriptInstalled) {
      await this.sendCommand(session, "Page.addScriptToEvaluateOnNewDocument", {
        source: expression,
      });
      session.controlsUiScriptInstalled = true;
      cdpDebugLog("ensureInPageControls:installed-new-document-script", {
        sessionId,
      });
    }
    await this.sendCommand(session, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    cdpDebugLog("ensureInPageControls:evaluate-success", {
      sessionId,
      hasReference: Boolean(session.referenceHighlight),
    });
  }

  private async applyPendingHighlight(
    sessionId: string,
    attempt = 0,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingHighlight) {
      return;
    }
    const payload = session.pendingHighlight;
    cdpDebugLog("highlight:attempt", {
      sessionId,
      refId: payload.refId,
      attempt,
    });
    const evaluateResult = await this.sendCommand(session, "Runtime.evaluate", {
      expression: `(${runReferenceHighlightScript.toString()})(${JSON.stringify(payload)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = this.readRuntimeEvaluateValue(evaluateResult);
    const reason =
      isJsonObject(value) && typeof value.reason === "string"
        ? value.reason
        : "Reference text not found in current page.";
    cdpDebugLog("highlight:result", {
      sessionId,
      refId: payload.refId,
      attempt,
      ok: isJsonObject(value) ? value.ok === true : false,
      result: reason,
    });
    if (isJsonObject(value) && value.ok === true) {
      session.pendingHighlight = undefined;
      cdpDebugLog("highlight:success", {
        sessionId,
        refId: payload.refId,
        attempt,
      });
      return;
    }
    if (attempt >= MAX_HIGHLIGHT_RETRY_ATTEMPTS) {
      throw new Error(
        `CDP highlight failed after ${MAX_HIGHLIGHT_RETRY_ATTEMPTS + 1} attempts: ${reason}`,
      );
    }
    const delay = Math.min(1600, 220 * (attempt + 1));
    await new Promise((resolve) => setTimeout(resolve, delay));
    await this.applyPendingHighlight(sessionId, attempt + 1);
  }

  async open(input: {
    url: string;
    reference?: BrowserViewReferenceHighlight;
  }): Promise<{ ok: true; sessionId: string; launchMode: CdpEndpointLaunchMode }> {
    const normalizedUrl = normalizeHttpUrl(input.url);
    if (!normalizedUrl) {
      throw new Error("Invalid URL for CDP browser.");
    }
    cdpWarnLog("open:start", {
      url: normalizedUrl,
      hasReference: Boolean(input.reference),
      refId: input.reference?.refId ?? null,
      referenceTextLength: input.reference?.text.length ?? 0,
    });
    const launchMode = await this.ensureEndpointReady();
    const target = await this.createTarget(normalizedUrl);
    await this.activateTarget(target.id);
    const socket = await this.createSocketConnection(target.webSocketDebuggerUrl);
    const reference = input.reference
      ? sanitizeReferenceHighlight(input.reference)
      : undefined;
    const session: CdpSession = {
      id: randomUUID(),
      targetId: target.id,
      socket,
      nextCommandId: 1,
      pending: new Map(),
      pendingHighlight: reference,
      referenceHighlight: reference,
      controlsUiScriptInstalled: false,
      lastSelectionSignature: "",
    };
    socket.on("message", (rawData: unknown) => {
      const text = toMessageText(rawData);
      if (!text) {
        return;
      }
      this.handleSocketMessage(session, text);
    });
    socket.on("close", () => {
      this.handleSocketClosed(session.id);
    });
    socket.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      cdpWarnLog("socket:runtime-error", {
        sessionId: session.id,
        message,
      });
      this.handleSocketClosed(session.id);
    });
    this.sessions.set(session.id, session);
    try {
      await this.installSessionScripts(session);
      await this.ensureInPageControls(session.id);
      await this.sendCommand(session, "Page.bringToFront");
      await this.sendCommand(session, "Page.navigate", {
        url: normalizedUrl,
      });
      if (session.pendingHighlight) {
        void this.applyPendingHighlight(session.id);
      }
    } catch (error) {
      this.handleSocketClosed(session.id);
      socket.close();
      throw error;
    }
    cdpWarnLog("open:ready", {
      sessionId: session.id,
      targetId: session.targetId,
      launchMode,
      hasReference: Boolean(reference),
      controlsUiScriptInstalled: session.controlsUiScriptInstalled,
      pendingHighlight: Boolean(session.pendingHighlight),
    });
    return { ok: true, sessionId: session.id, launchMode };
  }
}

const cdpBrowserController = new CdpBrowserController();

export function getCdpBrowserController() {
  return cdpBrowserController;
}
