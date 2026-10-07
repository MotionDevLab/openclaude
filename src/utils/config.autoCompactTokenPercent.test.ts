import { describe, expect, test } from 'bun:test'
import {
  isValidAutoCompactTokenPercent,
  normalizeAutoCompactTokenPercent,
} from './config.js'

describe('normalizeAutoCompactTokenPercent — settable token-% trigger (PR-B)', () => {
  test('accepts preset and custom positive-integer strings in 1-99', () => {
    expect(normalizeAutoCompactTokenPercent('70')).toBe('70')
    expect(normalizeAutoCompactTokenPercent('73')).toBe('73')
    expect(normalizeAutoCompactTokenPercent('1')).toBe('1')
    expect(normalizeAutoCompactTokenPercent('99')).toBe('99')
    expect(isValidAutoCompactTokenPercent('73')).toBe(true)
  })

  test('trims whitespace and pads the canonical form', () => {
    expect(normalizeAutoCompactTokenPercent(' 70 ')).toBe('70')
    expect(normalizeAutoCompactTokenPercent('007')).toBe('7')
  })

  test('out-of-range and garbage fall back to off (never reset behavior)', () => {
    expect(normalizeAutoCompactTokenPercent('0')).toBe('off')
    expect(normalizeAutoCompactTokenPercent('100')).toBe('off')
    expect(normalizeAutoCompactTokenPercent('-5')).toBe('off')
    expect(normalizeAutoCompactTokenPercent('72.5')).toBe('off')
    expect(normalizeAutoCompactTokenPercent('not-a-percent')).toBe('off')
    expect(normalizeAutoCompactTokenPercent('')).toBe('off')
    expect(normalizeAutoCompactTokenPercent(undefined)).toBe('off')
    expect(normalizeAutoCompactTokenPercent(70)).toBe('off')
    expect(isValidAutoCompactTokenPercent('100')).toBe(false)
    expect(isValidAutoCompactTokenPercent('not-a-percent')).toBe(false)
  })

  test('unsafe integers are rejected', () => {
    expect(isValidAutoCompactTokenPercent('99999999999999999999')).toBe(false)
    expect(normalizeAutoCompactTokenPercent('99999999999999999999')).toBe(
      'off',
    )
  })

  test('off and unset pass through as off', () => {
    expect(normalizeAutoCompactTokenPercent('off')).toBe('off')
    expect(normalizeAutoCompactTokenPercent(undefined)).toBe('off')
    expect(isValidAutoCompactTokenPercent('off')).toBe(true)
  })
})
