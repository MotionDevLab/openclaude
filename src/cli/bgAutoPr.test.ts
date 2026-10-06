import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { setGovernancePolicySettingsForSourceForTesting } from '../utils/governancePolicy.js'
import {
  AUTO_PR_BODY_MAX_LENGTH,
  AUTO_PR_TITLE_MAX_LENGTH,
  buildAutoPrArgs,
  maybeRunAutoPrForSession,
  resolveAutoPrTitleBody,
  runAutoPr,
  sanitizeAutoPrBody,
  sanitizeAutoPrTitle,
  type AutoPrExecFn,
  type AutoPrExecResult,
  type RunAutoPrDryRun,
} from './bgAutoPr.js'
import {
  _setBackgroundSessionsRootForTesting,
  createBackgroundSession,
  recordBackgroundSessionAutoPrResult,
  resolveBackgroundSession,
  type BackgroundSession,
} from './bgRegistry.js'

type ExecCall = {
  file: string
  args: string[]
  cwd: string
  input?: string
}

const ok = (stdout = ''): AutoPrExecResult => ({ stdout, stderr: '', code: 0 })
const fail = (stderr = '', code = 1): AutoPrExecResult => ({
  stdout: '',
  stderr,
  code,
})

function makeExecStub(
  handler: (file: string, args: string[]) => AutoPrExecResult,
): { exec: AutoPrExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: AutoPrExecFn = async (file, args, options) => {
    calls.push({
      file,
      args,
      cwd: options.cwd,
      ...(options.input !== undefined ? { input: options.input } : {}),
    })
    return handler(file, args)
  }
  return { exec, calls }
}

function calledWith(calls: ExecCall[], file: string, ...args: string[]): boolean {
  return calls.some(
    call =>
      call.file === file &&
      args.every((arg, index) => call.args[index] === arg),
  )
}

/** Read-only guards pass; mutations succeed. `toplevel` defaults to cwd. */
function happyHandler(workdir: string, overrides: { toplevel?: string } = {}) {
  const toplevel = overrides.toplevel ?? workdir
  return (file: string, args: string[]): AutoPrExecResult => {
    if (file === 'gh' && args[0] === '--version') return ok('gh version 2.74.0\n')
    if (file === 'git' && args[0] === 'status') return ok(' M src/a.ts\n')
    if (file === 'git' && args[0] === 'rev-list') {
      return fail('fatal: no upstream configured')
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return fail('no pull requests found')
    }
    if (file === 'git' && args[0] === 'branch') return ok('bg/demo\n')
    if (file === 'git' && args[0] === 'symbolic-ref') {
      return fail("unknown ref 'refs/remotes/origin/HEAD'")
    }
    if (file === 'git' && args[0] === 'rev-parse') return ok(`${toplevel}\n`)
    if (file === 'git' && args[0] === 'add') return ok('')
    if (file === 'git' && args[0] === 'commit') return ok('[bg/demo abc1234]\n')
    if (file === 'git' && args[0] === 'push') return ok('pushed\n')
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return ok('https://github.com/acme/repo/pull/42\n')
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  }
}

const baseInput = (workdir: string) => ({
  cwd: workdir,
  sessionId: 'bg-12345678',
  sessionName: 'demo',
  worktreeBranch: 'bg/demo',
})

