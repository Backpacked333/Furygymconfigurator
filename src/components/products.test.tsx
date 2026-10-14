import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, setFamily, type Config } from '../lib/config'
import ConfigPanel from './ConfigPanel'
import { EstimateDialog } from './Dialogs'

const panel = (config: Config, step: number) =>
  renderToStaticMarkup(
    <ConfigPanel
      config={config}
      step={step}
      unit="ft"
      quality="high"
      onChange={vi.fn()}
      setStep={vi.fn()}
      setUnit={vi.fn()}
      setQuality={vi.fn()}
      notify={vi.fn()}
      onPlan={vi.fn()}
      onTemplate={vi.fn()}
    />,
  )

describe('family-specific presentation', () => {
  it('shows source-backed Container dimensions and no Studio configuration selector', () => {
    const html = panel(setFamily(DEFAULT_CONFIG, 'container'), 0)
    expect(html).toContain('9.5′')
    expect(html).toContain('gym-design/container')
    expect(html).not.toContain('Configuration request')
    expect(html).toContain('not a price for this size or configuration')
  })
  it('offers Container openings, not Studio additions or timber accents', () => {
    const html = panel(setFamily(DEFAULT_CONFIG, 'container'), 1)
    for (const name of [
      '10′ roll-up door',
      'Center opening',
      'Partial open-side',
      'Full open-side',
      'Integrated exterior finish',
    ])
      expect(html).toContain(name)
    expect(html).not.toContain('Front deck')
    expect(html).not.toContain('Concept timber accent')
    expect(html).toContain('not approved construction dimensions')
  })
  it('offers Studio additions and labels the custom single-unit preview', () => {
    const exterior = panel(DEFAULT_CONFIG, 1)
    for (const name of ['Front deck', 'Gazebo', 'Rooftop deck', 'Exterior staircase'])
      expect(exterior).toContain(name)
    expect(exterior).not.toContain('Container opening')
    const custom = panel({ ...DEFAULT_CONFIG, studioLayout: 'stacked' }, 0)
    expect(custom).toContain('The scene shows one reference unit')
  })
  it.each(['studio', 'container'] as const)(
    'labels %s prices as family starting prices without a total or financing calculator',
    (family) => {
      const html = renderToStaticMarkup(
        <EstimateDialog config={setFamily(DEFAULT_CONFIG, family)} onClose={vi.fn()} />,
      )
      expect(html).toContain(family === 'studio' ? '$35,000' : '$20,000')
      expect(html).toContain('Quote required')
      expect(html).not.toContain('Illustrative total')
      expect(html).not.toContain('APR assumption')
      expect(html).toContain('https://www.furycogyms.com/start-a-project')
      expect(html).toContain('not automatically sent')
    },
  )
})
