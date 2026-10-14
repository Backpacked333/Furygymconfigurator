import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from './config'
import { createBrief } from './export'
import { pdfText, validateProject } from './pdfText'

vi.mock('./config', async (importOriginal) => {
  const config = await importOriginal<typeof import('./config')>()
  return {
    ...config,
    shareUrl: (value: typeof DEFAULT_CONFIG) =>
      'https://example.test/#c=' + config.encodeConfig(value),
  }
})

describe('EXPORT-04 PDF content and pagination', () => {
  it('keeps the full maximum notes, final notices and clickable links', async () => {
    const marker = 'LAST-NOTE-8Z2'
    const notes = 'A site access requirement. '.repeat(100).slice(0, 2000 - marker.length) + marker
    const pdf = await createBrief(structuredClone(DEFAULT_CONFIG), null, {
      name: 'A long name with accented Latin text: café, déjà vu',
      notes,
    })
    const output = pdf.output()
    expect(output).toContain(marker)
    expect(output).toContain('NOT FOR CONSTRUCTION')
    expect(output).toContain('not been sent to a sales team')
    expect(output).toContain('/Subtype /Link')
    expect(output).toContain('https://www.furycogyms.com/start-a-project')
    expect(pdf.getNumberOfPages()).toBeGreaterThanOrEqual(3)
    expect(output.match(/NOT FOR CONSTRUCTION/g)?.length).toBe(pdf.getNumberOfPages())
  })

  it('does not silently truncate or corrupt unsupported text', () => {
    expect(() => validateProject({ name: 'A'.repeat(61), notes: '' })).toThrow('60 characters')
    expect(() => validateProject({ name: 'Gym', notes: 'N'.repeat(2001) })).toThrow('2,000')
    expect(() => pdfText('שלום')).toThrow('Latin-script')
    expect(() => pdfText('Gym\u0000')).toThrow('Latin-script')
    expect(pdfText('20′ × 8′ — “café”\r\nNotes…')).toBe('20\' x 8\' - "café"\nNotes...')
  })

  it('freezes configuration and project before lazy PDF loading', async () => {
    const configuration = structuredClone(DEFAULT_CONFIG)
    const project = { name: 'Snapshot original', notes: 'Snapshot notes' }
    const pending = createBrief(configuration, null, project)
    configuration.finish = 'chalk'
    project.name = 'Mutated name'
    project.notes = 'Mutated notes'
    const output = (await pending).output()
    expect(output).toContain('Snapshot original')
    expect(output).toContain('Snapshot notes')
    expect(output).not.toContain('Mutated name')
    expect(output).not.toContain('Mutated notes')
  })
})
