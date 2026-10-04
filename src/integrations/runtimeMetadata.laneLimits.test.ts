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
