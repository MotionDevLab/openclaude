import { afterEach, describe, expect, test } from 'bun:test'
import {
  isValidMaxMessagesCompactionThreshold,
  normalizeMaxMessagesCompactionThreshold,
} from './config.js'

const SAVED_HARD_CAP = process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP

afterEach(() => {
  if (SAVED_HARD_CAP === undefined) {
    delete process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP
  } else {
    process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = SAVED_HARD_CAP
  }
})

describe('normalizeMaxMessagesCompactionThreshold — custom thresholds (PR-A)', () => {
  test('accepts a valid custom positive-integer string', () => {
    expect(normalizeMaxMessagesCompactionThreshold('350')).toBe('350')
    expect(isValidMaxMessagesCompactionThreshold('350')).toBe(true)
  })

  test('clamps a value over the hard cap instead of resetting to 200', () => {
    delete process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP
    expect(normalizeMaxMessagesCompactionThreshold('5000')).toBe('1000')
  })

  test('garbage falls back to 200', () => {
    expect(normalizeMaxMessagesCompactionThreshold('not-a-threshold')).toBe(
      '200',
    )
    expect(normalizeMaxMessagesCompactionThreshold('')).toBe('200')
    expect(normalizeMaxMessagesCompactionThreshold(undefined)).toBe('200')
    expect(isValidMaxMessagesCompactionThreshold('not-a-threshold')).toBe(false)
  })

  test('unsafe integers are rejected, not clamped', () => {
    expect(isValidMaxMessagesCompactionThreshold('99999999999999999999')).toBe(
      false,
    )
    expect(normalizeMaxMessagesCompactionThreshold('99999999999999999999')).toBe(
      '200',
    )
  })

  test('off passes through', () => {
    expect(normalizeMaxMessagesCompactionThreshold('off')).toBe('off')
    expect(isValidMaxMessagesCompactionThreshold('off')).toBe(true)
  })
})
