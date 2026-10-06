import { appendFile, open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { findForbiddenCommitMessagePattern } from '../utils/governancePolicy.js'
import {
  recordBackgroundSessionAutoPrResult,
  type BackgroundSession,
} from './bgRegistry.js'

export const AUTO_PR_TITLE_MAX_LENGTH = 70
export const AUTO_PR_BODY_MAX_LENGTH = 2000
export const AUTO_PR_PROPOSAL_FILE = '.openclaude/bg-pr.md'
export const AUTO_PR_STDOUT_TAIL_BYTES = 32 * 1024
const AUTO_PR_EXEC_TIMEOUT_MS = 2 * 60 * 1000
export const GH_INSTALL_HINT =
  'gh CLI not found on PATH. Install it (https://cli.github.com/) and authenticate (gh auth login); the background session stays exited and no PR was created.'

export type AutoPrTitleSource = 'explicit' | 'file' | 'stdout' | 'template'
export type AutoPrBodySource = 'file' | 'stdout' | 'template'

export type AutoPrExecResult = {
  stdout: string
  stderr: string
  code: number
  error?: string
}

export type AutoPrExecFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; input?: string },
) => Promise<AutoPrExecResult>

const defaultExec: AutoPrExecFn = (file, args, options) =>
  execFileNoThrowWithCwd(file, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? AUTO_PR_EXEC_TIMEOUT_MS,
    input: options.input,
  })

export type AutoPrReadFileFn = (path: string) => Promise<string | null>

const defaultReadFile: AutoPrReadFileFn = async path => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sanitize untrusted model-proposed PR titles: strip control chars, collapse
 * all whitespace to single spaces, drop empties, truncate to 70 chars.
 */
export function sanitizeAutoPrTitle(
  raw: string | undefined | null,
  maxLength: number = AUTO_PR_TITLE_MAX_LENGTH,
): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const cleaned = raw
    .replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, maxLength).trim() || undefined
}

/**
 * Sanitize untrusted model-proposed PR bodies: strip control chars (keeping
 * `\n`; `\t` survives stripping but collapses to a space below), collapse
 * horizontal whitespace runs, cap blank-line runs, truncate to 2000 chars.
 */
export function sanitizeAutoPrBody(
  raw: string | undefined | null,
  maxLength: number = AUTO_PR_BODY_MAX_LENGTH,
): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const cleaned = raw
    .replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, maxLength).trim() || undefined
}

function buildTemplateTitle(sessionName?: string, sessionId?: string): string {
  const fallback = `bg: ${sessionName?.trim() || sessionId || 'background session'}`
  return sanitizeAutoPrTitle(fallback) ?? 'bg: background session'
}

function buildTemplateBody(sessionId: string, worktreeBranch?: string): string {
  const branchLine = worktreeBranch ? ` (branch ${worktreeBranch})` : ''
  return (
    `Automated draft PR for background session ${sessionId}${branchLine}.\n\n` +
    '## Test plan\n' +
    '- Background job exited 0; manual review required before merge.'
  )
}

function parseStdoutMarkers(tail: string): {
  title?: string
  body?: string
} {
  const lines = tail.split('\n')
  let title: string | undefined
  let body: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (title === undefined && line.startsWith('PR_TITLE:')) {
      title = line.slice('PR_TITLE:'.length)
    } else if (body === undefined && line.startsWith('PR_BODY:')) {
      const collected: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const bodyLine = lines[j] ?? ''
        if (bodyLine.startsWith('PR_END')) break
        collected.push(bodyLine)
      }
      body = collected.join('\n')
    }
  }
  return { title, body }
}

export type ResolveAutoPrTitleBodyInput = {
  explicitTitle?: string
  proposalFileContent?: string | null
  stdoutTail?: string
  sessionName?: string
  sessionId: string
  worktreeBranch?: string
}

export type ResolvedAutoPrTitleBody = {
  title: string
  body: string
  titleSource: AutoPrTitleSource
  bodySource: AutoPrBodySource
}

/**
 * Title/body precedence: (1) explicit `--pr-title`; else (2) job-authored
 * `.openclaude/bg-pr.md` (line 1 = title, rest = body); else (3) stdout-tail
 * markers; else (4) deterministic template. The file wins over stdout so log
 * output can never inject PR content. Empty-after-sanitize falls through to
 * the next source; an empty title ultimately becomes the template title.
 */
