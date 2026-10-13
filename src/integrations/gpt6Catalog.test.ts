import { expect, test } from 'bun:test'

import gpt6Models from './models/gpt6.js'
import openaiVendor from './vendors/openai.js'

const GPT6_FLAGSHIPS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol'] as const
const GPT6_IDS = [...GPT6_FLAGSHIPS, 'gpt-6-luna'] as const

test('gpt-6 model descriptors carry the full API spec (no Codex cap published)', () => {
  for (const id of GPT6_IDS) {
    const descriptor = gpt6Models.find(model => model.id === id)
    expect(descriptor).toBeDefined()
    // Descriptor and catalog intentionally AGREE here — unlike the 5.6
    // family, there is no published Codex-route cap for GPT-6 (the 272k pin
    // is verified ONLY for 5.6; see the gpt6.ts descriptor comment). The
    // full 1.05M spec ships with a dated comment + first-500 monitoring
    // flag instead of an invented cap.
    expect(descriptor?.contextWindow).toBe(1_050_000)
    expect(descriptor?.maxOutputTokens).toBe(128_000)
  }
})

test('openai vendor gpt-6 catalog entries carry limits and reasoning metadata', () => {
  for (const id of GPT6_IDS) {
    const entry = openaiVendor.catalog?.models?.find(model => model.id === id)
    expect(entry).toBeDefined()
    expect(entry?.contextWindow).toBe(1_050_000)
    expect(entry?.maxOutputTokens).toBe(128_000)
    expect(entry?.reasoning?.wireFormat).toBe('reasoning_effort')
    expect(entry?.reasoning?.levels).toContain('xhigh')
  }
})

test('openai vendor gpt-6 flagships expose the Ultra tier as max; luna tops out at xhigh', () => {
  for (const id of GPT6_FLAGSHIPS) {
    const entry = openaiVendor.catalog?.models?.find(model => model.id === id)
    expect(entry?.reasoning?.levels).toContain('max')
    expect(entry?.reasoning?.defaultLevel).toBe('high')
  }
  const luna = openaiVendor.catalog?.models?.find(model => model.id === 'gpt-6-luna')
  expect(luna?.reasoning?.levels).not.toContain('max')
  expect(luna?.reasoning?.defaultLevel).toBe('medium')
})
