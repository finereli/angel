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
  { id: 'deepseek/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash (1017)', tier: 'flash', reasoning: true, priceInPerM: 0.15, priceOutPerM: 0.60 },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.05, priceOutPerM: 0.38 },
  { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash (0731)', tier: 'flash', reasoning: true, priceInPerM: 0.44, priceOutPerM: 1.32 },
  { id: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro (0813)', tier: 'flagship', reasoning: true, priceInPerM: 0.66, priceOutPerM: 1.98 },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', tier: 'flash', reasoning: true, priceInPerM: 0.10, priceOutPerM: 0.50 },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', tier: 'flash', reasoning: true, priceInPerM: 0.10, priceOutPerM: 0.50 },
  { id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo V2.6 Pro', tier: 'flagship', reasoning: true, priceInPerM: 0.44, priceOutPerM: 0.87 },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.04, priceOutPerM: 0.12 },
  { id: 'inception/mercury-3', label: 'Mercury 3', tier: 'flash', reasoning: true, priceInPerM: 0.10, priceOutPerM: 0.35 },
  { id: 'inclusionai/ling-3.1-flash', label: 'Ling 3.1 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.08, priceOutPerM: 0.23 },
  { id: 'qwen/qwen3.8-max-prime', label: 'Qwen3.8 Max Prime', tier: 'flagship', reasoning: true, priceInPerM: 4.00, priceOutPerM: 12.00 },
  { id: 'qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max', tier: 'flagship', reasoning: true, priceInPerM: 2.00, priceOutPerM: 6.00 },
  { id: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.15, priceOutPerM: 0.47 },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B', tier: 'flash', reasoning: true, priceInPerM: 0.04, priceOutPerM: 1.35 },
  { id: 'qwen/qwen3.7-flash', label: 'Qwen3.7 Flash', tier: 'flash', reasoning: true, priceInPerM: 0.03, priceOutPerM: 0.13 },
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
