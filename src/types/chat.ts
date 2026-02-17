export type ChatRole = 'user' | 'assistant'

export interface GraphToolInput {
  responseId?: string
  selectedNodeId?: string | null
  selectedNodeSummary?: string | null
}

export interface GraphRunNodePayload {
  id: string
  titleLong: string
  titleShort: string
  titleTiny: string
  excerpt: string
  parentId: string
  responseId?: string
}

export interface GraphToolOutput {
  nodesAdded?: number
  nodes?: GraphRunNodePayload[]
  explanation?: string
}

export interface ToolCallEventInput {
  responseId: string
  toolCallId: string
}

export interface SubagentStreamPayload {
  toolCallId: string
  toolName?: string
  messages: unknown[]
}

export interface DeepSearchSourcePayload {
  url?: string
  title?: string
  snippet?: string
  excerpts?: string[]
  referenceIds?: number[]
  viewpoint?: string
  error?: string
}

export interface DeepSearchReferencePayload {
  refId: number
  uri: string
  pageId: string
  url: string
  title?: string
  viewpoint: string
  startLine: number
  endLine: number
  text: string
  validationRefContent?: string
  accuracy?: 'high' | 'medium' | 'low' | 'conflicting' | 'insufficient'
  sourceAuthority?: 'high' | 'medium' | 'low' | 'unknown'
  issueReason?: string
  correctFact?: string
}

export interface DeepSearchStreamPayload {
  toolCallId: string
  toolName?: string
  mode?: 'search' | 'validate'
  query?: string
  projectId?: string
  searchId?: string
  status?: 'running' | 'complete' | 'failed'
  sources?: DeepSearchSourcePayload[]
  references?: DeepSearchReferencePayload[]
  prompt?: string
  conclusion?: string
  error?: string
  complete?: boolean
}

type Primitive = string | number | boolean | null

export type ChatToolInput = GraphToolInput | ToolCallEventInput | Record<string, unknown>

export type ChatToolOutput =
  | GraphToolOutput
  | SubagentStreamPayload
  | DeepSearchStreamPayload
  | Primitive
  | ChatToolOutput[]
  | Record<string, unknown>

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  status?: 'pending' | 'complete' | 'failed'
  error?: string
  requestText?: string
  kind?: 'text' | 'graph-event' | 'subagent-event' | 'deepsearch-event'
  toolName?: string
  toolInput?: ChatToolInput
  toolOutput?: ChatToolOutput
  toolStatus?: 'running' | 'complete' | 'failed'
}
