import type { DeepSearchReferencePayload } from "@/types/chat";
import type {
  BrowserPageValidationRecord,
} from "@/types/browserview";
import type { FlowEdge, FlowNode, SourceNodeData } from "@/types/flow";
import { stripLineNumberPrefix } from "./browser-utils";

interface ValidateReferenceSeed {
  title: string;
  url: string;
  text: string;
}

interface BuildValidationGraphInsertionOptions {
  baseNodes: FlowNode[];
  validation: BrowserPageValidationRecord;
  references: DeepSearchReferencePayload[];
}

interface ValidationGraphInsertion {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const toReferenceSeeds = (
  validation: BrowserPageValidationRecord,
  references: DeepSearchReferencePayload[],
): ValidateReferenceSeed[] => {
  if (references.length > 0) {
    return references.map((reference, index) => ({
      title:
        reference.title?.trim() ??
        `Support ${typeof reference.refId === "number" ? reference.refId : index + 1}`,
      url: reference.url?.trim() ?? validation.url,
      text: stripLineNumberPrefix(
        reference.validationRefContent?.trim() ?? reference.text?.trim() ?? "",
      ),
    }));
  }
  return [
    {
      title: validation.referenceTitle?.trim() ?? validation.title?.trim() ?? "Support 1",
      url: validation.referenceUrl?.trim() ?? validation.url,
      text: stripLineNumberPrefix(
        validation.validationRefContent?.trim() ?? validation.text?.trim() ?? "",
      ),
    },
  ];
};

const resolveValidationHeadline = (validation: BrowserPageValidationRecord): string => {
  if (validation.title?.trim()) {
    return validation.title.trim();
  }
  if (!URL.canParse(validation.url)) {
    return validation.url;
  }
  return new URL(validation.url).host;
};

const buildValidationExcerpt = (validation: BrowserPageValidationRecord): string => {
  const parts: string[] = [];
  if (validation.accuracy) {
    parts.push(`Accuracy: ${validation.accuracy}`);
  }
  if (validation.sourceAuthority) {
    parts.push(`Source authority: ${validation.sourceAuthority}`);
  }
  if (validation.issueReason) {
    parts.push(`Issue: ${validation.issueReason}`);
  }
  if (validation.correctFact) {
    parts.push(`Correct: ${validation.correctFact}`);
  }
  if (validation.text?.trim()) {
    parts.push(stripLineNumberPrefix(validation.text.trim()));
  }
  const summary = parts.join("\n");
  return summary.length > 560 ? `${summary.slice(0, 560)}...` : summary;
};

export const buildValidationGraphInsertion = ({
  baseNodes,
  validation,
  references,
}: BuildValidationGraphInsertionOptions): ValidationGraphInsertion => {
  const maxX = baseNodes.reduce(
    (currentMax, node) => Math.max(currentMax, node.position.x),
    0,
  );
  const maxY = baseNodes.reduce(
    (currentMax, node) => Math.max(currentMax, node.position.y),
    0,
  );
  const parentId = `validate-insight-${crypto.randomUUID()}`;
  const headline = resolveValidationHeadline(validation);
  const parentNode: FlowNode = {
    id: parentId,
    type: "insight",
    position: {
      x: maxX + 320,
      y: maxY + 100,
    },
    data: {
      titleLong: `Validate · ${headline}`,
      titleShort: "Validate",
      titleTiny: "V",
      excerpt: buildValidationExcerpt(validation),
      responseId: `validate:${crypto.randomUUID()}`,
    },
  };

  const supportSeeds = toReferenceSeeds(validation, references);
  const childNodes: FlowNode[] = supportSeeds.map((seed, index) => {
    const nodeId = `validate-source-${crypto.randomUUID()}`;
    const snippet = seed.text.trim();
    const data: SourceNodeData = {
      title: seed.title,
      url: seed.url,
      snippet: snippet.length > 380 ? `${snippet.slice(0, 380)}...` : snippet,
    };
    return {
      id: nodeId,
      type: "source",
      position: {
        x: parentNode.position.x + 280,
        y: parentNode.position.y + index * 140,
      },
      data,
    };
  });

  const parentSupportEdges: FlowEdge[] = childNodes.map((childNode) => ({
    id: `validate-edge-${crypto.randomUUID()}`,
    source: parentId,
    target: childNode.id,
    data: {
      relationType: "support",
    },
    style: {
      strokeDasharray: "4 3",
    },
  }));

  const supportRelationEdges: FlowEdge[] = [];
  for (let index = 1; index < childNodes.length; index += 1) {
    supportRelationEdges.push({
      id: `validate-support-rel-${crypto.randomUUID()}`,
      source: childNodes[index - 1].id,
      target: childNodes[index].id,
      data: {
        relationType: "support",
      },
      style: {
        strokeDasharray: "2 3",
      },
    });
  }

  return {
    nodes: [parentNode, ...childNodes],
    edges: [...parentSupportEdges, ...supportRelationEdges],
  };
};