export function resolveAutoPrTitleBody(
  input: ResolveAutoPrTitleBodyInput,
): ResolvedAutoPrTitleBody {
  let fileTitle: string | undefined
  let fileBody: string | undefined
  if (input.proposalFileContent) {
    const lines = input.proposalFileContent.split('\n')
    fileTitle = sanitizeAutoPrTitle(lines[0])
    fileBody = sanitizeAutoPrBody(lines.slice(1).join('\n'))
  }

  const markers = input.stdoutTail
    ? parseStdoutMarkers(input.stdoutTail)
    : { title: undefined, body: undefined }
  const stdoutTitle = sanitizeAutoPrTitle(markers.title)
  const stdoutBody = sanitizeAutoPrBody(markers.body)

  const explicitTitle = sanitizeAutoPrTitle(input.explicitTitle)
  const templateTitle = buildTemplateTitle(input.sessionName, input.sessionId)
  const templateBody = buildTemplateBody(input.sessionId, input.worktreeBranch)

  const title = explicitTitle ?? fileTitle ?? stdoutTitle ?? templateTitle
  const titleSource: AutoPrTitleSource = explicitTitle
    ? 'explicit'
    : fileTitle
      ? 'file'
      : stdoutTitle
        ? 'stdout'
        : 'template'
  const body = fileBody ?? stdoutBody ?? templateBody
  const bodySource: AutoPrBodySource = fileBody
    ? 'file'
    : stdoutBody
      ? 'stdout'
      : 'template'
  return { title, body, titleSource, bodySource }
}

/**
 * Pure `gh pr create --draft` argv builder. Note: `execFileNoThrow` rejects
 * `\r`/`\n` in argv, so `runAutoPr` switches multiline bodies to
 * `--body-file -` with stdin; dry-run prints whichever argv would execute.
 */
export function buildAutoPrArgs(options: {
  title: string
  body: string
  draft?: boolean
}): string[] {
  const { title, body, draft = true } = options
  return [
    'pr',
    'create',
    ...(draft ? ['--draft'] : []),
    '--title',
    title,
    '--body',
    body,
  ]
}

export type RunAutoPrInput = {
  cwd: string
  sessionId: string
  sessionName?: string
  worktreeBranch?: string
  title?: string
  stdoutTail?: string
  dryRun?: boolean
}

export type RunAutoPrSuccess = { prUrl: string }

export type RunAutoPrDryRun = {
  dryRun: true
  argv: string[]
  title: string
  body: string
  titleSource: AutoPrTitleSource
  bodySource: AutoPrBodySource
  branch: string
  dirty: boolean
  aheadCommits: number
}

export type RunAutoPrDeps = {
  exec?: AutoPrExecFn
  readFile?: AutoPrReadFileFn
}

function abort(message: string): never {
  throw new Error(`auto-PR aborted: ${message}`)
}

async function readProposalFile(
  cwd: string,
  readFileFn: AutoPrReadFileFn,
): Promise<string | null> {
  try {
    return await readFileFn(join(cwd, AUTO_PR_PROPOSAL_FILE))
  } catch {
    return null
  }
}

function parseAheadCount(output: string): number {
  const count = Number.parseInt(output.trim(), 10)
  return Number.isFinite(count) && count > 0 ? count : 0
}

/**
 * Draft-PR a finished background worktree: guards (in order) → commit-if-needed
 * → push → `gh pr create --draft`. All subprocess calls use `execFileNoThrow`
 * argv arrays (never shell); titles/bodies are untrusted plain text passed
 * literally. Throws `auto-PR aborted: <reason>` on any guard failure; the
 * caller stores the message as `prError` without touching session status.
 */
