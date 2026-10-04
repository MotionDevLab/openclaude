import { expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ValidationResult,
  validateManifest,
} from './validatePlugin.js'

const UNSET_VAR = 'OPENCLAUDE_TEST_MCP_UNSET_XYZ'

const BASE_MANIFEST = {
  name: 'mcp-checks-fixture',
  version: '1.0.0',
  description: 'Fixture plugin for MCP semantic checks.',
  author: { name: 'Tester' },
}

function withPluginDir(
  fn: (root: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'openclaude-mcp-validate-test-'))
    const savedUnset = process.env[UNSET_VAR]
    const savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT
    delete process.env[UNSET_VAR]
    delete process.env.CLAUDE_PLUGIN_ROOT
    try {
      await fn(root)
    } finally {
      if (savedUnset === undefined) delete process.env[UNSET_VAR]
      else process.env[UNSET_VAR] = savedUnset
      if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT
      else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function writePlugin(
  root: string,
  manifest: unknown,
  extraFiles: Record<string, string> = {},
): string {
  const pluginDir = join(root, '.claude-plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return join(pluginDir, 'plugin.json')
}

function messages(r: ValidationResult): string[] {
  return [
    ...r.errors.map(e => `${e.path}: ${e.message}`),
    ...r.warnings.map(w => `${w.path}: ${w.message}`),
  ]
}

const run = (
  fn: (root: string) => Promise<void>,
): (() => Promise<void>) => withPluginDir(fn)

test(
  'warns on an unresolvable stdio command but still passes',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: { ghost: { command: '__openclaude_missing_cmd__' } },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.warnings.length).toBe(1)
    expect(messages(r).join('\n')).toContain('__openclaude_missing_cmd__')
  }),
)

test(
  'stays green for a resolvable absolute command path',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: { self: { command: process.execPath } },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  }),
)

test(
  'errors on a missing referenced config file',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: './mcp/servers.json',
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(false)
    expect(messages(r).join('\n')).toContain('./mcp/servers.json')
  }),
)

test(
  'errors on an unparseable referenced config file',
  run(async root => {
    const p = writePlugin(
      root,
      { ...BASE_MANIFEST, mcpServers: './mcp/servers.json' },
      { 'mcp/servers.json': '{not json' },
    )
    const r = await validateManifest(p)
    expect(r.success).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  }),
)

test(
  'errors when referenced config content fails the server schema',
  run(async root => {
    const p = writePlugin(
      root,
      { ...BASE_MANIFEST, mcpServers: './mcp/servers.json' },
      {
        'mcp/servers.json': JSON.stringify({
          mcpServers: { broken: { command: 42 } },
        }),
      },
    )
    const r = await validateManifest(p)
    expect(r.success).toBe(false)
    expect(messages(r).join('\n')).toContain('broken')
  }),
)

test(
  'runs per-server checks on referenced-file servers and never leaks values',
  run(async root => {
    const secret = 'super-secret-value-999'
    const p = writePlugin(
      root,
      { ...BASE_MANIFEST, mcpServers: ['./mcp/servers.json'] },
      {
        'mcp/servers.json': JSON.stringify({
          mcpServers: {
            leaky: {
              command: '__openclaude_missing_cmd__',
              env: { TOKEN: secret },
            },
          },
        }),
      },
    )
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(messages(r).join('\n')).not.toContain(secret)
  }),
)

test(
  'warns on unset ${VAR} references with names only',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: {
        ghost: {
          command: process.execPath,
          args: [`--token=${'${' + UNSET_VAR + '}'}`],
        },
      },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(messages(r).join('\n')).toContain(UNSET_VAR)
  }),
)

test(
  'does not warn for ${VAR:-default} or ${CLAUDE_PLUGIN_ROOT}',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: {
        ghost: {
          command: process.execPath,
          args: [
            `${'${' + UNSET_VAR + ':-fallback}'}`,
            '${CLAUDE_PLUGIN_ROOT}/server.js',
          ],
        },
      },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.warnings).toEqual([])
  }),
)

