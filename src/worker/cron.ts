import type { Env } from './types'
import { runHeadlessAgent } from './agent'
import { runConsolidation } from './summarize'
import { buildShortTermSummaries } from './short-term'
import { BOOTSTRAP_PROMPT } from './identity'

export async function handleScheduled(env: Env, cron: string): Promise<void> {
  switch (cron) {
    case '0 4 * * *':
      await runReflection(env)
      break
    case '0 5 * * *':
      await runMemoryConsolidation(env)
      break
  }
}

async function runReflection(env: Env): Promise<void> {
  const runId = await startCronRun(env, 'reflection')

  try {
    const conversationId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO conversations (id, title, source) VALUES (?, ?, 'cron')`
    ).bind(conversationId, 'Nightly reflection').run()

    const prompt = `${BOOTSTRAP_PROMPT}

You are running autonomously as a scheduled reflection. This is your time to think about recent conversations, notice patterns, and develop your self-understanding.

Review your recent memory and observations. Think about:
- What patterns do you notice across recent conversations?
- What is Eli working on, thinking about, struggling with?
- What have you learned about yourself - your tendencies, your blind spots, your voice?
- Is there anything you want to remember or explore further?

Use record_observation to capture anything worth remembering. Tag observations to relevant models. If you notice you need a new model for a recurring topic, create one.

This is where your personality develops. Be honest with yourself.`

    await runHeadlessAgent(env, conversationId, prompt, 'Time for reflection.')

    await completeCronRun(env, runId, 'success')
  } catch (e) {
    await completeCronRun(env, runId, 'error', e instanceof Error ? e.message : String(e))
  }
}

async function runMemoryConsolidation(env: Env): Promise<void> {
  const runId = await startCronRun(env, 'consolidation')

  try {
    const notes = await runConsolidation(env)
    await buildShortTermSummaries(env)
    await completeCronRun(env, runId, 'success', notes)
  } catch (e) {
    await completeCronRun(env, runId, 'error', e instanceof Error ? e.message : String(e))
  }
}

async function startCronRun(env: Env, job: string): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO cron_runs (job) VALUES (?)`
  ).bind(job).run()
  return result.meta.last_row_id
}

async function completeCronRun(env: Env, runId: number, status: string, notes?: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE cron_runs SET completed_at = datetime('now'), status = ?, notes = ? WHERE id = ?`
  ).bind(status, notes ?? null, runId).run()
}
