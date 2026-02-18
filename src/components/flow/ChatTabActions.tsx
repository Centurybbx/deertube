import { useMemo, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { ArrowLeftRight, Check, Loader2, PencilLine, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ProjectChatSummary } from "./types";

interface ChatTabActionsProps {
  chats: ProjectChatSummary[];
  activeChatId: string | null;
  busy: boolean;
  onSwitchChat: (chatId: string) => void;
  onCreateChat: () => void;
  onRenameChat?: (chatId: string, title: string) => Promise<void> | void;
  onDeleteChat?: (chatId: string) => Promise<void> | void;
}

function toTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUpdatedLabel(value: string): string {
  const updatedAt = toTimestamp(value);
  if (!updatedAt) {
    return "1y";
  }
  const diffMs = Date.now() - updatedAt;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;
  if (diffMs < dayMs) {
    return `${Math.max(1, Math.floor(diffMs / hourMs) || 1)}h`;
  }
  if (diffMs < weekMs) {
    return `${Math.max(1, Math.floor(diffMs / dayMs))}d`;
  }
  if (diffMs < monthMs) {
    return `${Math.max(1, Math.floor(diffMs / weekMs))}w`;
  }
  if (diffMs < yearMs) {
    return `${Math.max(1, Math.floor(diffMs / monthMs))}m`;
  }
  return `${Math.max(1, Math.floor(diffMs / yearMs))}y`;
}

export function ChatTabActions({
  chats,
  activeChatId,
  busy,
  onSwitchChat,
  onCreateChat,
  onRenameChat,
  onDeleteChat,
}: ChatTabActionsProps) {
  const [renameCandidate, setRenameCandidate] = useState<ProjectChatSummary | null>(
    null,
  );
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<ProjectChatSummary | null>(
    null,
  );
  const hasItemActions = (onRenameChat ?? onDeleteChat) !== undefined;
  const sortedChats = useMemo(
    () =>
      [...chats].sort(
        (left, right) => {
          const leftValidation = left.isValidation === true ? 1 : 0;
          const rightValidation = right.isValidation === true ? 1 : 0;
          if (leftValidation !== rightValidation) {
            return rightValidation - leftValidation;
          }
          return toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
        },
      ),
    [chats],
  );
  const stopHeaderEvent = (event: SyntheticEvent) => {
    event.stopPropagation();
  };
  const handleSelectChange = (value: string) => {
    onSwitchChat(value);
  };
  const stopItemActionEvent = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const runItemAction = (event: SyntheticEvent, action: () => void) => {
    stopItemActionEvent(event);
    action();
  };
  const handleRenameClick = (chat: ProjectChatSummary) => {
    if (!onRenameChat) {
      return;
    }
    setRenameCandidate(chat);
    setRenameTitle(chat.title);
  };
  const handleDeleteClick = (chat: ProjectChatSummary) => {
    if (!onDeleteChat) {
      return;
    }
    setDeleteCandidate(chat);
  };
  const handleConfirmDelete = () => {
    const target = deleteCandidate;
    if (!target || !onDeleteChat) {
      setDeleteCandidate(null);
      return;
    }
    setDeleteCandidate(null);
    void Promise.resolve(onDeleteChat(target.id));
  };
  const canSubmitRename =
    renameCandidate !== null &&
    renameTitle.trim().length > 0 &&
    renameTitle.trim() !== renameCandidate.title;
  const closeRenameDialog = () => {
    setRenameCandidate(null);
    setRenameTitle("");
  };
  const handleConfirmRename = () => {
    if (!renameCandidate || !onRenameChat) {
      closeRenameDialog();
      return;
    }
    const nextTitle = renameTitle.trim();
    if (!nextTitle || nextTitle === renameCandidate.title) {
      closeRenameDialog();
      return;
    }
    const chatId = renameCandidate.id;
    closeRenameDialog();
    void Promise.resolve(onRenameChat(chatId, nextTitle));
  };
  const handleRenameInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    if (!canSubmitRename) {
      return;
    }
    handleConfirmRename();
  };

  return (
    <>
      <div
        className="ml-1 flex items-center gap-1"
        onMouseDown={stopHeaderEvent}
        onClick={stopHeaderEvent}
        onDoubleClick={stopHeaderEvent}
      >
        <Select
          value={activeChatId ?? undefined}
          onValueChange={handleSelectChange}
        >
          <SelectTrigger
            className="h-6 w-6 shrink-0 justify-center rounded-full border-0 bg-transparent p-0 text-foreground/80 shadow-none hover:bg-accent/50 [&>svg:last-child]:hidden"
            aria-label="Switch chat"
            title="Switch chat"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="center"
            sideOffset={6}
            className="max-h-72 w-[260px]"
          >
            {sortedChats.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No saved chats yet.
              </div>
            ) : (
              sortedChats.map((chat) => (
                <div key={chat.id} className="group/chat-row relative">
                  <SelectItem
                    value={chat.id}
                    className={cn(
                      "pr-2 [&_.select-item-indicator]:hidden [&[data-state=checked]_.chat-updated-time]:hidden [&[data-state=checked]_.chat-current-indicator]:inline-flex [&>*:last-child]:flex-1 [&>*:last-child]:w-full",
                    )}
                    title={chat.title}
                  >
                    <div className="flex w-full min-w-0 items-center gap-2">
                      <span className="min-w-0 w-full flex-1 truncate text-sm text-foreground">
                        {chat.title}
                      </span>
                      <div className="ml-auto flex h-5 shrink-0 items-center gap-1">
                        {hasItemActions ? (
                          <div className="chat-actions flex items-center gap-0.5 opacity-0 transition-opacity pointer-events-none group-hover/chat-row:opacity-100 group-hover/chat-row:pointer-events-auto group-focus-within/chat-row:opacity-100 group-focus-within/chat-row:pointer-events-auto">
                            {onRenameChat ? (
                              <button
                                type="button"
                                className="inline-flex h-4 w-4 items-center justify-center rounded bg-transparent text-muted-foreground transition hover:text-foreground"
                                aria-label={`Rename ${chat.title}`}
                                title={`Rename ${chat.title}`}
                                onPointerDown={(event) => {
                                  runItemAction(event, () => handleRenameClick(chat));
                                }}
                                onClick={stopItemActionEvent}
                              >
                                <PencilLine className="h-3 w-3" />
                              </button>
                            ) : null}
                            {onDeleteChat ? (
                              <button
                                type="button"
                                className="inline-flex h-4 w-4 items-center justify-center rounded bg-transparent text-muted-foreground transition hover:text-destructive"
                                aria-label={`Delete ${chat.title}`}
                                title={`Delete ${chat.title}`}
                                onPointerDown={(event) => {
                                  runItemAction(event, () => handleDeleteClick(chat));
                                }}
                                onClick={stopItemActionEvent}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="chat-meta flex items-center justify-end gap-1">
                          {chat.isValidation ? (
                            <span
                              className="shrink-0 rounded-sm border border-slate-400/40 bg-slate-500/10 px-1 py-0 text-[9px] font-semibold uppercase leading-4 tracking-[0.04em] text-slate-600 dark:text-slate-300"
                              title="Validate"
                              aria-label="Validate"
                            >
                              Val
                            </span>
                          ) : null}
                          {chat.isRunning ? (
                            <Loader2
                              className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
                              aria-label="Running"
                            />
                          ) : (
                            <>
                              <Check
                                className="chat-current-indicator hidden h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                aria-label="Current chat"
                              />
                              <span className="chat-updated-time shrink-0 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                                {formatUpdatedLabel(chat.updatedAt)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </SelectItem>
                </div>
              ))
            )}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 rounded-full border-0 bg-transparent text-foreground/80 shadow-none hover:bg-accent/50"
          aria-label="Create chat"
          title="Create chat"
          onClick={onCreateChat}
          disabled={busy}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Dialog
        open={renameCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeRenameDialog();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>
              Enter a new title for this chat.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            onKeyDown={handleRenameInputKeyDown}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeRenameDialog}>
              Cancel
            </Button>
            <Button onClick={handleConfirmRename} disabled={!canSubmitRename}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteCandidate(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {deleteCandidate
                ? `This will permanently delete "${deleteCandidate.title}".`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
