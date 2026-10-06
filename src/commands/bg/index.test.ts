import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import { isCommandEnabled } from '../../types/command.js'
import type { LocalCommandResult } from '../../types/command.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
} from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import command from './index.js'
import { BG_HELP, createBgCommandCall } from './bg.js'

function expectText(
  res: LocalCommandResult,
): Extract<LocalCommandResult, { type: 'text' }> {
  if (res.type !== 'text') throw new Error(`expected text result, got ${res.type}`)
  return res
}

function makeContext() {
  let state = { settings: {} as Record<string, unknown> }
  return {
    getAppState: () => state as never,
    setAppState: (updater: (s: typeof state) => typeof state) => {
      state = updater(state)
    },
    _state: () => state,
  } as unknown as Parameters<Awaited<ReturnType<typeof command.load>>['call']>[1] & {
    _state: () => typeof state
  }
}

describe('/bg registration', () => {
  test('registers as local jobs-alias command with hint + subcommands', () => {
    expect(command.name).toBe('bg')
    expect(command.aliases).toContain('jobs')
    expect(command.argumentHint).toBe('[ps|logs <id>|kill <id>|auto-pr <on|off>]')
    const names = command.subcommands?.map(s => s.name) ?? []
    for (const expected of ['ps', 'logs', 'kill', 'auto-pr']) {
      expect(names).toContain(expected)
    }
    for (const sub of command.subcommands ?? []) {
      expect(typeof sub.description).toBe('string')
      expect(sub.description.length).toBeGreaterThan(0)
      // argumentHint is optional (N1: `ps` omits it — it takes no args);
      // when present it must be a non-empty hint.
      if ('argumentHint' in sub) {
        expect(typeof sub.argumentHint).toBe('string')
        expect(sub.argumentHint?.length).toBeGreaterThan(0)
      }
    }
    // N1: `ps` takes no args, so it declares no hint key at all.
    expect(
      command.subcommands?.find(s => s.name === 'ps'),
    ).not.toHaveProperty('argumentHint')
  })

  test('isEnabled is default-on', () => {
    expect(command.isEnabled?.()).toBe(true)
    expect(isCommandEnabled(command)).toBe(true)
  })

  test('description sells background runs and points at CLI spawn', () => {
    expect(command.description).toContain('openclaude --bg')
  })

  test('loads a call function', async () => {
    const mod = await command.load()
    expect(typeof mod.call).toBe('function')
  })

  test('type is local with non-interactive support', () => {
    expect(command.type).toBe('local')
    if (command.type === 'local') {
      expect(command.supportsNonInteractive).toBe(true)
    }
  })
})

