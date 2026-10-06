import {
  killHandler as defaultKillHandler,
  logsHandler as defaultLogsHandler,
  psHandler as defaultPsHandler,
} from '../../cli/bg.js'
import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

export const BG_HELP =
  'Manage background runs (alias /jobs). Spawn with: openclaude --bg "...".\n' +
  'Usage:\n' +
  '  /bg ps                          list background sessions\n' +
  '  /bg logs <id-or-name> [--stderr|--stdout]   show a session log\n' +
  '  /bg kill <id-or-name>           stop a session (verified PID only)\n' +
  '  /bg auto-pr [on|off|status]      show or toggle draft auto-PR opt-in for this project (off by default)'

export const BG_FOLLOW_HINT =
  'Live follow (-f/--follow) is not supported from the slash command. ' +
  'Use `openclaude logs <id-or-name> -f` in a terminal to follow output.'

type BgHandlers = {
  psHandler: (args: string[]) => Promise<void>
  logsHandler: (args: string[] | string | undefined) => Promise<void>
  killHandler: (
    args: string[] | string | undefined,
    options?: { retentionSettingsReady?: boolean },
  ) => Promise<void>
}

type BgSettings = {
  getProjectAutoPr: () => SettingsJson['autoPR'] | undefined
  updateProjectAutoPr: (next: NonNullable<SettingsJson['autoPR']>) => Error | null
  getProjectSettingsPath: () => string | undefined
}

export type BgCommandDeps = BgHandlers & BgSettings

function defaultDeps(): BgCommandDeps {
  return {
    psHandler: defaultPsHandler,
    logsHandler: defaultLogsHandler,
    killHandler: defaultKillHandler,
    getProjectAutoPr: () => getSettingsForSource('projectSettings')?.autoPR,
    updateProjectAutoPr: next => {
      const { error } = updateSettingsForSource('projectSettings', {
        autoPR: next,
      } as SettingsJson)
      return error
    },
    getProjectSettingsPath: () =>
      getSettingsFilePathForSource('projectSettings'),
  }
}

class BgProcessExit extends Error {
  exitCode?: number
  constructor(code?: number) {
    super(`process.exit(${code ?? ''})`)
    this.name = 'BgProcessExit'
    this.exitCode = code
  }
}

function appendChunk(current: string, chunk: unknown): string {
  if (typeof chunk === 'string') return current + chunk
  if (chunk instanceof Uint8Array) return current + Buffer.from(chunk).toString('utf8')
  return current + String(chunk)
}

