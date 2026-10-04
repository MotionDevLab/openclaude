import { beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  buildCustomLaneProfileEnv,
  findMatchingCustomProvider,
  getCustomLaneDefaultModel,
  getCustomProviderLabel,
  getCustomProviderLimits,
  getCustomProvidersFromSettings,
  getCustomProviderSmallModel,
  isAllowedCustomProviderBaseUrl,
  isCustomLaneActive,
  isCustomProviderLoopbackHost,
  validateCustomProviderEntry,
  validateCustomProviders,
  type CustomProviderEntry,
} from './customProviders.js'
import * as actualSettings from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'

// Snapshot the real settings module before mocking. bun's mock.module is
// process-wide and mock.restore() does NOT undo it, so install the mock ONCE
// here, gated on a flag, and delegate to the real implementation whenever the
// settings-backed test is not actively running.
const realSettings = { ...actualSettings }
let activeCustomProvidersOverride: SettingsJson['customProviders'] | null = null

mock.module('./settings/settings.js', () => ({
  ...realSettings,
  getSettings_DEPRECATED: () => {
    if (!activeCustomProvidersOverride) {
      return realSettings.getSettings_DEPRECATED()
    }
    return {
      ...(realSettings.getSettings_DEPRECATED() ?? {}),
      customProviders: activeCustomProvidersOverride,
    }
  },
}))

beforeEach(() => {
  activeCustomProvidersOverride = null
})

const EXAMPLE_ENTRY: CustomProviderEntry = {
  id: 'example-lane',
  label: 'Example Gateway',
  baseUrl: 'http://127.0.0.1:8080/v1',
  models: ['example-model', 'example-small-model'],
  supportsEffort: true,
  smallModel: 'example-small-model',
}

const OR_ENTRY: CustomProviderEntry = {
  id: 'openrouter-direct',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  models: ['thinkingmachines/inkling:free'],
  supportsEffort: true,
}

describe('validateCustomProviderEntry', () => {
  test('accepts the documented example-lane and openrouter entries', () => {
    expect(validateCustomProviderEntry(EXAMPLE_ENTRY, 0)).toEqual([])
    expect(validateCustomProviderEntry(OR_ENTRY, 1)).toEqual([])
  })

  test('rejects bad ids, naming the entry and field', () => {
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, id: 'Bad_Id!' }, 0),
    ).toEqual(['customProviders["Bad_Id!"].id: must match [a-z0-9-] and be unique'])
    expect(validateCustomProviderEntry({ ...EXAMPLE_ENTRY, id: '' }, 2)).toEqual([
      'customProviders[2].id: must match [a-z0-9-] and be unique',
    ])
  })

  test('rejects empty labels', () => {
    expect(validateCustomProviderEntry({ ...EXAMPLE_ENTRY, label: '  ' }, 0)).toEqual([
      'customProviders["example-lane"].label: must be a non-empty string',
    ])
  })

  test('rejects unparseable base URLs', () => {
    expect(validateCustomProviderEntry({ ...EXAMPLE_ENTRY, baseUrl: '::not a url' }, 0)).toEqual([
      'customProviders["example-lane"].baseUrl: must be a parseable URL',
    ])
  })

  test('permits http:// for loopback hosts only', () => {
    for (const host of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
      expect(
        validateCustomProviderEntry({ ...EXAMPLE_ENTRY, baseUrl: host }, 0),
      ).toEqual([])
    }
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, baseUrl: 'http://192.168.1.10:11434/v1' }, 0),
    ).toEqual([
      'customProviders["example-lane"].baseUrl: plaintext http:// is only allowed for loopback hosts (localhost, 127.0.0.1, ::1)',
    ])
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, baseUrl: 'http://example.com/v1' }, 0),
    ).toEqual([
      'customProviders["example-lane"].baseUrl: plaintext http:// is only allowed for loopback hosts (localhost, 127.0.0.1, ::1)',
    ])
  })

  test('rejects apiKey fields by design', () => {
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, apiKey: 'sk-secret' }, 0),
    ).toEqual([
      'customProviders["example-lane"].apiKey: not supported — keep secrets in env files / shell env, never in settings.json',
    ])
  })

  test('rejects invalid effortLevels', () => {
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, effortLevels: ['low', 'turbo'] }, 0),
    ).toEqual([
      'customProviders["example-lane"].effortLevels: must be a non-empty array of low|medium|high|xhigh|max',
    ])
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, effortLevels: [] }, 0),
    ).toEqual([
      'customProviders["example-lane"].effortLevels: must be a non-empty array of low|medium|high|xhigh|max',
    ])
  })

  test('rejects non-object entries', () => {
    expect(validateCustomProviderEntry('nope', 3)).toEqual([
      'customProviders[3]: entry must be an object',
    ])
  })

  test('accepts lane-default limits', () => {
    expect(
      validateCustomProviderEntry(
        { ...EXAMPLE_ENTRY, contextWindow: 128_000, maxOutputTokens: 8_192 },
        0,
      ),
    ).toEqual([])
  })

  test('rejects malformed lane-default limits, naming entry and field', () => {
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, contextWindow: 0 }, 0),
    ).toEqual([
      'customProviders["example-lane"].contextWindow: must be a positive integer (tokens)',
    ])
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, contextWindow: 1.5 }, 0),
    ).toEqual([
      'customProviders["example-lane"].contextWindow: must be a positive integer (tokens)',
    ])
    expect(
      validateCustomProviderEntry({ ...EXAMPLE_ENTRY, maxOutputTokens: -8 }, 0),
    ).toEqual([
      'customProviders["example-lane"].maxOutputTokens: must be a positive integer (tokens)',
    ])
    expect(
      validateCustomProviderEntry(
        { ...EXAMPLE_ENTRY, maxOutputTokens: 'many' },
        0,
      ),
    ).toEqual([
      'customProviders["example-lane"].maxOutputTokens: must be a positive integer (tokens)',
    ])
  })
})

