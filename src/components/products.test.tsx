import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, SIGNATURES, setFamily, type Config } from '../lib/config'
import ConfigPanel from './ConfigPanel'
import { EstimateDialog } from './Dialogs'

const panel = (
  config: Config,
  step: number,
  tracing: { trace?: boolean; traceSupported?: boolean; cloud?: boolean } = {},
) =>
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
      trace
      setTrace={vi.fn()}
      traceSupported
      cloud={false}
      notify={vi.fn()}
      onPlan={vi.fn()}
      onSignature={vi.fn()}
      {...tracing}
    />,
  )

describe('family-specific presentation', () => {
  it('opens with the five signature builds drawn from their own configurations', () => {
    const html = panel(DEFAULT_CONFIG, 0)
    for (const build of SIGNATURES) expect(html).toContain(build.name)
    expect(html.match(/class="signature-art"/g)).toHaveLength(SIGNATURES.length)
  })
  it('offers interior finishes, the concrete floor, and grouped equipment', () => {
    const html = panel(DEFAULT_CONFIG, 2)
    for (const name of ['Gallery white', 'Oak slat ceiling', 'Warm cedar', 'Birch ply'])
      expect(html).toContain(name)
    for (const name of ['Polished concrete look', 'Functional trainer', 'Air bike', 'Half rack'])
      expect(html).toContain(name)
  })
  it('offers path-traced stills wherever an engine can trace them, and says which', () => {
    const stills = (tracing: { trace?: boolean; traceSupported?: boolean; cloud?: boolean }) => {
      const html = panel(DEFAULT_CONFIG, 3, tracing)
      const match =
        /<button class="toggle-row" role="switch" aria-checked="(true|false)"><span><strong>Path-traced stills<\/strong><small>([^<]*)<\/small>/.exec(
          html,
        )
      expect(match).not.toBeNull()
      return { on: match![1] === 'true', detail: match![2] }
    }
    // WebGPU alone: this device traces.
    expect(stills({ traceSupported: true, cloud: false })).toMatchObject({ on: true })
    expect(stills({ traceSupported: true, cloud: false }).detail).toContain('traced on this device')
    // A cloud renderer traces for any browser, WebGPU or not: the switch follows `trace` and
    // turns it off, rather than showing it off and stuck.
    expect(stills({ traceSupported: false, cloud: true })).toMatchObject({ on: true })
    expect(stills({ traceSupported: false, cloud: true }).detail).toContain('traced in the cloud')
    expect(stills({ trace: false, traceSupported: false, cloud: true })).toMatchObject({
      on: false,
    })
    expect(stills({ traceSupported: true, cloud: true }).detail).toContain('traced in the cloud')
    // Neither: off, and said why.
    const neither = stills({ traceSupported: false, cloud: false })
    expect(neither.on).toBe(false)
    expect(neither.detail).toContain('Needs a browser with WebGPU or a cloud renderer')
  })
  it('offers exactly the four customer scenes', () => {
    const html = panel(DEFAULT_CONFIG, 3)
    for (const name of [
      'Studio backdrop',
      'Residential courtyard',
      'Corporate campus',
      'Desert retreat',
    ])
      expect(html).toContain(name)
    expect(html).not.toContain('Private backyard')
    expect(html.match(/class="environment-card /g)).toHaveLength(4)
  })
  it('shows source-backed Container dimensions and no Studio configuration selector', () => {
    const html = panel(setFamily(DEFAULT_CONFIG, 'container'), 0)
    expect(html).toContain('9.5′')
    expect(html).toContain('gym-design/container')
    expect(html).not.toContain('Configuration request')
    expect(html).toContain('not a price for this size or configuration')
  })
  it('offers Container openings and portfolio additions, not Studio-only options', () => {
    const html = panel(setFamily(DEFAULT_CONFIG, 'container'), 1)
    for (const name of [
      '10′ roll-up door',
      'Center opening',
      'Partial open-side',
      'Full open-side',
      'Integrated exterior finish',
      'Portfolio additions',
      'Front deck',
      'Rooftop deck',
      'Exterior staircase',
      'Entry canopy',
      'Show the roll-up door raised',
    ])
      expect(html).toContain(name)
    expect(html).not.toContain('Gazebo')
    expect(html).not.toContain('Concept timber accent')
    expect(html).not.toContain('Hinged glass door')
    expect(html).toContain('not approved construction dimensions')
    // Infill choices appear once an open-side opening is chosen.
    expect(html).not.toContain('Glass overhead door')
    const open = panel({ ...setFamily(DEFAULT_CONFIG, 'container'), containerOpening: 'full' }, 1)
    for (const name of ['Glass overhead door', 'Top-hung glass sashes', 'Open side'])
      expect(open).toContain(name)
  })
  it('offers Studio additions and labels the custom single-unit preview', () => {
    const exterior = panel(DEFAULT_CONFIG, 1)
    for (const name of [
      'Front deck',
      'Gazebo',
      'Rooftop deck',
      'Exterior staircase',
      'Hinged glass door',
      'Sliding glass door',
    ])
      expect(exterior).toContain(name)
    expect(exterior).not.toContain('Container opening')
    expect(exterior).not.toContain('Entry canopy')
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
