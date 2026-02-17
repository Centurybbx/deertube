import ELK from "elkjs/lib/elk.bundled";

import type {
  ElkExtendedEdge,
  LayoutOptions,
  ElkNode,
} from "elkjs/lib/elk-api";
import type { FlowNode } from "../types/flow";

export const QUESTION_NODE_WIDTH = 360;
export const QUESTION_NODE_HEIGHT = 190;
export const SOURCE_NODE_WIDTH = 300;
export const SOURCE_NODE_HEIGHT = 170;
export const INSIGHT_NODE_WIDTH = 340;
export const INSIGHT_NODE_HEIGHT = 180;
export const QUESTION_FALLBACK_OFFSET_X = 360;
export const SOURCE_FALLBACK_OFFSET_X = 420;
export const SOURCE_FALLBACK_SPACING_Y = 170;
export const COLLISION_PADDING = 32;

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const elk = new ELK();

const baseLayoutOptions: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.spacing.nodeNode": "30",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "LEFT",
  "elk.layered.nodePlacement.bk.edgeStraightening": "IMPROVE",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.edgeRouting": "POLYLINE",
  "elk.interactiveLayout": "true",
  "elk.interactive": "true",
  "elk.layered.crossingMinimization": "true",
  "elk.layered.considerModelOrder.strategy": "PREFER_NODES",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
};

export const getNodeSize = (node: FlowNode | null) => {
  const resolveDimension = (
    value: number | null | undefined,
    fallback: number,
  ) => (typeof value === "number" && value > 0 ? value : fallback);

  if (node?.type === "source") {
    return {
      width: resolveDimension(node.width, SOURCE_NODE_WIDTH),
      height: resolveDimension(node.height, SOURCE_NODE_HEIGHT),
    };
  }
  if (node?.type === "insight") {
    return {
      width: resolveDimension(node.width, INSIGHT_NODE_WIDTH),
      height: resolveDimension(node.height, INSIGHT_NODE_HEIGHT),
    };
  }
  return {
    width: resolveDimension(node?.width, QUESTION_NODE_WIDTH),
    height: resolveDimension(node?.height, QUESTION_NODE_HEIGHT),
  };
};

const toBounds = (
  point: Point,
  size: Size,
  padding = COLLISION_PADDING,
): Bounds => ({
  left: point.x - padding,
  right: point.x + size.width + padding,
  top: point.y - padding,
  bottom: point.y + size.height + padding,
});

const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const collides = (point: Point, size: Size, nodes: FlowNode[]): boolean => {
  const target = toBounds(point, size);
  return nodes.some((node) => {
    const nodeBounds = toBounds(node.position, getNodeSize(node));
    return boundsOverlap(target, nodeBounds);
  });
};

const rightBiasedCandidates = (
  base: Point,
  stepX: number,
  stepY: number,
  rings: number,
): Point[] => {
  const candidates: Point[] = [base];
  for (let ring = 1; ring <= rings; ring += 1) {
    const x = base.x + stepX * ring;
    candidates.push({ x, y: base.y });
    for (let v = 1; v <= ring; v += 1) {
      const y = stepY * v;
      candidates.push({ x, y: base.y + y });
      candidates.push({ x, y: base.y - y });
    }
  }
  return candidates;
};

export const resolveRightBiasedPosition = ({
  desired,
  nodes,
  size,
  stepX = 90,
  stepY = 60,
  rings = 10,
}: {
  desired: Point;
  nodes: FlowNode[];
  size: Size;
  stepX?: number;
  stepY?: number;
  rings?: number;
}): Point => {
  const candidates = rightBiasedCandidates(desired, stepX, stepY, rings);
  for (const candidate of candidates) {
    if (!collides(candidate, size, nodes)) {
      return candidate;
    }
  }
  return desired;
};

export const resolveColumnPosition = ({
  desired,
  nodes,
  size,
  stepY = 70,
  stepX = 120,
  rings = 10,
}: {
  desired: Point;
  nodes: FlowNode[];
  size: Size;
  stepY?: number;
  stepX?: number;
  rings?: number;
}): Point => {
  for (let column = 0; column <= rings; column += 1) {
    const x = desired.x + stepX * column;
    if (column === 0 && !collides({ x, y: desired.y }, size, nodes)) {
      return { x, y: desired.y };
    }
    for (let offset = 1; offset <= rings; offset += 1) {
      const y = stepY * offset;
      const up = { x, y: desired.y - y };
      const down = { x, y: desired.y + y };
      if (!collides(up, size, nodes)) {
        return up;
      }
      if (!collides(down, size, nodes)) {
        return down;
      }
    }
  }
  return desired;
};

const nodeById = (layout: ElkNode, id: string): ElkNode | undefined =>
  layout.children?.find((child) => child.id === id);

const applyDelta = (point: Point, delta: Point): Point => ({
  x: point.x + delta.x,
  y: point.y + delta.y,
});

const layoutGraph = async (graph: ElkNode): Promise<ElkNode> =>
  await elk.layout(graph);

interface LayoutRequest {
  nodes: FlowNode[];
  edges: { id?: string; source: string; target: string }[];
  direction?: "RIGHT" | "LEFT" | "DOWN" | "UP";
  useExistingPositions?: boolean;
}

interface LayoutResult {
  positions: Record<string, Point>;
}

