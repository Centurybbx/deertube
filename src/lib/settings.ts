export type LlmPurpose = 'chat' | 'search' | 'extract' | 'graph' | 'validate'

export const LLM_PURPOSES: LlmPurpose[] = ['chat', 'search', 'extract', 'graph', 'validate']

export type BrowserDisplayMode = 'embedded' | 'cdp'

export interface LlmProviderConfig {
  id: string
  name: string
  provider: string
  apiKey: string
  baseUrl: string
}

export interface LlmModelConfig {
  id: string
  name: string
  providerId: string
  modelId: string
}

export interface LlmUsageConfig {
  chat: string
  search: string
  extract: string
  graph: string
  validate: string
}

export interface LlmRuntimeModelSettings {
  llmProvider?: string
  llmModelId?: string
  llmApiKey?: string
  llmBaseUrl?: string
}

export interface RuntimeSettingsPayload {
  tavilyApiKey?: string
  jinaReaderBaseUrl?: string
  jinaReaderApiKey?: string
  models: Partial<Record<LlmPurpose, LlmRuntimeModelSettings>>
}

export interface ProviderProfile {
  id: string
  name: string
  browserDisplayMode: BrowserDisplayMode
  tavilyApiKey: string
  jinaReaderBaseUrl: string
  jinaReaderApiKey: string
  llmProviders: LlmProviderConfig[]
  llmModels: LlmModelConfig[]
  llmUsage: LlmUsageConfig
}

interface LegacyProviderProfile extends Partial<ProviderProfile> {
  llmProvider?: string
  llmModelId?: string
  llmApiKey?: string
  llmBaseUrl?: string
}

const PROFILES_KEY = 'deertube:profiles'
const ACTIVE_BY_PROJECT_KEY = 'deertube:activeProfileByProject'
const DEFAULT_PROVIDER_NAME = 'OpenAI'
const DEFAULT_PROVIDER_ID = 'openai'
const DEFAULT_MODEL_ID = 'gpt-4o-mini'

const trimOrUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const createDefaultLlmProvider = (
  overrides: Partial<Omit<LlmProviderConfig, 'id'>> & { id?: string } = {},
): LlmProviderConfig => ({
  id: overrides.id ?? crypto.randomUUID(),
  name: trimOrUndefined(overrides.name) ?? DEFAULT_PROVIDER_NAME,
  provider: trimOrUndefined(overrides.provider) ?? DEFAULT_PROVIDER_ID,
  apiKey: overrides.apiKey ?? '',
  baseUrl: overrides.baseUrl ?? '',
})

const createDefaultLlmModel = (
  providerId: string,
  overrides: Partial<Omit<LlmModelConfig, 'id' | 'providerId'>> & { id?: string } = {},
): LlmModelConfig => {
  const modelId = trimOrUndefined(overrides.modelId) ?? DEFAULT_MODEL_ID
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: trimOrUndefined(overrides.name) ?? modelId,
    providerId,
    modelId,
  }
}

const createDefaultLlmUsage = (modelId: string): LlmUsageConfig => ({
  chat: modelId,
  search: modelId,
  extract: modelId,
  graph: modelId,
  validate: modelId,
})

const createDefaultProfile = (): ProviderProfile => {
  const provider = createDefaultLlmProvider()
  const model = createDefaultLlmModel(provider.id)
  return {
    id: crypto.randomUUID(),
    name: 'Default',
    browserDisplayMode: 'embedded',
    tavilyApiKey: '',
    jinaReaderBaseUrl: 'https://r.jina.ai/',
    jinaReaderApiKey: '',
    llmProviders: [provider],
    llmModels: [model],
    llmUsage: createDefaultLlmUsage(model.id),
  }
}

const ensureUniqueIds = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>()
  return items.map((item) => {
    const normalizedId = trimOrUndefined(item.id)
    const candidateId = normalizedId && !seen.has(normalizedId)
      ? normalizedId
      : crypto.randomUUID()
    seen.add(candidateId)
    return candidateId === item.id ? item : { ...item, id: candidateId }
  })
}

const pickValidModelId = (candidate: string | undefined, models: LlmModelConfig[]) => {
  if (!candidate) {
    return undefined
  }
  return models.some((model) => model.id === candidate) ? candidate : undefined
}

const normalizeUsage = (
  usage: Partial<LlmUsageConfig> | undefined,
  models: LlmModelConfig[],
): LlmUsageConfig => {
  const fallbackId = models[0]?.id
  if (!fallbackId) {
    return createDefaultLlmUsage('')
  }
  const chat = pickValidModelId(usage?.chat, models) ?? fallbackId
  const search = pickValidModelId(usage?.search, models) ?? chat
  const extract = pickValidModelId(usage?.extract, models) ?? search
  const graph = pickValidModelId(usage?.graph, models) ?? chat
  const validate = pickValidModelId(usage?.validate, models) ?? search
  return { chat, search, extract, graph, validate }
}

