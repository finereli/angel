import { describe, it, expect } from 'vitest'
import { buildSystemDoc } from './system-doc'
import { MODEL_CATALOG } from './models'

// The doc is served through the read_system_doc tool, so nothing here depends on
// the tool registry. The model inventory is generated from the code: add a model
// to MODEL_CATALOG and the doc must carry it. That is what keeps it from going
// stale the way the old hand-written default did (it still claimed DeepSeek was
// the only model).
describe('system doc', () => {
  const doc = buildSystemDoc()

  it('describes the machine, not just a stub', () => {
    expect(doc.length).toBeGreaterThan(500)
    expect(doc).toContain('Durable Object')
    expect(doc).toContain('D1')
    expect(doc).toContain('recall')
  })

  it('names every model in the catalog', () => {
    for (const m of MODEL_CATALOG) expect(doc).toContain(m.label)
  })
})