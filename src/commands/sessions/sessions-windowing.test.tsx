import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

import { createRoot } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'
const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const UP = '\x1b[A'

const SESSION_COUNT = 20

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

let projectDir: string
let allLogs: LogOption[]

function sessionIdFor(n: number): string {
  return '10000000-1000-4000-8000-' + String(n).padStart(12, '0')
}

function titleFor(n: number): string {
  return 'task-' + String(n).padStart(2, '0')
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return lastFrame ?? output
}

async function waitUntil<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    const value = read()
    if (predicate(value)) return value
    await Bun.sleep(20)
  }
  throw new Error('Timed out; last value: ' + String(read()).slice(0, 400))
}

async function makeLog(n: number): Promise<LogOption> {
  const sessionId = sessionIdFor(n)
  const title = titleFor(n)
  const fullPath = join(projectDir, sessionId + '.jsonl')
  await writeFile(fullPath, '{}\n')
  await mkdir(join(projectDir, sessionId), { recursive: true })
  const modified = new Date(Date.now() - n * 60_000)
  return {
    date: modified.toISOString(),
    messages: [],
    fullPath,
    value: n,
    created: modified,
    modified,
    firstPrompt: title,
    customTitle: title,
    messageCount: 2,
    isSidechain: false,
    sessionId,
  }
}

async function runSessions() {
  const { call } = await import('./sessions.js?' + Date.now() + '-' + Math.random())
  const done: Array<string | undefined> = []
  const resume = mock((_sessionId: string, _log: LogOption, _entrypoint: string) =>
    Promise.resolve(),
  )
  const node = await call(
    (result?: string) => {
      done.push(result)
    },
    { resume } as unknown as LocalJSXCommandContext,
    '',
  )

  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(
    <AppStateProvider>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
  )

  const frame = (): string => stripAnsi(extractLastFrame(output))
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      stdin.write(key)
      await Bun.sleep(60)
    }
  }
  return {
    done,
    resume,
    frame,
    waitFor: (predicate: (f: string) => boolean) => waitUntil(frame, predicate),
    press,
    settle: () => Bun.sleep(300),
    unmount: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

describe('/sessions windowing (20 sessions)', () => {
  let mounted: Awaited<ReturnType<typeof runSessions>> | undefined

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'openclaude-sessions-win-'))
    allLogs = []
    for (let n = 1; n <= SESSION_COUNT; n++) {
      allLogs.push(await makeLog(n))
    }
    const real = await import('../../utils/sessionStorage.js')
    mock.module('../../utils/getWorktreePaths.js', () => ({
      getWorktreePaths: () => Promise.resolve([]),
    }))
    mock.module('../../utils/sessionStorage.js', () => ({
      ...real,
      getSessionIdFromLog: (log: LogOption) => log.sessionId,
      isLiteLog: () => false,
      loadSameRepoMessageLogs: () =>
        Promise.resolve(allLogs.filter(log => existsSync(log.fullPath!))),
    }))
  })

  afterEach(async () => {
    mounted?.unmount()
    mounted = undefined
    mock.restore()
    await rm(projectDir, { recursive: true, force: true })
  })

  test('scrolls past the 8th row without blanking and reaches every row', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (20)'))
    await mounted.settle()

    for (let i = 0; i < 12; i++) await mounted.press(DOWN)
    const mid = await mounted.waitFor(f => f.includes('task-13'))
    expect(mid).toContain('Sessions (20)')
    expect(mid).toContain('task-12')
    expect(mid.trim().length).toBeGreaterThan(200)

    for (let i = 0; i < 7; i++) await mounted.press(DOWN)
    const bottom = await mounted.waitFor(f => f.includes('task-20'))
    expect(bottom).toContain('Sessions (20)')
    expect(bottom.trim().length).toBeGreaterThan(200)

    for (let i = 0; i < 19; i++) await mounted.press(UP)
    const top = await mounted.waitFor(f => f.includes('task-01'))
    expect(top).toContain('Sessions (20)')
  }, 60000)

  test('double-d delete returns a usable list instead of a stuck flow', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (20)'))
    await mounted.settle()

    await mounted.press(DOWN, DOWN)
    await mounted.press('d')
    await mounted.waitFor(f => f.includes('Press d again to delete "task-03"'))
    await mounted.press('d')
    const after = await mounted.waitFor(f => f.includes('Deleted "task-03"'))
    expect(after).toContain('Sessions (19)')
    expect(existsSync(join(projectDir, sessionIdFor(3) + '.jsonl'))).toBe(false)
    expect(existsSync(join(projectDir, sessionIdFor(1) + '.jsonl'))).toBe(true)

    await mounted.press(ENTER)
    await mounted.waitFor(f => f.includes('Return to the list'))
    await mounted.press(ESC)
    expect(await mounted.waitFor(f => f.includes('Sessions (19)'))).toContain('Sessions (19)')
    expect(mounted.done).toEqual([])

    await mounted.press(ESC)
    await waitUntil(() => mounted!.done.length, n => n > 0)
    expect(mounted.done).toEqual([undefined])
  }, 60000)
})
