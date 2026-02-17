import type { FlowEdge, FlowNode } from "../../types/flow";
import type { ChatMessage } from "../../types/chat";
import type {
  BrowserPageValidationRecord,
  BrowserPageValidationStatusRecord,
} from "../../types/browserview";
import type { Theme } from "../../lib/theme";

export interface ProjectState {
  nodes: FlowNode[];
  edges: FlowEdge[];
  chat: ChatMessage[];
  autoLayoutLocked?: boolean;
  browserValidationByUrl?: Record<string, BrowserPageValidationRecord>;
  browserValidationChatByUrl?: Record<string, string>;
  browserValidationStatusByUrl?: Record<string, BrowserPageValidationStatusRecord>;
}

export interface ProjectChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  isRunning?: boolean;
  isValidation?: boolean;
}

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface FlowWorkspaceProps {
  project: ProjectInfo;
  initialState: ProjectState;
  theme: Theme;
  onToggleTheme: () => void;
  onExit: () => void;
  isVisible?: boolean;
  saveEnabled?: boolean;
}