describe('bgAutoPr', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'openclaude-bg-autopr-'))
    setGovernancePolicySettingsForSourceForTesting(() => null)
  })

  afterEach(async () => {
    setGovernancePolicySettingsForSourceForTesting(null)
    await rm(workdir, { recursive: true, force: true })
  })

  it('builds the draft gh argv', () => {
    expect(buildAutoPrArgs({ title: 't', body: 'b' })).toEqual([
      'pr',
      'create',
      '--draft',
      '--title',
      't',
      '--body',
      'b',
    ])
  })

  it('sanitizes titles: strips control chars, collapses whitespace, truncates to 70', () => {
    expect(sanitizeAutoPrTitle('  hello\x00\x07  world\nnewline  ')).toBe(
      'hello world newline',
    )
    expect(sanitizeAutoPrTitle('x'.repeat(100))).toHaveLength(
      AUTO_PR_TITLE_MAX_LENGTH,
    )
    expect(sanitizeAutoPrTitle('   \n\t  ')).toBeUndefined()
    expect(sanitizeAutoPrTitle(undefined)).toBeUndefined()
  })

  it('sanitizes bodies: keeps newlines, collapses tabs, truncates to 2000', () => {
    expect(sanitizeAutoPrBody('a\x00b\tc\nd')).toBe('ab c\nd')
    expect(sanitizeAutoPrBody('y'.repeat(3000))).toHaveLength(
      AUTO_PR_BODY_MAX_LENGTH,
    )
    expect(sanitizeAutoPrBody('   ')).toBeUndefined()
  })

  it('commits, pushes, and creates a draft PR on the happy path', async () => {
    const { exec, calls } = makeExecStub(happyHandler(workdir))
    const result = await runAutoPr(
      { ...baseInput(workdir), stdoutTail: 'some log output' },
      { exec, readFile: async () => null },
    )

    expect(result).toEqual({ prUrl: 'https://github.com/acme/repo/pull/42' })
    expect(calledWith(calls, 'git', 'add', '-A')).toBe(true)
    const commit = calls.find(call => call.args[0] === 'commit')
    expect(commit?.args).toEqual(['commit', '-m', 'bg: demo'])
    expect(calledWith(calls, 'git', 'push', '-u', 'origin', 'bg/demo')).toBe(true)
    const create = calls.find(
      call => call.file === 'gh' && call.args[1] === 'create',
    )
    expect(create?.args).toContain('--draft')
    expect(create?.args).toContain('bg: demo')
  })

  it('aborts with nothing to PR when the tree is clean and not ahead', async () => {
    const { exec, calls } = makeExecStub((file, args) => {
      if (file === 'gh' && args[0] === '--version') return ok('gh\n')
      if (file === 'git' && args[0] === 'status') return ok('')
      if (file === 'git' && args[0] === 'rev-list') return ok('0\n')
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
    })
    await expect(runAutoPr(baseInput(workdir), { exec })).rejects.toThrow(
      'auto-PR aborted: nothing to PR',
    )
    expect(calls.some(call => call.args[0] === 'push')).toBe(false)
  })

  it('aborts when a PR already exists, without pushing or creating', async () => {
    const { exec, calls } = makeExecStub((file, args) => {
      if (file === 'gh' && args[0] === '--version') return ok('gh\n')
      if (file === 'git' && args[0] === 'status') return ok(' M a\n')
      if (file === 'git' && args[0] === 'rev-list') return ok('0\n')
      if (file === 'gh' && args[0] === 'pr') {
        return ok(
          '{"number":7,"url":"https://github.com/acme/repo/pull/7"}\n',
        )
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
    })
    await expect(runAutoPr(baseInput(workdir), { exec })).rejects.toThrow(
      'auto-PR aborted: PR already exists: https://github.com/acme/repo/pull/7',
    )
    expect(calledWith(calls, 'git', 'add')).toBe(false)
    expect(calledWith(calls, 'git', 'push')).toBe(false)
    expect(
      calls.some(call => call.file === 'gh' && call.args[1] === 'create'),
    ).toBe(false)
  })

  it('refuses to open a PR from main', async () => {
    const { exec, calls } = makeExecStub((file, args) => {
      if (file === 'gh' && args[0] === '--version') return ok('gh\n')
      if (file === 'git' && args[0] === 'status') return ok(' M a\n')
      if (file === 'git' && args[0] === 'rev-list') return ok('0\n')
      if (file === 'gh' && args[0] === 'pr') return fail('none')
      if (file === 'git' && args[0] === 'branch') return ok('main\n')
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
    })
    await expect(runAutoPr(baseInput(workdir), { exec })).rejects.toThrow(
      'auto-PR aborted: refusing to open a PR from protected branch "main"',
    )
    expect(calledWith(calls, 'git', 'push')).toBe(false)
  })

  it('refuses to open a PR from the origin/HEAD target', async () => {
    const { exec } = makeExecStub((file, args) => {
      if (file === 'gh' && args[0] === '--version') return ok('gh\n')
      if (file === 'git' && args[0] === 'status') return ok(' M a\n')
      if (file === 'git' && args[0] === 'rev-list') return ok('0\n')
      if (file === 'gh' && args[0] === 'pr') return fail('none')
      if (file === 'git' && args[0] === 'branch') return ok('develop\n')
      if (file === 'git' && args[0] === 'symbolic-ref') {
        return ok('refs/remotes/origin/develop\n')
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
    })
    await expect(runAutoPr(baseInput(workdir), { exec })).rejects.toThrow(
      'auto-PR aborted: refusing to open a PR from protected branch "develop"',
    )
  })

  it('aborts when the worktree cwd does not match the git top-level', async () => {
    const other = await mkdtemp(join(tmpdir(), 'openclaude-bg-autopr-top-'))
    try {
      const { exec } = makeExecStub(happyHandler(workdir, { toplevel: other }))
      await expect(runAutoPr(baseInput(workdir), { exec })).rejects.toThrow(
        'auto-PR aborted: worktree cwd does not match git top-level (symlink guard)',
      )
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('fails with an install hint when gh is missing', async () => {
    const { exec } = makeExecStub(() => ({
      stdout: '',
      stderr: '',
      code: 1,
      error: "spawn gh ENOENT: 'gh'",
    }))
    await expect(runAutoPr(baseInput(workdir), { exec })).rejects.toThrow(
      'gh CLI not found on PATH',
    )
  })

  it('dry-run prints argv and sources but executes no mutations', async () => {
    const { exec, calls } = makeExecStub(happyHandler(workdir))
    const result = (await runAutoPr(
      {
        ...baseInput(workdir),
        dryRun: true,
        stdoutTail: 'PR_TITLE: From markers\nPR_BODY:\nbody here\nPR_END\n',
      },
      { exec, readFile: async () => null },
    )) as RunAutoPrDryRun

    expect(result.dryRun).toBe(true)
    expect(result.title).toBe('From markers')
    expect(result.titleSource).toBe('stdout')
    expect(result.argv.slice(0, 3)).toEqual(['pr', 'create', '--draft'])
    for (const call of calls) {
      expect(['--version', 'status', 'rev-list', 'view', 'branch', 'symbolic-ref', 'rev-parse']).toContain(
        call.args[0] === 'pr' ? call.args[1] : call.args[0],
      )
    }
    expect(calledWith(calls, 'git', 'add')).toBe(false)
    expect(calledWith(calls, 'git', 'commit')).toBe(false)
    expect(calledWith(calls, 'git', 'push')).toBe(false)
    expect(
      calls.some(call => call.file === 'gh' && call.args[1] === 'create'),
    ).toBe(false)
  })

  it('skips the commit when clean but ahead of remote', async () => {
    const { exec, calls } = makeExecStub((file, args) => {
      const base = happyHandler(workdir)(file, args)
      if (file === 'git' && args[0] === 'status') return ok('')
      if (file === 'git' && args[0] === 'rev-list') return ok('3\n')
      return base
    })
    const result = await runAutoPr(baseInput(workdir), {
      exec,
      readFile: async () => null,
    })
    expect(result).toEqual({ prUrl: 'https://github.com/acme/repo/pull/42' })
    expect(calledWith(calls, 'git', 'commit')).toBe(false)
    expect(calledWith(calls, 'git', 'push', '-u', 'origin', 'bg/demo')).toBe(true)
  })

  it('resolves title/body with explicit > file > stdout > template precedence', () => {
    const session = { sessionId: 'bg-12345678', sessionName: 'demo' }
    const file = 'File title\n\nFile body.'
    const stdout = 'PR_TITLE: Stdout title\nPR_BODY:\nStdout body\nPR_END\n'

    const explicit = resolveAutoPrTitleBody({
      ...session,
      explicitTitle: 'Explicit',
      proposalFileContent: file,
      stdoutTail: stdout,
    })
    expect([explicit.title, explicit.titleSource]).toEqual([
      'Explicit',
      'explicit',
    ])
    // Explicit title does not pin the body: the file body still wins.
    expect([explicit.body, explicit.bodySource]).toEqual([
      'File body.',
      'file',
    ])

    const fromFile = resolveAutoPrTitleBody({
      ...session,
      proposalFileContent: file,
      stdoutTail: stdout,
    })
    expect([fromFile.title, fromFile.titleSource]).toEqual([
      'File title',
      'file',
    ])

    const fromStdout = resolveAutoPrTitleBody({ ...session, stdoutTail: stdout })
    expect([fromStdout.title, fromStdout.titleSource]).toEqual([
      'Stdout title',
      'stdout',
    ])
    expect([fromStdout.body, fromStdout.bodySource]).toEqual([
      'Stdout body',
      'stdout',
    ])

    const template = resolveAutoPrTitleBody({ ...session })
    expect([template.title, template.titleSource]).toEqual([
      'bg: demo',
      'template',
    ])
    expect(template.body).toContain('bg-12345678')
  })

  it('falls through sources that are empty after sanitize', () => {
    const resolved = resolveAutoPrTitleBody({
      sessionId: 'bg-12345678',
      proposalFileContent: '   \n\n\n',
      stdoutTail: 'noise without markers\n',
    })
    expect(resolved.titleSource).toBe('template')
    expect(resolved.bodySource).toBe('template')
  })

  it('reads stdout markers until PR_END or EOF', () => {
    const untilEnd = resolveAutoPrTitleBody({
      sessionId: 'bg-1',
      stdoutTail: 'x\nPR_BODY:\nline1\nline2\nPR_END\ntrailing\n',
    })
    expect(untilEnd.body).toBe('line1\nline2')

    const untilEof = resolveAutoPrTitleBody({
      sessionId: 'bg-1',
      stdoutTail: 'PR_TITLE: T\nPR_BODY:\nline1\nline2',
    })
    expect(untilEof.body).toBe('line1\nline2')
  })

  it('keeps shell metacharacters in bodies literal (never shell)', async () => {
    const body = 'Summary $(rm -rf ~) `id`\nSecond line & | ; > <\n'
    const seen: string[] = []
    const { exec, calls } = makeExecStub(happyHandler(workdir))
    const result = await runAutoPr(
      { ...baseInput(workdir), stdoutTail: `PR_TITLE: T\nPR_BODY:\n${body}PR_END\n` },
      {
        exec,
        readFile: async path => {
          seen.push(path)
          return null
        },
      },
    )
    expect(result).toEqual({ prUrl: 'https://github.com/acme/repo/pull/42' })
    expect(seen).toEqual([join(workdir, '.openclaude/bg-pr.md')])
    const create = calls.find(
      call => call.file === 'gh' && call.args[1] === 'create',
    )
    // Multiline bodies travel via stdin, verbatim.
    expect(create?.args).toEqual([
      'pr',
      'create',
      '--draft',
      '--title',
      'T',
      '--body-file',
      '-',
    ])
    expect(create?.input).toBe(
      'Summary $(rm -rf ~) `id`\nSecond line & | ; > <',
    )

    const single = 'one line $(rm -rf ~) `id`'
    const { exec: exec2, calls: calls2 } = makeExecStub(happyHandler(workdir))
    await runAutoPr(
      { ...baseInput(workdir), stdoutTail: `PR_TITLE: T\nPR_BODY:\n${single}\nPR_END\n` },
      { exec: exec2, readFile: async () => null },
    )
    const create2 = calls2.find(
      call => call.file === 'gh' && call.args[1] === 'create',
    )
    expect(create2?.args).toContain(single)
  })

  it('rejects titles matching forbidden commit message patterns', async () => {
    setGovernancePolicySettingsForSourceForTesting(source =>
      source === 'projectSettings'
        ? { git: { forbiddenCommitMessagePatterns: ['WIP'] } }
        : null,
    )
    const { exec } = makeExecStub(happyHandler(workdir))
    await expect(
      runAutoPr(
        { ...baseInput(workdir), title: 'WIP: half done' },
        { exec, readFile: async () => null },
      ),
    ).rejects.toThrow('auto-PR aborted: PR title contains forbidden pattern "WIP"')
  })

  it('truncates oversize titles and bodies', async () => {
    const { exec, calls } = makeExecStub(happyHandler(workdir))
    await runAutoPr(
      {
        ...baseInput(workdir),
        title: 't'.repeat(100),
        stdoutTail: `PR_BODY:\n${'bb\n'.repeat(1000)}PR_END\n`,
      },
      { exec, readFile: async () => null },
    )
    const commit = calls.find(call => call.args[0] === 'commit')
    expect(commit?.args[2]).toHaveLength(AUTO_PR_TITLE_MAX_LENGTH)
    const create = calls.find(
      call => call.file === 'gh' && call.args[1] === 'create',
    )
    expect(create?.input).toHaveLength(AUTO_PR_BODY_MAX_LENGTH)
  })
})

describe('maybeRunAutoPrForSession', () => {
  function optedInSession(overrides: Partial<BackgroundSession> = {}): BackgroundSession {
    return {
      id: 'bg-12345678',
      pid: 4242,
      cwd: '/repo',
      status: 'exited',
      exitCode: 0,
      sessionId: 'conversation-bg-12345678',
      startedAt: '2026-08-15T08:00:00.000Z',
      updatedAt: '2026-08-15T08:00:00.000Z',
      command: ['openclaude', '--print', 'work'],
      stdoutLogPath: '/tmp/stdout.log',
      stderrLogPath: '/tmp/stderr.log',
      worktreePath: '/repo',
      worktreeBranch: 'bg/demo',
      autoPR: { enabled: true },
      ...overrides,
    }
  }

  it('no-ops for non-exit-0, non-opted-in, and non-worktree terminals', async () => {
    const variants: Partial<BackgroundSession>[] = [
      { status: 'failed', exitCode: 1 },
      { status: 'exited', exitCode: 3 },
      { status: 'killed' },
      { worktreePath: undefined },
      { autoPR: undefined },
      { autoPR: { enabled: false } },
    ]
    for (const overrides of variants) {
      let runs = 0
      let records = 0
      await maybeRunAutoPrForSession(optedInSession(overrides), {
        runAutoPr: async () => {
          runs++
          return { prUrl: 'https://x/1' }
        },
        recordResult: async () => {
          records++
        },
      })
      expect([runs, records]).toEqual([0, 0])
    }
  })

  it('stores prUrl and appends the log line on success', async () => {
    const recorded: { prUrl?: string; prError?: string }[] = []
    const appended: string[] = []
    await maybeRunAutoPrForSession(optedInSession(), {
      runAutoPr: async () => ({ prUrl: 'https://github.com/acme/repo/pull/42' }),
      recordResult: async (_id, result) => {
        recorded.push(result)
      },
      readStdoutTail: async () => undefined,
      appendLogLine: async (_path, line) => {
        appended.push(line)
      },
    })
    expect(recorded).toEqual([{ prUrl: 'https://github.com/acme/repo/pull/42' }])
    expect(appended).toEqual([
      'auto-PR created draft PR: https://github.com/acme/repo/pull/42',
    ])
  })

  it('stores prError without throwing when runAutoPr fails', async () => {
    const recorded: { prUrl?: string; prError?: string }[] = []
    await expect(
      maybeRunAutoPrForSession(optedInSession(), {
        runAutoPr: async () => {
          throw new Error('auto-PR aborted: nothing to PR')
        },
        recordResult: async (_id, result) => {
          recorded.push(result)
        },
        readStdoutTail: async () => undefined,
        appendLogLine: async () => {},
      }),
    ).resolves.toBeUndefined()
    expect(recorded).toEqual([{ prError: 'auto-PR aborted: nothing to PR' }])
  })

  it('appends dry-run argv to the log without recording', async () => {
    const recorded: unknown[] = []
    const appended: string[] = []
    await maybeRunAutoPrForSession(optedInSession(), {
      runAutoPr: async () => ({
        dryRun: true as const,
        argv: ['pr', 'create', '--draft', '--title', 't', '--body', 'b'],
        title: 't',
        body: 'b',
        titleSource: 'template',
        bodySource: 'template',
        branch: 'bg/demo',
        dirty: false,
        aheadCommits: 1,
      }),
      recordResult: async (_id, result) => {
        recorded.push(result)
      },
      readStdoutTail: async () => undefined,
      appendLogLine: async (_path, line) => {
        appended.push(line)
      },
    })
    expect(recorded).toEqual([])
    expect(appended).toHaveLength(1)
    expect(appended[0]).toContain('pr create --draft --title t --body b')
  })

  it('round-trips autoPR config and prUrl/prError through the registry', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'openclaude-bg-autopr-reg-'))
    const sessionCwd = await mkdtemp(join(tmpdir(), 'openclaude-bg-autopr-cwd-'))
    _setBackgroundSessionsRootForTesting(join(configDir, 'bg-sessions'))
    try {
      await createBackgroundSession({
        id: 'bg-autopr-1',
        pid: 4242,
        cwd: sessionCwd,
        command: ['openclaude', '--print', 'work'],
        sessionId: 'conversation-bg-autopr-1',
        autoPR: { enabled: true, title: 'Ship it', dryRun: true },
      })
      const stored = await resolveBackgroundSession('bg-autopr-1')
      expect(stored.autoPR).toEqual({
        enabled: true,
        title: 'Ship it',
        dryRun: true,
      })

      await recordBackgroundSessionAutoPrResult('bg-autopr-1', {
        prUrl: 'https://github.com/acme/repo/pull/9',
      })
      expect((await resolveBackgroundSession('bg-autopr-1')).prUrl).toBe(
        'https://github.com/acme/repo/pull/9',
      )

      await recordBackgroundSessionAutoPrResult('bg-autopr-1', {
        prError: 'auto-PR aborted: nothing to PR',
      })
      const failed = await resolveBackgroundSession('bg-autopr-1')
      expect(failed.prError).toBe('auto-PR aborted: nothing to PR')
      expect(failed.status).toBe('running')

      await expect(
        createBackgroundSession({
          id: 'bg-autopr-bad',
          pid: 4242,
          cwd: sessionCwd,
          command: ['openclaude'],
          sessionId: 'conversation-bg-autopr-bad',
          autoPR: { enabled: 'yes' } as unknown as { enabled: boolean },
        }),
      ).rejects.toThrow('Invalid background session auto-PR config')
    } finally {
      _setBackgroundSessionsRootForTesting(undefined)
      await rm(configDir, { recursive: true, force: true })
      await rm(sessionCwd, { recursive: true, force: true })
    }
  })
})
