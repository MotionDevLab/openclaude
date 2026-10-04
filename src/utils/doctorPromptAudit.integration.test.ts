import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runPromptAudit, type PromptAuditLoaderDeps } from './doctorPromptAudit.js'
import { clearAgentDefinitionsCache } from '../tools/AgentTool/loadAgentsDir.js'
import { clearSkillCaches } from '../skills/loadSkillsDir.js'
import { clearMemoryFileCaches } from './claudemd.js'
import { clearCommandsCache } from '../commands.js'
import { loadMarkdownFilesForSubdir } from './markdownConfigLoader.js'

const SHARED_PARAGRAPH = `The deploy checklist requires a green build, a passing smoke run, and an explicit owner on call before anything ships to production systems.`

async function makeTree(): Promise<{
  dir: string
  mainPath: string
  otherPath: string
  cmdPath: string
  brokenAgentPath: string
  bigSkillPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-audit-'))
  await mkdir(join(dir, 'rules'), { recursive: true })
  await mkdir(join(dir, 'commands'), { recursive: true })
  const mainPath = join(dir, 'rules', 'main.md')
  const otherPath = join(dir, 'rules', 'other.md')
  const cmdPath = join(dir, 'commands', 'ship.md')
  const brokenAgentPath = join(dir, 'agents', 'broken.md')
  const bigSkillPath = join(dir, 'skills', 'big', 'SKILL.md')
  await writeFile(
    mainPath,
    [
      '# Main rules',
      'See @./missing.md for details.',
      'Run /ghost-cmd to deploy.',
      'Set {$project} here and read .claude/old.json.',
      '',
      SHARED_PARAGRAPH,
      '',
    ].join('\n'),
  )
  await writeFile(
    otherPath,
    [
      '# Other',
      '',
      `  ${SHARED_PARAGRAPH.toUpperCase()}  `,
      '',
      'Export CLAUDE_CODE_FOO=1 for legacy env.',
      'See https://example.com/guide.md which is upstream.',
    ].join('\n'),
  )
  await writeFile(cmdPath, '# Ship\n\nRun /doctor after shipping.\n')
  return { dir, mainPath, otherPath, cmdPath, brokenAgentPath, bigSkillPath }
}

function fakeDeps(tree: {
  mainPath: string
  otherPath: string
  cmdPath: string
  brokenAgentPath: string
  bigSkillPath: string
}): PromptAuditLoaderDeps {
  return {
    getMemoryFiles: async () => [
      {
        path: tree.mainPath,
        content: await readFile(tree.mainPath, 'utf8'),
      },
      {
        path: tree.otherPath,
        content: await readFile(tree.otherPath, 'utf8'),
      },
    ],
    loadMarkdownFilesForSubdir: async subdir => {
      if (subdir !== 'commands') return []
      return [
        {
          filePath: tree.cmdPath,
          content: await readFile(tree.cmdPath, 'utf8'),
        },
      ]
    },
    getAgentDefinitionsWithOverrides: async () => ({
      failedFiles: [{ path: tree.brokenAgentPath, error: 'missing name' }],
    }),
    getCommands: async () => [{ name: 'doctor' }],
    getSkillDirCommands: async () => [],
    getOversizedMarkdownSkips: () => [
      { filePath: tree.bigSkillPath, sizeBytes: 300000, maxBytes: 262144 },
    ],
  }
}

afterEach(() => {
  loadMarkdownFilesForSubdir.cache.clear?.()
  clearAgentDefinitionsCache()
  clearSkillCaches()
  clearMemoryFileCaches()
  clearCommandsCache()
})

describe('prompt-audit temp-dir integration', () => {
  test('finds every category end to end without touching memoized loaders', async () => {
    const tree = await makeTree()
    const report = await runPromptAudit(tree.dir, undefined, fakeDeps(tree))

    expect(report).toContain('3 file(s) scanned')
    expect(report).toContain('ghost-cmd')
    expect(report).toContain('missing.md')
    expect(report).toContain('legacy-variable')
    expect(report).toContain('legacy-config-dir')
    expect(report).toContain('legacy-env-prefix')
    expect(report).toContain('Duplicate blocks')
    expect(report).toContain(tree.brokenAgentPath)
    expect(report).toContain(tree.bigSkillPath)
    // Upstream URL must not be reported as a stale local path.
    expect(report).not.toContain('example.com/guide.md')
    // Known command referenced from the command file stays quiet: the
    // stale-command section lists only the unknown reference.
    const staleSection =
      report.split('Stale /command references')[1]?.split('##')[0] ?? ''
    expect(staleSection).toContain('/ghost-cmd')
    expect(staleSection).not.toContain('/doctor')
    expect(
      staleSection.split('\n').filter(line => line.startsWith('  - ')),
    ).toHaveLength(1)
  })

  test('path filter scopes the scanned files', async () => {
    const tree = await makeTree()
    const report = await runPromptAudit(tree.dir, 'other', fakeDeps(tree))

    expect(report).toContain('1 file(s) scanned')
    expect(report).toContain(tree.otherPath)
    expect(report).not.toContain(tree.mainPath)
  })
})
