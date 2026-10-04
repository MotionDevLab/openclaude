import { existsSync as nodeExistsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, normalize } from 'path'
import { getCommands } from '../commands.js'
import { getSkillDirCommands } from '../skills/loadSkillsDir.js'
import { getAgentDefinitionsWithOverrides } from '../tools/AgentTool/loadAgentsDir.js'
import { getMemoryFiles } from './claudemd.js'
import {
  getOversizedMarkdownSkips,
  loadMarkdownFilesForSubdir,
} from './markdownConfigLoader.js'

export type PromptAuditFile = {
  path: string
  content: string
  source: string
}

export type PromptAuditFs = {
  existsSync: (path: string) => boolean
}

export type StalePathFinding = {
  file: string
  line: number
  ref: string
  resolved: string
}

export type StaleCommandFinding = {
  file: string
  line: number
  command: string
}

export type DuplicateBlockFinding = {
  files: string[]
  preview: string
  occurrences: number
}

export type LegacyPatternFinding = {
  file: string
  line: number
  patternId: string
  match: string
  suggestion: string
}

export type FailedFileFinding = {
  path: string
  reason: string
}

export type PromptAuditResult = {
  filesScanned: number
  stalePaths: StalePathFinding[]
  staleCommands: StaleCommandFinding[]
  duplicates: DuplicateBlockFinding[]
  legacy: LegacyPatternFinding[]
  failedFiles: FailedFileFinding[]
}

/**
 * The single explicit list of legacy prompt patterns. Add new entries here
 * rather than scattering ad-hoc regexes through the detectors.
 */
export const LEGACY_PROMPT_PATTERNS = [
  {
    id: 'legacy-variable',
    source: String.raw`\{\$[A-Za-z0-9_]+\}`,
    suggestion: 'Replace {$name} with {{ name }} or $ARGUMENTS.',
  },
  {
    id: 'legacy-config-dir',
    source: String.raw`\.claude/`,
    suggestion: 'Use .openclaude/ instead of .claude/ for project config paths.',
  },
  {
    id: 'legacy-env-prefix',
    source: 'CLAUDE_CODE_',
    suggestion: 'Use the OPENCLAUDE_ prefix instead of CLAUDE_CODE_.',
  },
] as const

