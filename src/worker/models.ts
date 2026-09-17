// The models offered in the settings screen, plus their per-token price -
// shown next to each option so a choice is never a guess. Pulled from
// OpenRouter's /api/v1/models; prices are USD per 1M tokens and drift over
// time, so they're a snapshot, not a live quote. `null` model = use the
// DEEPSEEK_MODEL secret / code default (see llm.ts getModel()).
//
// This is the server-side allowlist too: settings:set only accepts a model
// id that appears here (or null), never an arbitrary client-supplied string.

export interface ModelOption {
  id: string
  label: string
  tier: 'flagship' | 'flash'
  reasoning: boolean
  priceInPerM: number
  priceOutPerM: number
}

export const MODEL_CATALOG: ModelOption[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'flagship', reasoning: true, priceInPerM: 1.60, priceOutPerM: 3.20 },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.09, priceOutPerM: 0.18 },
  { id: 'qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max', tier: 'flagship', reasoning: true, priceInPerM: 2.00, priceOutPerM: 6.00 },
  { id: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.15, priceOutPerM: 0.47 },
]

export function isKnownModel(id: string): boolean {
  return MODEL_CATALOG.some(m => m.id === id)
}

export function modelSupportsReasoning(id: string | null | undefined): boolean {
  if (!id) return true // the default (DeepSeek) supports it
  return MODEL_CATALOG.find(m => m.id === id)?.reasoning ?? false
}

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v)
}
