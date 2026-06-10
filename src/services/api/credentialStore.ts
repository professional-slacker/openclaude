/**
 * Credential Store — Multi-provider credential management.
 *
 * Decouples credential storage from provider resolution. Supports multiple
 * concurrent providers with independent API keys, base URLs, and auth configs.
 *
 * Three implementations:
 *   - EnvCredentialStore: reads from process.env
 *   - FileCredentialStore: reads from OS secure storage (keychain/libsecret/credential locker)
 *   - MemoryCredentialStore: in-memory Map for testing & ProviderOverride
 */

import type { ProviderTransport } from './providerConfig.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import type { SecureStorage } from '../../utils/secureStorage/index.js'

// ---------------------------------------------------------------------------
// Interfaces (re-exported for consumers)
// ---------------------------------------------------------------------------

export interface Credential {
  apiKey: string
  baseUrl?: string
  authType?: 'bearer' | 'api-key' | 'custom'
  authHeader?: string
  authScheme?: string
  authHeaderValue?: string
  apiFormat?: ProviderTransport
  customHeaders?: Record<string, string>
}

export interface ProviderConfig {
  providerId: string
  displayName: string
  defaultModel: string
  defaultBaseUrl?: string
  supportedTransports: ProviderTransport[]
  envPrefix: string // e.g., 'OPENAI', 'GEMINI', 'MISTRAL', 'XAI', 'MINIMAX'
  validate(cred: Credential): boolean
}

export interface CredentialStore {
  get(providerId: string): Credential | undefined
  set(providerId: string, cred: Credential): void
  delete(providerId: string): void
  list(): string[]
  getAll(): Map<string, Credential>
}

export interface ProviderRegistry {
  providers: Map<string, ProviderConfig>
  register(config: ProviderConfig): void
  get(providerId: string): ProviderConfig | undefined
  resolve(model: string): ProviderConfig | undefined
  getAllProviders(): ProviderConfig[]
}

// ---------------------------------------------------------------------------
// Provider → env-var mapping
// ---------------------------------------------------------------------------

/**
 * Canonical mapping from provider ID to the environment variable names that
 * carry its API key. Ordered by precedence (first non-empty value wins).
 */
const PROVIDER_ENV_VAR_MAP: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  codex: ['CODEX_API_KEY'],
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  deepseek: ['DEEPSEEK_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  'xiaomi-mimo': ['MIMO_API_KEY'],
  venice: ['VENICE_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
}

/** Map provider ID → default base URL env var name */
const PROVIDER_BASE_URL_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  gemini: 'GEMINI_BASE_URL',
  mistral: 'MISTRAL_BASE_URL',
  xai: 'XAI_BASE_URL',
  minimax: 'MINIMAX_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
  'xiaomi-mimo': 'MIMO_BASE_URL',
}

/** Map provider ID → model override env var name */
const PROVIDER_MODEL_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_MODEL',
  gemini: 'GEMINI_MODEL',
  mistral: 'MISTRAL_MODEL',
  xai: 'XAI_MODEL',
  minimax: 'MINIMAX_MODEL',
  deepseek: 'DEEPSEEK_MODEL',
}

// ---------------------------------------------------------------------------
// EnvCredentialStore
// ---------------------------------------------------------------------------

/**
 * Reads credentials from process.env.
 *
 * Looks up provider-specific env vars (GEMINI_API_KEY, XAI_API_KEY, etc.)
 * and falls back to common aliases. Does NOT mutate process.env — callers
 * that need OPENAI_API_KEY compatibility should use hydrateOpenAIShim.
 */
export class EnvCredentialStore implements CredentialStore {
  private env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
  }

  get(providerId: string): Credential | undefined {
    const apiKey = this.resolveApiKey(providerId)
    if (!apiKey) return undefined

    const baseUrl = this.resolveBaseUrl(providerId)
    const model = this.resolveModel(providerId)

    return {
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { apiFormat: undefined } : {}),
    }
  }

  set(providerId: string, cred: Credential): void {
    // EnvCredentialStore is read-only from process.env.
    // Mutation goes through FileCredentialStore or MemoryCredentialStore.
  }

  delete(providerId: string): void {
    // EnvCredentialStore is read-only.
  }

  list(): string[] {
    return Object.keys(PROVIDER_ENV_VAR_MAP).filter(id => this.get(id) !== undefined)
  }

  getAll(): Map<string, Credential> {
    const result = new Map<string, Credential>()
    Object.keys(PROVIDER_ENV_VAR_MAP).forEach(id => {
      const cred = this.get(id)
      if (cred) result.set(id, cred)
    })
    return result
  }

  private resolveApiKey(providerId: string): string | undefined {
    const vars = PROVIDER_ENV_VAR_MAP[providerId]
    if (!vars) return undefined
    for (let i = 0; i < vars.length; i++) {
      const val = this.env[vars[i]]?.trim()
      if (val) return val
    }
    return undefined
  }

  private resolveBaseUrl(providerId: string): string | undefined {
    const envName = PROVIDER_BASE_URL_ENV_MAP[providerId]
    if (!envName) return undefined
    return this.env[envName]?.trim() || undefined
  }

  private resolveModel(providerId: string): string | undefined {
    const envName = PROVIDER_MODEL_ENV_MAP[providerId]
    if (!envName) return undefined
    return this.env[envName]?.trim() || undefined
  }
}

