import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as actualSettings from '../../utils/settings/settings.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { call as clearContextWindow } from '../clear-context-window/clear-context-window.js'
import { call as setContextWindow } from './set-context-window.js'
import {
  clearSessionContextWindowOverride,
  getContextWindowForModel,
} from '../../utils/context.js'
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from '../../services/compact/autoCompact.js'

const persisted: unknown[] = []
mock.module('../../utils/settings/settings.js', () => ({
  ...actualSettings,
  updateSettingsForSource: (...args: unknown[]) => {
    persisted.push(args)
    return { error: null }
  },
}))

const { call } = await import('./set-context-window.js')

const context = { options: { mainLoopModel: 'active-model-test-only' } } as never

let hasSharedMutationLock = false
const savedEnv = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
}

beforeEach(async () => {
  await acquireSharedMutationLock('commands/set-context-window/set-context-window.test.ts')
  hasSharedMutationLock = true
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000'
  delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  clearSessionContextWindowOverride('claude-sonnet-4')
})

afterEach(() => {
  clearSessionContextWindowOverride('claude-sonnet-4')
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  if (hasSharedMutationLock) {
    releaseSharedMutationLock()
    hasSharedMutationLock = false
  }
})

describe('set-context-window --save', () => {
  test('without --save, settings are untouched', async () => {
    persisted.length = 0
    clearSessionContextWindowOverride('save-test-model-a')
    const result = await call('save-test-model-a 200000', context)
    expect(result.type).toBe('text')
    if (result.type !== 'text') return
    expect(result.value).toContain('session only')
    expect(persisted).toHaveLength(0)
    clearSessionContextWindowOverride('save-test-model-a')
  })

  test('--save persists normalized model key with contextWindow', async () => {
    persisted.length = 0
    clearSessionContextWindowOverride('Save-Test-Model-B')
    const result = await call('Save-Test-Model-B 262144 --save', context)
    expect(result.type).toBe('text')
    if (result.type !== 'text') return
    expect(result.value).toContain('saved to settings.json modelLimits')
    expect(result.value).toContain('Persisted to settings.json modelLimits')
    expect(persisted).toHaveLength(1)
    const [source, payload] = persisted[0] as [string, Record<string, unknown>]
    expect(source).toBe('userSettings')
    expect(payload).toEqual({
      modelLimits: { 'save-test-model-b': { contextWindow: 262144 } },
    })
    clearSessionContextWindowOverride('Save-Test-Model-B')
  })
})

test('/set-context-window updates tokens and compaction immediately; clear restores defaults', async () => {
  const context = {
    options: { mainLoopModel: 'claude-sonnet-4' },
  } as never

  expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(50_000)
  const result = await setContextWindow('1000000', context)
  expect(result).toMatchObject({ type: 'text', value: expect.stringContaining('1,000,000') })
  expect(getContextWindowForModel('claude-sonnet-4')).toBe(1_000_000)
  expect(getEffectiveContextWindowSize('claude-sonnet-4')).toBe(980_000)
  expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(950_000)

  await clearContextWindow('claude-sonnet-4', context)
  expect(getContextWindowForModel('claude-sonnet-4')).toBe(200_000)
  expect(getEffectiveContextWindowSize('claude-sonnet-4')).toBe(80_000)
  expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(50_000)
})
