import { describe, expect, mock, test } from 'bun:test'
import * as actualSettings from '../../utils/settings/settings.js'

const persisted: unknown[] = []
mock.module('../../utils/settings/settings.js', () => ({
  ...actualSettings,
  updateSettingsForSource: (...args: unknown[]) => {
    persisted.push(args)
    return { error: null }
  },
}))

const { call } = await import('./set-context-window.js')
const { clearSessionContextWindowOverride } = await import(
  '../../utils/context.js'
)

const context = { options: { mainLoopModel: 'active-model-test-only' } } as never

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
