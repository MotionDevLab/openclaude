import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

// @ts-expect-error -- query-string cache-buster: the `?...` suffix makes Bun
// treat this as a distinct module id, bypassing other suites'
// mock.module('../utils/settings/settings.js') registrations so we capture the
// genuine module.
import * as realSettingsModule from '../utils/settings/settings.js?laneLimitsRealSettings'

// Integration coverage for the `customProviders` lane-default limits flowing
// through the real runtime resolution path. The per-symbol tests in
// customProviders.test.ts exercise getCustomProviderLimits directly; this
// drives the full chain via resolveModelRuntimeLimits, which is what runtime
// code actually calls, and locks the precedence: exact env override and
// per-model `modelLimits` beat the lane default, and the lane default beats
// the discovery cache / descriptor fallback.

type SettingsShape = {
  modelLimits?: Record<
    string,
    { contextWindow?: number; maxOutputTokens?: number }
  >
  customProviders?: Array<{
    id: string
    label: string
    baseUrl: string
    models?: string[]
    contextWindow?: number
    maxOutputTokens?: number
  }>
}

let mockSettings: SettingsShape = {}
// Gate the overrides so the process-global mock.module is a transparent
// passthrough to the real settings whenever this suite is not the one
// running — otherwise a later integrations test that reads settings would
// see this suite's stub leak in.
let settingsOverrideActive = false

beforeEach(async () => {
  await acquireSharedMutationLock('integrations/runtimeMetadata.laneLimits.test.ts')
  mock.restore()
  mockSettings = {}
  mock.module('../utils/settings/settings.js', () => ({
    ...realSettingsModule,
    getInitialSettings: () =>
      settingsOverrideActive
        ? mockSettings
        : realSettingsModule.getInitialSettings(),
    getSettings_DEPRECATED: () =>
      settingsOverrideActive
        ? mockSettings
        : realSettingsModule.getSettings_DEPRECATED(),
  }))
  settingsOverrideActive = true
})