export async function runAutoPr(
  input: RunAutoPrInput,
  deps: RunAutoPrDeps = {},
): Promise<RunAutoPrSuccess | RunAutoPrDryRun> {
  const exec = deps.exec ?? defaultExec
  const readFileFn = deps.readFile ?? defaultReadFile
  const { cwd } = input

  const ghVersion = await exec('gh', ['--version'], { cwd })
  if (ghVersion.code !== 0) abort(GH_INSTALL_HINT)

  // Guard 1: something must exist to PR — a dirty tree or commits ahead of remote.
  const status = await exec('git', ['status', '--porcelain'], { cwd })
  if (status.code !== 0) {
    abort(`git status failed (exit ${status.code}); refusing to guess`)
  }
  const dirty = status.stdout.trim().length > 0
  const revList = await exec('git', ['rev-list', '--count', '@{u}..HEAD'], {
    cwd,
  })
  const aheadCommits = revList.code === 0 ? parseAheadCount(revList.stdout) : 0
  if (!dirty && aheadCommits === 0) {
    abort('nothing to PR (working tree clean and not ahead of remote)')
  }

  // Guard 2: never duplicate — if the branch already has a PR, stop.
  const prView = await exec('gh', ['pr', 'view', '--json', 'number,url'], {
    cwd,
  })
  if (prView.code === 0) {
    let existing = '#?'
    try {
      const parsed = JSON.parse(prView.stdout) as {
        number?: number
        url?: string
      }
      existing =
        parsed.url ?? (parsed.number !== undefined ? `#${parsed.number}` : '#?')
    } catch {
      // Exit 0 means a PR exists even when the JSON is unparseable.
    }
    abort(`PR already exists: ${existing}`)
  }

  // Guard 3: never PR from main/master or the origin/HEAD target.
  const branchOut = await exec('git', ['branch', '--show-current'], { cwd })
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() : ''
  if (!branch) abort('cannot determine current branch (detached HEAD?)')
  if (branch === 'main' || branch === 'master') {
    abort(`refusing to open a PR from protected branch "${branch}"`)
  }
  const symbolicRef = await exec(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { cwd },
  )
  if (symbolicRef.code === 0) {
    const target = symbolicRef.stdout.trim().split('/').pop() ?? ''
    if (target && target === branch) {
      abort(`refusing to open a PR from protected branch "${branch}"`)
    }
  }

  // Guard 4 (RED 3 symlink guard): realpath(cwd) must equal
  // realpath(git top-level), so `git add -A` below can only stage the worktree.
  const topLevel = await exec('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (topLevel.code !== 0) abort('cannot determine git top-level')
  const [realCwd, realTop] = await Promise.all([
    realpath(cwd).catch((): null => null),
    realpath(topLevel.stdout.trim()).catch((): null => null),
  ])
  if (!realCwd || !realTop) {
    abort('cannot resolve worktree path symlinks; refusing to guess')
  }
  if (realCwd.normalize('NFC') !== realTop.normalize('NFC')) {
    abort('worktree cwd does not match git top-level (symlink guard)')
  }

  const proposalFileContent = await readProposalFile(cwd, readFileFn)
  const resolved = resolveAutoPrTitleBody({
    explicitTitle: input.title,
    proposalFileContent,
    stdoutTail: input.stdoutTail,
    sessionName: input.sessionName,
    sessionId: input.sessionId,
    worktreeBranch: input.worktreeBranch ?? branch,
  })

  const forbidden = findForbiddenCommitMessagePattern(resolved.title)
  if (forbidden) {
    abort(`PR title contains forbidden pattern "${forbidden}"`)
  }

  // execFileNoThrow rejects \r/\n in argv, so multiline bodies travel via
  // stdin (`gh pr create --body-file -`); single-line bodies use --body.
  const multilineBody = /[\r\n]/.test(resolved.body)
  const argv = multilineBody
    ? ['pr', 'create', '--draft', '--title', resolved.title, '--body-file', '-']
    : buildAutoPrArgs({ title: resolved.title, body: resolved.body })

  if (input.dryRun === true) {
    return {
      dryRun: true as const,
      argv,
      title: resolved.title,
      body: resolved.body,
      titleSource: resolved.titleSource,
      bodySource: resolved.bodySource,
      branch,
      dirty,
      aheadCommits,
    }
  }

  // Commit-if-needed: only files already in the worktree cwd (guard 4 proved
  // cwd IS the repo top-level, so `git add -A` cannot reach across the repo
  // root into anything else). Never `commit -a` from anywhere else.
  if (dirty) {
    const add = await exec('git', ['add', '-A'], { cwd })
    if (add.code !== 0) abort(`git add failed (exit ${add.code})`)
    const commit = await exec('git', ['commit', '-m', resolved.title], { cwd })
    if (commit.code !== 0) {
      abort(
        `git commit failed (exit ${commit.code}): ${commit.stderr.trim().slice(0, 300)}`,
      )
    }
  }

  const push = await exec('git', ['push', '-u', 'origin', branch], { cwd })
  if (push.code !== 0) {
    abort(
      `git push failed (exit ${push.code}): ${push.stderr.trim().slice(0, 300)}`,
    )
  }

  const create = await exec('gh', argv, {
    cwd,
    ...(multilineBody ? { input: resolved.body } : {}),
  })
  if (create.code !== 0) {
    abort(
      `gh pr create failed (exit ${create.code}): ${create.stderr.trim().slice(0, 300)}`,
    )
  }
  const urlMatch = create.stdout.match(/https?:\/\/\S+/)
  if (!urlMatch) abort('gh pr create succeeded but printed no PR URL')
  return { prUrl: urlMatch[0] }
}

async function readStdoutTail(logPath: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(logPath, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - AUTO_PR_STDOUT_TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(size, AUTO_PR_STDOUT_TAIL_BYTES))
    await handle.read(buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function appendLogLine(logPath: string, line: string): Promise<void> {
  try {
    await appendFile(logPath, `${line}\n`, 'utf8')
  } catch {
    // Log appends are best-effort; the session record is authoritative.
  }
}

export type AutoPrSessionRunnerDeps = {
  runAutoPr?: typeof runAutoPr
  recordResult?: (
    id: string,
    result: { prUrl?: string; prError?: string },
  ) => Promise<unknown>
  readStdoutTail?: (logPath: string) => Promise<string | undefined>
  appendLogLine?: (logPath: string, line: string) => Promise<void>
}

/**
 * Finalizer auto-PR hook: exit-0 + opted-in + worktree only. Every other
 * terminal (failed/killed/stale, non-zero, non-worktree, not opted-in) is a
 * no-op. Failures are stored as `prError` (plus a log line) and never flip
 * session status; this function never throws.
 */
export async function maybeRunAutoPrForSession(
  session: BackgroundSession,
  deps: AutoPrSessionRunnerDeps = {},
): Promise<void> {
  try {
    if (
      !(
        session.status === 'exited' &&
        session.exitCode === 0 &&
        session.autoPR?.enabled === true &&
        session.worktreePath
      )
    ) {
      return
    }
    const run = deps.runAutoPr ?? runAutoPr
    const record = deps.recordResult ?? recordBackgroundSessionAutoPrResult
    const readTail = deps.readStdoutTail ?? readStdoutTail
    const appendLine = deps.appendLogLine ?? appendLogLine

    let stdoutTail: string | undefined
    try {
      stdoutTail = session.stdoutLogPath
        ? await readTail(session.stdoutLogPath)
        : undefined
    } catch {
      stdoutTail = undefined
    }

    const result = await run(
      {
        cwd: session.worktreePath,
        sessionId: session.id,
        ...(session.name ? { sessionName: session.name } : {}),
        ...(session.worktreeBranch
          ? { worktreeBranch: session.worktreeBranch }
          : {}),
        ...(session.autoPR.title ? { title: session.autoPR.title } : {}),
        ...(session.autoPR.dryRun === true ? { dryRun: true as const } : {}),
        ...(stdoutTail !== undefined ? { stdoutTail } : {}),
      },
      {},
    )
    if ('dryRun' in result) {
      // Lengths + source only: never log the body itself in debug paths.
      // The exact argv (what would execute) goes to the session log.
      if (session.stdoutLogPath) {
        await appendLine(
          session.stdoutLogPath,
          `auto-PR dry-run: ${result.argv.join(' ')} (title from ${result.titleSource}, ${result.title.length} chars; body from ${result.bodySource}, ${result.body.length} chars; branch ${result.branch})`,
        )
      }
      return
    }
    await record(session.id, { prUrl: result.prUrl })
    if (session.stdoutLogPath) {
      await appendLine(
        session.stdoutLogPath,
        `auto-PR created draft PR: ${result.prUrl}`,
      )
    }
  } catch (error) {
    const message = errorMessage(error)
    try {
      const record = deps.recordResult ?? recordBackgroundSessionAutoPrResult
      await record(session.id, { prError: message })
      if (session.stdoutLogPath) {
        const appendLine = deps.appendLogLine ?? appendLogLine
        await appendLine(session.stdoutLogPath, `auto-PR failed: ${message}`)
      }
    } catch {
      // Recording the outcome must never break finalization.
    }
  }
}
