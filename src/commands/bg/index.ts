import type { Command } from '../../commands.js'

const bg = {
  type: 'local',
  name: 'bg',
  aliases: ['jobs'],
  description:
    'Run tasks in the background with worktree isolation and draft-PR on success — spawn with openclaude --bg "...", manage with ps|logs|kill',
  argumentHint: '[ps|logs <id>|kill <id>|auto-pr <on|off>]',
  subcommands: [
    {
      name: 'ps',
      description: 'List background sessions',
      argumentHint: '',
    },
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
      argumentHint: '[on|off]',
    },
  ],
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => import('./bg.js'),
} satisfies Command

export default bg
