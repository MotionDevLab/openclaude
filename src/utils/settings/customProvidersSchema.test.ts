import { expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

test('customProviders accepts the documented zen-router entry', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [
      {
        id: 'zen-router',
        label: 'OpenCode Zen Router',
        baseUrl: 'http://127.0.0.1:18905/zen/v1',
        models: ['muse-spark-1.3-contributor-free'],
        supportsEffort: true,
        smallModel: 'nemotron-3.5-lightning-free',
      },
    ],
  })
  expect(result.success).toBe(true)
})

test('customProviders accepts a minimal entry (defaults apply)', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [
      {
        id: 'or',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    ],
  })
  expect(result.success).toBe(true)
})

test('customProviders rejects a bad id', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [{ id: 'Bad_Id!', label: 'X', baseUrl: 'https://x.example/v1' }],
  })
  expect(result.success).toBe(false)
})

test('customProviders rejects an empty label', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [{ id: 'x', label: '', baseUrl: 'https://x.example/v1' }],
  })
  expect(result.success).toBe(false)
})

test('customProviders rejects an apiKey field (secrets stay in env files)', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [
      { id: 'x', label: 'X', baseUrl: 'https://x.example/v1', apiKey: 'sk-secret' },
    ],
  })
  expect(result.success).toBe(false)
})

test('customProviders rejects invalid effortLevels', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [
      { id: 'x', label: 'X', baseUrl: 'https://x.example/v1', effortLevels: ['turbo'] },
    ],
  })
  expect(result.success).toBe(false)
})

test('settings without customProviders still parse (key is optional)', () => {
  expect(SettingsSchema().safeParse({}).success).toBe(true)
})

test('providerEnvFile accepts a settings-default path', () => {
  expect(
    SettingsSchema().safeParse({
      providerEnvFile: '~/.openclaude/providers/zen-router.env',
    }).success,
  ).toBe(true)
})

test('providerEnvFile rejects an empty path', () => {
  expect(SettingsSchema().safeParse({ providerEnvFile: '' }).success).toBe(
    false,
  )
})
