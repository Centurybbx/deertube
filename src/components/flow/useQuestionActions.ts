import { useCallback, useMemo, useState, type MutableRefObject } from "react";
import type { ReactFlowInstance } from "reactflow";
import { placeQuestionNode, placeSourceNodes } from "../../lib/flowPlacement";
import {
  QUESTION_NODE_HEIGHT,
  QUESTION_NODE_WIDTH,
  SOURCE_NODE_WIDTH,
} from "../../lib/elkLayout";
import { trpc } from "../../lib/trpc";
import type {
  FlowEdge,
  FlowNode,
  QuestionNode as QuestionNodeType,
  SourceNode as SourceNodeType,
} from "../../types/flow";
import {
  buildRuntimeSettings,
  type ProviderProfile,
} from "../../lib/settings";

interface UseQuestionActionsOptions {
  projectPath: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  setNodes: (updater: (prev: FlowNode[]) => FlowNode[]) => void;
  setEdges: (updater: (prev: FlowEdge[]) => FlowEdge[]) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  lastQuestionId: MutableRefObject<string | null>;
  flowInstance: ReactFlowInstance | null;
  activeProfile: ProviderProfile | null;
  buildContextSummary: (targetId: string) => string;
}

export function useQuestionActions({
  projectPath,
  nodes,
  edges,
  setNodes,
  setEdges,
  selectedId,
  setSelectedId,
  lastQuestionId,
  flowInstance,
  activeProfile,
  buildContextSummary,
}: UseQuestionActionsOptions) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const runtimeSettings = useMemo(
    () => buildRuntimeSettings(activeProfile),
    [activeProfile],
  );

  const updateQuestionNode = useCallback(
    (questionId: string, patch: Partial<QuestionNodeType["data"]>) => {
      setNodes((prev: FlowNode[]) =>
        prev.map((node) => {
          if (node.id === questionId && node.type === "question") {
            return {
              ...node,
              data: {
                ...node.data,
                ...patch,
              },
            };
          }
          return node;
        }),
      );
    },
    [setNodes],
  );

  const runQuestion = useCallback(
    async (
      questionId: string,
      questionText: string,
      questionPosition: { x: number; y: number },
      parentId: string | null,
    ) => {
      setBusy(true);
      try {
        const context = parentId ? buildContextSummary(parentId) : "";
        const result = await trpc.deepSearch.run.mutate({
          projectPath,
          query: questionText,
          maxResults: 5,
          context,
          settings: runtimeSettings,
        });

        const sourcePositions = await placeSourceNodes({
          questionId,
          questionPosition,
          nodes,
          edges,
          sources: result.sources.map((source) => ({ id: source.id })),
        });
        const sourceNodes: SourceNodeType[] = result.sources.map(
          (source, index) => ({
            id: source.id,
            type: "source",
            position: sourcePositions[index],
            data: {
              title: source.title,
              url: source.url,
              snippet: source.snippet,
            },
            width: SOURCE_NODE_WIDTH,
          }),
        );

        setNodes((prev: FlowNode[]) =>
          prev
            .map((node) => {
              if (node.id === questionId && node.type === "question") {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    answer: result.answer,
                    status: undefined,
                  },
                };
              }
              return node;
            })
            .concat(sourceNodes),
        );

        const sourceEdges: FlowEdge[] = result.sources.map((source) => ({
          id: crypto.randomUUID(),
          source: questionId,
          target: source.id,
          type: "smoothstep",
        }));
        setEdges((prev: FlowEdge[]) => [...prev, ...sourceEdges]);

        requestAnimationFrame(() => {
          flowInstance?.fitView({ padding: 0.2, duration: 400 });
        });
      } catch (error) {
        updateQuestionNode(questionId, {
          answer: "Request failed. Please try again.",
          status: "failed",
        });
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [
      buildContextSummary,
      edges,
      flowInstance,
      nodes,
      projectPath,
      runtimeSettings,
      setEdges,
      setNodes,
      updateQuestionNode,
    ],
  );

  const handleAsk = useCallback(async () => {
    if (!prompt.trim() || busy || !selectedId) {
      return;
    }
    const questionText = prompt.trim();
    setPrompt("");
    setBusy(true);

    const parentNode = nodes.find((node) => node.id === selectedId) ?? null;
    const parentPosition = parentNode?.position ?? { x: 0, y: 0 };

    const questionId = crypto.randomUUID();
    const questionPosition = await placeQuestionNode({
      parentNode,
      parentPosition,
      questionId,
      nodes,
      edges,
    });
    const questionNode: QuestionNodeType = {
      id: questionId,
      type: "question",
      position: questionPosition,
      data: {
        question: questionText,
        answer: "Searching and reasoning...",
        status: "running",
      },
      width: QUESTION_NODE_WIDTH,
    };

    setNodes((prev: FlowNode[]) => [...prev, questionNode]);
    if (flowInstance) {
      const centerX = questionPosition.x + QUESTION_NODE_WIDTH / 2;
      const centerY = questionPosition.y + QUESTION_NODE_HEIGHT / 2;
      requestAnimationFrame(() => {
        flowInstance.setCenter(centerX, centerY, {
          zoom: flowInstance.getZoom(),
          duration: 400,
        });
      });
    }
    if (selectedId) {
      setEdges((prev: FlowEdge[]) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          source: selectedId,
          target: questionId,
          type: "smoothstep",
        },
      ]);
    } else {
      const fallbackSource = lastQuestionId.current;
      if (fallbackSource) {
      setEdges((prev: FlowEdge[]) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          source: fallbackSource,
          target: questionId,
          type: "smoothstep",
        },
      ]);
      }
    }
    lastQuestionId.current = questionId;
    setSelectedId(questionId);

    void runQuestion(questionId, questionText, questionPosition, selectedId);
  }, [
    busy,
    edges,
    flowInstance,
    nodes,
    prompt,
    selectedId,
    setEdges,
    setNodes,
    setSelectedId,
    lastQuestionId,
    runQuestion,
  ]);

  const retryQuestion = useCallback(
    (questionId: string) => {
      if (busy) {
        return;
      }
      const questionNode = nodes.find(
        (node) => node.id === questionId && node.type === "question",
      ) as QuestionNodeType | undefined;
      if (!questionNode) {
        return;
      }
      if (questionNode.data.status !== "failed") {
        return;
      }
      const parentEdge = edges.find((edge) => edge.target === questionId);
      updateQuestionNode(questionId, {
        answer: "Searching and reasoning...",
        status: "running",
      });
      void runQuestion(
        questionId,
        questionNode.data.question,
        questionNode.position,
        parentEdge?.source ?? null,
      );
    },
    [busy, edges, nodes, runQuestion, updateQuestionNode],
  );

  return { prompt, setPrompt, busy, handleAsk, retryQuestion };
}