// ---------------------------------------------------------------------------
// FileCredentialStore
// ---------------------------------------------------------------------------

/**
 * Reads credentials from OS secure storage.
 *
 * Integrates with the existing secureStorage module (keychain on macOS,
 * libsecret on Linux, Credential Locker on Windows, plaintext fallback).
 * Each provider's persisted blob is keyed under its canonical storage key
 * inside the shared SecureStorageData envelope.
 */

/** Storage key per provider inside SecureStorageData */
const PROVIDER_STORAGE_KEY: Record<string, string> = {
  gemini: 'gemini',
  xai: 'xai',
  codex: 'codex',
  github: 'githubModels',
}

/** Credential blob interfaces (mirrors existing implementations) */
interface GeminiStoredBlob {
  accessToken: string
}

interface XaiStoredBlob {
  accessToken: string
  refreshToken: string
  idToken?: string
  tokenEndpoint: string
}

interface CodexStoredBlob {
  apiKey?: string
  accessToken: string
  refreshToken?: string
  accountId?: string
}

interface GithubStoredBlob {
  accessToken: string
  oauthAccessToken?: string
}

export class FileCredentialStore implements CredentialStore {
  private secureStorage: SecureStorage
  private overlay: Map<string, Credential>

  constructor(secureStorage?: SecureStorage) {
    this.secureStorage = secureStorage ?? getSecureStorage()
    this.overlay = new Map()
  }

