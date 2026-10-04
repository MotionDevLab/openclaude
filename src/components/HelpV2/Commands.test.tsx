import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import type { Command } from '../../types/command.js'
import { renderToString } from '../../utils/staticRender.js'
import { Commands } from './Commands.js'

function localCommand({
  name,
  description,
  argumentHint,
}: {
  name: string
  description: string
  argumentHint?: string
}): Command {
  return {
    type: 'local-jsx',
    name,
    description,
    ...(argumentHint !== undefined ? { argumentHint } : {}),
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

  test('help row mentions variants via argumentHint', async () => {
    const commands = [
      localCommand({
        name: 'doctor',
        description: 'Diagnose and verify your OpenClaude installation',
        argumentHint: 'report [--json] | prompt-audit [path?]',
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
    expect(out).toContain('prompt-audit')
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