describe('validateCustomProviders', () => {
  test('accepts undefined (key omitted)', () => {
    expect(validateCustomProviders(undefined)).toEqual([])
  })

  test('rejects non-arrays and duplicate ids', () => {
    expect(validateCustomProviders({})).toEqual(['customProviders: must be an array'])
    expect(validateCustomProviders([EXAMPLE_ENTRY, { ...EXAMPLE_ENTRY, label: 'Copy' }])).toEqual([
      'customProviders["example-lane"].id: duplicate id',
    ])
  })

  test('allows duplicate display labels (matching is by baseUrl+model)', () => {
    const other: CustomProviderEntry = {
      id: 'example-lane-2',
      label: 'Example Gateway',
      baseUrl: 'http://127.0.0.1:8081/v1',
    }
    expect(validateCustomProviders([EXAMPLE_ENTRY, other])).toEqual([])
  })
})

describe('isCustomProviderLoopbackHost', () => {
  test('matches loopback hosts exactly, never substrings', () => {
    expect(isCustomProviderLoopbackHost('localhost')).toBe(true)
    expect(isCustomProviderLoopbackHost('127.0.0.1')).toBe(true)
    expect(isCustomProviderLoopbackHost('::1')).toBe(true)
    expect(isCustomProviderLoopbackHost('[::1]')).toBe(true)
    expect(isCustomProviderLoopbackHost('evil.localhost.com')).toBe(false)
    expect(isCustomProviderLoopbackHost('localhost.evil.com')).toBe(false)
    expect(isCustomProviderLoopbackHost('192.168.1.10')).toBe(false)
  })
})

describe('isAllowedCustomProviderBaseUrl', () => {
  test('allows https anywhere, http only on loopback', () => {
    expect(isAllowedCustomProviderBaseUrl('https://openrouter.ai/api/v1')).toBe(true)
    expect(isAllowedCustomProviderBaseUrl('http://127.0.0.1:8080/v1')).toBe(true)
    expect(isAllowedCustomProviderBaseUrl('http://example.com/v1')).toBe(false)
    expect(isAllowedCustomProviderBaseUrl('::not a url')).toBe(false)
    expect(isAllowedCustomProviderBaseUrl('ws://127.0.0.1:8080/v1')).toBe(false)
  })
})

