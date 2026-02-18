import { Handle, Position, type NodeProps } from 'reactflow'
import type { SourceNodeData } from '../../types/flow'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ExternalLink } from 'lucide-react'
import { useSourceActionContext } from '../flow/SourceActionContext'

type SourceNodeProps = NodeProps<SourceNodeData>

export default function SourceNode({ data, selected }: SourceNodeProps) {
  const actions = useSourceActionContext()
  const referenceUri = data.referenceUri?.trim()
  const canOpenReference = Boolean(referenceUri && actions)

  return (
    <Card
      className={`relative w-[300px] border-border/70 bg-card/90 text-foreground shadow-xl shadow-black/25 after:pointer-events-none after:absolute after:-inset-1 after:rounded-[18px] after:shadow-[0_0_18px_rgba(56,189,248,0.45)] after:opacity-0 after:transition-opacity after:duration-200 ${
        selected ? "ring-1 ring-primary/40 after:opacity-100" : ""
      }`}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-[0.65rem] uppercase tracking-[0.25em] text-muted-foreground">
            Source
          </div>
          {canOpenReference ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="nodrag nopan h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (!referenceUri) {
                  return
                }
                actions?.openReference(referenceUri, data.title)
              }}
              aria-label="Open reference"
              title="Open reference"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="mt-2 text-sm font-semibold text-foreground">{data.title}</div>
        <div className="mt-1 break-all text-[0.7rem] text-muted-foreground">
          {data.url}
        </div>
        {data.snippet && (
          <div className="mt-3 max-h-24 overflow-hidden text-[0.75rem] leading-relaxed text-foreground/70">
            {data.snippet}
          </div>
        )}
      </CardContent>
      <Handle type="target" position={Position.Left} />
    </Card>
  )
}
