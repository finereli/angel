// The models offered in the settings screen, plus their per-token price -
// shown next to each option so a choice is never a guess. Pulled from
// OpenRouter's /api/v1/models; prices are USD per 1M tokens and drift over
// time, so they're a snapshot, not a live quote.
//
// This is the server-side allowlist too: settings:set only accepts a model
// id that appears here, never an arbitrary client-supplied string.

export interface ModelOption {
  id: string
  label: string
  tier: 'flagship' | 'flash'
  reasoning: boolean
  priceInPerM: number
  priceOutPerM: number
}

export const MODEL_CATALOG: ModelOption[] = [
  { id: 'deepseek/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.15, priceOutPerM: 0.60 },
  { id: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.15, priceOutPerM: 0.47 },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', tier: 'flash', reasoning: true, priceInPerM: 0.10, priceOutPerM: 0.50 },
]

// Hand-picked, not a leaderboard: the latest flash model from DeepSeek and from
// Qwen, and Haiku, which makes a good companion. Used until someone picks a model, and for anyone whose saved model has since
// left the catalog. A constant in code, not server config: there is no env knob.
export const DEFAULT_MODEL = MODEL_CATALOG[0]!.id

// The model a request actually runs on.
export function resolveModel(saved: string | null | undefined): string {
  return saved && isKnownModel(saved) ? saved : DEFAULT_MODEL
}

export function modelLabel(id: string): string {
  return MODEL_CATALOG.find(m => m.id === id)?.label ?? id
}

export function isKnownModel(id: string): boolean {
  return MODEL_CATALOG.some(m => m.id === id)
}

export function modelSupportsReasoning(id: string | null | undefined): boolean {
  return MODEL_CATALOG.find(m => m.id === resolveModel(id))?.reasoning ?? false
}

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v)
}
