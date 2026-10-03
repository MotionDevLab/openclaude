import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  ensureIntegrationsLoaded,
  getCatalogEntriesForRoute,
} from '../integrations/index.js'
import * as realAuth from './auth.js'
import * as realThinking from './thinking.js'
import * as actualSettings from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'
const realModelSupportOverridesModule = await import(
  `./model/modelSupportOverrides.js?real=${Date.now()}-${Math.random()}`,
)
const realModelSupportOverrides = {
  get3PModelCapabilityOverride:
    realModelSupportOverridesModule.get3PModelCapabilityOverride,
}

// Gated customProviders override for the declared-lane effort tests below.
// mock.module is process-wide and mock.restore() does NOT undo it, so the
// mock delegates to the real settings implementation whenever no test sets
// the flag (same pattern as providerDiscovery.test.ts).
const realSettings = { ...actualSettings }
let activeCustomProvidersOverride: SettingsJson['customProviders'] | null = null

mock.module('./settings/settings.js', () => ({
  ...realSettings,
  getSettings_DEPRECATED: () => {
    if (!activeCustomProvidersOverride) {
      return realSettings.getSettings_DEPRECATED()
    }
    return {
      ...(realSettings.getSettings_DEPRECATED() ?? {}),
      customProviders: activeCustomProvidersOverride,
    }
  },
}))

const originalEnv = { ...process.env }
const routingEnvKeys = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'GEMINI_API_KEY',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'USER_TYPE',
] as const

async function importFreshEffortModule() {
  return import(`./effort.js?ts=${Date.now()}-${Math.random()}`)
}

function restoreProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(originalEnv, key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/effort.test.ts')
  mock.module(
    './model/modelSupportOverrides.js',
    () => realModelSupportOverrides,
  )
  activeCustomProvidersOverride = null
  for (const key of routingEnvKeys) {
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('./auth.js', () => realAuth)
    mock.module('./thinking.js', () => realThinking)
    mock.module(
      './model/modelSupportOverrides.js',
      () => realModelSupportOverrides,
    )
    activeCustomProvidersOverride = null
    restoreProcessEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('getDefaultEffortForModel — default-Opus effort gate (#1769)', () => {
  test('Pro sessions on the default Opus (now 4.8) get medium effort', async () => {
    process.env.USER_TYPE = 'external'
    mock.module('./auth.js', () => ({
      ...realAuth,
      isProSubscriber: () => true,
      isMaxSubscriber: () => false,
      isTeamSubscriber: () => false,
    }))
    // Keep the ultrathink path out of the way so the opus branch is what's tested.
    mock.module('./thinking.js', () => ({
      ...realThinking,
      isUltrathinkEnabled: () => false,
    }))

    const { getDefaultEffortForModel } = await importFreshEffortModule()

    // Pre-fix this returned undefined because the branch only matched opus-4-6.
    expect(getDefaultEffortForModel('claude-opus-4-8')).toBe('medium')
    expect(getDefaultEffortForModel('claude-opus-4-7')).toBe('medium')
    expect(getDefaultEffortForModel('claude-opus-4-6')).toBe('medium')
    // Control: a non-default Opus does NOT get the medium default (proves the
    // result comes from the model match, not isProSubscriber alone).
    expect(getDefaultEffortForModel('claude-opus-4-1')).toBeUndefined()
  })
})

describe('CLAUDE_CODE_ALWAYS_ENABLE_EFFORT precedence', () => {
  test('keeps API-rejecting Claude models excluded across every public effort predicate', async () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'

    const {
      modelSupportsEffort,
      modelSupportsShimReasoningEffort,
      modelSupportsWireEffort,
      resolveAppliedEffort,
      resolveModelReasoningControl,
    } = await importFreshEffortModule()
    const context = {
      apiProvider: 'firstParty' as const,
      routeId: 'anthropic',
      useRuntimeFallback: false,
    }
    const rejectedModels = [
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-20241022',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-20250514',
      'claude-opus-4-1-20250805',
      'claude-haiku-4-5-20251001',
    ]

    for (const model of rejectedModels) {
      expect(resolveModelReasoningControl(model, context)).toMatchObject({
        supportsReasoning: false,
        controllable: false,
        source: 'none',
      })
      expect(modelSupportsEffort(model, context)).toBe(false)
      expect(
        modelSupportsShimReasoningEffort(
          model,
          undefined,
          undefined,
          context,
        ),
      ).toBe(false)
      expect(modelSupportsWireEffort(model, context)).toBe(false)
      expect(resolveAppliedEffort(model, 'medium', context)).toBeUndefined()
    }
  })

  test('preserves supported Claude controls and selected wire values', async () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'

    const {
      modelSupportsEffort,
      modelSupportsShimReasoningEffort,
      modelSupportsWireEffort,
      resolveAppliedEffort,
    } = await importFreshEffortModule()
    const context = {
      apiProvider: 'firstParty' as const,
      routeId: 'anthropic',
      useRuntimeFallback: false,
    }
    const supportedModels = [
      ['claude-opus-4-5-20251101', 'low', 'low'],
      ['claude-opus-4-6', 'max', 'max'],
      ['claude-opus-4-8', 'xhigh', 'xhigh'],
      ['claude-sonnet-4-6', 'max', 'high'],
    ] as const

    for (const [model, selected, expected] of supportedModels) {
      expect(modelSupportsEffort(model, context)).toBe(true)
      expect(
        modelSupportsShimReasoningEffort(
          model,
          undefined,
          undefined,
          context,
        ),
      ).toBe(true)
      expect(modelSupportsWireEffort(model, context)).toBe(true)
      expect(resolveAppliedEffort(model, selected, context)).toBe(expected)
    }
  })

  test('only force-enables unresolved custom models beyond their provider fallback', async () => {
    const {
      modelSupportsEffort,
      modelSupportsShimReasoningEffort,
      modelSupportsWireEffort,
      resolveAppliedEffort,
    } = await importFreshEffortModule()
    const model = 'gateway-custom-model'
    const context = {
      apiProvider: 'openai' as const,
      routeId: 'custom',
      useRuntimeFallback: false,
    }
    const support = () => [
      modelSupportsEffort(model, context),
      modelSupportsShimReasoningEffort(
        model,
        undefined,
        undefined,
        context,
      ),
      modelSupportsWireEffort(model, context),
    ]

    delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    expect(support()).toEqual([false, false, false])
    expect(resolveAppliedEffort(model, 'medium', context)).toBeUndefined()

    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    expect(support()).toEqual([true, true, true])
    expect(resolveAppliedEffort(model, 'medium', context)).toBe('medium')
  })

  test('uses the scoped routing environment for force enable', async () => {
    const { modelSupportsEffort, resolveAppliedEffort } =
      await importFreshEffortModule()
    const model = 'gateway-custom-model'
    const context = {
      apiProvider: 'openai' as const,
      routeId: 'custom',
      useRuntimeFallback: false,
      processEnv: {
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      } as NodeJS.ProcessEnv,
    }

    delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    expect(modelSupportsEffort(model, context)).toBe(true)
    expect(resolveAppliedEffort(model, 'medium', context)).toBe('medium')

    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    context.processEnv = {}
    expect(modelSupportsEffort(model, context)).toBe(false)
    expect(resolveAppliedEffort(model, 'medium', context)).toBeUndefined()
  })

  test('uses the scoped environment for compatibility and catalog route fallbacks', async () => {
    const { resolveModelReasoningControl } = await importFreshEffortModule()
    const scopedOpenAIEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'scoped-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    } as NodeJS.ProcessEnv
    const context = {
      apiProvider: 'openai' as const,
      processEnv: scopedOpenAIEnv,
    }
    const noControl = {
      supportsReasoning: false,
      controllable: false,
      source: 'none',
    }

    process.env.LONGCAT_API_KEY = 'ambient-key'
    expect(resolveModelReasoningControl('gateway-custom-model', context)).toMatchObject(
      noControl,
    )

    delete process.env.LONGCAT_API_KEY
    process.env.ZAI_API_KEY = 'ambient-key'
    expect(
      resolveModelReasoningControl('glm-5.2', {
        ...context,
        openaiShimConfig: {},
      }),
    ).toMatchObject(noControl)

    delete process.env.ZAI_API_KEY
    process.env.XAI_API_KEY = 'ambient-key'
    expect(resolveModelReasoningControl('grok-4.6', context)).toMatchObject(
      noControl,
    )

    delete process.env.XAI_API_KEY
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    expect(
      resolveModelReasoningControl('gpt-5.6', {
        apiProvider: 'openai',
        processEnv: {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_API_KEY: 'scoped-key',
          OPENAI_API_BASE: 'https://gateway.example.test/v1',
        },
        supportsCodexReasoningEffort: false,
      }),
    ).toMatchObject(noControl)
  })

  test('ambient custom-route predicates do not advertise native transport effort', async () => {
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.GEMINI_API_KEY
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_BASE_URL = 'https://gateway.example.test/v1'
    process.env.OPENAI_MODEL = 'claude-opus-4-5'

    const { modelSupportsEffort, resolveAppliedEffort } =
      await importFreshEffortModule()

    for (const model of ['claude-opus-4-5', 'gemini-3-pro']) {
      expect(modelSupportsEffort(model)).toBe(false)
      expect(resolveAppliedEffort(model, 'medium')).toBeUndefined()
    }
    expect(modelSupportsEffort('gpt-5.4')).toBe(true)
    expect(resolveAppliedEffort('gpt-5.4', 'medium')).toBe('medium')
  })
})

