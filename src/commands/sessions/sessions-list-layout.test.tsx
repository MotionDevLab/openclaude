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
let longTitles = false

function sessionIdFor(n: number): string {
  return '30000000-3000-4000-8000-' + String(n).padStart(12, '0')
}

function titleFor(n: number): string {
  const base = 'task-' + String(n).padStart(2, '0')
  if (longTitles) return base + ' ' + 'w'.repeat(190) + ' TAIL-' + String(n).padStart(2, '0')
  return base
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
  while (Date.now() - startedAt < 8000) {
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
  await writeFile(fullPath, '{}')
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
    gitBranch: 'feat/sessions-qa-fixes',
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

describe('/sessions list layout (resume-picker parity)', () => {
  let mounted: Awaited<ReturnType<typeof runSessions>> | undefined

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'openclaude-sessions-layout-'))
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
    longTitles = false
    await rm(projectDir, { recursive: true, force: true })
  })

  test('options stack label over metadata like the resume picker, not side by side', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (20)'))
    await mounted.settle()
    const lines = mounted.frame().split('\n')
    const labelLine = lines.find(l => l.includes('task-03'))
    expect(labelLine).toBeDefined()
    // Expanded layout: the metadata row sits below the label row, so the
    // label line never carries the message count. Compact two-column puts
    // them on one line.
    expect(labelLine!).not.toContain('messages')
  }, 60000)

  test('window is sized in rows (3 per option), so later rows stay reachable', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (20)'))
    await mounted.settle()
    // 24-row harness terminal -> floor((24 - 12) / 3) = 4 visible options.
    expect(mounted.frame()).toContain('task-04')
    expect(mounted.frame()).not.toContain('task-05')

    for (let i = 0; i < 4; i++) await mounted.press(DOWN)
    expect(await mounted.waitFor(f => f.includes('task-05'))).toContain('task-05')

    for (let i = 0; i < 15; i++) await mounted.press(DOWN)
    expect(await mounted.waitFor(f => f.includes('task-20'))).toContain('task-20')

    for (let i = 0; i < 19; i++) await mounted.press(UP)
    expect(await mounted.waitFor(f => f.includes('task-01'))).toContain('task-01')
  }, 60000)

  test('200-char titles are truncated to one terminal-width line', async () => {
    longTitles = true
    // Rebuild logs with long titles (beforeEach ran with short ones).
    allLogs = []
    for (let n = 1; n <= SESSION_COUNT; n++) {
      allLogs.push(await makeLog(n))
    }
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (20)'))
    await mounted.settle()
    const frame = mounted.frame()
    expect(frame).toContain('task-01')
    // The untruncated tail must never reach the screen.
    expect(frame).not.toContain('TAIL-01')
  }, 60000)
})