export const layoutFlowWithElk = async ({
  nodes,
  edges,
  direction = "RIGHT",
  useExistingPositions = false,
}: LayoutRequest): Promise<LayoutResult> => {
  const children: ElkNode[] = nodes.map((node) => {
    const size = getNodeSize(node);
    const positionedNode: ElkNode = {
      id: node.id,
      width: size.width,
      height: size.height,
    };
    if (useExistingPositions) {
      if (node.position) {
        positionedNode.x = node.position.x;
        positionedNode.y = node.position.y;
      }
      if (node.positionAbsolute) {
        positionedNode.x = node.positionAbsolute.x;
        positionedNode.y = node.positionAbsolute.y;
      }
    }
    return positionedNode;
  });

  const elkEdges: ElkExtendedEdge[] = edges.map((edge, index) => ({
    id: edge.id ?? `edge-${edge.source}-${edge.target}-${index}`,
    sources: [edge.source],
    targets: [edge.target],
  }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: { ...baseLayoutOptions, "elk.direction": direction },
    children,
    edges: elkEdges,
  };

  const layout = await layoutGraph(graph);
  if (!layout) {
    return { positions: {} };
  }

  const positions: Record<string, Point> = {};
  layout.children?.forEach((node) => {
    positions[node.id] = {
      x: node.x ?? 0,
      y: node.y ?? 0,
    };
  });

  return { positions };
};

export const layoutQuestionWithElk = async ({
  parent,
  parentPosition,
  questionId,
}: {
  parent: FlowNode | null;
  parentPosition: Point;
  questionId: string;
}): Promise<Point> => {
  const parentSize = getNodeSize(parent);
  const questionSize = {
    width: QUESTION_NODE_WIDTH,
    height: QUESTION_NODE_HEIGHT,
  };

  const graph: ElkNode = {
    id: "root",
    layoutOptions: baseLayoutOptions,
    children: [
      {
        id: parent?.id ?? "parent",
        width: parentSize.width,
        height: parentSize.height,
      },
      {
        id: questionId,
        width: questionSize.width,
        height: questionSize.height,
      },
    ],
    edges: [
      {
        id: "edge-parent-question",
        sources: [parent?.id ?? "parent"],
        targets: [questionId],
      },
    ],
  };

  const layout = await layoutGraph(graph);
  if (!layout) {
    return {
      x: parentPosition.x + QUESTION_FALLBACK_OFFSET_X,
      y: parentPosition.y,
    };
  }

  const layoutParent = nodeById(layout, parent?.id ?? "parent");
  const layoutQuestion = nodeById(layout, questionId);
  if (!layoutParent || !layoutQuestion) {
    return {
      x: parentPosition.x + QUESTION_FALLBACK_OFFSET_X,
      y: parentPosition.y,
    };
  }

  const delta = {
    x: parentPosition.x - (layoutParent.x ?? 0),
    y: parentPosition.y - (layoutParent.y ?? 0),
  };

  return applyDelta(
    {
      x: layoutQuestion.x ?? parentPosition.x + QUESTION_FALLBACK_OFFSET_X,
      y: layoutQuestion.y ?? parentPosition.y,
    },
    delta,
  );
};

export const layoutSourcesWithElk = async ({
  questionPosition,
  questionId,
  sourceIds,
}: {
  questionPosition: Point;
  questionId: string;
  sourceIds: string[];
}): Promise<Point[]> => {
  if (sourceIds.length === 0) {
    return [];
  }

  const children: ElkNode[] = [
    {
      id: questionId,
      width: QUESTION_NODE_WIDTH,
      height: QUESTION_NODE_HEIGHT,
    },
    ...sourceIds.map((id) => ({
      id,
      width: SOURCE_NODE_WIDTH,
      height: SOURCE_NODE_HEIGHT,
    })),
  ];

  const edges: ElkExtendedEdge[] = sourceIds.map((id, index) => ({
    id: `edge-${questionId}-${id}-${index}`,
    sources: [questionId],
    targets: [id],
  }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: baseLayoutOptions,
    children,
    edges,
  };

  const layout = await layoutGraph(graph);
  if (!layout) {
    return sourceIds.map((_, index) => ({
      x: questionPosition.x + SOURCE_FALLBACK_OFFSET_X,
      y: questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
    }));
  }

  const layoutQuestion = nodeById(layout, questionId);
  if (!layoutQuestion) {
    return sourceIds.map((_, index) => ({
      x: questionPosition.x + SOURCE_FALLBACK_OFFSET_X,
      y: questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
    }));
  }

  const delta = {
    x: questionPosition.x - (layoutQuestion.x ?? 0),
    y: questionPosition.y - (layoutQuestion.y ?? 0),
  };

  const xCandidates = sourceIds
    .map((id) => nodeById(layout, id)?.x)
    .filter((value): value is number => typeof value === "number");
  const snapX = xCandidates.length > 0 ? Math.max(...xCandidates) : null;

  return sourceIds.map((id, index) => {
    const node = nodeById(layout, id);
    if (!node) {
      return {
        x: questionPosition.x + SOURCE_FALLBACK_OFFSET_X,
        y: questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
      };
    }
    const baseX =
      snapX ?? node.x ?? questionPosition.x + SOURCE_FALLBACK_OFFSET_X;
    return applyDelta(
      {
        x: baseX,
        y: node.y ?? questionPosition.y + index * SOURCE_FALLBACK_SPACING_Y,
      },
      delta,
    );
  });
};