test(
  'errors on undeclared ${user_config.KEY} references',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: {
        ghost: {
          command: process.execPath,
          env: { API_KEY: '${user_config.api_key}' },
        },
      },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(false)
    expect(messages(r).join('\n')).toContain('user_config.api_key')
  }),
)

test(
  'accepts declared ${user_config.KEY} references',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      userConfig: {
        api_key: {
          type: 'string',
          title: 'API key',
          description: 'Key for the service.',
        },
      },
      mcpServers: {
        ghost: {
          command: process.execPath,
          env: { API_KEY: '${user_config.api_key}' },
        },
      },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  }),
)

test(
  'errors on a missing local MCPB file',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: './bundle.mcpb',
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(false)
    expect(messages(r).join('\n')).toContain('./bundle.mcpb')
  }),
)

test(
  'warns on a non-https MCPB URL but stays green on https',
  run(async root => {
    const http = writePlugin(join(root, 'http'), {
      ...BASE_MANIFEST,
      mcpServers: 'http://example.com/bundle.mcpb',
    })
    const https = writePlugin(join(root, 'https'), {
      ...BASE_MANIFEST,
      mcpServers: 'https://example.com/bundle.mcpb',
    })
    const rHttp = await validateManifest(http)
    expect(rHttp.success).toBe(true)
    expect(rHttp.warnings.length).toBe(1)
    const rHttps = await validateManifest(https)
    expect(rHttps.success).toBe(true)
    expect(rHttps.warnings).toEqual([])
  }),
)

test(
  'errors on a non-absolute remote url',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: { r: { type: 'http', url: 'not-a-url' } },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  }),
)

test(
  'warns on http to non-loopback but exempts loopback',
  run(async root => {
    const remote = writePlugin(join(root, 'remote'), {
      ...BASE_MANIFEST,
      mcpServers: { r: { type: 'http', url: 'http://example.com/x' } },
    })
    const loopback = writePlugin(join(root, 'loopback'), {
      ...BASE_MANIFEST,
      mcpServers: { r: { type: 'http', url: 'http://localhost:3000/x' } },
    })
    const rRemote = await validateManifest(remote)
    expect(rRemote.success).toBe(true)
    expect(rRemote.warnings.length).toBe(1)
    const rLoop = await validateManifest(loopback)
    expect(rLoop.success).toBe(true)
    expect(rLoop.warnings).toEqual([])
  }),
)

test(
  'warns on literal-credential headers but not on ${VAR} headers',
  run(async root => {
    const literal = writePlugin(join(root, 'literal'), {
      ...BASE_MANIFEST,
      mcpServers: {
        r: {
          type: 'http',
          url: 'https://example.com/x',
          headers: { Authorization: 'Bearer abc123' },
        },
      },
    })
    const ref = writePlugin(join(root, 'ref'), {
      ...BASE_MANIFEST,
      mcpServers: {
        r: {
          type: 'http',
          url: 'https://example.com/x',
          headers: { Authorization: `${'${' + UNSET_VAR + '}'}` },
        },
      },
    })
    const rLiteral = await validateManifest(literal)
    expect(rLiteral.warnings.length).toBe(1)
    expect(messages(rLiteral).join('\n')).not.toContain('abc123')
    const rRef = await validateManifest(ref)
    // ${UNSET_VAR} is unset, so exactly one warning: the missing var.
    expect(rRef.warnings.length).toBe(1)
    expect(messages(rRef).join('\n')).toContain(UNSET_VAR)
  }),
)

test(
  'skips sdk and ide-internal servers silently',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: {
        a: { type: 'sdk', name: 'x' },
        b: { type: 'sse-ide', url: 'http://example.com/x', ideName: 'y' },
      },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.warnings).toEqual([])
  }),
)

