import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, RotateCw, Send, Square } from "lucide-react";

interface FlowPanelInputProps {
  visible: boolean;
  left: number;
  top: number;
  width?: number;
  zoom?: number;
  prompt: string;
  busy: boolean;
  asyncBusy?: boolean;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onStopAsync?: () => void;
  onRetry?: (messageId: string) => void;
  retryMessageId?: string | null;
  onFocusZoom?: (focusInput: () => void) => void;
}

export default function FlowPanelInput({
  visible,
  left,
  top,
  width,
  zoom = 1,
  prompt,
  busy,
  asyncBusy = false,
  onPromptChange,
  onSend,
  onStop,
  onStopAsync,
  onRetry,
  retryMessageId = null,
  onFocusZoom,
}: FlowPanelInputProps) {
  const isMicro = zoom <= 0.55;
  const isCompact = !isMicro && zoom <= 0.85;
  const minWidth = isMicro ? 120 : isCompact ? 160 : 200;
  const resolvedWidth = width ? Math.max(width, minWidth) : minWidth;
  const placeholder = isMicro
    ? "Ask..."
    : isCompact
      ? "Ask a question..."
      : "Ask a research question...";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const useTextarea = !isMicro && !isCompact;
  const canRetry = Boolean(retryMessageId && onRetry);
  const hasPrompt = prompt.trim().length > 0;
  const retryOnly = canRetry && !hasPrompt;
  const canStop = busy && Boolean(onStop);
  const canStopAsync = asyncBusy && Boolean(onStopAsync);
  const actionLabel = canStop
    ? "Stop generation"
    : retryOnly
      ? "Retry request"
      : "Send message";
  const asyncActionLabel = "Stop async tasks";
  const buttonSizeClass = isMicro
    ? "h-6 w-6"
    : isCompact
      ? "h-7 w-7"
      : "h-8 w-8";
  const iconSizeClass = isMicro
    ? "[&_svg]:size-3"
    : isCompact
      ? "[&_svg]:size-3.5"
      : "[&_svg]:size-4";

  const handleAction = () => {
    if (canStop) {
      onStop?.();
      return;
    }
    if (retryOnly) {
      onRetry?.(retryMessageId!);
      return;
    }
    onSend();
  };

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const handleFocus = () => {
    if (!onFocusZoom) {
      return;
    }
    onFocusZoom(() => {
      requestAnimationFrame(() => {
        if (useTextarea) {
          textareaRef.current?.focus();
        }
      });
    });
  };

  return (
    <div
      className={`pointer-events-auto absolute z-10 text-foreground transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
      }`}
      style={{ left, top, width: resolvedWidth }}
    >
      <div
        className={`flex items-center gap-2 rounded-xl border border-border/70 bg-card/80 shadow-lg shadow-black/20 ${
          isMicro ? "px-1 py-0.5" : isCompact ? "px-1.5 py-0.5" : "px-2 py-1"
        }`}
      >
        {useTextarea ? (
          <Textarea
            value={prompt}
            onChange={(event) => {
              onPromptChange(event.target.value);
              setTimeout(() => adjustHeight(), 0);
            }}
            placeholder={placeholder}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleAction();
              }
            }}
            disabled={busy}
            onFocus={handleFocus}
            ref={textareaRef}
            rows={1}
            className={`resize-none overflow-y-auto border-transparent bg-transparent text-foreground placeholder:text-muted-foreground focus-visible:ring-0 min-h-8 text-xs [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted/60 hover:[&::-webkit-scrollbar-thumb]:bg-muted`}
            style={{
              maxHeight: "160px",
              overflowY: "auto",
              scrollbarWidth: "thin",
              scrollbarColor: "var(--muted-foreground) transparent",
            }}
          />
        ) : (
          <Input
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={placeholder}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleAction();
              }
            }}
            disabled={busy}
            onFocus={handleFocus}
            className={`border-transparent bg-transparent text-foreground placeholder:text-muted-foreground focus-visible:ring-0 ${
              isMicro ? "h-6 text-[10px]" : "h-7 text-[11px]"
            }`}
          />
        )}
        {canStopAsync ? (
          <Button
            size="icon"
            variant="outline"
            className={`group relative rounded-md ${buttonSizeClass} ${iconSizeClass} hover:border-destructive hover:text-destructive`}
            onClick={() => {
              onStopAsync?.();
            }}
            aria-label={asyncActionLabel}
            title={asyncActionLabel}
          >
            <>
              <Loader2
                className="animate-spin transition-opacity duration-150 group-hover:opacity-0"
                style={{ animationDuration: "2.8s" }}
              />
              <Square className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </>
          </Button>
        ) : null}
        <Button
          size="icon"
          variant={retryOnly ? "destructive" : "default"}
          className={`group relative rounded-md ${buttonSizeClass} ${iconSizeClass} ${
            canStop
              ? "hover:bg-destructive hover:text-destructive-foreground"
              : ""
          }`}
          onClick={handleAction}
          disabled={canStop ? false : busy || (!retryOnly && !hasPrompt)}
          aria-label={actionLabel}
          title={actionLabel}
        >
          {canStop ? (
            <>
              <Loader2
                className="animate-spin transition-opacity duration-150 group-hover:opacity-0"
                style={{ animationDuration: "2.8s" }}
              />
              <Square className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </>
          ) : retryOnly ? (
            <RotateCw />
          ) : (
            <Send />
          )}
        </Button>
      </div>
    </div>
  );
}