describe('findMatchingCustomProvider', () => {
  const entries = [EXAMPLE_ENTRY, OR_ENTRY]

  test('matches on normalized base URL ignoring trailing slashes', () => {
    expect(
      findMatchingCustomProvider(
        'http://127.0.0.1:8080/v1///',
        'example-model',
        entries,
      ),
    ).toEqual(EXAMPLE_ENTRY)
  })

  test('matches models case-insensitively', () => {
    expect(
      findMatchingCustomProvider(
        'http://127.0.0.1:8080/v1',
        'EXAMPLE-MODEL',
        entries,
      )?.id,
    ).toBe('example-lane')
  })

  test('models omitted or ["*"] matches every model', () => {
    const wildcard: CustomProviderEntry = {
      id: 'wild',
      label: 'Wild',
      baseUrl: 'http://127.0.0.1:19999/v1',
    }
    const star: CustomProviderEntry = {
      id: 'star',
      label: 'Star',
      baseUrl: 'http://127.0.0.1:19998/v1',
      models: ['*'],
    }
    expect(findMatchingCustomProvider('http://127.0.0.1:19999/v1', 'anything-at-all', [wildcard])?.id).toBe('wild')
    expect(findMatchingCustomProvider('http://127.0.0.1:19998/v1', 'anything-at-all', [star])?.id).toBe('star')
  })

  test('model mismatch does not match', () => {
    expect(
      findMatchingCustomProvider('http://127.0.0.1:8080/v1', 'gpt-4o', entries),
    ).toBeUndefined()
  })

  test('base URL mismatch does not match', () => {
    expect(
      findMatchingCustomProvider('http://127.0.0.1:9999/v1', 'example-model', entries),
    ).toBeUndefined()
  })

  test('omitted model matches by base URL alone', () => {
    expect(
      findMatchingCustomProvider('https://openrouter.ai/api/v1', undefined, entries)?.id,
    ).toBe('openrouter-direct')
  })

  test('returns undefined for missing or unparseable base URLs', () => {
    expect(findMatchingCustomProvider(undefined, 'x', entries)).toBeUndefined()
    expect(findMatchingCustomProvider('', 'x', entries)).toBeUndefined()
  })
})

describe('getCustomProviderLabel / getCustomProviderSmallModel', () => {
  const entries = [EXAMPLE_ENTRY, OR_ENTRY]

  test('label resolves through the same lookup', () => {
    expect(
      getCustomProviderLabel('http://127.0.0.1:8080/v1', 'example-model', entries),
    ).toBe('Example Gateway')
    expect(
      getCustomProviderLabel('http://127.0.0.1:8080/v1', 'gpt-4o', entries),
    ).toBeUndefined()
  })

  test('smallModel falls through to undefined when the entry sets none', () => {
    expect(
      getCustomProviderSmallModel('http://127.0.0.1:8080/v1', 'example-model', entries),
    ).toBe('example-small-model')
    expect(
      getCustomProviderSmallModel('https://openrouter.ai/api/v1', 'thinkingmachines/inkling:free', entries),
    ).toBeUndefined()
  })
})

describe('getCustomProviderLimits', () => {
  const limited: CustomProviderEntry = {
    id: 'limited-lane',
    label: 'Limited',
    baseUrl: 'https://limits.example/v1',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  }
  const entries = [EXAMPLE_ENTRY, OR_ENTRY, limited]

  test('returns the matched entry limits, each field independent', () => {
    expect(
      getCustomProviderLimits('https://limits.example/v1', 'any-model', entries),
    ).toEqual({ contextWindow: 128_000, maxOutputTokens: 8_192 })
    expect(
      getCustomProviderLimits(
        'https://limits.example/v1',
        'any-model',
        [{ ...limited, maxOutputTokens: undefined }],
      ),
    ).toEqual({ contextWindow: 128_000 })
  })

  test('returns {} when no entry matches or the entry declares no limits', () => {
    expect(
      getCustomProviderLimits('https://limits.example/v1', undefined, [OR_ENTRY]),
    ).toEqual({})
    expect(
      getCustomProviderLimits('https://unknown.example/v1', 'any-model', entries),
    ).toEqual({})
    expect(getCustomProviderLimits(undefined, 'any-model', entries)).toEqual({})
  })

  test('strips ?runtime suffixes for scoped entries', () => {
    const scoped: CustomProviderEntry = {
      id: 'scoped-lane',
      label: 'Scoped',
      baseUrl: 'https://scoped.example/v1',
      models: ['scoped-model'],
      contextWindow: 64_000,
    }
    expect(
      getCustomProviderLimits('https://scoped.example/v1', 'scoped-model?reasoning=high', [scoped]),
    ).toEqual({ contextWindow: 64_000 })
    expect(
      getCustomProviderLimits('https://scoped.example/v1', 'other-model?reasoning=high', [scoped]),
    ).toEqual({})
  })

  test('drops malformed values instead of throwing', () => {
    const malformed = {
      ...limited,
      contextWindow: -5,
      maxOutputTokens: 1.5,
    } as unknown as CustomProviderEntry
    expect(
      getCustomProviderLimits('https://limits.example/v1', 'any-model', [malformed]),
    ).toEqual({})
  })
})