const normalizeProfile = (raw: LegacyProviderProfile): ProviderProfile => {
  const defaults = createDefaultProfile()

  const legacyProvider = createDefaultLlmProvider({
    name: raw.llmProvider,
    provider: raw.llmProvider,
    apiKey: raw.llmApiKey ?? '',
    baseUrl: raw.llmBaseUrl ?? '',
  })
  const rawProviders = Array.isArray(raw.llmProviders) ? raw.llmProviders : []
  const normalizedProviders = rawProviders.length > 0
    ? rawProviders.map((provider) =>
      createDefaultLlmProvider({
        id: provider.id,
        name: provider.name,
        provider: provider.provider,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
      }))
    : [legacyProvider]
  const providers = ensureUniqueIds(normalizedProviders)
  const fallbackProviderId = providers[0]?.id ?? defaults.llmProviders[0].id
  const providerIds = new Set(providers.map((provider) => provider.id))

  const rawModels = Array.isArray(raw.llmModels) ? raw.llmModels : []
  const normalizedModels = rawModels.length > 0
    ? rawModels.map((model) =>
      createDefaultLlmModel(
        providerIds.has(model.providerId) ? model.providerId : fallbackProviderId,
        {
          id: model.id,
          name: model.name,
          modelId: model.modelId,
        },
      ))
    : [
      createDefaultLlmModel(fallbackProviderId, {
        modelId: raw.llmModelId,
        name: raw.llmModelId,
      }),
    ]
  const models = ensureUniqueIds(normalizedModels).map((model) => {
    if (providerIds.has(model.providerId)) {
      return model
    }
    return { ...model, providerId: fallbackProviderId }
  })
  if (models.length === 0) {
    const fallbackModel = createDefaultLlmModel(fallbackProviderId)
    models.push(fallbackModel)
  }

  const usage = normalizeUsage(raw.llmUsage, models)
  const browserDisplayMode =
    raw.browserDisplayMode === 'cdp' ? 'cdp' : 'embedded'

  return {
    id: raw.id ?? defaults.id,
    name: raw.name ?? defaults.name,
    browserDisplayMode,
    tavilyApiKey: raw.tavilyApiKey ?? '',
    jinaReaderBaseUrl: raw.jinaReaderBaseUrl ?? defaults.jinaReaderBaseUrl,
    jinaReaderApiKey: raw.jinaReaderApiKey ?? '',
    llmProviders: providers.length > 0 ? providers : defaults.llmProviders,
    llmModels: models,
    llmUsage: usage,
  }
}

export const ensureValidLlmUsage = (
  usage: Partial<LlmUsageConfig>,
  models: LlmModelConfig[],
): LlmUsageConfig => normalizeUsage(usage, models)

const resolveModelForPurpose = (
  profile: ProviderProfile,
  purpose: LlmPurpose,
): LlmRuntimeModelSettings | null => {
  const fallbackModel = profile.llmModels[0]
  if (!fallbackModel) {
    return null
  }
  const modelId = profile.llmUsage[purpose] || profile.llmUsage.chat
  const model = profile.llmModels.find((item) => item.id === modelId) ?? fallbackModel
  const provider = profile.llmProviders.find((item) => item.id === model.providerId)
    ?? profile.llmProviders[0]
  if (!provider) {
    return null
  }
  return {
    llmProvider: trimOrUndefined(provider.provider),
    llmModelId: trimOrUndefined(model.modelId),
    llmApiKey: trimOrUndefined(provider.apiKey),
    llmBaseUrl: trimOrUndefined(provider.baseUrl),
  }
}

export const buildRuntimeSettings = (
  profile: ProviderProfile | null,
): RuntimeSettingsPayload | undefined => {
  if (!profile) {
    return undefined
  }
  const models: Partial<Record<LlmPurpose, LlmRuntimeModelSettings>> = {}
  LLM_PURPOSES.forEach((purpose) => {
    const resolved = resolveModelForPurpose(profile, purpose)
    if (resolved) {
      models[purpose] = resolved
    }
  })
  return {
    tavilyApiKey: trimOrUndefined(profile.tavilyApiKey),
    jinaReaderBaseUrl: trimOrUndefined(profile.jinaReaderBaseUrl),
    jinaReaderApiKey: trimOrUndefined(profile.jinaReaderApiKey),
    models,
  }
}

const safeParse = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback
  }
  return JSON.parse(value) as T
}

export const loadProfiles = (): ProviderProfile[] => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [createDefaultProfile()]
  }
  const stored = safeParse<LegacyProviderProfile[]>(
    window.localStorage.getItem(PROFILES_KEY),
    [],
  )
  const profiles = Array.isArray(stored) ? stored.map(normalizeProfile) : []
  if (profiles.length === 0) {
    const defaults = [createDefaultProfile()]
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify(defaults))
    return defaults
  }
  return profiles
}

export const saveProfiles = (profiles: ProviderProfile[]) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
}

export const loadActiveProfileId = (projectPath: string): string | null => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const mapping = safeParse<Record<string, string>>(
    window.localStorage.getItem(ACTIVE_BY_PROJECT_KEY),
    {},
  )
  return mapping[projectPath] ?? null
}

export const saveActiveProfileId = (projectPath: string, profileId: string | null) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const mapping = safeParse<Record<string, string>>(
    window.localStorage.getItem(ACTIVE_BY_PROJECT_KEY),
    {},
  )
  if (profileId) {
    mapping[projectPath] = profileId
  } else {
    delete mapping[projectPath]
  }
  window.localStorage.setItem(ACTIVE_BY_PROJECT_KEY, JSON.stringify(mapping))
}

export const ensureActiveProfileId = (
  projectPath: string,
  profiles: ProviderProfile[],
  currentId: string | null,
): string | null => {
  if (profiles.length === 0) {
    return null
  }
  const exists = currentId && profiles.some((profile) => profile.id === currentId)
  if (exists) {
    return currentId
  }
  const fallback = profiles[0]?.id ?? null
  if (fallback) {
    saveActiveProfileId(projectPath, fallback)
  }
  return fallback
}

export const createProfileDraft = (name: string): ProviderProfile => ({
  ...createDefaultProfile(),
  name,
})
