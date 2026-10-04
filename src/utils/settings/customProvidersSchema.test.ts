import { expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

test('customProviders accepts the documented example-lane entry', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [
      {
        id: 'example-lane',
        label: 'Example Gateway',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['example-model'],
        supportsEffort: true,
        smallModel: 'example-small-model',
      },
    ],
  })
  expect(result.success).toBe(true)
})

test('customProviders accepts lane-default limits', () => {
  const result = SettingsSchema().safeParse({
    customProviders: [
      {
        id: 'or',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
      },
    ],
  })
  expect(result.success).toBe(true)
})

test('customProviders rejects non-positive lane-default limits', () => {
  for (const limits of [
    { contextWindow: 0 },
    { contextWindow: -100 },
    { contextWindow: 1.5 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 'many' },
  ]) {
    const result = SettingsSchema().safeParse({
      customProviders: [
        { id: 'x', label: 'X', baseUrl: 'https://x.example/v1', ...limits },
      ],
    })
    expect(result.success).toBe(false)
  }
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
      providerEnvFile: '~/.openclaude/providers/example-lane.env',
    }).success,
  ).toBe(true)
})

test('providerEnvFile rejects an empty path', () => {
  expect(SettingsSchema().safeParse({ providerEnvFile: '' }).success).toBe(
    false,
  )
})