describe('settings-backed lookup', () => {
  test('reads entries from loaded settings', async () => {
    activeCustomProvidersOverride = [EXAMPLE_ENTRY]
    const fresh = await import(`./customProviders.js?settings-backed=${Date.now()}`)
    expect(
      fresh.getCustomProviderLabel('http://127.0.0.1:8080/v1', 'example-model'),
    ).toBe('Example Gateway')
    activeCustomProvidersOverride = null
  })

  test('drops lanes whose baseUrl fails the allowlist', () => {
    activeCustomProvidersOverride = [
      EXAMPLE_ENTRY,
      OR_ENTRY,
      {
        ...EXAMPLE_ENTRY,
        id: 'plain-http',
        baseUrl: 'http://example.com/v1',
      },
    ]
    try {
      expect(getCustomProvidersFromSettings().map(e => e.id)).toEqual([
        'example-lane',
        'openrouter-direct',
      ])
    } finally {
      activeCustomProvidersOverride = null
    }
  })
})

describe('in-session lane switch helpers (§3.4)', () => {
  test('default model is the first listed model for specific lists', () => {
    expect(getCustomLaneDefaultModel(EXAMPLE_ENTRY, 'gpt-4o')).toBe(
      'example-model',
    )
  })

  test('wildcard entries keep the current lane model', () => {
    const wildcard: CustomProviderEntry = {
      id: 'wild',
      label: 'Wild',
      baseUrl: 'http://127.0.0.1:19999/v1',
    }
    const star: CustomProviderEntry = {
      ...wildcard,
      id: 'star',
      models: ['*'],
    }
    expect(getCustomLaneDefaultModel(wildcard, 'current-model')).toBe('current-model')
    expect(getCustomLaneDefaultModel(star, 'current-model')).toBe('current-model')
    expect(getCustomLaneDefaultModel(wildcard, undefined)).toBeUndefined()
    expect(getCustomLaneDefaultModel(wildcard, '  ')).toBeUndefined()
  })

  test('profile env carries endpoint + model, no key material', () => {
    expect(buildCustomLaneProfileEnv(EXAMPLE_ENTRY, 'gpt-4o')).toEqual({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
      OPENAI_MODEL: 'example-model',
    })
  })

  test('profile env omits the model when neither entry nor session has one', () => {
    const wildcard: CustomProviderEntry = {
      id: 'wild',
      label: 'Wild',
      baseUrl: 'http://127.0.0.1:19999/v1',
    }
    expect(buildCustomLaneProfileEnv(wildcard, undefined)).toEqual({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://127.0.0.1:19999/v1',
    })
  })

  test('lane-active check matches by (baseUrl, model)', () => {
    expect(
      isCustomLaneActive(
        EXAMPLE_ENTRY,
        'http://127.0.0.1:8080/v1',
        'example-model',
      ),
    ).toBe(true)
    expect(
      isCustomLaneActive(EXAMPLE_ENTRY, 'http://127.0.0.1:8080/v1', 'gpt-4o'),
    ).toBe(false)
    expect(isCustomLaneActive(EXAMPLE_ENTRY, undefined, undefined)).toBe(false)
  })
})
