import { describe, expect, test } from 'bun:test'

import { getProcessStartTimes } from './genericProcessUtils.js'

describe('getProcessStartTimes', () => {
  test('includes the current process with a plausible start time', async () => {
    const table = await getProcessStartTimes()
    const expected = Date.now() - process.uptime() * 1000
    const actual = table.get(process.pid)
    expect(actual).toBeDefined()
    expect(Math.abs((actual as number) - expected)).toBeLessThan(60_000)
  })

  test('does not include a pid that cannot exist', async () => {
    const table = await getProcessStartTimes()
    expect(table.get(2_000_000_000)).toBeUndefined()
  })
})
