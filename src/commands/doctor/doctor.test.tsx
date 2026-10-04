import { afterEach, describe, expect, mock, test } from 'bun:test'
import { isValidElement } from 'react'
import {
  createDoctorCommandCall,
  runDoctorPromptAuditCommand,
  runDoctorReportCommand,
  splitDoctorArgs,
} from './doctor.js'

afterEach(() => {
  mock.restore()
})

describe('/doctor report', () => {
  test('emits report output when no outFile is provided', async () => {
    const options = {
      format: 'json' as const,
      outFile: null,
      includeDebug: false,
      redacted: true as const,
    }
    const parseIssueReportArgs = mock(() => options)
    const renderIssueReport = mock(async () => '# diagnostic report')
    const writeIssueReport = mock(() => '/tmp/openclaude-report.md')
    const onDone = mock(() => {})
    const result = await runDoctorReportCommand(['--json'], onDone, {
      parseIssueReportArgs,
      renderIssueReport,
      writeIssueReport,
    })

    expect(result).toBeNull()
    expect(parseIssueReportArgs).toHaveBeenCalledWith(['--json'])
    expect(renderIssueReport).toHaveBeenCalledWith(options)
    expect(writeIssueReport).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith('# diagnostic report', {
      display: 'system',
    })
  })

  test('writes report output when --out is provided', async () => {
    const options = {
      format: 'markdown' as const,
      outFile: 'report.md',
      includeDebug: false,
      redacted: true as const,
    }
    const parseIssueReportArgs = mock(() => options)
    const renderIssueReport = mock(async () => '# diagnostic report')
    const writeIssueReport = mock(() => '/tmp/openclaude-report.md')
    const onDone = mock(() => {})
    const result = await runDoctorReportCommand(
      ['--out', 'report.md'],
      onDone,
      {
        parseIssueReportArgs,
        renderIssueReport,
        writeIssueReport,
      },
    )

    expect(result).toBeNull()
    expect(parseIssueReportArgs).toHaveBeenCalledWith(['--out', 'report.md'])
    expect(renderIssueReport).toHaveBeenCalledWith(options)
    expect(writeIssueReport).toHaveBeenCalledWith('report.md', '# diagnostic report')
    expect(onDone).toHaveBeenCalledWith(
      'Diagnostic report written to /tmp/openclaude-report.md',
      { display: 'system' },
    )
  })

  test('routes report arguments through the slash command entrypoint', async () => {
    const options = {
      format: 'markdown' as const,
      outFile: null,
      includeDebug: true,
      redacted: true,
    }
    const parseIssueReportArgs = mock(() => options)
    const renderIssueReport = mock(async () => '# report')
    const writeIssueReport = mock(() => '/tmp/report.md')
    const call = createDoctorCommandCall({
      parseIssueReportArgs,
      renderIssueReport,
      writeIssueReport,
    })
    const onDone = mock(() => {})

    const result = await call(
      onDone as never,
      {} as never,
      'report --markdown --include-debug',
    )

    expect(result).toBeNull()
    expect(parseIssueReportArgs).toHaveBeenCalledWith([
      '--markdown',
      '--include-debug',
    ])
    expect(renderIssueReport).toHaveBeenCalledWith(options)
    expect(onDone).toHaveBeenCalledWith('# report', { display: 'system' })
  })

  test('falls back to the Doctor screen for non-report arguments', async () => {
    const parseIssueReportArgs = mock(() => ({
      format: 'markdown' as const,
      outFile: null,
      includeDebug: false,
      redacted: true,
    }))
    const call = createDoctorCommandCall({
      parseIssueReportArgs,
      renderIssueReport: mock(async () => '# report'),
      writeIssueReport: mock(() => '/tmp/report.md'),
    })
    const onDone = mock(() => {})

    const result = await call(onDone as never, {} as never, '')

    expect(isValidElement(result)).toBe(true)
    expect(parseIssueReportArgs).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('propagates report generation errors through the slash command promise', async () => {
    const call = createDoctorCommandCall({
      parseIssueReportArgs: mock(() => ({
        format: 'markdown' as const,
        outFile: null,
        includeDebug: false,
        redacted: true,
      })),
      renderIssueReport: mock(async () => {
        throw new Error('render failed')
      }),
      writeIssueReport: mock(() => '/tmp/report.md'),
    })

    await expect(call(mock(() => {}) as never, {} as never, 'report')).rejects.toThrow(
      'render failed',
    )
  })

  test('rejects unredacted report options in the slash command flow', async () => {
    const parseIssueReportArgs = mock(() => ({
      format: 'markdown' as const,
      outFile: null,
      includeDebug: false,
      redacted: false,
    }))
    const renderIssueReport = mock(async () => '# report')
    const writeIssueReport = mock(() => '/tmp/report.md')
    const call = createDoctorCommandCall({
      parseIssueReportArgs,
      renderIssueReport,
      writeIssueReport,
    })

    await expect(call(mock(() => {}) as never, {} as never, 'report')).rejects.toThrow(
      'Unredacted diagnostic reports are not supported',
    )
    expect(renderIssueReport).not.toHaveBeenCalled()
    expect(writeIssueReport).not.toHaveBeenCalled()
  })

  test('splits quoted report arguments without eating escaped quotes', () => {
    expect(
      splitDoctorArgs(`report --out "nested/report file.md" '--json-ish'`),
    ).toEqual(['report', '--out', 'nested/report file.md', '--json-ish'])
    expect(splitDoctorArgs(`report --out "a \\"quoted\\" file.md"`)).toEqual([
      'report',
      '--out',
      'a "quoted" file.md',
    ])
    expect(splitDoctorArgs(String.raw`report --out foo\ bar.md`)).toEqual([
      'report',
      '--out',
      'foo bar.md',
    ])
    expect(splitDoctorArgs(String.raw`report --out C:\Users\Alice\report.md`)).toEqual([
      'report',
      '--out',
      String.raw`C:\Users\Alice\report.md`,
    ])
  })
})

describe('/doctor prompt-audit', () => {
  const reportDependencies = () => ({
    parseIssueReportArgs: mock(() => ({
      format: 'markdown' as const,
      outFile: null,
      includeDebug: false,
      redacted: true as const,
    })),
    renderIssueReport: mock(async () => '# report'),
    writeIssueReport: mock(() => '/tmp/report.md'),
  })

  test('emits the audit report through onDone', async () => {
    const runPromptAudit = mock(async () => '# prompt audit')
    const onDone = mock(() => {})

    const result = await runDoctorPromptAuditCommand(['rules'], onDone, {
      runPromptAudit,
    })

    expect(result).toBeNull()
    expect(runPromptAudit).toHaveBeenCalledWith(process.cwd(), 'rules')
    expect(onDone).toHaveBeenCalledWith('# prompt audit', {
      display: 'system',
    })
  })

  test('passes no path filter when omitted', async () => {
    const runPromptAudit = mock(async () => '# prompt audit')

    await runDoctorPromptAuditCommand([], mock(() => {}), { runPromptAudit })

    expect(runPromptAudit).toHaveBeenCalledWith(process.cwd(), undefined)
  })

  test('routes prompt-audit arguments through the slash command entrypoint', async () => {
    const runPromptAudit = mock(async () => '# prompt audit')
    const call = createDoctorCommandCall(reportDependencies(), {
      runPromptAudit,
    })
    const onDone = mock(() => {})

    const result = await call(onDone as never, {} as never, 'prompt-audit rules')

    expect(result).toBeNull()
    expect(runPromptAudit).toHaveBeenCalledWith(process.cwd(), 'rules')
    expect(onDone).toHaveBeenCalledWith('# prompt audit', {
      display: 'system',
    })
  })

  test('still falls back to the Doctor screen for other arguments', async () => {
    const runPromptAudit = mock(async () => '# prompt audit')
    const call = createDoctorCommandCall(reportDependencies(), {
      runPromptAudit,
    })

    const result = await call(
      mock(() => {}) as never,
      {} as never,
      'prompt-audit-typo',
    )

    expect(isValidElement(result)).toBe(true)
    expect(runPromptAudit).not.toHaveBeenCalled()
  })
})