describe('/bg subcommand dispatch', () => {
  test('empty args show help', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {
        throw new Error('should not be called')
      },
      logsHandler: async () => {
        throw new Error('should not be called')
      },
      killHandler: async () => {
        throw new Error('should not be called')
      },
    })
    const res = expectText(await call('', makeContext()))
    expect(res.value).toContain('/bg ps')
    expect(res.value).toContain('openclaude --bg')
  })

  test('unknown subcommand shows help', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
    })
    const res = expectText(await call('frobnicate', makeContext()))
    expect(res.value).toContain('Unknown /bg subcommand')
    expect(res.value).toContain('/bg ps')
  })

  test('ps delegates to psHandler and returns its output', async () => {
    let seen: string[] | null = null
    const call = createBgCommandCall({
      psHandler: async args => {
        seen = args
        console.log('ID  STATUS  PID')
        console.log('bg-abc  running  123')
      },
      logsHandler: async () => {},
      killHandler: async () => {},
    })
    const res = expectText(await call('ps', makeContext()))
    expect(seen!).toEqual([])
    expect(res.value).toContain('bg-abc')
  })

  test('logs delegates target and flags to logsHandler', async () => {
    let seen: unknown = null
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async args => {
        seen = args
        console.log('log line one')
      },
      killHandler: async () => {},
    })
    const res = expectText(await call('logs bg-abc --stderr', makeContext()))
    expect(seen).toEqual(['bg-abc', '--stderr'])
    expect(res.value).toContain('log line one')
  })

  test('logs captures process.stdout.write output', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {
        process.stdout.write('streamed-log-bytes\n')
      },
      killHandler: async () => {},
    })
    const res = expectText(await call('logs bg-abc', makeContext()))
    expect(res.value).toContain('streamed-log-bytes')
  })

  test('logs with empty handler output names the target and hints at streams', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
    })
    const res = expectText(await call('logs bg-abc', makeContext()))
    expect(res.value).toContain('"bg-abc"')
    expect(res.value).toContain('--stderr')
  })

  test('logs without a target shows usage without calling the handler', async () => {
    let called = false
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {
        called = true
      },
      killHandler: async () => {},
    })
    const res = expectText(await call('logs', makeContext()))
    expect(called).toBe(false)
    expect(res.value).toContain('Usage: /bg logs')
  })

  test('logs follow flag returns CLI guidance without calling the handler', async () => {
    let called = false
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {
        called = true
      },
      killHandler: async () => {},
    })
    const res = expectText(await call('logs bg-abc -f', makeContext()))
    expect(called).toBe(false)
    expect(res.value).toContain('openclaude logs')
  })

  test('logs handler failure surfaces as error text, not a throw', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {
        console.error('Error: no such session: bg-nope')
        process.exit(1)
      },
      killHandler: async () => {},
    })
    const res = expectText(await call('logs bg-nope', makeContext()))
    expect(res.value).toContain('no such session')
  })

  test('kill delegates to killHandler (verified-PID path lives in the handler)', async () => {
    let seen: unknown = null
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async args => {
        seen = args
        console.log('Killed background session bg-abc.')
      },
    })
    const res = expectText(await call('kill bg-abc', makeContext()))
    expect(seen).toEqual(['bg-abc'])
    expect(res.value).toContain('Killed background session bg-abc')
  })

  test('kill without a target shows usage without calling the handler', async () => {
    let called = false
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {
        called = true
      },
    })
    const res = expectText(await call('kill', makeContext()))
    expect(called).toBe(false)
    expect(res.value).toContain('Usage: /bg kill')
  })

  test('subcommand matching is case-insensitive', async () => {
    let psCalled = false
    const call = createBgCommandCall({
      psHandler: async () => {
        psCalled = true
        console.log('ok')
      },
      logsHandler: async () => {},
      killHandler: async () => {},
    })
    await call('PS', makeContext())
    expect(psCalled).toBe(true)
  })
})

describe('/bg auto-pr toggle (mocked settings)', () => {
  test('bare auto-pr reports effective state', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
      getProjectAutoPr: () => undefined,
      getProjectSettingsPath: () => '/proj/.openclaude/settings.json',
      updateProjectAutoPr: () => null,
    })
    const res = expectText(await call('auto-pr', makeContext()))
    expect(res.value).toContain('disabled (default off)')
  })

  test('auto-pr on persists enabled:true via the settings-write path', async () => {
    let written: unknown = null
    const ctx = makeContext()
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
      getProjectAutoPr: () => ({ enabled: false, dryRun: true }),
      updateProjectAutoPr: next => {
        written = next
        return null
      },
      getProjectSettingsPath: () => '/proj/.openclaude/settings.json',
    })
    const res = expectText(await call('auto-pr on', ctx))
    expect(written).toEqual({ enabled: true, dryRun: true })
    expect(res.value).toContain('now enabled')
    expect(ctx._state().settings).toMatchObject({ autoPR: { enabled: true } })
  })

  test('auto-pr off preserves sibling fields', async () => {
    let written: unknown = null
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
      getProjectAutoPr: () => ({ enabled: true, dryRun: true }),
      updateProjectAutoPr: next => {
        written = next
        return null
      },
      getProjectSettingsPath: () => '/proj/.openclaude/settings.json',
    })
    const res = expectText(await call('auto-pr OFF', makeContext()))
    expect(written).toEqual({ enabled: false, dryRun: true })
    expect(res.value).toContain('disabled (default off)')
  })

  test('auto-pr write errors surface without throwing', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
      getProjectAutoPr: () => undefined,
      updateProjectAutoPr: () => new Error('settings are read-only'),
      getProjectSettingsPath: () => '/proj/.openclaude/settings.json',
    })
    const res = expectText(await call('auto-pr on', makeContext()))
    expect(res.value).toContain('Failed to update auto-PR setting')
  })

  test('auto-pr status is a documented query alias for bare auto-pr', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
      getProjectAutoPr: () => undefined,
      getProjectSettingsPath: () => '/proj/.openclaude/settings.json',
      updateProjectAutoPr: () => null,
    })
    const res = expectText(await call('auto-pr status', makeContext()))
    expect(res.value).toContain('disabled (default off)')
    expect(res.value).toContain('Usage: /bg auto-pr <on|off>')
  })

  test('auto-pr with junk shows usage', async () => {
    const call = createBgCommandCall({
      psHandler: async () => {},
      logsHandler: async () => {},
      killHandler: async () => {},
      getProjectAutoPr: () => undefined,
      updateProjectAutoPr: () => null,
      getProjectSettingsPath: () => '/proj/.openclaude/settings.json',
    })
    const res = expectText(await call('auto-pr maybe', makeContext()))
    expect(res.value).toContain('Usage: /bg auto-pr')
  })
})

