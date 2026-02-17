import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { generateText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { baseProcedure, createTRPCRouter } from '../init'
import { ensureProjectStore } from './project'
import type { JsonObject, JsonValue } from '../../../src/types/json'
import { resolveDeepResearchReference } from '../../deepresearch/store'

const TavilyOptionalStringSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value : undefined),
  z.string().optional(),
)

const TavilyOptionalNullableStringSchema = z.preprocess(
  (value) => (typeof value === 'string' || value === null ? value : undefined),
  z.string().nullable().optional(),
)

const TavilySearchResultSchema = z.object({
  title: TavilyOptionalStringSchema,
  url: TavilyOptionalStringSchema,
  content: TavilyOptionalStringSchema,
  raw_content: TavilyOptionalNullableStringSchema,
  snippet: TavilyOptionalStringSchema,
  description: TavilyOptionalStringSchema,
})

type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>

const TavilyResponseSchema = z.object({
  results: z.array(TavilySearchResultSchema).optional(),
})

const ModelSettingsSchema = z.object({
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
})

const RuntimeSettingsSchema = z.object({
  tavilyApiKey: z.string().optional(),
  jinaReaderBaseUrl: z.string().optional(),
  jinaReaderApiKey: z.string().optional(),
  llmProvider: z.string().optional(),
  llmModelId: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
  models: z.object({
    chat: ModelSettingsSchema.optional(),
    search: ModelSettingsSchema.optional(),
    extract: ModelSettingsSchema.optional(),
    graph: ModelSettingsSchema.optional(),
    validate: ModelSettingsSchema.optional(),
  }).optional(),
})

type ModelSettings = z.infer<typeof ModelSettingsSchema>
type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>

const trimOrUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const buildLegacyModelSettings = (settings: RuntimeSettings | undefined): ModelSettings | undefined => {
  if (!settings) {
    return undefined
  }
  const llmProvider = trimOrUndefined(settings.llmProvider)
  const llmModelId = trimOrUndefined(settings.llmModelId)
  const llmApiKey = trimOrUndefined(settings.llmApiKey)
  const llmBaseUrl = trimOrUndefined(settings.llmBaseUrl)
  if (!llmProvider && !llmModelId && !llmApiKey && !llmBaseUrl) {
    return undefined
  }
  return {
    llmProvider,
    llmModelId,
    llmApiKey,
    llmBaseUrl,
  }
}

const resolveModelSettings = (
  preferred: ModelSettings | undefined,
  fallback: ModelSettings | undefined,
) => {
  const llmProvider
    = trimOrUndefined(preferred?.llmProvider)
      ?? trimOrUndefined(fallback?.llmProvider)
      ?? 'openai'
  const llmModelId
    = trimOrUndefined(preferred?.llmModelId)
      ?? trimOrUndefined(fallback?.llmModelId)
      ?? 'gpt-4o-mini'
  const llmApiKey
    = trimOrUndefined(preferred?.llmApiKey)
      ?? trimOrUndefined(fallback?.llmApiKey)
  const llmBaseUrl
    = trimOrUndefined(preferred?.llmBaseUrl)
      ?? trimOrUndefined(fallback?.llmBaseUrl)
      ?? process.env.OPENAI_BASE_URL
      ?? 'https://api.openai.com/v1'
  return {
    llmProvider,
    llmModelId,
    llmApiKey,
    llmBaseUrl,
  }
}

const parseJson = (raw: string): JsonValue | null => {
  const trimmed = raw.trim()
  if (
    !trimmed.startsWith('{')
    && !trimmed.startsWith('[')
    && !trimmed.startsWith('"')
  ) {
    return null
  }
  return JSON.parse(raw) as JsonValue
}

async function writeJsonFile(filePath: string, data: JsonValue) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

async function fetchTavilySearch(query: string, maxResults: number): Promise<TavilySearchResult[]> {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is not set')
  }
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_raw_content: false,
      search_depth: 'advanced',
    }),
  })
  const raw = await response.text()
  if (!response.ok) {
    console.warn('[tavily.search.error]', {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    })
    throw new Error(`Tavily search failed: ${response.status}`)
  }
  let parsedJson: JsonValue
  try {
    parsedJson = JSON.parse(raw) as JsonValue
  }
  catch (error) {
    console.warn('[tavily.search.parse]', {
      query,
      status: response.status,
      error: error instanceof Error ? error.message : 'unknown',
      bodyPreview: raw.slice(0, 400),
    })
    throw new Error('Tavily search response parse failed.')
  }
  const parsed = TavilyResponseSchema.safeParse(parsedJson)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    console.warn('[tavily.search.schema]', {
      query,
      status: response.status,
      issue: firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'invalid',
      bodyPreview: raw.slice(0, 400),
    })
    throw new Error('Tavily search response schema invalid.')
  }
  const results = parsed.data.results ?? []
  if (results.length === 0) {
    console.warn('[tavily.search.empty]', {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    })
  }
  return results
}

