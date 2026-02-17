import { useCallback, type MouseEvent } from "react";
import { trpc } from "../../lib/trpc";
import type { FlowNode, SourceNodeData } from "../../types/flow";

export function usePreviewHover() {
  const handleNodeEnter = useCallback((_: MouseEvent, node: FlowNode) => {
    if (node.type !== "source") {
      return;
    }
    const data = node.data as SourceNodeData;
    if (!data.url) {
      return;
    }
    const width = Math.min(window.innerWidth * 0.6, 980);
    const height = Math.min(window.innerHeight * 0.65, 720);
    const x = window.innerWidth - width - 24;
    const y = 24;
    void trpc.preview.show.mutate({
      url: data.url,
      bounds: { x, y, width, height },
    });
  }, []);

  const handleNodeLeave = useCallback(() => {
    void trpc.preview.hide.mutate();
  }, []);

  return { handleNodeEnter, handleNodeLeave };
}
