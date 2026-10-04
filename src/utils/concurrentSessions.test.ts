import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  countConcurrentSessions,
  isMatchingProcessStart,
  PROCESS_START_MATCH_TOLERANCE_MS,
  registerSession,
} from './concurrentSessions.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.js'
import { getProcessStartTimes, isProcessRunning } from './genericProcessUtils.js'

let sandbox = ''
let previousOverride: string | undefined
const children: Array<{ pid: number; kill: () => void }> = []

function sessionsDir(): string {
  return join(sandbox, 'sessions')
}

function writePidFile(pid: number, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(sessionsDir(), `${pid}.json`),
    JSON.stringify({ pid, ...extra }),
  )
}

function spawnSleeper(): number {
  const child = Bun.spawn(
    ['bun', '-e', 'await new Promise(r => setTimeout(r, 120000))'],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  children.push({ pid: child.pid, kill: () => child.kill() })
  return child.pid
}

async function waitForAlive(pid: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 10_000) {
    if (isProcessRunning(pid)) {
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`sleeper pid ${pid} never became observable`)
}

// Sweeping is fire-and-forget (void unlink), so poll for disappearance.
async function waitForSwept(name: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 10_000) {
    if (!existsSync(join(sessionsDir(), name))) {
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`pid file ${name} was never swept`)
}

beforeEach(() => {
  previousOverride = getClaudeConfigHomeDirOverrideForTesting()
  sandbox = mkdtempSync(join(tmpdir(), 'oc-sessions-test-'))
  mkdirSync(sessionsDir(), { recursive: true })
  setClaudeConfigHomeDirForTesting(sandbox)
})

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
  setClaudeConfigHomeDirForTesting(previousOverride)
})

describe('isMatchingProcessStart', () => {
  test('matches within tolerance, mismatches beyond it', () => {
    expect(isMatchingProcessStart(1000, 1000)).toBe(true)
    expect(
      isMatchingProcessStart(1000, 1000 + PROCESS_START_MATCH_TOLERANCE_MS),
    ).toBe(true)
    expect(
      isMatchingProcessStart(1000, 1000 + PROCESS_START_MATCH_TOLERANCE_MS + 1),
    ).toBe(false)
  })

  test('unknown live start matches (fail open, never undercount)', () => {
    expect(isMatchingProcessStart(1, undefined)).toBe(true)
  })
})

describe('registerSession', () => {
  test('stores the process start time in the pid file', async () => {
    const registered = await registerSession()
    expect(registered).toBe(true)
    const raw = readFileSync(join(sessionsDir(), `${process.pid}.json`), 'utf8')
    const data = JSON.parse(raw) as { processStart?: unknown }
    expect(typeof data.processStart).toBe('number')
    const expected = Date.now() - process.uptime() * 1000
    expect(Math.abs((data.processStart as number) - expected)).toBeLessThan(
      60_000,
    )
  })
})

describe('countConcurrentSessions pid validation', () => {
  test('excludes a live pid whose recorded start time mismatches', async () => {
    const pid = spawnSleeper()
    await waitForAlive(pid)
    // Epoch start can never match a live process: simulates pid reuse,
    // where a stale pid file now names an unrelated live process.
    writePidFile(pid, { processStart: 1 })

    expect(await countConcurrentSessions()).toBe(0)
    await waitForSwept(`${pid}.json`)
  })

  test('counts a live pid with a matching start time', async () => {
    const pid = spawnSleeper()
    await waitForAlive(pid)
    const actual = (await getProcessStartTimes()).get(pid)
    expect(actual).toBeDefined()
    writePidFile(pid, { processStart: actual })

    expect(await countConcurrentSessions()).toBe(1)
  })

  test('counts pid files without a recorded start time as today', async () => {
    const pid = spawnSleeper()
    await waitForAlive(pid)
    writePidFile(pid)

    expect(await countConcurrentSessions()).toBe(1)
  })

  test('still sweeps dead-pid files', async () => {
    writePidFile(1_999_999_111)

    expect(await countConcurrentSessions()).toBe(0)
    await waitForSwept('1999999111.json')
  })
})
