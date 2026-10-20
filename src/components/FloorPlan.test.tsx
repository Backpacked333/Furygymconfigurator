// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, projectDesignToConfig } from '../domain/design'
import { arrangementEquipment, FIXED_ARRANGEMENTS } from '../domain/arrangements'
import {
  DEFAULT_CONFIG,
  entryCenter,
  openingGeometry,
  studioBays,
  studioDoorCenter,
  type Config,
} from '../lib/config'
import { DesignSpecification } from '../prototype/DesignSpecification'
import FloorPlan from './FloorPlan'

describe('shared FloorPlan editing policy (jsdom, not visual verification)', () => {
  let host: HTMLDivElement, root: Root
  const change = vi.fn(),
    notify = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    change.mockClear()
    notify.mockClear()
    Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
      configurable: true,
      value: () => null,
    })
    Object.defineProperty(SVGSVGElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(SVGSVGElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    })
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const key = (target: Element, value: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
    })
  const pointer = (target: Element, type: string) =>
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }))
    })
  const render = (config: Config, readOnly = false) =>
    act(() =>
      root.render(
        <FloorPlan
          config={config}
          unit="ft"
          readOnly={readOnly}
          onChange={change}
          notify={notify}
        />,
      ),
    )
  const editable: Config = {
    ...DEFAULT_CONFIG,
    items: [{ id: 'bench', sku: 'bench', x: -4, z: 0, rotation: 0 }],
  }

  it('keeps editable default keyboard move/rotate/delete and selection controls', () => {
    act(() =>
      root.render(<FloorPlan config={editable} unit="ft" onChange={change} notify={notify} />),
    )
    const item = host.querySelector('[data-equipment]')!
    expect(item.getAttribute('role')).toBe('button')
    key(item, 'ArrowRight')
    expect(change.mock.calls.at(-1)?.[0].items[0]).toMatchObject({ x: -3.75, z: 0 })
    key(item, 'r')
    expect(change.mock.calls.at(-1)?.[0].items[0].rotation).toBe(90)
    key(item, 'Enter')
    expect(host.textContent).toContain('Rotate')
    expect(host.textContent).toContain('Remove')
    key(item, 'Delete')
    expect(change.mock.calls.at(-1)?.[0].items).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('retains placement rejection for the floor bounds, planned entry and overlapping equipment', () => {
    const cases: { config: Config; key: string; message: string }[] = [
      {
        config: { ...editable, items: [{ ...editable.items[0], x: 9 }] },
        key: 'ArrowRight',
        message: 'inside the usable floor area',
      },
      {
        config: {
          ...editable,
          items: [{ ...editable.items[0], x: entryCenter(editable), z: 0.5 }],
        },
        key: 'ArrowDown',
        message: 'planned entry clear',
      },
      {
        config: {
          ...editable,
          items: [...editable.items, { ...editable.items[0], id: 'other', x: -1.9 }],
        },
        key: 'ArrowRight',
        message: 'overlaps',
      },
    ]
    for (const test of cases) {
      change.mockClear()
      notify.mockClear()
      render(test.config)
      key(host.querySelector('[data-equipment]')!, test.key)
      expect(change).not.toHaveBeenCalled()
      expect(notify.mock.calls[0]?.[0]).toContain(test.message)
    }
  })

  it('keeps legacy pointer selection/commit and rejects an invalid pointer drop', () => {
    render(editable)
    pointer(host.querySelector('[data-equipment]')!, 'pointerdown')
    expect(host.textContent).toContain('Rotate')
    pointer(host.querySelector('svg')!, 'pointerup')
    expect(change).toHaveBeenCalledTimes(1)
    expect(change.mock.calls[0][0].items).toEqual(editable.items)
    change.mockClear()
    render({ ...editable, items: [{ ...editable.items[0], x: 10 }] })
    pointer(host.querySelector('[data-equipment]')!, 'pointerdown')
    pointer(host.querySelector('svg')!, 'pointermove')
    pointer(host.querySelector('svg')!, 'pointerup')
    expect(change).not.toHaveBeenCalled()
    expect(notify.mock.calls.at(-1)?.[0]).toContain('inside the usable floor area')
  })

  it.each(FIXED_ARRANGEMENTS)(
    'renders exact $id inventory/occupied geometry with no mutation ingress',
    (arrangement) => {
      const design = defaultDesign({ family: arrangement.family, lengthFt: arrangement.lengthFt })
      const config = projectDesignToConfig(design)
      const before = structuredClone(config)
      render(config, true)
      expect(host.querySelectorAll('[tabindex],button,[role=button],.plan-item')).toHaveLength(0)
      const items = [...host.querySelectorAll('[data-equipment]')]
      expect(items).toHaveLength(arrangement.items.length)
      items.forEach((element, index) => {
        const item = arrangement.items[index]
        const dimensions = arrangementEquipment(item.sku)
        expect(element.getAttribute('data-equipment')).toBe(item.sku)
        expect(element.getAttribute('transform')).toBe(`translate(${item.x} ${item.z})`)
        expect(Number(element.querySelector('rect')!.getAttribute('width'))).toBe(
          item.rotation === 90 ? dimensions.depthFt : dimensions.occupiedWidthFt,
        )
        expect(Number(element.querySelector('rect')!.getAttribute('height'))).toBe(
          item.rotation === 90 ? dimensions.occupiedWidthFt : dimensions.depthFt,
        )
        for (const action of [
          'Enter',
          ' ',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Delete',
          'Backspace',
          'r',
          'R',
        ])
          key(element, action)
        for (const action of [
          'mousedown',
          'click',
          'pointerdown',
          'pointermove',
          'pointerup',
          'pointercancel',
        ])
          pointer(element, action)
      })
      for (const action of ['pointermove', 'pointerup', 'pointercancel'])
        pointer(host.querySelector('svg')!, action)
      expect(change).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
      expect(config).toEqual(before)
      expect(host.textContent).toContain('DRAFT · Fixed arrangement')
      expect(host.textContent).toContain('Ceiling, doors and access are unresolved')
      expect(host.querySelectorAll('[tabindex],button,[role=button]')).toHaveLength(0)
      const paths = [...host.querySelectorAll('path')].map((path) => path.getAttribute('d'))
      if (config.family === 'container') {
        const opening = openingGeometry(config)
        expect(paths).toContain(`M ${opening.center - opening.width / 2} 3.85 h ${opening.width}`)
      }
      expect(
        host.querySelector(`g[transform="translate(${entryCenter(config)} 0)"]`)?.textContent,
      ).toContain('ENTRY / KEEP CLEAR')
    },
  )

  it.each(['hinged', 'sliding'] as const)(
    'retains exact Studio %s door symbols in both modes',
    (studioDoor) => {
      const config = { ...projectDesignToConfig(defaultDesign()), studioDoor }
      const leaf = studioBays(config.length).width - 0.14
      const center = studioDoorCenter(config)
      const expected =
        studioDoor === 'sliding'
          ? `M ${center - leaf / 2} 4.1 h ${leaf * 2}`
          : `M ${center + leaf / 2 - leaf} 3.85 A ${leaf} ${leaf} 0 0 0 ${center + leaf / 2} ${3.85 + leaf}`
      for (const readOnly of [false, true]) {
        render(config, readOnly)
        const paths = [...host.querySelectorAll('path')].map((path) => path.getAttribute('d'))
        expect(paths).toContain(expected)
      }
    },
  )

  it('cannot commit a previously active drag after switching to read-only', () => {
    render(editable)
    pointer(host.querySelector('[data-equipment]')!, 'pointerdown')
    render(editable, true)
    pointer(host.querySelector('svg')!, 'pointerup')
    key(host.querySelector('[data-equipment]')!, 'Backspace')
    expect(change).not.toHaveBeenCalled()
    expect(host.querySelector('button')).toBeNull()
  })

  it('keeps SVG grid IDs distinct when the stage plan and specification coexist', () => {
    const design = defaultDesign()
    act(() =>
      root.render(
        <>
          <DesignSpecification design={design} unit="ft" showPlan compact />
          <DesignSpecification design={design} unit="ft" showPlan />
        </>,
      ),
    )
    const ids = [...host.querySelectorAll('pattern[id]')].map((element) => element.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const svg of host.querySelectorAll('svg.plan-svg')) {
      const id = svg.querySelector('pattern')!.id
      expect(svg.querySelector(`[fill="url(#${id})"]`)).not.toBeNull()
    }
  })

  it('reuses the shared plan in compact stage mode and shared specifications in full mode', () => {
    const design = defaultDesign({ family: 'container', lengthFt: 40 })
    act(() => root.render(<DesignSpecification design={design} unit="ft" showPlan compact />))
    expect(host.querySelector('.floor-plan.is-read-only')).not.toBeNull()
    expect(host.querySelectorAll('svg')).toHaveLength(1)
    expect(host.querySelector('table')).toBeNull()
    act(() => root.render(<DesignSpecification design={design} unit="m" showPlan />))
    expect(host.querySelector('.prototype-plan-frame .floor-plan.is-read-only')).not.toBeNull()
    expect(host.querySelector('.comparison table')).not.toBeNull()
    expect(host.textContent).toContain('Quote required')
    expect(host.querySelectorAll('.prototype-inventory li')).toHaveLength(6)
    expect(host.textContent).toContain('Rack footprint includes loaded bar')
  })
})
