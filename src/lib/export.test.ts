import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from './config'
import { createBrief } from './export'
import { pdfText, validateProject } from './pdfText'
import { occupiedEnvelope } from './spatial'

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

  it('draws physical protrusions and rotated origin offsets, not centered catalog boxes', async () => {
    const item = { id: 'offset-bench', sku: 'bench', x: -6, z: 0, rotation: 90 } as const
    const config = { ...structuredClone(DEFAULT_CONFIG), items: [item] }
    const output = (await createBrief(config, null, { name: 'Spatial parity', notes: '' })).output()
    const rectangles = [...output.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re/g)].map(
      (match) => match.slice(1).map(Number),
    )
    const points = 72 / 25.4
    const scale = 174 / config.length
    const frame = rectangles.find(
      ([, , w, h]) => Math.abs(w - 174 * points) < 1e-6 && Math.abs(h + 8 * scale * points) < 1e-6,
    )!
    expect(frame).toBeDefined()
    const bounds = occupiedEnvelope(item)
    const expected = [
      frame[0] + (bounds.min.x + config.length / 2) * scale * points,
      frame[1] - (bounds.min.z + 4) * scale * points,
      (bounds.max.x - bounds.min.x) * scale * points,
      -(bounds.max.z - bounds.min.z) * scale * points,
    ]
    expect(
      rectangles.some((rect) =>
        rect.every((value, axis) => Math.abs(value - expected[axis]) < 1e-6),
      ),
    ).toBe(true)
  })

  it('keeps roof/access elevations and inquiry-only site context separate from the floor', async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.addons = { deck: true, gazebo: false, roof: true, stairs: true }
    config.presentation.context = 'sunken-lounge'
    const output = (
      await createBrief(config, null, { name: 'Multilevel concept', notes: '' })
    ).output()
    expect(output).toContain('Ground-contact and multilevel structures')
    expect(output).toContain('Raised structures and opening poses')
    expect(output).toContain('Roof access landing')
    expect(output).toContain('Inquiry-only site context')
    expect(output).toContain('Sunken lounge site context')
    expect(output).toContain('not a certified clearance')
  })
})