const AT_REF_PATTERN = /(^|[\s"'`(\[{])@([^\s"'`()[\]{}]+)/g
const MD_REF_PATTERN = /([\w\-.~/]+\.md)\b/g
const COMMAND_REF_PATTERN = /(^|[\s"'`(\[{])\/([a-z][a-z0-9_-]{1,})/g
const URL_PATTERN = /https?:\/\/\S+/g

const DUPLICATE_MIN_CHARS = 80
const DUPLICATE_PREVIEW_CHARS = 120

const REPORT_MAX_PER_CATEGORY = 20

function toDisplayPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function resolvePromptRef(ref: string, fromFile: string): string {
  const bare = ref.startsWith('@') ? ref.slice(1) : ref
  if (bare.startsWith('~/')) {
    return toDisplayPath(normalize(join(homedir(), bare.slice(2))))
  }
  if (bare.startsWith('/')) {
    return toDisplayPath(normalize(bare))
  }
  return toDisplayPath(normalize(join(dirname(fromFile), bare)))
}

function isUrlRef(ref: string): boolean {
  return /^https?:\/\//.test(ref)
}

/**
 * Conservative gate for `@`-refs shaped like repo paths (`@owner/repo`).
 * Skips refs with a slash but no dot and no path prefix — prose mentions
 * of GitHub paths and model refs (`@openai/gpt-4`). Single-token refs
 * (`@Makefile`, `@user`) keep today's behavior.
 */
export function isRepoShapedRef(ref: string): boolean {
  return (
    ref.includes('/') && !ref.includes('.') && !/^(\.\/|\.\.\/|~\/|\/)/.test(ref)
  )
}

/**
 * Finds @-includes and .md path references that do not exist on disk.
 * Conservative: URLs are stripped before scanning, and .md matches that are
 * part of an @-ref on the same line are reported once (as the @-ref).
 */
export function findStaleFilePaths(
  files: PromptAuditFile[],
  fs: PromptAuditFs,
): StalePathFinding[] {
  const findings: StalePathFinding[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const lines = file.content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      const atSpans: Array<{ start: number; end: number }> = []

      for (const match of line.matchAll(AT_REF_PATTERN)) {
        const rawRef = match[2] ?? ''
        // Trailing sentence punctuation is prose, not path: `See @./a.md.`
        // must resolve `./a.md`, not `./a.md.`. The `.md` pattern below is
        // already safe via its trailing word boundary.
        const ref = rawRef.replace(/[.,;:!?)]+$/, '')
        if (!ref || isUrlRef(ref)) continue
        if (isRepoShapedRef(ref)) continue
        const fullRef = `@${ref}`
        const resolved = resolvePromptRef(fullRef, file.path)
        atSpans.push({
          start: (match.index ?? 0) + match[0].length - fullRef.length,
          end: (match.index ?? 0) + match[0].length,
        })
        const key = `${file.path}:${index + 1}:${fullRef}`
        if (!seen.has(key) && !fs.existsSync(resolved)) {
          seen.add(key)
          findings.push({
            file: file.path,
            line: index + 1,
            ref: fullRef,
            resolved,
          })
        }
      }

      const searchable = line.replace(URL_PATTERN, match => ' '.repeat(match.length))
      for (const match of searchable.matchAll(MD_REF_PATTERN)) {
        const ref = match[1] ?? ''
        if (!ref) continue
        const start = match.index ?? 0
        // Skip .md matches that belong to an @-ref reported above.
        if (atSpans.some(span => start >= span.start - 1 && start < span.end)) {
          continue
        }
        const resolved = resolvePromptRef(ref, file.path)
        const key = `${file.path}:${index + 1}:${ref}`
        if (!seen.has(key) && !fs.existsSync(resolved)) {
          seen.add(key)
          findings.push({ file: file.path, line: index + 1, ref, resolved })
        }
      }
    }
  }

  return findings
}

/**
 * Finds /command references that match no known command. Conservative:
 * candidates must start at a token boundary (whitespace, quote, paren, or
 * bracket), start lowercase, be at least 2 chars, and not be followed by `/`
 * — so `and/or`, `TCP/IP`, `/usr/bin`, and URLs yield zero findings.
 */
export function findStaleCommandRefs(
  files: PromptAuditFile[],
  knownCommands: Set<string> | string[],
): StaleCommandFinding[] {
  const known = new Set(
    (knownCommands instanceof Set ? [...knownCommands] : knownCommands).map(name =>
      name.toLowerCase(),
    ),
  )
  const findings: StaleCommandFinding[] = []

  for (const file of files) {
    const lines = file.content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = (lines[index] ?? '').replace(URL_PATTERN, '')
      for (const match of line.matchAll(COMMAND_REF_PATTERN)) {
        const command = match[2] ?? ''
        if (!command) continue
        const after = line[(match.index ?? 0) + match[0].length]
        if (after === '/') continue
        if (!known.has(command.toLowerCase())) {
          findings.push({ file: file.path, line: index + 1, command })
        }
      }
    }
  }

  return findings
}

function normalizeBlock(block: string): string {
  return block.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Finds normalized-paragraph blocks (blank-line separated, whitespace
 * collapsed, case folded) that appear in more than one file. Blocks shorter
 * than DUPLICATE_MIN_CHARS and fenced code blocks are ignored.
 */
export function findDuplicateParagraphs(
  files: PromptAuditFile[],
  minLength: number = DUPLICATE_MIN_CHARS,
): DuplicateBlockFinding[] {
  const groups = new Map<string, { preview: string; files: Set<string> }>()

  for (const file of files) {
    for (const block of file.content.split(/\n\s*\n/)) {
      if (block.includes('```')) continue
      const normalized = normalizeBlock(block)
      if (normalized.length < minLength) continue
      const collapsed = block.trim().replace(/\s+/g, ' ')
      const existing = groups.get(normalized)
      if (existing) {
        existing.files.add(file.path)
      } else {
        groups.set(normalized, {
          preview:
            collapsed.length > DUPLICATE_PREVIEW_CHARS
              ? `${collapsed.slice(0, DUPLICATE_PREVIEW_CHARS)}…`
              : collapsed,
          files: new Set([file.path]),
        })
      }
    }
  }

  const findings: DuplicateBlockFinding[] = []
  for (const group of groups.values()) {
    if (group.files.size > 1) {
      const sorted = [...group.files].sort()
      findings.push({
        files: sorted,
        preview: group.preview,
        occurrences: sorted.length,
      })
    }
  }
  findings.sort((a, b) => b.occurrences - a.occurrences)

  return findings
}

/** Scans every line against the single LEGACY_PROMPT_PATTERNS list. */
export function findLegacyPatterns(
  files: PromptAuditFile[],
): LegacyPatternFinding[] {
  const findings: LegacyPatternFinding[] = []

  for (const file of files) {
    const lines = file.content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      for (const entry of LEGACY_PROMPT_PATTERNS) {
        const pattern = new RegExp(entry.source, 'g')
        for (const match of line.matchAll(pattern)) {
          findings.push({
            file: file.path,
            line: index + 1,
            patternId: entry.id,
            match: match[0] ?? '',
            suggestion: entry.suggestion,
          })
        }
      }
    }
  }

  return findings
}

/** Combines agent parse failures and oversized-markdown skips. */
export function collectFailedFiles(
  agentFailedFiles:
    | Array<{ path: string; error: string }>
    | undefined,
  oversizedSkips:
    | Array<{ filePath: string; sizeBytes: number; maxBytes: number }>
    | undefined,
): FailedFileFinding[] {
  const findings: FailedFileFinding[] = []
  for (const failure of agentFailedFiles ?? []) {
    findings.push({ path: failure.path, reason: failure.error })
  }
  for (const skip of oversizedSkips ?? []) {
    findings.push({
      path: skip.filePath,
      reason: `oversized (${skip.sizeBytes} bytes > ${skip.maxBytes} max)`,
    })
  }
  return findings
}

export type PromptAuditLoaderDeps = {
  getMemoryFiles: () => Promise<
    Array<{ path: string; content: string; rawContent?: string }>
  >
  loadMarkdownFilesForSubdir: (
    subdir: 'commands' | 'agents' | 'skills',
    cwd: string,
  ) => Promise<Array<{ filePath: string; content: string }>>
  getAgentDefinitionsWithOverrides: (
    cwd: string,
  ) => Promise<{ failedFiles?: Array<{ path: string; error: string }> }>
  getCommands: (cwd: string) => Promise<Array<{ name: string }>>
  getSkillDirCommands: (cwd: string) => Promise<Array<{ name: string }>>
  getOversizedMarkdownSkips: () => Array<{
    filePath: string
    sizeBytes: number
    maxBytes: number
  }>
}

export const defaultPromptAuditLoaderDeps: PromptAuditLoaderDeps = {
  getMemoryFiles,
  loadMarkdownFilesForSubdir,
  getAgentDefinitionsWithOverrides,
  getCommands,
  getSkillDirCommands,
  getOversizedMarkdownSkips,
}

export type CollectedPromptAudit = {
  files: PromptAuditFile[]
  failedFiles: FailedFileFinding[]
  knownCommandNames: string[]
}

/** Gathers prompt-bearing files through the existing loaders. */
export async function collectPromptAuditFiles(
  cwd: string,
  deps: PromptAuditLoaderDeps = defaultPromptAuditLoaderDeps,
): Promise<CollectedPromptAudit> {
  const [
    memoryFiles,
    commandFiles,
    agentFiles,
    skillFiles,
    agentDefs,
    commands,
    skillCommands,
    oversized,
  ] = await Promise.all([
    deps.getMemoryFiles(),
    deps.loadMarkdownFilesForSubdir('commands', cwd),
    deps.loadMarkdownFilesForSubdir('agents', cwd),
    deps.loadMarkdownFilesForSubdir('skills', cwd),
    deps.getAgentDefinitionsWithOverrides(cwd),
    deps.getCommands(cwd),
    deps.getSkillDirCommands(cwd),
    Promise.resolve(deps.getOversizedMarkdownSkips()),
  ])

  const files: PromptAuditFile[] = [
    ...memoryFiles.map(entry => ({
      path: entry.path,
      content: entry.rawContent ?? entry.content,
      source: 'memory',
    })),
    ...commandFiles.map(entry => ({
      path: entry.filePath,
      content: entry.content,
      source: 'command',
    })),
    ...agentFiles.map(entry => ({
      path: entry.filePath,
      content: entry.content,
      source: 'agent',
    })),
    ...skillFiles.map(entry => ({
      path: entry.filePath,
      content: entry.content,
      source: 'skill',
    })),
  ]

  const knownCommandNames = new Set<string>()
  for (const command of [...commands, ...skillCommands]) {
    knownCommandNames.add(command.name.toLowerCase())
  }

  return {
    files,
    failedFiles: collectFailedFiles(agentDefs.failedFiles, oversized),
    knownCommandNames: [...knownCommandNames],
  }
}

function renderSection<T>(
  title: string,
  items: T[],
  renderItem: (item: T) => string,
  maxItems: number = REPORT_MAX_PER_CATEGORY,
): string {
  const lines = [`## ${title} (${items.length})`]
  for (const item of items.slice(0, maxItems)) {
    lines.push(`  - ${renderItem(item)}`)
  }
  if (items.length > maxItems) {
    lines.push(`  + ${items.length - maxItems} more`)
  }
  return lines.join('\n')
}

/** Renders a capped plain-text report (per-category cap + overflow lines). */
export function renderPromptAuditReport(result: PromptAuditResult): string {
  const total =
    result.stalePaths.length +
    result.staleCommands.length +
    result.duplicates.length +
    result.legacy.length +
    result.failedFiles.length
  const header = `Prompt audit: ${result.filesScanned} file(s) scanned, `
  if (total === 0) {
    return `${header}no issues found.`
  }

  return [
    `${header}${total} issue(s) found.`,
    renderSection('Stale file paths', result.stalePaths, finding =>
      `${finding.file}:${finding.line}: ${finding.ref} -> ${finding.resolved} (not found)`,
    ),
    renderSection('Stale /command references', result.staleCommands, finding =>
      `${finding.file}:${finding.line}: /${finding.command} (no such command)`,
    ),
    renderSection('Duplicate blocks', result.duplicates, finding =>
      `${finding.occurrences} files: ${finding.files.join(', ')} — "${finding.preview}"`,
    ),
    renderSection('Legacy patterns', result.legacy, finding =>
      `${finding.file}:${finding.line}: [${finding.patternId}] ${finding.match} — ${finding.suggestion}`,
    ),
    renderSection('Files that failed to load', result.failedFiles, finding =>
      `${finding.path} — ${finding.reason}`,
    ),
  ].join('\n')
}

/**
 * Full audit: collect via existing loaders, run the five deterministic
 * detectors, render a capped report. `pathFilter` scopes files by substring.
 */
export async function runPromptAudit(
  cwd: string,
  pathFilter?: string,
  deps: PromptAuditLoaderDeps = defaultPromptAuditLoaderDeps,
  fs: PromptAuditFs = { existsSync: nodeExistsSync },
): Promise<string> {
  const collected = await collectPromptAuditFiles(cwd, deps)
  const scoped = pathFilter
    ? collected.files.filter(entry => entry.path.includes(pathFilter))
    : collected.files
  // The filter scopes failed files too: a scoped run must not report
  // unrelated load failures.
  const failedFiles = pathFilter
    ? collected.failedFiles.filter(entry => entry.path.includes(pathFilter))
    : collected.failedFiles
  return renderPromptAuditReport({
    filesScanned: scoped.length,
    stalePaths: findStaleFilePaths(scoped, fs),
    staleCommands: findStaleCommandRefs(scoped, collected.knownCommandNames),
    duplicates: findDuplicateParagraphs(scoped),
    legacy: findLegacyPatterns(scoped),
    failedFiles,
  })
}
