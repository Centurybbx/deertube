import type { Edge, Node } from 'reactflow'

export interface QuestionNodeData {
  question: string
  answer: string
  status?: 'running' | 'failed'
}

export interface SourceNodeData {
  title: string
  url: string
  snippet?: string
  referenceUri?: string
  disableHoverPreview?: boolean
}

export interface InsightNodeData {
  titleLong: string
  titleShort: string
  titleTiny: string
  excerpt: string
  responseId: string
}

export type FlowNodeData = QuestionNodeData | SourceNodeData | InsightNodeData
export type QuestionNode = Node<QuestionNodeData, 'question'>
export type SourceNode = Node<SourceNodeData, 'source'>
export type InsightNode = Node<InsightNodeData, 'insight'>
export type FlowNode = Node<FlowNodeData>
export type FlowEdgeRelationType = 'support'

export interface FlowEdgeData {
  relationType?: FlowEdgeRelationType
}

export type FlowEdge = Edge
