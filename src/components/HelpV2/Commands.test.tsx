import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import type { Command } from '../../types/command.js'
import { renderToString } from '../../utils/staticRender.js'
import { Commands } from './Commands.js'

function localCommand({
  name,
  description,
  argumentHint,
  subcommands,
}: {
  name: string
  description: string
  argumentHint?: string
  subcommands?: Command['subcommands']
}): Command {
  return {
    type: 'local-jsx',
    name,
    description,
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(subcommands !== undefined ? { subcommands } : {}),
    isHidden: false,
    progressMessage: 'running',
    contentLength: 0,
    getPromptForCommand: async () => [],
  } as unknown as Command
}

describe('HelpV2 Commands argumentHint', () => {
  test('returns a valid element for a doctor-like command', () => {
    const commands = [
      localCommand({
        name: 'doctor',
        description: 'Diagnose and verify your OpenClaude installation',
        argumentHint: 'report [--json] | prompt-audit [path?]',
      }),
    ]

    const element = (
      <Commands
        commands={commands}
        maxHeight={30}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />
    )

    expect(isValidElement(element)).toBe(true)
  })

  test('parent row collapses hint to subcommand marker', async () => {
    const commands = [
      localCommand({
        name: 'doctor',
        description: 'Diagnose and verify your OpenClaude installation',
        argumentHint:
          'report [--json|--markdown] [--out file] [--include-debug] | prompt-audit [path?]',
        subcommands: [
          {
            name: 'report',
            description: 'Diagnose installation and settings',
            argumentHint: '[--json|--markdown] [--out file] [--include-debug]',
          },
          {
            name: 'prompt-audit',
            description:
              'Audit prompts/loader files, or walk a directory for stale refs and legacy patterns',
            argumentHint: '[path?]',
          },
        ],
      }),
    ]

    const out = await renderToString(
      <Commands
        commands={commands}
        maxHeight={30}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    expect(out).toContain('/doctor')
    // Parent hint wall-of-text is gone; replaced with a short marker.
    expect(out).toContain('2 subcommands')
    expect(out).not.toContain('| prompt-audit')
  })

  test('subcommand child rows render with labels and descriptions', async () => {
    const commands = [
      localCommand({
        name: 'doctor',
        description: 'Diagnose and verify your OpenClaude installation',
        argumentHint:
          'report [--json|--markdown] [--out file] [--include-debug] | prompt-audit [path?]',
        subcommands: [
          {
            name: 'report',
            description: 'Diagnose installation and settings',
            argumentHint: '[--json|--markdown] [--out file] [--include-debug]',
          },
          {
            name: 'prompt-audit',
            description:
              'Audit prompts/loader files, or walk a directory for stale refs and legacy patterns',
            argumentHint: '[path?]',
          },
        ],
      }),
    ]

    const out = await renderToString(
      <Commands
        commands={commands}
        maxHeight={30}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    expect(out).toContain('/doctor report')
    expect(out).toContain('/doctor prompt-audit')
    expect(out).toContain('Diagnose installation and settings')
    expect(out).toContain('Audit prompts/loader files')
  })

  test('subcommand children sort directly under the parent', async () => {
    const commands = [
      localCommand({ name: 'zebra', description: 'Last alphabetically' }),
      localCommand({
        name: 'doctor',
        description: 'Diagnose and verify your OpenClaude installation',
        argumentHint: 'report | prompt-audit [path?]',
        subcommands: [
          {
            name: 'report',
            description: 'Diagnose installation and settings',
          },
          {
            name: 'prompt-audit',
            description: 'Audit prompts',
            argumentHint: '[path?]',
          },
        ],
      }),
      localCommand({ name: 'apple', description: 'First alphabetically' }),
    ]

    const out = await renderToString(
      <Commands
        commands={commands}
        maxHeight={40}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    const appleIdx = out.indexOf('/apple')
    const doctorIdx = out.indexOf('/doctor')
    const reportIdx = out.indexOf('/doctor report')
    const auditIdx = out.indexOf('/doctor prompt-audit')
    const zebraIdx = out.indexOf('/zebra')

    expect(appleIdx).toBeGreaterThanOrEqual(0)
    expect(doctorIdx).toBeGreaterThanOrEqual(0)
    expect(reportIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(zebraIdx).toBeGreaterThanOrEqual(0)
    // apple < doctor < children < zebra
    expect(appleIdx).toBeLessThan(doctorIdx)
    expect(doctorIdx).toBeLessThan(reportIdx)
    expect(reportIdx).toBeLessThan(auditIdx)
    expect(auditIdx).toBeLessThan(zebraIdx)
  })

  test('hint-less command row is unchanged', async () => {
    const commands = [localCommand({ name: 'model', description: 'Change model' })]

    const out = await renderToString(
      <Commands
        commands={commands}
        maxHeight={30}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    expect(out).toContain('/model')
    expect(out).toContain('Change model')
    expect(out).not.toContain(' — ')
  })

  test('throwing argumentHint getter still renders the base row', async () => {
    const broken = {
      type: 'local-jsx',
      name: 'doctor',
      get description(): string {
        return 'Diagnose and verify your OpenClaude installation'
      },
      get argumentHint(): string {
        throw new Error('no hint')
      },
      isHidden: false,
      progressMessage: 'running',
      contentLength: 0,
      getPromptForCommand: async () => [],
    } as unknown as Command

    const out = await renderToString(
      <Commands
        commands={[broken]}
        maxHeight={30}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    expect(out).toContain('/doctor')
    expect(out).toContain('Diagnose and verify your OpenClaude installation')
  })
})

describe('HelpV2 Commands bg', () => {
  // Fixture mirrors the real /bg command (src/commands/bg/index.ts).
  function bgCommand(): Command {
    return {
      type: 'local',
      name: 'bg',
      description:
        'Run tasks in the background with worktree isolation and draft-PR on success',
      aliases: ['jobs'],
      argumentHint: '[ps|logs <id>|kill <id>|auto-pr <on|off>]',
      subcommands: [
        { name: 'ps', description: 'List background sessions' },
        {
          name: 'logs',
          description: 'Show a background session log',
          argumentHint: '<id-or-name> [--stderr|--stdout]',
        },
        {
          name: 'kill',
          description: 'Stop a background session (verified PID only)',
          argumentHint: '<id-or-name>',
        },
        {
          name: 'auto-pr',
          description:
            'Show or toggle draft auto-PR opt-in for this project (off by default)',
          argumentHint: '[on|off|status]',
        },
      ],
      isHidden: false,
    } as unknown as Command
  }

  test('parent row collapses hint to 4-subcommand marker', async () => {
    const out = await renderToString(
      <Commands
        commands={[bgCommand()]}
        maxHeight={30}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    expect(out).toContain('/bg')
    // Parent hint wall-of-text is gone; replaced with a short marker.
    expect(out).toContain('4 subcommands')
    expect(out).not.toContain('[ps|logs')
  })

  test('subcommand child rows render with labels and descriptions', async () => {
    const out = await renderToString(
      <Commands
        commands={[bgCommand()]}
        maxHeight={30}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    expect(out).toContain('/bg ps')
    expect(out).toContain('/bg logs')
    expect(out).toContain('/bg kill')
    expect(out).toContain('/bg auto-pr')
    expect(out).toContain('List background sessions')
    expect(out).toContain('Stop a background session (verified PID only)')
  })

  test('subcommand children sort directly under the parent', async () => {
    const commands = [
      localCommand({ name: 'zebra', description: 'Last alphabetically' }),
      bgCommand(),
      localCommand({ name: 'apple', description: 'First alphabetically' }),
    ]

    const out = await renderToString(
      <Commands
        commands={commands}
        maxHeight={40}
        columns={120}
        title="Browse default commands:"
        onCancel={() => {}}
      />,
      120,
    )

    const appleIdx = out.indexOf('/apple')
    const bgIdx = out.indexOf('/bg')
    const psIdx = out.indexOf('/bg ps')
    const autoPrIdx = out.indexOf('/bg auto-pr')
    const zebraIdx = out.indexOf('/zebra')

    expect(appleIdx).toBeGreaterThanOrEqual(0)
    expect(bgIdx).toBeGreaterThanOrEqual(0)
    expect(psIdx).toBeGreaterThanOrEqual(0)
    expect(autoPrIdx).toBeGreaterThanOrEqual(0)
    expect(zebraIdx).toBeGreaterThanOrEqual(0)
    // apple < bg < children < zebra
    expect(appleIdx).toBeLessThan(bgIdx)
    expect(bgIdx).toBeLessThan(psIdx)
    expect(psIdx).toBeLessThan(autoPrIdx)
    expect(autoPrIdx).toBeLessThan(zebraIdx)
  })
})
