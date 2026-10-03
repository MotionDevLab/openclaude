/**
 * install prepare script: make `npm install -g github:...` (and any other
 * source-tree install) produce a runnable package.
 *
 * npm runs `prepare` — not `prepack` — on git dependencies, so without this
 * hook a git install ships the source tree with no `dist/` and a dead `bin`
 * entry. The hook has two modes:
 *
 * - dev workflow (`bun install` in a working checkout with devDependencies
 *   already resolvable): no-op. Contributors keep the old behavior of
 *   building explicitly via `bun run build`.
 * - source install (devDependencies missing, e.g. npm's prod-only git
 *   install): fetch exact deps with the repo lockfile, then build.
 *
 * Re-entrancy: the ensure step below runs `bun install`, which re-triggers
 * this same hook. The OPENCLAUDE_PREPARE_ACTIVE marker makes the nested
 * invocation exit immediately (bun runs prepare on every install, npm only
 * on git installs — the marker covers both).
 *
 * Plain node, no dependencies: must run under npm (cmd/sh) as well as bun.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const BUILD_DEPS = ['typescript/package.json', 'react-reconciler/package.json']

if (process.env.OPENCLAUDE_PREPARE_ACTIVE === '1') {
  process.exit(0)
}

const require = createRequire(import.meta.url)
const depsComplete = BUILD_DEPS.every(dep => {
  try {
    require.resolve(dep)
    return true
  } catch {
    return false
  }
})

if (depsComplete) {
  process.exit(0)
}

process.env.OPENCLAUDE_PREPARE_ACTIVE = '1'
const shell = process.platform === 'win32'
const install = spawnSync('bun', ['install', '--frozen-lockfile'], {
  stdio: 'inherit',
  shell,
})
if ((install.status ?? 1) !== 0) {
  process.exit(install.status ?? 1)
}
const build = spawnSync('bun', ['run', 'build'], { stdio: 'inherit', shell })
process.exit(build.status ?? 1)
