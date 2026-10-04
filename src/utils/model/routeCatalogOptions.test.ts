import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'

import { filterAvailableCatalogEntries } from '../../integrations/index.js'
import { buildRouteCatalogModelOptions, mergeRouteCatalogEntries } from './routeCatalogOptions.js'

describe('buildRouteCatalogModelOptions', () => {
  test('marks the route default model as recommended without catalog metadata', () => {
    const options = buildRouteCatalogModelOptions(
      'DeepSeek',
      [
        { id: 'deepseek-chat', apiName: 'deepseek-chat', label: 'DeepSeek Chat' },
        { id: 'deepseek-v4-pro', apiName: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ],
      'deepseek-v4-pro',
    )

    expect(options).toEqual([
      {
        value: 'deepseek-chat',
        label: 'DeepSeek Chat',
        description: `${chalk.yellow('⚠ fallback 128K')} · Provider: DeepSeek`,
        descriptionForModel: `${chalk.yellow('⚠ fallback 128K')} · Provider: DeepSeek (deepseek-chat)`,
        dimDescription: false,
      },
      {
        value: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: `Recommended · ${chalk.yellow('⚠ fallback 128K')} · Provider: DeepSeek`,
        descriptionForModel: `Recommended · ${chalk.yellow('⚠ fallback 128K')} · Provider: DeepSeek (deepseek-v4-pro)`,
        dimDescription: false,
      },
    ])
  })

  test('keeps duplicate API models selectable by catalog id and recommends only the selected variant', () => {
    const options = buildRouteCatalogModelOptions('Kimi Code', [
      { id: 'k3', apiName: 'k3', label: 'Kimi K3 (1M)' },
      { id: 'k3-256k', apiName: 'k3', label: 'Kimi K3 (256K)' },
    ], 'k3')

    expect(options.map(option => option.value)).toEqual(['k3', 'k3-256k'])
    expect(options[0]?.description).toContain('Recommended')
    expect(options[1]?.description).not.toContain('Recommended')
  })

  test('surfaces catalog entry notes as a description tag', () => {
    const options = buildRouteCatalogModelOptions('Gitlawb Opengateway', [
      {
        id: 'opengateway-nemotron-3-ultra-free',
        apiName: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        label: 'Nemotron 3 Ultra Free (via Opengateway)',
        notes: 'Free',
      },
    ])

    expect(options[0]?.description).toBe(`${chalk.yellow('⚠ fallback 128K')} · Free · Provider: Gitlawb Opengateway`)
    expect(options[0]?.dimDescription).toBe(false)
  })
})

describe('picker fallback marking', () => {
  test('missing window shows yellow fallback, known window shows green size', () => {
    const options = buildRouteCatalogModelOptions('OpenCode Zen', [
      { id: 'muse-spark-1.3-free', apiName: 'muse-spark-1.3-free', label: 'Muse Spark 1.3 Free' },
      { id: 'muse-spark-1.2-free', apiName: 'muse-spark-1.2-free', label: 'Muse Spark 1.2 Free', contextWindow: 1048576 },
    ])
    const missingOpt = options.find(o => o.value === 'muse-spark-1.3-free')!
    expect(missingOpt.description).toContain('fallback 128K')
    expect(missingOpt.description).toContain('Provider: OpenCode Zen')
    expect(missingOpt.dimDescription).toBe(false)
    const knownOpt = options.find(o => o.value === 'muse-spark-1.2-free')!
    expect(knownOpt.description).toContain('1M context')
    expect(knownOpt.description).not.toContain('fallback')
    expect(knownOpt.dimDescription).toBeUndefined()
  })
})

describe('mergeRouteCatalogEntries + availability filter', () => {
  // The exact composition used by loadDescriptorDiscoveryContext
  // (src/commands/model/model.tsx): merge the RAW static list first, filter
  // after. An expired static entry must win the apiName dedup against a
  // cached discovery duplicate so the post-merge filter removes both copies.
  test('a cached duplicate of an expired static entry does not resurface after the cutoff', () => {
    const rawStatic = [
      { id: 'evergreen', apiName: 'model-evergreen' },
      {
        id: 'time-boxed',
        apiName: 'model-window',
        availableUntil: '2026-08-13T10:00:00Z',
      },
    ]
    const cachedDiscovery = [
      // Same apiName as the expired static entry, but no expiry marker —
      // exactly what a discovery cache would hold.
      { id: 'discovered-window', apiName: 'model-window' },
      { id: 'discovered-extra', apiName: 'model-extra' },
    ]

    const afterCutoff = new Date('2026-08-13T10:00:01Z')
    const merged = filterAvailableCatalogEntries(
      mergeRouteCatalogEntries(rawStatic, cachedDiscovery),
      afterCutoff,
    )
    expect(merged.map(e => e.id)).toEqual(['evergreen', 'discovered-extra'])

    // Pre-filtering the static side (the buggy order) lets the cached
    // duplicate through — documents why the raw list feeds the merge.
    const buggy = filterAvailableCatalogEntries(
      mergeRouteCatalogEntries(
        filterAvailableCatalogEntries(rawStatic, afterCutoff),
        cachedDiscovery,
      ),
      afterCutoff,
    )
    expect(buggy.map(e => e.id)).toContain('discovered-window')
  })

  test('inside the window the static entry masks the cached duplicate', () => {
    const rawStatic = [
      {
        id: 'time-boxed',
        apiName: 'model-window',
        availableUntil: '2026-08-13T10:00:00Z',
      },
    ]
    const cachedDiscovery = [{ id: 'discovered-window', apiName: 'model-window' }]
    const during = new Date('2026-08-12T00:00:00Z')
    const merged = filterAvailableCatalogEntries(
      mergeRouteCatalogEntries(rawStatic, cachedDiscovery),
      during,
    )
    expect(merged.map(e => e.id)).toEqual(['time-boxed'])
  })
})
