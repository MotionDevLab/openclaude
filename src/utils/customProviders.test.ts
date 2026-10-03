import { beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  findMatchingCustomProvider,
  getCustomProviderLabel,
  getCustomProviderSmallModel,
  isAllowedCustomProviderBaseUrl,
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

const ZEN_ENTRY: CustomProviderEntry = {
  id: 'zen-router',
  label: 'OpenCode Zen Router',
  baseUrl: 'http://127.0.0.1:18905/zen/v1',
  models: ['muse-spark-1.3-contributor-free', 'nemotron-3.5-lightning-free'],
  supportsEffort: true,
  smallModel: 'nemotron-3.5-lightning-free',
}

const OR_ENTRY: CustomProviderEntry = {
  id: 'openrouter-direct',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  models: ['thinkingmachines/inkling:free'],
  supportsEffort: true,
}

describe('validateCustomProviderEntry', () => {
  test('accepts the documented zen-router and openrouter entries', () => {
    expect(validateCustomProviderEntry(ZEN_ENTRY, 0)).toEqual([])
    expect(validateCustomProviderEntry(OR_ENTRY, 1)).toEqual([])
  })

  test('rejects bad ids, naming the entry and field', () => {
    expect(
      validateCustomProviderEntry({ ...ZEN_ENTRY, id: 'Bad_Id!' }, 0),
    ).toEqual(['customProviders["Bad_Id!"].id: must match [a-z0-9-] and be unique'])
    expect(validateCustomProviderEntry({ ...ZEN_ENTRY, id: '' }, 2)).toEqual([
      'customProviders[2].id: must match [a-z0-9-] and be unique',
    ])
  })

  test('rejects empty labels', () => {
    expect(validateCustomProviderEntry({ ...ZEN_ENTRY, label: '  ' }, 0)).toEqual([
      'customProviders["zen-router"].label: must be a non-empty string',
    ])
  })

  test('rejects unparseable base URLs', () => {
    expect(validateCustomProviderEntry({ ...ZEN_ENTRY, baseUrl: '::not a url' }, 0)).toEqual([
      'customProviders["zen-router"].baseUrl: must be a parseable URL',
    ])
  })

  test('permits http:// for loopback hosts only', () => {
    for (const host of ['http://localhost:11434/v1', 'http://127.0.0.1:18905/zen/v1', 'http://[::1]:18905/zen/v1']) {
      expect(
        validateCustomProviderEntry({ ...ZEN_ENTRY, baseUrl: host }, 0),
      ).toEqual([])
    }
    expect(
      validateCustomProviderEntry({ ...ZEN_ENTRY, baseUrl: 'http://192.168.1.10:11434/v1' }, 0),
    ).toEqual([
      'customProviders["zen-router"].baseUrl: plaintext http:// is only allowed for loopback hosts (localhost, 127.0.0.1, ::1)',
    ])
    expect(
      validateCustomProviderEntry({ ...ZEN_ENTRY, baseUrl: 'http://example.com/v1' }, 0),
    ).toEqual([
      'customProviders["zen-router"].baseUrl: plaintext http:// is only allowed for loopback hosts (localhost, 127.0.0.1, ::1)',
    ])
  })

  test('rejects apiKey fields by design', () => {
    expect(
      validateCustomProviderEntry({ ...ZEN_ENTRY, apiKey: 'sk-secret' }, 0),
    ).toEqual([
      'customProviders["zen-router"].apiKey: not supported — keep secrets in env files / shell env, never in settings.json',
    ])
  })

  test('rejects invalid effortLevels', () => {
    expect(
      validateCustomProviderEntry({ ...ZEN_ENTRY, effortLevels: ['low', 'turbo'] }, 0),
    ).toEqual([
      'customProviders["zen-router"].effortLevels: must be a non-empty array of low|medium|high|xhigh|max',
    ])
    expect(
      validateCustomProviderEntry({ ...ZEN_ENTRY, effortLevels: [] }, 0),
    ).toEqual([
      'customProviders["zen-router"].effortLevels: must be a non-empty array of low|medium|high|xhigh|max',
    ])
  })

  test('rejects non-object entries', () => {
    expect(validateCustomProviderEntry('nope', 3)).toEqual([
      'customProviders[3]: entry must be an object',
    ])
  })
})

describe('validateCustomProviders', () => {
  test('accepts undefined (key omitted)', () => {
    expect(validateCustomProviders(undefined)).toEqual([])
  })

  test('rejects non-arrays and duplicate ids', () => {
    expect(validateCustomProviders({})).toEqual(['customProviders: must be an array'])
    expect(validateCustomProviders([ZEN_ENTRY, { ...ZEN_ENTRY, label: 'Copy' }])).toEqual([
      'customProviders["zen-router"].id: duplicate id',
    ])
  })

  test('allows duplicate display labels (matching is by baseUrl+model)', () => {
    const other: CustomProviderEntry = {
      id: 'zen-router-2',
      label: 'OpenCode Zen Router',
      baseUrl: 'http://127.0.0.1:18906/zen/v1',
    }
    expect(validateCustomProviders([ZEN_ENTRY, other])).toEqual([])
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
    expect(isAllowedCustomProviderBaseUrl('http://127.0.0.1:18905/zen/v1')).toBe(true)
    expect(isAllowedCustomProviderBaseUrl('http://example.com/v1')).toBe(false)
    expect(isAllowedCustomProviderBaseUrl('::not a url')).toBe(false)
    expect(isAllowedCustomProviderBaseUrl('ws://127.0.0.1:18905/zen/v1')).toBe(false)
  })
})

describe('findMatchingCustomProvider', () => {
  const entries = [ZEN_ENTRY, OR_ENTRY]

  test('matches on normalized base URL ignoring trailing slashes', () => {
    expect(
      findMatchingCustomProvider(
        'http://127.0.0.1:18905/zen/v1///',
        'muse-spark-1.3-contributor-free',
        entries,
      ),
    ).toEqual(ZEN_ENTRY)
  })

  test('matches models case-insensitively', () => {
    expect(
      findMatchingCustomProvider(
        'http://127.0.0.1:18905/zen/v1',
        'MUSE-SPARK-1.3-CONTRIBUTOR-FREE',
        entries,
      )?.id,
    ).toBe('zen-router')
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
      findMatchingCustomProvider('http://127.0.0.1:18905/zen/v1', 'gpt-4o', entries),
    ).toBeUndefined()
  })

  test('base URL mismatch does not match', () => {
    expect(
      findMatchingCustomProvider('http://127.0.0.1:9999/v1', 'muse-spark-1.3-contributor-free', entries),
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
  const entries = [ZEN_ENTRY, OR_ENTRY]

  test('label resolves through the same lookup', () => {
    expect(
      getCustomProviderLabel('http://127.0.0.1:18905/zen/v1', 'muse-spark-1.3-contributor-free', entries),
    ).toBe('OpenCode Zen Router')
    expect(
      getCustomProviderLabel('http://127.0.0.1:18905/zen/v1', 'gpt-4o', entries),
    ).toBeUndefined()
  })

  test('smallModel falls through to undefined when the entry sets none', () => {
    expect(
      getCustomProviderSmallModel('http://127.0.0.1:18905/zen/v1', 'muse-spark-1.3-contributor-free', entries),
    ).toBe('nemotron-3.5-lightning-free')
    expect(
      getCustomProviderSmallModel('https://openrouter.ai/api/v1', 'thinkingmachines/inkling:free', entries),
    ).toBeUndefined()
  })
})

describe('settings-backed lookup', () => {
  test('reads entries from loaded settings', async () => {
    activeCustomProvidersOverride = [ZEN_ENTRY]
    const fresh = await import(`./customProviders.js?settings-backed=${Date.now()}`)
    expect(
      fresh.getCustomProviderLabel('http://127.0.0.1:18905/zen/v1', 'muse-spark-1.3-contributor-free'),
    ).toBe('OpenCode Zen Router')
    activeCustomProvidersOverride = null
  })
})
