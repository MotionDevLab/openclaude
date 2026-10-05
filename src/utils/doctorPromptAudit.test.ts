import { describe, expect, test } from 'bun:test'
import {
  collectFailedFiles,
  collectPromptAuditFilesFromDir,
  findDuplicateParagraphs,
  findLegacyPatterns,
  findStaleCommandRefs,
  findStaleFilePaths,
  isRepoShapedRef,
  LEGACY_PROMPT_PATTERNS,
  PROMPT_AUDIT_DIR_MAX_DEPTH,
  PROMPT_AUDIT_DIR_MAX_FILES,
  renderPromptAuditReport,
  type PromptAuditFile,
  type PromptAuditFs,
  type PromptAuditResult,
} from './doctorPromptAudit.js'

function memFs(existing: string[]): PromptAuditFs {
  const known = new Set(existing)
  return { existsSync: (path: string) => known.has(path) }
}

function file(
  path: string,
  content: string,
  source = 'test',
): PromptAuditFile {
  return { path, content, source }
}

function emptyResult(overrides: Partial<PromptAuditResult> = {}): PromptAuditResult {
  return {
    filesScanned: 0,
    stalePaths: [],
    staleCommands: [],
    duplicates: [],
    legacy: [],
    failedFiles: [],
    ...overrides,
  }
}

describe('findStaleFilePaths', () => {
  test('flags @-includes that do not exist on disk', () => {
    const files = [
      file(
        '/proj/.openclaude/rules/main.md',
        'See @./backend.md for details.\nSee @./missing.md for more.',
      ),
    ]
    const fs = memFs(['/proj/.openclaude/rules/backend.md'])

    const findings = findStaleFilePaths(files, fs)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: '/proj/.openclaude/rules/main.md',
      line: 2,
      ref: '@./missing.md',
      resolved: '/proj/.openclaude/rules/missing.md',
    })
  })

  test('flags .md path references that do not exist', () => {
    const files = [
      file('/proj/rules/a.md', 'Read .openclaude/rules/gone.md when ready.'),
    ]

    const findings = findStaleFilePaths(files, memFs([]))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.ref).toBe('.openclaude/rules/gone.md')
  })

  test('ignores http(s) URLs ending in .md', () => {
    const files = [
      file(
        '/proj/rules/a.md',
        'See https://example.com/guide.md for upstream docs.',
      ),
    ]

    expect(findStaleFilePaths(files, memFs([]))).toEqual([])
  })

  test('strips trailing sentence punctuation from @-refs', () => {
    const files = [
      file(
        '/proj/rules/a.md',
        'See @./exists.md. Then read @./gone.md, finally @./other.md!',
      ),
    ]
    const fs = memFs(['/proj/rules/exists.md'])

    const findings = findStaleFilePaths(files, fs)

    expect(findings).toHaveLength(2)
    expect(findings.map(finding => finding.ref)).toEqual([
      '@./gone.md',
      '@./other.md',
    ])
    expect(findings[0]).toMatchObject({
      file: '/proj/rules/a.md',
      line: 1,
      resolved: '/proj/rules/gone.md',
    })
  })

  test('skips repo-shaped @-refs like @owner/repo prose', () => {
    const files = [
      file(
        '/proj/rules/a.md',
        'See @owner/repo for upstream.\nRead @owner/repo/sub/path here.\nModel @openai/gpt-4 is used.',
      ),
    ]

    expect(findStaleFilePaths(files, memFs([]))).toEqual([])
  })

  test('keeps true-positive @-refs that are not repo-shaped', () => {
    const cases = [
      '@./missing.md',
      '@/abs/x',
      '@~/x',
      '@a/b.md',
      '@Makefile',
      '@user',
    ]
    for (const ref of cases) {
      const files = [file('/proj/rules/a.md', `See ${ref} here.`)]
      const findings = findStaleFilePaths(files, memFs([]))
      expect(findings.map(finding => finding.ref)).toContain(ref)
    }
  })

  test('flags only the true positive when repo prose shares a doc with a missing ref', () => {
    const files = [
      file(
        '/proj/rules/a.md',
        'See @owner/repo for upstream.\nSee @./missing.md for details.',
      ),
    ]

    const findings = findStaleFilePaths(files, memFs([]))

    expect(findings.map(finding => finding.ref)).toEqual(['@./missing.md'])
  })
})

