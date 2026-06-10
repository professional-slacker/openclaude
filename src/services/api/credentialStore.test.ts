import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  CompositeCredentialStore,
  DefaultProviderRegistry,
  EnvCredentialStore,
  MemoryCredentialStore,
  createDefaultCredentialStore,
  type Credential,
  type CredentialStore,
  type ProviderConfig,
  type ProviderRegistry,
} from './credentialStore.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCredential(overrides?: Partial<Credential>): Credential {
  return {
    apiKey: 'sk-test-key',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// MemoryCredentialStore
// ---------------------------------------------------------------------------

describe('MemoryCredentialStore', () => {
  let store: MemoryCredentialStore

  beforeEach(() => {
    store = new MemoryCredentialStore()
  })

  test('get returns undefined for unknown provider', () => {
    expect(store.get('unknown')).toBeUndefined()
  })

  test('set and get round-trip', () => {
    const cred = makeCredential({ apiKey: 'sk-abc', baseUrl: 'https://api.example.com/v1' })
    store.set('test-provider', cred)
    const result = store.get('test-provider')
    expect(result).toBeDefined()
    expect(result!.apiKey).toBe('sk-abc')
    expect(result!.baseUrl).toBe('https://api.example.com/v1')
  })

  test('set overwrites existing credential', () => {
    store.set('test-provider', makeCredential({ apiKey: 'first' }))
    store.set('test-provider', makeCredential({ apiKey: 'second' }))
    expect(store.get('test-provider')!.apiKey).toBe('second')
  })

  test('delete removes credential', () => {
    store.set('test-provider', makeCredential())
    expect(store.get('test-provider')).toBeDefined()
    store.delete('test-provider')
    expect(store.get('test-provider')).toBeUndefined()
  })

  test('delete of unknown provider is a no-op', () => {
    store.delete('unknown')
    // Should not throw
  })

  test('list returns all provider IDs', () => {
    store.set('a', makeCredential())
    store.set('b', makeCredential())
    const ids = store.list()
    expect(ids).toHaveLength(2)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  test('list returns empty array when store is empty', () => {
    expect(store.list()).toEqual([])
  })

  test('getAll returns all credentials', () => {
    store.set('a', makeCredential({ apiKey: 'key-a' }))
    store.set('b', makeCredential({ apiKey: 'key-b' }))
    const all = store.getAll()
    expect(all.size).toBe(2)
    expect(all.get('a')!.apiKey).toBe('key-a')
    expect(all.get('b')!.apiKey).toBe('key-b')
  })

  test('getAll returns a copy, not a live reference', () => {
    store.set('a', makeCredential())
    const copy = store.getAll()
    copy.delete('a')
    expect(store.get('a')).toBeDefined()
  })

  test('constructor accepts initial map', () => {
    const initial = new Map<string, Credential>()
    initial.set('preloaded', makeCredential({ apiKey: 'preloaded-key' }))
    const preloaded = new MemoryCredentialStore(initial)
    expect(preloaded.get('preloaded')!.apiKey).toBe('preloaded-key')
  })
})

// ---------------------------------------------------------------------------
// EnvCredentialStore
// ---------------------------------------------------------------------------

describe('EnvCredentialStore', () => {
  test('get returns undefined when env var is not set', () => {
    const store = new EnvCredentialStore({})
    expect(store.get('openai')).toBeUndefined()
  })

  test('get returns credential when OPENAI_API_KEY is set', () => {
    const store = new EnvCredentialStore({ OPENAI_API_KEY: 'sk-openai-test' })
    const cred = store.get('openai')
    expect(cred).toBeDefined()
    expect(cred!.apiKey).toBe('sk-openai-test')
  })

  test('get returns credential for Gemini with GEMINI_API_KEY', () => {
    const store = new EnvCredentialStore({ GEMINI_API_KEY: 'gemini-key' })
    const cred = store.get('gemini')
    expect(cred).toBeDefined()
    expect(cred!.apiKey).toBe('gemini-key')
  })

  test('get falls back to GOOGLE_API_KEY for Gemini', () => {
    const store = new EnvCredentialStore({ GOOGLE_API_KEY: 'google-key' })
    const cred = store.get('gemini')
    expect(cred).toBeDefined()
    expect(cred!.apiKey).toBe('google-key')
  })

  test('get prefers GEMINI_API_KEY over GOOGLE_API_KEY', () => {
    const store = new EnvCredentialStore({
      GEMINI_API_KEY: 'gemini-first',
      GOOGLE_API_KEY: 'google-second',
    })
    expect(store.get('gemini')!.apiKey).toBe('gemini-first')
  })

  test('get returns credential for xAI with XAI_API_KEY', () => {
    const store = new EnvCredentialStore({ XAI_API_KEY: 'xai-key' })
    expect(store.get('xai')!.apiKey).toBe('xai-key')
  })

  test('get resolves baseUrl from env', () => {
    const store = new EnvCredentialStore({
      GEMINI_API_KEY: 'gk',
      GEMINI_BASE_URL: 'https://custom-gemini.example.com',
    })
    expect(store.get('gemini')!.baseUrl).toBe('https://custom-gemini.example.com')
  })

  test('get returns undefined for unknown provider', () => {
    const store = new EnvCredentialStore({ SOME_KEY: 'value' })
    expect(store.get('nonexistent')).toBeUndefined()
  })

  test('get ignores empty/whitespace-only env vars', () => {
    const store = new EnvCredentialStore({ OPENAI_API_KEY: '   ' })
    expect(store.get('openai')).toBeUndefined()
  })

  test('set is a no-op (does not mutate env)', () => {
    const env = { OPENAI_API_KEY: 'original' }
    const store = new EnvCredentialStore(env)
    store.set('openai', makeCredential({ apiKey: 'override' }))
    expect(env.OPENAI_API_KEY).toBe('original')
  })

  test('delete is a no-op (does not mutate env)', () => {
    const env = { OPENAI_API_KEY: 'original' }
    const store = new EnvCredentialStore(env)
    store.delete('openai')
    expect(env.OPENAI_API_KEY).toBe('original')
  })

  test('list returns provider IDs with configured env vars', () => {
    const store = new EnvCredentialStore({
      OPENAI_API_KEY: 'sk-1',
      GEMINI_API_KEY: 'gk-1',
    })
    const ids = store.list()
    expect(ids).toContain('openai')
    expect(ids).toContain('gemini')
    expect(ids).not.toContain('mistral')
  })

  test('getAll returns all configured credentials', () => {
    const store = new EnvCredentialStore({
      OPENAI_API_KEY: 'sk-oai',
      XAI_API_KEY: 'xai-k',
    })
    const all = store.getAll()
    expect(all.size).toBeGreaterThanOrEqual(2)
    expect(all.get('openai')!.apiKey).toBe('sk-oai')
    expect(all.get('xai')!.apiKey).toBe('xai-k')
  })

  test('getAll excludes providers without credentials', () => {
    const store = new EnvCredentialStore({})
    const all = store.getAll()
    expect(all.size).toBe(0)
  })

  test('GitHub provider reads GITHUB_TOKEN and GH_TOKEN', () => {
    const store1 = new EnvCredentialStore({ GITHUB_TOKEN: 'gh-token' })
    expect(store1.get('github')!.apiKey).toBe('gh-token')

    const store2 = new EnvCredentialStore({ GH_TOKEN: 'gh-alt' })
    expect(store2.get('github')!.apiKey).toBe('gh-alt')

    const store3 = new EnvCredentialStore({ GITHUB_TOKEN: 'first', GH_TOKEN: 'second' })
    expect(store3.get('github')!.apiKey).toBe('first')
  })

  test('DeepSeek provider reads DEEPSEEK_API_KEY', () => {
    const store = new EnvCredentialStore({ DEEPSEEK_API_KEY: 'ds-key' })
    expect(store.get('deepseek')!.apiKey).toBe('ds-key')
  })

  test('MiniMax provider reads MINIMAX_API_KEY', () => {
    const store = new EnvCredentialStore({ MINIMAX_API_KEY: 'mm-key' })
    expect(store.get('minimax')!.apiKey).toBe('mm-key')
  })

  test('Mistral provider reads MISTRAL_API_KEY', () => {
    const store = new EnvCredentialStore({ MISTRAL_API_KEY: 'mistral-key' })
    expect(store.get('mistral')!.apiKey).toBe('mistral-key')
  })
})

// ---------------------------------------------------------------------------
// CompositeCredentialStore
// ---------------------------------------------------------------------------

describe('CompositeCredentialStore', () => {
  let high: MemoryCredentialStore
  let low: MemoryCredentialStore
  let composite: CompositeCredentialStore

  beforeEach(() => {
    high = new MemoryCredentialStore()
    low = new MemoryCredentialStore()
    composite = new CompositeCredentialStore(high, low)
  })

  test('get returns from highest-priority store first', () => {
    high.set('test', makeCredential({ apiKey: 'high-key' }))
    low.set('test', makeCredential({ apiKey: 'low-key' }))
    expect(composite.get('test')!.apiKey).toBe('high-key')
  })

  test('get falls through to lower-priority store', () => {
    low.set('test', makeCredential({ apiKey: 'low-key' }))
    expect(composite.get('test')!.apiKey).toBe('low-key')
  })

  test('get returns undefined when no store has the credential', () => {
    expect(composite.get('unknown')).toBeUndefined()
  })

  test('set writes to the first (highest-priority) store', () => {
    composite.set('test', makeCredential({ apiKey: 'composite-set' }))
    expect(high.get('test')!.apiKey).toBe('composite-set')
    expect(low.get('test')).toBeUndefined()
  })

  test('set is a no-op when store list is empty', () => {
    const empty = new CompositeCredentialStore()
    // Should not throw
    empty.set('test', makeCredential())
  })

  test('delete removes from all stores', () => {
    high.set('test', makeCredential())
    low.set('test', makeCredential())
    composite.delete('test')
    expect(high.get('test')).toBeUndefined()
    expect(low.get('test')).toBeUndefined()
  })

  test('list aggregates IDs from all stores', () => {
    high.set('a', makeCredential())
    low.set('b', makeCredential())
    const ids = composite.list()
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).toHaveLength(2)
  })

  test('list deduplicates IDs across stores', () => {
    high.set('shared', makeCredential())
    low.set('shared', makeCredential())
    expect(composite.list()).toHaveLength(1)
  })

  test('getAll merges all stores, higher-priority wins on conflict', () => {
    high.set('shared', makeCredential({ apiKey: 'high-wins' }))
    low.set('shared', makeCredential({ apiKey: 'low-loses' }))
    low.set('only-low', makeCredential({ apiKey: 'low-only' }))
    const all = composite.getAll()
    expect(all.get('shared')!.apiKey).toBe('high-wins')
    expect(all.get('only-low')!.apiKey).toBe('low-only')
  })
})

// ---------------------------------------------------------------------------
// DefaultProviderRegistry
// ---------------------------------------------------------------------------

describe('DefaultProviderRegistry', () => {
  let registry: DefaultProviderRegistry

  const mockProvider: ProviderConfig = {
    providerId: 'mock-provider',
    displayName: 'Mock Provider',
    defaultModel: 'mock-model-v1',
    supportedTransports: ['chat_completions'],
    envPrefix: 'MOCK',
    validate: () => true,
  }

  beforeEach(() => {
    registry = new DefaultProviderRegistry()
  })

  test('register adds a provider', () => {
    registry.register(mockProvider)
    expect(registry.get('mock-provider')).toBe(mockProvider)
  })

  test('get returns undefined for unknown provider', () => {
    expect(registry.get('unknown')).toBeUndefined()
  })

  test('register overwrites existing provider with same ID', () => {
    const v2: ProviderConfig = { ...mockProvider, defaultModel: 'mock-model-v2' }
    registry.register(mockProvider)
    registry.register(v2)
    expect(registry.get('mock-provider')!.defaultModel).toBe('mock-model-v2')
  })

  test('resolve finds provider by defaultModel', () => {
    registry.register(mockProvider)
    const found = registry.resolve('mock-model-v1')
    expect(found).toBeDefined()
    expect(found!.providerId).toBe('mock-provider')
  })

  test('resolve returns undefined for unresolved model', () => {
    registry.register(mockProvider)
    expect(registry.resolve('nonexistent-model')).toBeUndefined()
  })

  test('resolve returns first match when multiple providers have same model', () => {
    const second: ProviderConfig = {
      ...mockProvider,
      providerId: 'second-provider',
    }
    registry.register(mockProvider)
    registry.register(second)
    const found = registry.resolve('mock-model-v1')
    expect(found!.providerId).toBe('mock-provider')
  })

  test('getAllProviders returns all registered providers', () => {
    registry.register(mockProvider)
    const second: ProviderConfig = {
      ...mockProvider,
      providerId: 'second-provider',
      defaultModel: 'second-model',
    }
    registry.register(second)
    const all = registry.getAllProviders()
    expect(all).toHaveLength(2)
  })

  test('getAllProviders returns empty array when no providers registered', () => {
    expect(registry.getAllProviders()).toEqual([])
  })

  test('providers map is publicly accessible', () => {
    registry.register(mockProvider)
    expect(registry.providers.has('mock-provider')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createDefaultCredentialStore factory
// ---------------------------------------------------------------------------

describe('createDefaultCredentialStore', () => {
  test('returns a CompositeCredentialStore', () => {
    const store = createDefaultCredentialStore({}, undefined)
    expect(store).toBeDefined()
    expect(store.get).toBeDefined()
    expect(store.set).toBeDefined()
  })

  test('resolves from env when key is set', () => {
    const store = createDefaultCredentialStore({ OPENAI_API_KEY: 'sk-from-env' }, undefined)
    expect(store.get('openai')!.apiKey).toBe('sk-from-env')
  })

  test('memory overrides env via set', () => {
    const store = createDefaultCredentialStore({ OPENAI_API_KEY: 'sk-from-env' }, undefined)
    store.set('openai', makeCredential({ apiKey: 'memory-override' }))
    expect(store.get('openai')!.apiKey).toBe('memory-override')
  })
})