describe('configured third-party effort precedence', () => {
  test('supersedes descriptive LongCat catalog capabilities without bypassing route contracts', async () => {
    ensureIntegrationsLoaded()
    const longCatEntry = getCatalogEntriesForRoute('longcat').find(
      entry => entry.apiName === 'LongCat-2.0',
    )!
    const {
      getAvailableEffortLevels,
      modelSupportsEffort,
      modelSupportsWireEffort,
      resolveAppliedEffort,
      resolveModelReasoningControl,
    } = await importFreshEffortModule()
    const context = {
      apiProvider: 'openai' as const,
      routeId: 'longcat',
      useRuntimeFallback: false,
    }

    expect(resolveModelReasoningControl('LongCat-2.0', context)).toMatchObject({
      supportsReasoning: true,
      controllable: false,
      source: 'capability',
      levels: [],
    })

    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'LongCat-2.0'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'effort,max_effort,xhigh_effort'

    expect(resolveModelReasoningControl('LongCat-2.0', context)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'capability',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      wireFormat: 'reasoning_effort',
    })
    expect(modelSupportsEffort('LongCat-2.0', context)).toBe(true)
    expect(modelSupportsWireEffort('LongCat-2.0', context)).toBe(true)
    expect(getAvailableEffortLevels('LongCat-2.0', context)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(resolveAppliedEffort('LongCat-2.0', 'max', context)).toBe('max')

    const transportVetoContext = {
      ...context,
      openaiShimConfig: { removeBodyFields: ['reasoning_effort'] },
    }
    expect(
      resolveModelReasoningControl('LongCat-2.0', transportVetoContext),
    ).toMatchObject({
      controllable: false,
      source: 'compat',
    })
    expect(
      resolveAppliedEffort('LongCat-2.0', 'max', transportVetoContext),
    ).toBeUndefined()

    const explicitMetadataContext = {
      ...context,
      catalogEntries: [
        {
          ...longCatEntry,
          reasoning: {
            mode: 'always-on' as const,
            wireFormat: 'none' as const,
          },
        },
      ],
    }
    expect(
      resolveModelReasoningControl('LongCat-2.0', explicitMetadataContext),
    ).toMatchObject({
      supportsReasoning: true,
      controllable: false,
      source: 'metadata',
      wireFormat: 'none',
    })
  })

  test('preserves the legacy default for a configured override', async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    mock.module('./auth.js', () => ({
      ...realAuth,
      isProSubscriber: () => true,
      isMaxSubscriber: () => false,
      isTeamSubscriber: () => false,
    }))
    mock.module('./thinking.js', () => ({
      ...realThinking,
      isUltrathinkEnabled: () => false,
    }))

    const { getDefaultEffortForModel, resolveAppliedEffort } =
      await importFreshEffortModule()
    const context = {
      apiProvider: 'openai' as const,
      routeId: 'custom',
      useRuntimeFallback: false,
    }

    expect(getDefaultEffortForModel('claude-opus-4-6', context)).toBe('medium')
    expect(
      resolveAppliedEffort('claude-opus-4-6', undefined, context),
    ).toBe('medium')
  })
})