test(
  'checks .mcp.json at the plugin root',
  run(async root => {
    const p = writePlugin(
      root,
      {
        ...BASE_MANIFEST,
        mcpServers: { ok: { command: process.execPath } },
      },
      {
        '.mcp.json': JSON.stringify({
          mcpServers: { ghost: { command: '__openclaude_missing_cmd__' } },
        }),
      },
    )
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.warnings.length).toBe(1)
    expect(messages(r).join('\n')).toContain('.mcp.json')
  }),
)

test(
  'stays silent for a valid .mcp.json with clean servers',
  run(async root => {
    const p = writePlugin(
      root,
      {
        ...BASE_MANIFEST,
        mcpServers: { ok: { command: process.execPath } },
      },
      {
        '.mcp.json': JSON.stringify({
          mcpServers: {
            alsoOk: {
              type: 'http',
              url: 'https://example.com/x',
            },
          },
        }),
      },
    )
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  }),
)

test(
  'resolves refs relative to a bare plugin.json outside .claude-plugin',
  run(async root => {
    const dir = join(root, 'plain')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        ...BASE_MANIFEST,
        mcpServers: './servers.json',
      }),
      'utf8',
    )
    writeFileSync(
      join(dir, 'servers.json'),
      JSON.stringify({
        mcpServers: { ok: { command: process.execPath } },
      }),
      'utf8',
    )
    const r = await validateManifest(join(dir, 'plugin.json'))
    expect(r.success).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  }),
)

test(
  'resolves refs from a directory argument via validateManifest',
  run(async root => {
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: './mcp/servers.json',
    })
    void p
    const r = await validateManifest(root)
    expect(r.success).toBe(false)
    expect(messages(r).join('\n')).toContain('./mcp/servers.json')
  }),
)

test(
  'resolves commands under paths with spaces, quotes and parentheses',
  run(async root => {
    const tricky = join(root, 'my dir (x86)', 'tool.exe')
    mkdirSync(join(tricky, '..'), { recursive: true })
    writeFileSync(tricky, 'x', 'utf8')
    chmodSync(tricky, 0o755)
    const p = writePlugin(root, {
      ...BASE_MANIFEST,
      mcpServers: {
        ok: { command: tricky },
        quoted: { command: `"${tricky}"` },
        missing: { command: '"__openclaude_missing_cmd__"' },
      },
    })
    const r = await validateManifest(p)
    expect(r.success).toBe(true)
    expect(r.warnings.length).toBe(1)
    expect(messages(r).join('\n')).toContain('__openclaude_missing_cmd__')
  }),
)

test(
  'rejects an MCP servers file ref that escapes the plugin root',
  run(async root => {
    const outsideName = `mcp-outside-${process.pid}.json`
    const outside = join(root, '..', outsideName)
    writeFileSync(
      outside,
      JSON.stringify({ ok: { command: process.execPath } }),
      'utf8',
    )
    try {
      const p = writePlugin(root, {
        ...BASE_MANIFEST,
        mcpServers: `./../${outsideName}`,
      })
      const r = await validateManifest(p)
      expect(r.success).toBe(false)
      expect(messages(r).join('\n')).toContain('resolves outside the plugin root')
    } finally {
      rmSync(outside, { force: true })
    }
  }),
)

test(
  'rejects a local MCP bundle ref that escapes the plugin root',
  run(async root => {
    const outsideName = `mcp-outside-${process.pid}.mcpb`
    const outside = join(root, '..', outsideName)
    writeFileSync(outside, 'bundle-bytes', 'utf8')
    try {
      const p = writePlugin(root, {
        ...BASE_MANIFEST,
        mcpServers: `./../${outsideName}`,
      })
      const r = await validateManifest(p)
      expect(r.success).toBe(false)
      expect(messages(r).join('\n')).toContain('resolves outside the plugin root')
    } finally {
      rmSync(outside, { force: true })
    }
  }),
)
