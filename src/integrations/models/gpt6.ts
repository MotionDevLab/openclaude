import { defineModel } from '../define.js'

const gpt6Capabilities = {
  supportsVision: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: false,
  supportsPreciseTokenCount: true,
}

function gpt6Model(
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
) {
  return defineModel({
    id,
    label,
    brandId: 'gpt',
    vendorId: 'openai',
    classification: ['chat', 'vision', 'coding'],
    defaultModel: id,
    capabilities: gpt6Capabilities,
    contextWindow,
    maxOutputTokens,
  })
}

export default [
  // GPT-6 family (October 2026). Live API spec, two agreeing sources
  // (2026-10-13): OpenRouter (`openai/gpt-6-astra`: `context_length`
  // 1,050,000, `top_provider.max_completion_tokens` 128,000) and models.dev
  // (`limit.context` 1,050,000, `limit.input` 922,000, `limit.output`
  // 128,000). The same 1,050,000 / 128,000 spec is verified for gpt-6.1-sol,
  // gpt-6-sol, and gpt-6-luna (both sources).
  //
  // Unlike the 5.6 family, there is NO published Codex-route cap for these
  // models: OpenAI's Codex bundled metadata pin (openai/codex#33972) covers
  // the 5.6 family only, and no Astra/Sol/Luna Codex number (or pricing-tier
  // boundary rule) could be found as of 2026-10-13 — in-session research came
  // back empty (no web tooling available; zero Astra references in-tree).
  // So the descriptors below carry the full API spec instead of a
  // Codex-route pin. Do NOT copy the 5.6 272k cap here: that number is
  // verified ONLY for the 5.6 family. FIRST-500 MONITORING: watch early
  // production Codex traffic for 500 "input exceeds the context window"
  // failures (issue #1118 precedent); if the Codex backend enforces a lower
  // effective cap, pin these descriptors to it with provenance.
  // The 1.05M API spec lives in the openai-vendor catalog entries, same as
  // the 5.6 family. Last cross-checked 2026-10-13.
  gpt6Model('gpt-6-astra', 'GPT-6 Astra', 1_050_000, 128_000),
  gpt6Model('gpt-6.1-sol', 'GPT-6.1 Sol', 1_050_000, 128_000),
  gpt6Model('gpt-6-sol', 'GPT-6 Sol', 1_050_000, 128_000),
  gpt6Model('gpt-6-luna', 'GPT-6 Luna', 1_050_000, 128_000),
]
