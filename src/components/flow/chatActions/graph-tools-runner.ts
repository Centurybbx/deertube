import {
  finishRunningChatJob,
  startRunningChatJob,
} from "@/lib/running-chat-jobs";
import type { RuntimeSettingsPayload } from "@/lib/settings";
import type { GraphRunNodePayload, ChatMessage } from "@/types/chat";
import type { FlowEdge, FlowNode } from "@/types/flow";
import type { ReactFlowInstance } from "reactflow";
import { planGraphInsightInsertion } from "./graph-insertion";
import type { GraphSnapshot } from "./node-context";

interface GraphRunMutationInput {
  projectPath: string;
  responseId: string;
  responseText: string;
  selectedNodeId?: string;
  selectedNodeSummary?: string;
  graph: GraphSnapshot;
  settings?: RuntimeSettingsPayload;
}

interface GraphRunMutationResult {
  nodes: GraphRunNodePayload[];
  explanation?: string;
}

interface RunGraphToolsForResponseOptions {
  responseId: string;
  responseText: string;
  chatId: string | null;
  projectPath: string;
  selectedId: string | null;
  selectedNodeSummary: string | undefined;
  graphSnapshot: GraphSnapshot;
  nodes: FlowNode[];
  edges: FlowEdge[];
  runtimeSettings: RuntimeSettingsPayload | undefined;
  flowInstance: ReactFlowInstance | null;
  setGraphBusy: (busy: boolean) => void;
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  setEdges: (updater: (prev: FlowEdge[]) => FlowEdge[]) => void;
  setGraphEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
  runGraphMutation: (
    input: GraphRunMutationInput,
  ) => Promise<GraphRunMutationResult>;
}

const appendGraphRunningEvent = ({
  eventId,
  responseId,
  selectedId,
  selectedNodeSummary,
  setGraphEventMessages,
}: {
  eventId: string;
  responseId: string;
  selectedId: string | null;
  selectedNodeSummary: string | undefined;
  setGraphEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  const startedAt = new Date().toISOString();
  setGraphEventMessages((prev) => [
    ...prev,
    {
      id: eventId,
      role: "assistant",
      content: "",
      createdAt: startedAt,
      kind: "graph-event",
      toolName: "graph.run",
      toolStatus: "running",
      toolInput: {
        responseId,
        selectedNodeId: selectedId ?? null,
        selectedNodeSummary: selectedNodeSummary ?? null,
      },
    },
  ]);
};

const markGraphEventComplete = ({
  eventId,
  graphNodes,
  explanation,
  setGraphEventMessages,
}: {
  eventId: string;
  graphNodes: GraphRunNodePayload[];
  explanation: string | undefined;
  setGraphEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  const nodesAdded = graphNodes.length;
  setGraphEventMessages((prev) =>
    prev.map((event) =>
      event.id === eventId
        ? {
            ...event,
            toolStatus: "complete",
            toolOutput: {
              nodesAdded,
              nodes: graphNodes,
              explanation,
            },
          }
        : event,
    ),
  );
};

const markGraphEventFailed = ({
  eventId,
  errorMessage,
  setGraphEventMessages,
}: {
  eventId: string;
  errorMessage: string;
  setGraphEventMessages: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void;
}) => {
  setGraphEventMessages((prev) =>
    prev.map((event) =>
      event.id === eventId
        ? {
            ...event,
            toolStatus: "failed",
            error: errorMessage,
          }
        : event,
    ),
  );
};

const focusInsertedInsights = (
  flowInstance: ReactFlowInstance,
  insertedNode: FlowNode,
) => {
  const focusWidth = typeof insertedNode.width === "number" ? insertedNode.width : 0;
  const centerX = insertedNode.position.x + focusWidth / 2;
  const centerY = insertedNode.position.y + 120;
  requestAnimationFrame(() => {
    flowInstance.setCenter(centerX, centerY, {
      zoom: flowInstance.getZoom(),
      duration: 400,
    });
  });
};

export const runGraphToolsForResponse = async ({
  responseId,
  responseText,
  chatId,
  projectPath,
  selectedId,
  selectedNodeSummary,
  graphSnapshot,
  nodes,
  edges,
  runtimeSettings,
  flowInstance,
  setGraphBusy,
  setNodes,
  setEdges,
  setGraphEventMessages,
  runGraphMutation,
}: RunGraphToolsForResponseOptions): Promise<void> => {
  if (!responseText.trim()) {
    return;
  }

  const eventId = crypto.randomUUID();
  const runningJobId = `graph:${eventId}`;

  if (chatId) {
    startRunningChatJob(projectPath, chatId, runningJobId);
  }
  appendGraphRunningEvent({
    eventId,
    responseId,
    selectedId,
    selectedNodeSummary,
    setGraphEventMessages,
  });

  setGraphBusy(true);
  try {
    const result = await runGraphMutation({
      projectPath,
      responseId,
      responseText,
      selectedNodeId: selectedId ?? undefined,
      selectedNodeSummary,
      graph: graphSnapshot,
      settings: runtimeSettings,
    });

    const graphNodes = result.nodes;
    markGraphEventComplete({
      eventId,
      graphNodes,
      explanation: result.explanation,
      setGraphEventMessages,
    });

    if (graphNodes.length === 0) {
      return;
    }

    const { insightNodes, newEdges } = await planGraphInsightInsertion({
      baseNodes: nodes,
      baseEdges: edges,
      graphNodes,
    });

    setNodes((prev: FlowNode[]) => [...prev, ...insightNodes]);
    if (newEdges.length > 0) {
      setEdges((prev: FlowEdge[]) => [...prev, ...newEdges]);
    }

    if (flowInstance && insightNodes.length > 0) {
      focusInsertedInsights(flowInstance, insightNodes[0]);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Graph tool failed";
    markGraphEventFailed({
      eventId,
      errorMessage,
      setGraphEventMessages,
    });
    throw error instanceof Error ? error : new Error(errorMessage);
  } finally {
    if (chatId) {
      finishRunningChatJob(projectPath, chatId, runningJobId);
    }
    setGraphBusy(false);
  }
};
