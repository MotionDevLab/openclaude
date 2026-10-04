import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setUseCoworkPlugins } from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { pluginValidateHandler } from './plugins.js'

type Captured = { log: string[]; error: string[]; stdout: string[] }

const VALID_MANIFEST = {
  name: 'json-test-plugin',
  version: '1.0.0',
  description: 'Fixture plugin for --json handler tests.',
  author: { name: 'Tester' },
}

const INVALID_MANIFEST = {
  // Missing required `name` — schema must reject this.
  version: '1.0.0',
}

const MARKETPLACE_MANIFEST = {
  name: 'json-test-marketplace',
  owner: { name: 'Tester' },
  plugins: [],
}

/**
 * Runs the handler with process.exit, console.log/error and
 * process.stdout.write captured. process.exit becomes a recorded code plus
 * a short-circuit throw; runValidate swallows only that throw.
 */
async function withValidateFixture(
  fn: (fixture: {
    dir: string
    captured: Captured
    exitCodes: number[]
  }) => Promise<void>,
): Promise<void> {
  await acquireSharedMutationLock('pluginValidateHandler')
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-plugin-validate-test-'))
  const captured: Captured = { log: [], error: [], stdout: [] }
  const exitCodes: number[] = []
  const saved = {
    exit: process.exit,
    log: console.log,
    error: console.error,
    write: process.stdout.write,
  }
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0)
    throw new Error('__exit__')
  }) as typeof process.exit
  console.log = ((...args: unknown[]) => {
    captured.log.push(args.map(String).join(' '))
  }) as typeof console.log
  console.error = ((...args: unknown[]) => {
    captured.error.push(args.map(String).join(' '))
  }) as typeof console.error
  process.stdout.write = ((chunk: unknown) => {
    captured.stdout.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await fn({ dir, captured, exitCodes })
  } finally {
    process.exit = saved.exit
    console.log = saved.log
    console.error = saved.error
    process.stdout.write = saved.write
    setUseCoworkPlugins(false)
    rmSync(dir, { recursive: true, force: true })
    releaseSharedMutationLock()
  }
}

async function runValidate(
  manifestPath: string,
  options: { cowork?: boolean; json?: boolean },
): Promise<void> {
  try {
    await pluginValidateHandler(manifestPath, options)
  } catch (e: unknown) {
    if (!(e instanceof Error) || e.message !== '__exit__') throw e
  }
}

function writeManifest(dir: string, file: string, data: unknown): string {
  const full = join(dir, file)
  writeFileSync(full, JSON.stringify(data), 'utf8')
  return full
}

test('emits a single JSON document for a valid manifest with --json', async () => {
  await withValidateFixture(async ({ dir, captured, exitCodes }) => {
    const manifestPath = writeManifest(dir, 'plugin.json', VALID_MANIFEST)
    await runValidate(manifestPath, { json: true })
    expect(exitCodes).toEqual([0])
    expect(captured.log).toEqual([])
    expect(captured.stdout.length).toBe(1)
    const doc = JSON.parse(captured.stdout.join('')) as {
      success: boolean
      manifest: { success: boolean; fileType: string }
      contents: unknown[]
    }
    expect(doc.success).toBe(true)
    expect(doc.manifest.success).toBe(true)
    expect(doc.manifest.fileType).toBe('plugin')
    expect(doc.contents).toEqual([])
  })
})

test('reports failure as JSON with exit 1 for an invalid manifest', async () => {
  await withValidateFixture(async ({ dir, captured, exitCodes }) => {
    const manifestPath = writeManifest(dir, 'plugin.json', INVALID_MANIFEST)
    await runValidate(manifestPath, { json: true })
    expect(exitCodes).toEqual([1])
    expect(captured.log).toEqual([])
    const doc = JSON.parse(captured.stdout.join('')) as {
      success: boolean
      manifest: { success: boolean }
    }
    expect(doc.success).toBe(false)
    expect(doc.manifest.success).toBe(false)
  })
})

test('human output is unchanged without --json', async () => {
  await withValidateFixture(async ({ dir, captured, exitCodes }) => {
    const manifestPath = writeManifest(dir, 'plugin.json', VALID_MANIFEST)
    await runValidate(manifestPath, {})
    expect(exitCodes).toEqual([0])
    // Human mode writes progress via console.log and the final tick via
    // cliOk (process.stdout.write) — assert both, and that no JSON appears.
    expect(captured.log.join('\n')).toContain('Validating plugin manifest')
    expect(captured.stdout.join('')).toContain('Validation passed')
    expect(() =>
      JSON.parse(captured.log.join('') + captured.stdout.join('')),
    ).toThrow()
  })
})

test('supports --cowork composed with --json', async () => {
  await withValidateFixture(async ({ dir, captured, exitCodes }) => {
    const manifestPath = writeManifest(dir, 'plugin.json', VALID_MANIFEST)
    await runValidate(manifestPath, { cowork: true, json: true })
    expect(exitCodes).toEqual([0])
    const doc = JSON.parse(captured.stdout.join('')) as { success: boolean }
    expect(doc.success).toBe(true)
  })
})

test('emits contents: [] for a marketplace manifest with --json', async () => {
  await withValidateFixture(async ({ dir, captured, exitCodes }) => {
    const manifestPath = writeManifest(
      dir,
      'marketplace.json',
      MARKETPLACE_MANIFEST,
    )
    await runValidate(manifestPath, { json: true })
    expect(exitCodes).toEqual([0])
    const doc = JSON.parse(captured.stdout.join('')) as {
      manifest: { fileType: string }
      contents: unknown[]
    }
    expect(doc.manifest.fileType).toBe('marketplace')
    expect(doc.contents).toEqual([])
  })
})

test('prints nothing on stdout when --json hits the exit-2 path', async () => {
  await withValidateFixture(async ({ captured, exitCodes }) => {
    // NUL byte makes path.resolve throw — an unexpected error, exit 2.
    await runValidate('\0', { json: true })
    expect(exitCodes).toEqual([2])
    expect(captured.stdout).toEqual([])
  })
})