describe('isRepoShapedRef', () => {
  test.each([
    ['owner/repo', true],
    ['owner/repo/sub/path', true],
    ['openai/gpt-4', true],
    ['./missing.md', false],
    ['/abs/x', false],
    ['~/x', false],
    ['a/b.md', false],
    ['owner/repo/file.md', false],
    ['Makefile', false],
    ['user', false],
  ])('isRepoShapedRef(%s) is %s', (ref, expected) => {
    expect(isRepoShapedRef(ref)).toBe(expected)
  })
})

describe('findStaleCommandRefs', () => {
  test('flags slash references that match no known command', () => {
    const files = [file('/proj/cmd.md', 'Run /ghost-cmd to deploy.')]
    const known = new Set(['doctor', 'commit'])

    const findings = findStaleCommandRefs(files, known)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: '/proj/cmd.md',
      line: 1,
      command: 'ghost-cmd',
    })
  })

  test('accepts known commands regardless of case', () => {
    const files = [file('/proj/cmd.md', 'Run /Doctor to diagnose.')]
    const known = new Set(['doctor'])

    expect(findStaleCommandRefs(files, known)).toEqual([])
  })

  test('ignores prose, paths, and URLs that merely contain slashes', () => {
    const lines = [
      'Choose this and/or that option.',
      'Traffic runs over TCP/IP here.',
      'Use /usr/bin/env to launch.',
      'See https://example.com/a/b for details.',
      'The tool /usr/local/bin/helper is installed.',
    ]
    const files = [file('/proj/prose.md', lines.join('\n'))]
    const known = new Set(['doctor'])

    expect(findStaleCommandRefs(files, known)).toEqual([])
  })
})

describe('findDuplicateParagraphs', () => {
  const shared = `The deploy checklist requires a green build, a passing smoke run, and an explicit owner on call before anything ships to production systems.`
  const sharedReworded = `  the DEPLOY checklist requires   a green build, a passing smoke run, and an explicit owner on call before anything ships to production systems.  `

  test('flags a normalized block shared by two files', () => {
    const files = [
      file('/proj/a.md', `# A\n\n${shared}\n\nUnique tail one.`),
      file('/proj/b.md', `# B\n\n${sharedReworded}\n\nUnique tail two.`),
    ]

    const findings = findDuplicateParagraphs(files)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.occurrences).toBe(2)
    expect(findings[0]?.files).toEqual(['/proj/a.md', '/proj/b.md'])
  })

  test('ignores short shared blocks below the min-length gate', () => {
    const files = [
      file('/proj/a.md', 'Shared intro line here.\n\nBody one.'),
      file('/proj/b.md', 'Shared intro line here.\n\nBody two.'),
    ]

    expect(findDuplicateParagraphs(files)).toEqual([])
  })
})

describe('findLegacyPatterns', () => {
  test('exposes a single explicit pattern list', () => {
    expect(LEGACY_PROMPT_PATTERNS.length).toBe(3)
    expect(LEGACY_PROMPT_PATTERNS.map(entry => entry.id)).toEqual([
      'legacy-variable',
      'legacy-config-dir',
      'legacy-env-prefix',
    ])
  })

  test('flags legacy tokens, dirs, and env prefixes with line numbers', () => {
    const files = [
      file(
        '/proj/skill.md',
        'Set {$project} here.\nRead .claude/old.json next.\nExport CLAUDE_CODE_FOO=1.',
      ),
    ]

    const findings = findLegacyPatterns(files)

    expect(findings).toHaveLength(3)
    expect(findings.map(finding => finding.patternId)).toEqual([
      'legacy-variable',
      'legacy-config-dir',
      'legacy-env-prefix',
    ])
    expect(findings.map(finding => finding.line)).toEqual([1, 2, 3])
    for (const finding of findings) {
      expect(finding.suggestion.length).toBeGreaterThan(0)
    }
  })

  test('returns nothing for clean content', () => {
    const files = [
      file(
        '/proj/clean.md',
        'Use {{ project }} and .openclaude/rules/a.md with OPENCLAUDE_FOO=1.',
      ),
    ]

    expect(findLegacyPatterns(files)).toEqual([])
  })
})

