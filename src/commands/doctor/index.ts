import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const doctor: Command = {
  name: 'doctor',
  description: 'Diagnose and verify your OpenClaude installation and settings',
  argumentHint: 'report [--json|--markdown] [--out file] [--include-debug] | prompt-audit [path?]',
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
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  type: 'local-jsx',
  load: () => import('./doctor.js'),
}

export default doctor