async function fetchTavilySearchWithKey(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<TavilySearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_raw_content: false,
      search_depth: 'advanced',
    }),
  })
  const raw = await response.text()
  if (!response.ok) {
    console.warn('[tavily.search.error]', {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    })
    throw new Error(`Tavily search failed: ${response.status}`)
  }
  let parsedJson: JsonValue
  try {
    parsedJson = JSON.parse(raw) as JsonValue
  }
  catch (error) {
    console.warn('[tavily.search.parse]', {
      query,
      status: response.status,
      error: error instanceof Error ? error.message : 'unknown',
      bodyPreview: raw.slice(0, 400),
    })
    throw new Error('Tavily search response parse failed.')
  }
  const parsed = TavilyResponseSchema.safeParse(parsedJson)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    console.warn('[tavily.search.schema]', {
      query,
      status: response.status,
      issue: firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'invalid',
      bodyPreview: raw.slice(0, 400),
    })
    throw new Error('Tavily search response schema invalid.')
  }
  const results = parsed.data.results ?? []
  if (results.length === 0) {
    console.warn('[tavily.search.empty]', {
      query,
      status: response.status,
      bodyPreview: raw.slice(0, 400),
    })
  }
  return results
}

async function fetchJinaReaderMarkdown(
  url: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<string> {
  const normalizedBase = baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : 'https://r.jina.ai/'
  const readerUrl = `${normalizedBase}${url}`
  const response = await fetch(readerUrl, {
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  })
  if (!response.ok) {
    throw new Error(`Jina reader failed: ${response.status}`)
  }
  const raw = await response.text()
  const parsed = parseJson(raw)
  if (parsed === null) {
    return raw
  }
  if (typeof parsed === 'string') {
    return parsed
  }
  if (typeof parsed === 'object') {
    const obj = parsed as JsonObject
    if (typeof obj.content === 'string') {
      return obj.content
    }
    const nested = obj.data
    if (nested && typeof nested === 'object') {
      const nestedContent = (nested as JsonObject).content
      if (typeof nestedContent === 'string') {
        return nestedContent
      }
    }
    return JSON.stringify(obj, null, 2)
  }
  return raw
}

export const deepSearchRouter = createTRPCRouter({
  resolveReference: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        uri: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const reference = await resolveDeepResearchReference(input.projectPath, input.uri)
      return { reference }
    }),
  run: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        query: z.string().min(1),
        maxResults: z.number().min(1).max(8).optional(),
        context: z.string().optional(),
        settings: RuntimeSettingsSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const store = await ensureProjectStore(input.projectPath)
      const maxResults = input.maxResults ?? 5
      const searchItems = input.settings?.tavilyApiKey
        ? await fetchTavilySearchWithKey(input.query, maxResults, input.settings.tavilyApiKey)
        : await fetchTavilySearch(input.query, maxResults)
      const sources = await Promise.all(
        searchItems.map(async (item) => {
          const pageId = randomUUID()
          const url = item.url ?? ''
          const title = item.title ?? item.description ?? 'Untitled'
          let markdown = item.content ?? item.snippet ?? ''
          if (url) {
            markdown = await fetchJinaReaderMarkdown(
              url,
              input.settings?.jinaReaderBaseUrl,
              input.settings?.jinaReaderApiKey,
            )
          }
          const metadata = {
            id: pageId,
            title,
            url,
            content: markdown,
            fetchedAt: new Date().toISOString(),
          }
          await writeJsonFile(path.join(store.pagesDir, `${pageId}.json`), metadata)
          return {
            id: pageId,
            title,
            url,
            snippet: markdown.slice(0, 400),
          }
        }),
      )

      const searchId = randomUUID()
      await writeJsonFile(path.join(store.searchesDir, `${searchId}.json`), {
        id: searchId,
        query: input.query,
        sources: sources.map((source) => source.id),
        createdAt: new Date().toISOString(),
      })

      let answer = 'Search completed.'
      const legacyModelSettings = buildLegacyModelSettings(input.settings)
      const resolvedModel = resolveModelSettings(
        input.settings?.models?.search,
        input.settings?.models?.chat ?? legacyModelSettings,
      )
      const contextBlock = input.context
        ? `Context from current graph path:\n${input.context}\n\n`
        : ''
      const context = sources
        .map((source, index) => {
          return `Source ${index + 1}: ${source.title}\n${source.snippet}`
        })
        .join('\n\n')
      const provider = createOpenAICompatible({
        name: resolvedModel.llmProvider,
        baseURL: resolvedModel.llmBaseUrl,
        apiKey: resolvedModel.llmApiKey,
      })
      const result = await generateText({
        model: provider(resolvedModel.llmModelId),
        system:
          'You are a deep-research assistant. Write a concise answer and cite sources by index like [1].',
        prompt: `${contextBlock}Question: ${input.query}\n\n${context}`,
      })
      answer = result.text

      return {
        answer,
        sources,
        searchId,
      }
    }),
})

export type DeepSearchRouter = typeof deepSearchRouter