async function captureHandlerOutput(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const origLog = console.log
  const origError = console.error
  const origStdoutWrite = process.stdout.write
  const origStderrWrite = process.stderr.write
  const origExit = process.exit
  let stdout = ''
  let stderr = ''
  let exitCode: number | undefined

  console.log = ((...args: unknown[]) => {
    stdout +=
      args
        .map(arg => (typeof arg === 'string' ? arg : String(arg)))
        .join(' ') + '\n'
  }) as typeof console.log
  console.error = ((...args: unknown[]) => {
    stderr +=
      args
        .map(arg => (typeof arg === 'string' ? arg : String(arg)))
        .join(' ') + '\n'
  }) as typeof console.error
  process.stdout.write = ((chunk: unknown, ..._rest: unknown[]) => {
    // Callbacks are intentionally dropped: capture is synchronous string
    // accumulation, so there is never an async flush to signal.
    stdout = appendChunk(stdout, chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stderr = appendChunk(stderr, chunk)
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: number) => {
    throw new BgProcessExit(code)
  }) as typeof process.exit

  try {
    await fn()
  } catch (error) {
    if (error instanceof BgProcessExit) {
      exitCode = error.exitCode
    } else {
      throw error
    }
  } finally {
    console.log = origLog
    console.error = origError
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    process.exit = origExit
  }
  return { stdout, stderr, exitCode }
}

function toText(value: string): LocalCommandResult {
  return { type: 'text', value }
}

function formatCaptured(captured: { stdout: string; stderr: string }): string {
  const out = captured.stdout.trimEnd()
  const err = captured.stderr.trimEnd()
  if (out && err) return `${out}\n${err}`
  return out || err || '(no output)'
}

async function runPs(deps: BgHandlers): Promise<LocalCommandResult> {
  try {
    const captured = await captureHandlerOutput(() => deps.psHandler([]))
    return toText(formatCaptured(captured))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toText(`Error: ${message}`)
  }
}

async function runLogs(
  deps: BgHandlers,
  rest: string[],
): Promise<LocalCommandResult> {
  if (rest.includes('-f') || rest.includes('--follow')) {
    return toText(BG_FOLLOW_HINT)
  }
  if (rest.length === 0) {
    return toText(`Usage: /bg logs <id-or-name> [--stderr|--stdout]\n\n${BG_HELP}`)
  }
  try {
    const captured = await captureHandlerOutput(() => deps.logsHandler(rest))
    // Non-zero exit from fail() is intentionally rendered as captured text
    // (the slash UX shows the handler's error output instead of throwing).
    return toText(formatCaptured(captured))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toText(`Error: ${message}`)
  }
}

async function runKill(
  deps: BgHandlers,
  rest: string[],
): Promise<LocalCommandResult> {
  if (rest.length === 0) {
    return toText(`Usage: /bg kill <id-or-name>\n\n${BG_HELP}`)
  }
  try {
    const captured = await captureHandlerOutput(() => deps.killHandler(rest))
    return toText(formatCaptured(captured))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toText(`Error: ${message}`)
  }
}

function describeAutoPrState(enabled: boolean): string {
  return enabled ? 'enabled' : 'disabled (default off)'
}

async function runAutoPr(
  deps: BgSettings,
  rest: string[],
  context: Parameters<LocalCommandCall>[1],
): Promise<LocalCommandResult> {
  const sub = (rest[0] ?? '').toLowerCase()
  const current = deps.getProjectAutoPr()
  const enabled = current?.enabled === true
  const settingsPath =
    deps.getProjectSettingsPath() ?? '.openclaude/settings.json'

  if (rest.length === 0 || sub === 'status') {
    return toText(
      `Draft auto-PR for this project is ${describeAutoPrState(enabled)}.\n` +
        `Project settings: ${settingsPath}\n` +
        'Usage: /bg auto-pr <on|off>',
    )
  }

  if (sub === 'on' || sub === 'off') {
    const next = { ...current, enabled: sub === 'on' }
    const error = deps.updateProjectAutoPr(next)
    if (error) {
      return toText(`Failed to update auto-PR setting: ${error.message}`)
    }
    try {
      const setAppState = (
        context as unknown as {
          setAppState?: (f: (prev: never) => never) => void
        }
      ).setAppState
      if (typeof setAppState === 'function') {
        setAppState((prev: never) => {
          const s = prev as unknown as {
            settings?: Record<string, unknown>
          }
          return {
            ...(s as object),
            settings: { ...(s.settings ?? {}), autoPR: next },
          } as never
        })
      }
    } catch {
      // App-state sync is best-effort and stays silent to the user (the
      // settings file write already succeeded), but leave a debug-log
      // breadcrumb so sync failures are still diagnosable.
      logForDebugging('bg auto-pr: setAppState sync failed (settings file write already succeeded)', {
        level: 'warn',
      })
    }
    const effective = next.enabled === true
    return toText(
      `Draft auto-PR for this project is now ${describeAutoPrState(effective)}.\n` +
        `Project settings: ${settingsPath}`,
    )
  }

  return toText(`Usage: /bg auto-pr <on|off>\n\n${BG_HELP}`)
}

export function splitBgArgs(args: string): string[] {
  const trimmed = args.trim()
  if (!trimmed) return []
  return trimmed.split(/\s+/).filter(Boolean)
}

export function createBgCommandCall(
  deps: Partial<BgCommandDeps> = {},
): LocalCommandCall {
  const resolved: BgCommandDeps = { ...defaultDeps(), ...deps }
  return async (args, context) => {
    const parts = splitBgArgs(args)
    const [subRaw, ...rest] = parts
    const sub = (subRaw ?? '').toLowerCase()
    switch (sub) {
      case '':
        return toText(BG_HELP)
      case 'ps':
        return runPs(resolved)
      case 'logs':
        return runLogs(resolved, rest)
      case 'kill':
        return runKill(resolved, rest)
      case 'auto-pr':
      case 'autopr':
      case 'auto_pr':
        // `autopr`/`auto_pr` are intentional hidden spelling conveniences
        // (kept out of the hint/help so the primary `auto-pr` contract stays
        // unambiguous); `status` is the documented query alias (see hint+help).
        return runAutoPr(resolved, rest, context)
      default:
        return toText(`Unknown /bg subcommand: ${subRaw}\n\n${BG_HELP}`)
    }
  }
}

export const call: LocalCommandCall = createBgCommandCall()