describe('/bg auto-pr toggle round-trip on a temp project dir', () => {
  let tempDir = ''
  let savedCwd = ''

  beforeEach(async () => {
    await acquireSharedMutationLock('commands/bg/index.test.ts temp project')
    savedCwd = getOriginalCwd()
    tempDir = mkdtempSync(join(tmpdir(), 'openclaude-bg-autopr-'))
    setOriginalCwd(tempDir)
    resetSettingsCache()
  })

  afterEach(() => {
    try {
      setOriginalCwd(savedCwd)
      resetSettingsCache()
      if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('on -> off -> on round-trip via the existing settings-write path', async () => {
    // Fail-closed default: no file yet, so the toggle must report off.
    expect(getSettingsForSource('projectSettings')?.autoPR?.enabled).not.toBe(true)
    const call = createBgCommandCall()
    const ctx = makeContext()

    const on1 = expectText(await call('auto-pr on', ctx))
    expect(on1.value).toContain('now enabled')
    expect(getSettingsForSource('projectSettings')?.autoPR?.enabled).toBe(true)

    const off = expectText(await call('auto-pr off', ctx))
    expect(off.value).toContain('disabled (default off)')
    expect(getSettingsForSource('projectSettings')?.autoPR?.enabled).not.toBe(true)

    const on2 = expectText(await call('auto-pr on', ctx))
    expect(on2.value).toContain('now enabled')
    expect(getSettingsForSource('projectSettings')?.autoPR?.enabled).toBe(true)

    // The write went to the temp project's file, not hand-rolled JSON elsewhere.
    const projectFile = getSettingsFilePathForSource('projectSettings')
    expect(projectFile?.startsWith(tempDir)).toBe(true)
    const raw = await readFile(projectFile as string, 'utf8')
    expect(JSON.parse(raw).autoPR.enabled).toBe(true)
  })

  test('leaves the real project defaults untouched', async () => {
    const call = createBgCommandCall()
    await call('auto-pr on', makeContext())
    expect(getSettingsForSource('projectSettings')?.autoPR?.enabled).toBe(true)

    // Restore the real cwd: the temp opt-in must not leak into it.
    setOriginalCwd(savedCwd)
    resetSettingsCache()
    const realEnabled = getSettingsForSource('projectSettings')?.autoPR?.enabled
    expect(realEnabled).not.toBe(true)

    // Re-enter temp to keep afterEach restore symmetric.
    setOriginalCwd(tempDir)
    resetSettingsCache()
  })
})

describe('/bg help text', () => {
  test('help mentions spawn, management verbs, and the toggle', () => {
    expect(BG_HELP).toContain('openclaude --bg')
    expect(BG_HELP).toContain('/bg ps')
    expect(BG_HELP).toContain('/bg logs')
    expect(BG_HELP).toContain('/bg kill')
    expect(BG_HELP).toContain('/bg auto-pr')
  })
})