describe('collectFailedFiles', () => {
  test('combines agent failures and oversized skips', () => {
    const findings = collectFailedFiles(
      [{ path: '/proj/agents/broken.md', error: 'missing name' }],
      [{ filePath: '/proj/skills/big/SKILL.md', sizeBytes: 300000, maxBytes: 262144 }],
    )

    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ path: '/proj/agents/broken.md' })
    expect(findings[1]).toMatchObject({ path: '/proj/skills/big/SKILL.md' })
  })

  test('returns empty when nothing failed', () => {
    expect(collectFailedFiles([], [])).toEqual([])
    expect(collectFailedFiles(undefined, undefined)).toEqual([])
  })
})

describe('renderPromptAuditReport', () => {
  test('reports a clean scan', () => {
    const report = renderPromptAuditReport(emptyResult({ filesScanned: 4 }))

    expect(report).toContain('4 file(s) scanned')
    expect(report).toContain('no issues found')
  })

  test('caps each category with a "+N more" overflow line', () => {
    const stalePaths = Array.from({ length: 25 }, (_, index) => ({
      file: `/proj/f${index}.md`,
      line: 1,
      ref: '@./missing.md',
      resolved: `/proj/missing-${index}.md`,
    }))
    const report = renderPromptAuditReport(
      emptyResult({ filesScanned: 25, stalePaths }),
    )

    expect(report).toContain('Stale file paths (25)')
    const section = report.split('Stale file paths')[1]?.split('##')[0] ?? ''
    const itemLines = section.split('\n').filter(line => line.startsWith('  - '))
    expect(itemLines).toHaveLength(20)
    expect(section).toContain('+ 5 more')
  })

  test('empty scan renders an honest empty message, never "no issues found"', () => {
    const report = renderPromptAuditReport(emptyResult({ filesScanned: 0 }), 'docs')

    expect(report).toContain('no prompt files found')
    expect(report).toContain('"docs"')
    expect(report).toContain('Nothing was audited')
    expect(report).not.toContain('no issues found')
  })

  test('truncated walk appends an overflow note with the file cap', () => {
    const report = renderPromptAuditReport(
      emptyResult({ filesScanned: PROMPT_AUDIT_DIR_MAX_FILES, truncated: true }),
      'docs',
    )

    expect(report).toContain(`${PROMPT_AUDIT_DIR_MAX_FILES}`)
  })
})

function dirEntry(
  name: string,
  kind: 'file' | 'dir' | 'symlink-dir' = 'file',
): { name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean } {
  return {
    name,
    isDirectory: () => kind === 'dir' || kind === 'symlink-dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink-dir',
  }
}

