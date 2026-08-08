import type { Env, ModelRow } from './types'
import { chatCompletion } from './llm'
import { getAllModels } from './memory'

export async function routeMessage(
  env: Env,
  userMessage: string
): Promise<{ models: ModelRow[]; catalog: string }> {
  const allModels = await getAllModels(env)
  if (allModels.length === 0) {
    return { models: [], catalog: 'No memory models exist yet.' }
  }

  const catalog = allModels.map(m =>
    `- ${m.name} (${m.observation_count} obs): ${m.description || 'no description'}`
  ).join('\n')

  // For small model counts, just load everything
  if (allModels.length <= 5) {
    return {
      models: allModels.filter(m => m.portrait),
      catalog: formatCatalog(allModels),
    }
  }

  const result = await chatCompletion(env, [
    {
      role: 'system',
      content: `You are a memory router. Given a user message and a catalog of memory models, pick the 3-8 most relevant models. Return ONLY a JSON array of model names, nothing else.

Available models:
${catalog}`,
    },
    { role: 'user', content: userMessage },
  ], { temperature: 0, max_tokens: 256 })

  let picked: string[] = []
  try {
    const text = result.content || '[]'
    const match = text.match(/\[[\s\S]*\]/)
    if (match) picked = JSON.parse(match[0])
  } catch {
    picked = allModels.slice(0, 5).map(m => m.name)
  }

  const pickedModels = allModels.filter(m => picked.includes(m.name) && m.portrait)
  const unpicked = allModels.filter(m => !picked.includes(m.name))

  return {
    models: pickedModels,
    catalog: formatCatalog(unpicked),
  }
}

function formatCatalog(models: ModelRow[]): string {
  if (models.length === 0) return ''
  return `# Available memory models (not loaded - use memory_load_model to pull)\n${
    models.map(m => `- ${m.name} (${m.observation_count} obs): ${m.description || ''}`).join('\n')
  }`
}

export function formatRoutedMemory(models: ModelRow[]): string {
  if (models.length === 0) return ''
  const parts = ['# Loaded memory']
  for (const m of models) {
    parts.push(`## ${m.name}`)
    if (m.portrait) parts.push(m.portrait)
  }
  return parts.join('\n\n')
}