  get(providerId: string): Credential | undefined {
    // Check overlay first (runtime overrides)
    if (this.overlay.has(providerId)) return this.overlay.get(providerId)

    const storageKey = PROVIDER_STORAGE_KEY[providerId]
    if (!storageKey) return undefined

    try {
      const data = this.secureStorage.read()
      if (!data) return undefined

      switch (providerId) {
        case 'gemini': {
          const blob = (data as Record<string, unknown>)[storageKey] as GeminiStoredBlob | undefined
          const token = blob?.accessToken?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
        case 'xai': {
          const blob = (data as Record<string, unknown>)[storageKey] as XaiStoredBlob | undefined
          const token = blob?.accessToken?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
        case 'codex': {
          const blob = (data as Record<string, unknown>)[storageKey] as CodexStoredBlob | undefined
          const token = (blob?.apiKey ?? blob?.accessToken)?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
        case 'github': {
          const blob = (data as Record<string, unknown>)[storageKey] as GithubStoredBlob | undefined
          const token = blob?.accessToken?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
      }
    } catch {
      // Secure storage unavailable — return undefined
    }

    return undefined
  }

  async getAsync(providerId: string): Promise<Credential | undefined> {
    if (this.overlay.has(providerId)) return this.overlay.get(providerId)

    const storageKey = PROVIDER_STORAGE_KEY[providerId]
    if (!storageKey) return undefined

    try {
      const data = await this.secureStorage.readAsync()
      if (!data) return undefined

      switch (providerId) {
        case 'gemini': {
          const blob = (data as Record<string, unknown>)[storageKey] as GeminiStoredBlob | undefined
          const token = blob?.accessToken?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
        case 'xai': {
          const blob = (data as Record<string, unknown>)[storageKey] as XaiStoredBlob | undefined
          const token = blob?.accessToken?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
        case 'codex': {
          const blob = (data as Record<string, unknown>)[storageKey] as CodexStoredBlob | undefined
          const token = (blob?.apiKey ?? blob?.accessToken)?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
        case 'github': {
          const blob = (data as Record<string, unknown>)[storageKey] as GithubStoredBlob | undefined
          const token = blob?.accessToken?.trim()
          return token ? { apiKey: token, authType: 'bearer' } : undefined
        }
      }
    } catch {
      // Secure storage unavailable
    }

    return undefined
  }

  set(providerId: string, cred: Credential): void {
    this.overlay.set(providerId, cred)
  }

  delete(providerId: string): void {
    this.overlay.delete(providerId)
  }

  list(): string[] {
    const stored = new Set<string>(this.overlay.keys())
    Object.keys(PROVIDER_STORAGE_KEY).forEach(id => {
      if (this.get(id)) stored.add(id)
    })
    return Array.from(stored)
  }

  getAll(): Map<string, Credential> {
    const result = new Map<string, Credential>()
    Object.keys(PROVIDER_STORAGE_KEY).forEach(id => {
      const cred = this.get(id)
      if (cred) result.set(id, cred)
    })
    this.overlay.forEach((cred, id) => {
      result.set(id, cred)
    })
    return result
  }
}

// ---------------------------------------------------------------------------
// MemoryCredentialStore
// ---------------------------------------------------------------------------

/**
 * In-memory credential store for testing and ProviderOverride scenarios.
 * Does not persist anywhere.
 */
export class MemoryCredentialStore implements CredentialStore {
  private store: Map<string, Credential>

  constructor(initial?: Map<string, Credential>) {
    this.store = initial ? new Map(initial) : new Map()
  }

  get(providerId: string): Credential | undefined {
    return this.store.get(providerId)
  }

  set(providerId: string, cred: Credential): void {
    this.store.set(providerId, cred)
  }

  delete(providerId: string): void {
    this.store.delete(providerId)
  }

  list(): string[] {
    return Array.from(this.store.keys())
  }

  getAll(): Map<string, Credential> {
    const copy = new Map<string, Credential>()
    this.store.forEach((cred, id) => copy.set(id, cred))
    return copy
  }
}

// ---------------------------------------------------------------------------
// CompositeCredentialStore
// ---------------------------------------------------------------------------

/**
 * Chains multiple stores together with priority order.
 * First match wins. set/delete go to the first store.
 */
export class CompositeCredentialStore implements CredentialStore {
  private stores: CredentialStore[]

  constructor(...stores: CredentialStore[]) {
    this.stores = stores
  }

  get(providerId: string): Credential | undefined {
    for (let i = 0; i < this.stores.length; i++) {
      const cred = this.stores[i].get(providerId)
      if (cred) return cred
    }
    return undefined
  }

  set(providerId: string, cred: Credential): void {
    if (this.stores.length > 0) {
      this.stores[0].set(providerId, cred)
    }
  }

  delete(providerId: string): void {
    for (let i = 0; i < this.stores.length; i++) {
      this.stores[i].delete(providerId)
    }
  }

  list(): string[] {
    const ids = new Set<string>()
    this.stores.forEach(store => {
      store.list().forEach(id => ids.add(id))
    })
    return Array.from(ids)
  }

  getAll(): Map<string, Credential> {
    const result = new Map<string, Credential>()
    for (let i = this.stores.length - 1; i >= 0; i--) {
      this.stores[i].getAll().forEach((cred, id) => {
        result.set(id, cred)
      })
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

/**
 * Registry of known AI providers. Integrates with the integration registry
 * for vendor/gateway discovery but maintains its own lightweight index for
 * fast credential-keyed lookups.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  providers: Map<string, ProviderConfig> = new Map()

  register(config: ProviderConfig): void {
    this.providers.set(config.providerId, config)
  }

  get(providerId: string): ProviderConfig | undefined {
    return this.providers.get(providerId)
  }

  resolve(_model: string): ProviderConfig | undefined {
    let found: ProviderConfig | undefined
    this.providers.forEach(config => {
      if (!found && config.defaultModel === _model) found = config
    })
    return found
  }

  getAllProviders(): ProviderConfig[] {
    return Array.from(this.providers.values())
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the default CredentialStore chain:
 *   1. Memory (testing / ProviderOverride)
 *   2. File  (OS secure storage)
 *   3. Env   (environment variables)
 *
 * Higher-number = lower priority. Memory overrides everything.
 */
export function createDefaultCredentialStore(
  env?: NodeJS.ProcessEnv,
  secureStorage?: SecureStorage,
): CredentialStore {
  const memory = new MemoryCredentialStore()
  const file = new FileCredentialStore(secureStorage)
  const envStore = new EnvCredentialStore(env)
  return new CompositeCredentialStore(memory, file, envStore)
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _defaultCredentialStore: CredentialStore | undefined

/** Return the lazy singleton CredentialStore (Memory > File > Env). */
export function getDefaultCredentialStore(): CredentialStore {
  if (!_defaultCredentialStore) {
    _defaultCredentialStore = createDefaultCredentialStore()
  }
  return _defaultCredentialStore
}

/**
 * Resolve an API key for a provider using the default store chain.
 * Returns the resolved key or undefined if no credential is configured.
 */
export function resolveProviderApiKey(providerId: string): string | undefined {
  return getDefaultCredentialStore().get(providerId)?.apiKey
}