function fakeDirFs(tree: Record<string, Array<{ name: string; kind?: 'file' | 'dir' | 'symlink-dir' }>>, contents: Record<string, string>, unreadable: string[] = []): PromptAuditFs {
  return {
    existsSync: () => true,
    readdir: async (dir: string) => {
      const entries = tree[dir.replace(/\\/g, '/')]
      if (!entries) throw new Error(`ENOENT: ${dir}`)
      return entries.map(e => dirEntry(e.name, e.kind ?? 'file'))
    },
    readFile: async (path: string) => {
      const key = path.replace(/\\/g, '/')
      if (unreadable.includes(key)) throw new Error('EACCES: permission denied')
      const content = contents[key]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
  }
}

describe('collectPromptAuditFilesFromDir', () => {
  test('finds nested .md files case-insensitively and ignores non-md', async () => {
    const fs = fakeDirFs(
      {
        '/root': [
          { name: 'a.md', kind: 'file' },
          { name: 'b.MD', kind: 'file' },
          { name: 'notes.txt', kind: 'file' },
          { name: 'sub', kind: 'dir' },
        ],
        '/root/sub': [{ name: 'c.Markdown', kind: 'file' }, { name: 'd.md', kind: 'file' }],
      },
      {
        '/root/a.md': '# A',
        '/root/b.MD': '# B',
        '/root/sub/c.Markdown': '# C (not .md, ignored)',
        '/root/sub/d.md': '# D',
      },
    )

    const collected = await collectPromptAuditFilesFromDir('/root', fs)
    const paths = collected.files.map(f => f.path.replace(/\\/g, '/')).sort()

    expect(paths).toEqual(['/root/a.md', '/root/b.MD', '/root/sub/d.md'])
    for (const entry of collected.files) {
      expect(entry.source).toBe('dir')
    }
    expect(collected.failedFiles).toEqual([])
    expect(collected.truncated).toBe(false)
  })

  test('skips hidden dirs, node_modules, and .git', async () => {
    const fs = fakeDirFs(
      {
        '/root': [
          { name: 'keep.md', kind: 'file' },
          { name: '.hidden', kind: 'dir' },
          { name: 'node_modules', kind: 'dir' },
          { name: '.git', kind: 'dir' },
        ],
        '/root/.hidden': [{ name: 'secret.md', kind: 'file' }],
        '/root/node_modules': [{ name: 'pkg.md', kind: 'file' }],
        '/root/.git': [{ name: 'objects.md', kind: 'file' }],
      },
      { '/root/keep.md': '# keep' },
    )

    const collected = await collectPromptAuditFilesFromDir('/root', fs)

    expect(collected.files.map(f => f.path.replace(/\\/g, '/'))).toEqual(['/root/keep.md'])
  })

  test('records unreadable files as failedFiles instead of throwing', async () => {
    const fs = fakeDirFs(
      { '/root': [{ name: 'good.md', kind: 'file' }, { name: 'bad.md', kind: 'file' }] },
      { '/root/good.md': '# ok' },
      ['/root/bad.md'],
    )

    const collected = await collectPromptAuditFilesFromDir('/root', fs)

    expect(collected.files.map(f => f.path.replace(/\\/g, '/'))).toEqual(['/root/good.md'])
    expect(collected.failedFiles).toHaveLength(1)
    expect(collected.failedFiles[0]?.path.replace(/\\/g, '/')).toBe('/root/bad.md')
    expect(collected.failedFiles[0]?.reason.length ?? 0).toBeGreaterThan(0)
  })

  test('honors the named file cap and marks the walk truncated', async () => {
    const names = Array.from({ length: PROMPT_AUDIT_DIR_MAX_FILES + 5 }, (_, i) => ({
      name: `f${i}.md`,
      kind: 'file' as const,
    }))
    const contents: Record<string, string> = {}
    for (const entry of names) contents[`/root/${entry.name}`] = '# x'
    const fs = fakeDirFs({ '/root': names }, contents)

    const collected = await collectPromptAuditFilesFromDir('/root', fs)

    expect(collected.files).toHaveLength(PROMPT_AUDIT_DIR_MAX_FILES)
    expect(collected.truncated).toBe(true)
  })

  test('does not follow symlinked dirs so cycles terminate', async () => {
    const fs = fakeDirFs(
      {
        '/root': [
          { name: 'top.md', kind: 'file' },
          { name: 'loop', kind: 'symlink-dir' },
        ],
        '/root/loop': [
          { name: 'inner.md', kind: 'file' },
          { name: 'loop', kind: 'symlink-dir' },
        ],
      },
      { '/root/top.md': '# top', '/root/loop/inner.md': '# inner' },
    )

    const collected = await collectPromptAuditFilesFromDir('/root', fs)

    expect(collected.files.length).toBeLessThanOrEqual(PROMPT_AUDIT_DIR_MAX_FILES)
    expect(collected.files.map(f => f.path.replace(/\\/g, '/'))).toContain('/root/top.md')
  })

  test('stops descending beyond the max depth', async () => {
    const tree: Record<string, Array<{ name: string; kind?: 'file' | 'dir' | 'symlink-dir' }>> = {}
    const contents: Record<string, string> = { '/root/top.md': '# top' }
    tree['/root'] = [{ name: 'top.md', kind: 'file' }]
    let dir = '/root'
    for (let i = 0; i <= PROMPT_AUDIT_DIR_MAX_DEPTH + 5; i++) {
      const child = `d${i}`
      tree[dir]?.push({ name: child, kind: 'dir' })
      dir = `${dir}/${child}`
      tree[dir] = []
      if (i === 5) {
        tree[dir]?.push({ name: 'shallow.md', kind: 'file' })
        contents[`${dir}/shallow.md`] = '# shallow'
      }
    }
    tree[dir]?.push({ name: 'deep.md', kind: 'file' })
    contents[`${dir}/deep.md`] = '# deep'
    const fs = fakeDirFs(tree, contents)

    const collected = await collectPromptAuditFilesFromDir('/root', fs)
    const paths = collected.files.map(f => f.path.replace(/\\/g, '/'))

    expect(paths).toContain('/root/top.md')
    expect(paths).toContain('/root/d0/d1/d2/d3/d4/d5/shallow.md')
    expect(paths).not.toContain(`${dir}/deep.md`)
  })
})
