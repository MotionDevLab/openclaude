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
const DEL = '\x1b[3~'
const DOWN = '\x1b[B'

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
const GAMMA = '33333333-3333-4333-8333-333333333333'

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

let projectDir: string
let allLogs: LogOption[]

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
  while (Date.now() - startedAt < 2500) {
    const value = read()
    if (predicate(value)) return value
    await Bun.sleep(10)
  }
  throw new Error(`Timed out; last value: ${String(read())}`)
}

async function makeLog(sessionId: string, title: string, minutesAgo: number): Promise<LogOption> {
  const fullPath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(fullPath, '{}\n')
  await mkdir(join(projectDir, sessionId), { recursive: true })
  const modified = new Date(Date.now() - minutesAgo * 60_000)
  return {
    date: modified.toISOString(),
    messages: [],
    fullPath,
    value: minutesAgo,
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
  const { call } = await import(`./sessions.js?${Date.now()}-${Math.random()}`)
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
  return {
    done,
    resume,
    waitFor: (predicate: (f: string) => boolean) => waitUntil(frame, predicate),
    press: async (...keys: string[]) => {
      for (const key of keys) {
        stdin.write(key)
        await Bun.sleep(60)
      }
    },
    settle: () => Bun.sleep(300),
    unmount: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

describe('/sessions Delete key (fork UX convergence)', () => {
  let mounted: Awaited<ReturnType<typeof runSessions>> | undefined

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'openclaude-sessions-delkey-'))
    allLogs = [
      await makeLog(ALPHA, 'alpha task', 1),
      await makeLog(BETA, 'beta task', 2),
      await makeLog(GAMMA, 'gamma task', 3),
    ]
    const real = await import('../../utils/sessionStorage.js')
    mock.module('../../utils/getWorktreePaths.js', () => ({
      getWorktreePaths: () => Promise.resolve([]),
    }))
    // Mirror the disk: a deleted transcript drops out of the next reload.
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

  test('Delete arms the pending delete (cue shows)', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (3)'))
    await mounted.settle()
    await mounted.press(DOWN, DOWN, DEL)
    await mounted.waitFor(f => f.includes('Press d again to delete "gamma task"'))
    expect(existsSync(join(projectDir, `${GAMMA}.jsonl`))).toBe(true)
  })

  test('Delete then Delete confirms the delete', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (3)'))
    await mounted.settle()
    await mounted.press(DOWN, DOWN, DEL)
    await mounted.waitFor(f => f.includes('Press d again to delete "gamma task"'))
    await mounted.press(DEL)
    const after = await mounted.waitFor(f => f.includes('Deleted "gamma task"'))
    expect(after).toContain('Sessions (2)')
    expect(existsSync(join(projectDir, `${GAMMA}.jsonl`))).toBe(false)
    expect(existsSync(join(projectDir, GAMMA))).toBe(false)
    expect(existsSync(join(projectDir, `${ALPHA}.jsonl`))).toBe(true)
  })

  test('Delete then d confirms the delete', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (3)'))
    await mounted.settle()
    await mounted.press(DOWN, DOWN, DEL)
    await mounted.waitFor(f => f.includes('Press d again to delete "gamma task"'))
    await mounted.press('d')
    const after = await mounted.waitFor(f => f.includes('Deleted "gamma task"'))
    expect(after).toContain('Sessions (2)')
    expect(existsSync(join(projectDir, `${GAMMA}.jsonl`))).toBe(false)
  })

  test('Delete then another key disarms it', async () => {
    mounted = await runSessions()
    await mounted.waitFor(f => f.includes('Sessions (3)'))
    await mounted.settle()
    await mounted.press(DOWN, DOWN, DEL)
    await mounted.waitFor(f => f.includes('Press d again to delete "gamma task"'))
    await mounted.press('x')
    await mounted.waitFor(f => !f.includes('Press d again'))
    expect(existsSync(join(projectDir, `${GAMMA}.jsonl`))).toBe(true)
  })
})