describe('customProviders declared-lane effort (§3.2)', () => {
  const ZEN_BASE_URL = 'http://127.0.0.1:18905/zen/v1'
  const SPARK_MODEL = 'muse-spark-1.3-contributor-free'

  function zenContext(baseUrl: string | undefined = ZEN_BASE_URL) {
    return {
      apiProvider: 'openai' as const,
      routeId: 'custom',
      useRuntimeFallback: false,
      baseUrl,
    }
  }

  function declareZenLane(entry?: Record<string, unknown>) {
    activeCustomProvidersOverride = [
      {
        id: 'zen-router',
        label: 'OpenCode Zen Router',
        baseUrl: ZEN_BASE_URL,
        models: [SPARK_MODEL, 'nemotron-3.5-lightning-free'],
        supportsEffort: true,
        ...(entry ?? {}),
      },
    ]
  }

  test('matched entry resolves controllable reasoning_effort with default levels', async () => {
    declareZenLane()
    const { modelSupportsEffort, resolveModelReasoningControl, getAvailableEffortLevels } =
      await importFreshEffortModule()

    expect(resolveModelReasoningControl(SPARK_MODEL, zenContext())).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      mode: 'levels',
      levels: ['low', 'medium', 'high'],
      wireFormat: 'reasoning_effort',
      source: 'capability',
    })
    expect(modelSupportsEffort(SPARK_MODEL, zenContext())).toBe(true)
    expect(getAvailableEffortLevels(SPARK_MODEL, zenContext())).toEqual([
      'low',
      'medium',
      'high',
    ])
  })

  test('entry effortLevels are honored (lanes opt into more)', async () => {
    declareZenLane({ effortLevels: ['low', 'medium', 'high', 'xhigh'] })
    const { resolveModelReasoningControl, getAvailableEffortLevels } =
      await importFreshEffortModule()

    expect(resolveModelReasoningControl(SPARK_MODEL, zenContext())).toMatchObject({
      controllable: true,
      levels: ['low', 'medium', 'high', 'xhigh'],
      wireFormat: 'reasoning_effort',
      source: 'capability',
    })
    expect(getAvailableEffortLevels(SPARK_MODEL, zenContext())).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  test('model mismatch on the same base URL stays non-controllable', async () => {
    declareZenLane()
    const { modelSupportsEffort, resolveModelReasoningControl } =
      await importFreshEffortModule()

    expect(modelSupportsEffort('gpt-4o', zenContext())).toBe(false)
    expect(
      resolveModelReasoningControl('gpt-4o', zenContext()).controllable,
    ).toBe(false)
  })

  test('entry without supportsEffort stays non-controllable', async () => {
    declareZenLane({ supportsEffort: false })
    const { modelSupportsEffort } = await importFreshEffortModule()

    expect(modelSupportsEffort(SPARK_MODEL, zenContext())).toBe(false)
  })

  test('explicit tier false wins over a matching entry', async () => {
    declareZenLane()
    // Pin the model in a tier WITHOUT the effort capability: the tier
    // override resolves false and must beat the entry.
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = SPARK_MODEL
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
    const { modelSupportsEffort, resolveModelReasoningControl } =
      await importFreshEffortModule()

    expect(modelSupportsEffort(SPARK_MODEL, zenContext())).toBe(false)
    expect(
      resolveModelReasoningControl(SPARK_MODEL, zenContext()).controllable,
    ).toBe(false)
  })

  test('explicit tier true keeps the existing resolution (entry ignored)', async () => {
    declareZenLane({ effortLevels: ['low'] })
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = SPARK_MODEL
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'effort,max_effort,xhigh_effort'
    const { resolveModelReasoningControl } = await importFreshEffortModule()

    expect(resolveModelReasoningControl(SPARK_MODEL, zenContext())).toMatchObject({
      controllable: true,
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      wireFormat: 'reasoning_effort',
      source: 'capability',
    })
  })

  test('settings edits take effect without a restart (no stale memo)', async () => {
    declareZenLane()
    const { modelSupportsEffort } = await importFreshEffortModule()
    const context = zenContext()

    expect(modelSupportsEffort(SPARK_MODEL, context)).toBe(true)

    // Flip the lane off mid-session: the same module instance must observe it.
    declareZenLane({ supportsEffort: false })
    expect(modelSupportsEffort(SPARK_MODEL, context)).toBe(false)
  })

  test('env base URL fallback covers callers without context baseUrl', async () => {
    declareZenLane()
    process.env.OPENAI_BASE_URL = ZEN_BASE_URL
    const { modelSupportsEffort } = await importFreshEffortModule()

    expect(
      modelSupportsEffort(SPARK_MODEL, {
        apiProvider: 'openai' as const,
        routeId: 'custom',
        useRuntimeFallback: false,
      }),
    ).toBe(true)
  })
})