afterEach(() => {
  try {
    mock.restore()
    settingsOverrideActive = false
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFresh() {
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./runtimeMetadata.js?ts=${nonce}`)
}

const LANE_BASE_URL = 'https://lane-limits.example/v1'

function laneEntry(overrides = {}) {
  return {
    id: 'lane-limits',
    label: 'Lane Limits',
    baseUrl: LANE_BASE_URL,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    ...overrides,
  }
}

test('resolveModelRuntimeLimits applies the lane default for an unpinned model', async () => {
  mockSettings = { customProviders: [laneEntry()] }
  const { resolveModelRuntimeLimits } = await importFresh()

  const limits = resolveModelRuntimeLimits({
    model: 'lane-test-model-xyz',
    baseUrl: LANE_BASE_URL,
    processEnv: {},
  })

  expect(limits.contextWindow).toBe(128_000)
  expect(limits.maxOutputTokens).toBe(8_192)
})

test('resolveModelRuntimeLimits lets per-model modelLimits win over the lane default', async () => {
  mockSettings = {
    customProviders: [laneEntry()],
    modelLimits: { 'lane-test-model-xyz': { contextWindow: 64_000 } },
  }
  const { resolveModelRuntimeLimits } = await importFresh()

  const limits = resolveModelRuntimeLimits({
    model: 'lane-test-model-xyz',
    baseUrl: LANE_BASE_URL,
    processEnv: {},
  })

  expect(limits.contextWindow).toBe(64_000)
  // maxOutputTokens has no per-model pin, so the lane default still applies.
  expect(limits.maxOutputTokens).toBe(8_192)
})

test('resolveModelRuntimeLimits lets an exact env override win over the lane default', async () => {
  mockSettings = { customProviders: [laneEntry()] }
  const { resolveModelRuntimeLimits } = await importFresh()

  const limits = resolveModelRuntimeLimits({
    model: 'lane-test-model-xyz',
    baseUrl: LANE_BASE_URL,
    processEnv: {
      CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: JSON.stringify({
        'lane-test-model-xyz': 256_000,
      }),
    },
  })

  expect(limits.contextWindow).toBe(256_000)
  expect(limits.maxOutputTokens).toBe(8_192)
})

test('resolveModelRuntimeLimits ignores the lane default on a different base URL', async () => {
  mockSettings = { customProviders: [laneEntry()] }
  const { resolveModelRuntimeLimits } = await importFresh()

  const limits = resolveModelRuntimeLimits({
    model: 'lane-test-model-xyz',
    baseUrl: 'https://other-lane.example/v1',
    processEnv: {},
  })

  expect(limits.contextWindow).toBeUndefined()
})

test('resolveModelRuntimeLimits respects the lane models scoping', async () => {
  mockSettings = {
    customProviders: [laneEntry({ models: ['scoped-model'] })],
  }
  const { resolveModelRuntimeLimits } = await importFresh()

  const scoped = resolveModelRuntimeLimits({
    model: 'scoped-model',
    baseUrl: LANE_BASE_URL,
    processEnv: {},
  })
  expect(scoped.contextWindow).toBe(128_000)

  const unscoped = resolveModelRuntimeLimits({
    model: 'other-model',
    baseUrl: LANE_BASE_URL,
    processEnv: {},
  })
  expect(unscoped.contextWindow).toBeUndefined()
})

test('resolveModelRuntimeLimits lets the lane default beat the discovery cache', async () => {
  const { clearDiscoveryCache, setCachedModels } = await import(
    `./discoveryCache.js?ts=${Date.now()}`
  )
  const { getDiscoveryCacheKey } = await import(
    `./discoveryService.js?ts=${Date.now()}`
  )
  // The discovery cache path comes from getClaudeConfigHomeDir(), which
  // ignores CLAUDE_CONFIG_DIR by design. Without this override the fixture
  // below would be written into the caller's real ~/.openclaude.
  const {
    getClaudeConfigHomeDirOverrideForTesting,
    setClaudeConfigHomeDirForTesting,
  } = await import('../utils/envUtils.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const previousOverride = getClaudeConfigHomeDirOverrideForTesting()
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-lane-limits-'))
  setClaudeConfigHomeDirForTesting(tempDir)
  try {
    await setCachedModels(getDiscoveryCacheKey('custom', { baseUrl: LANE_BASE_URL }), {
      models: [
        {
          id: 'lane-cache-combo',
          apiName: 'lane-cache-combo',
          label: 'lane-cache-combo',
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
        },
      ],
    })

    const { resolveModelRuntimeLimits } = await importFresh()
    // No explicit baseUrl option: the lane match fires through the
    // OPENAI_BASE_URL env fallback, the same path context budgeting uses.
    const resolveWithDiscovery = () =>
      resolveModelRuntimeLimits({
        model: 'lane-cache-combo',
        processEnv: {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: LANE_BASE_URL,
        },
      })

    // Establish that the isolated cache is observable first, so the lane
    // assertion below proves precedence rather than passing on a missing
    // fixture.
    mockSettings = {}
    const discovered = resolveWithDiscovery()
    expect(discovered.contextWindow).toBe(128_000)
    expect(discovered.maxOutputTokens).toBe(8_192)

    mockSettings = { customProviders: [laneEntry({ contextWindow: 1_000_000, maxOutputTokens: 32_768 })] }
    const overridden = resolveWithDiscovery()

    expect(overridden.contextWindow).toBe(1_000_000)
    expect(overridden.maxOutputTokens).toBe(32_768)
  } finally {
    // Clears the module-level sync snapshot as well, so the fixture cannot
    // leak into a later suite once the temp dir is removed.
    await clearDiscoveryCache()
    setClaudeConfigHomeDirForTesting(previousOverride)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveModelRuntimeLimits matches ?runtime suffix variants to a scoped lane', async () => {
  mockSettings = {
    customProviders: [laneEntry({ models: ['scoped-model'] })],
  }
  const { resolveModelRuntimeLimits } = await importFresh()

  const limits = resolveModelRuntimeLimits({
    model: 'scoped-model?reasoning=high',
    baseUrl: LANE_BASE_URL,
    processEnv: {},
  })

  expect(limits.contextWindow).toBe(128_000)
})

test('wildcard lane supplies 1M to unknown variant', async () => {
  // Characterization: a wildcard `models: ['*']` lane default covers a model
  // with no per-model pin, without a catalog entry. Entries are passed
  // explicitly to avoid settings I/O.
  const { getCustomProviderLimits } = await import(
    '../utils/customProviders.js'
  )

  const limits = getCustomProviderLimits(
    'https://example.test/v1',
    'brand-new-model-99',
    [
      {
        id: 'test-lane',
        label: 'Test',
        baseUrl: 'https://example.test/v1',
        models: ['*'],
        contextWindow: 1000000,
      },
    ],
  )

  expect(limits.contextWindow).toBe(1000000)
})
