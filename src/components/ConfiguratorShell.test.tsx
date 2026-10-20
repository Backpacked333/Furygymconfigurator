// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfiguratorShell,
  ConfiguratorPanelToggle,
  ConfiguratorSummary,
  ConfiguratorNotification,
} from './ConfiguratorShell'
import { StageHeader } from './StageHeader'
import { StageFrame, StageImageLayers, StageFilmstrip } from './StagePresentation'

describe('shared Fury presentation (DOM evidence, not visual parity)', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })
  it('retains default v3 shell classes, brand information action, skip target and a single supplied nav', () => {
    const brand = vi.fn(),
      toggle = vi.fn(),
      dismiss = vi.fn()
    act(() =>
      root.render(
        <ConfiguratorShell
          mobilePanel
          onBrand={brand}
          headerActions={
            <nav aria-label="Build actions">
              <button>My builds</button>
            </nav>
          }
          workspace={
            <>
              <section className="stage">
                <ConfiguratorPanelToggle open onToggle={toggle} />
              </section>
              <div id="configuration" className="panel-wrapper" />
            </>
          }
        >
          <ConfiguratorSummary
            monogram="S20"
            title="Your Studio"
            detail="20 ft"
            estimate="Quote required"
            action={<button>Build brief</button>}
          />
          <ConfiguratorNotification message="Saved" onDismiss={dismiss} />
        </ConfiguratorShell>,
      ),
    )
    expect(host.firstElementChild?.className).toBe('app panel-open')
    expect(host.querySelector('.skip-link')?.getAttribute('href')).toBe('#configuration')
    expect(host.querySelectorAll('header nav')).toHaveLength(1)
    expect(host.querySelector('.brand')?.textContent).toContain('FURY')
    act(() => (host.querySelector('.brand') as HTMLAnchorElement).click())
    expect(brand).toHaveBeenCalledOnce()
    act(() => (host.querySelector('.mobile-toggle') as HTMLButtonElement).click())
    expect(toggle).toHaveBeenCalledOnce()
    expect(host.querySelector('.mobile-toggle')?.getAttribute('aria-controls')).toBe(
      'configuration',
    )
    expect(host.querySelector('.summary-bar .summary-product')?.textContent).toContain(
      'Your Studio',
    )
    act(() =>
      (host.querySelector('[aria-label="Dismiss notification"]') as HTMLButtonElement).click(),
    )
    expect(dismiss).toHaveBeenCalledOnce()
  })
  it('wires the existing view and history controls without its own design state', () => {
    const view = vi.fn(),
      undo = vi.fn(),
      redo = vi.fn()
    act(() =>
      root.render(
        <StageHeader
          collection="CONTAINER GYMS"
          title="C-20"
          meta="160 ft²"
          view="interior"
          onView={view}
          canUndo
          canRedo={false}
          onUndo={undo}
          onRedo={redo}
          status={<span>Historical reference</span>}
        />,
      ),
    )
    const buttons = [...host.querySelectorAll('button')]
    expect(
      buttons.map((button) => button.textContent || button.getAttribute('aria-label')),
    ).toEqual(['Exterior', 'Interior', 'Floor plan', 'Undo last change', 'Redo last change'])
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
    act(() => {
      buttons[2].click()
      buttons[3].click()
      buttons[4].click()
    })
    expect(view).toHaveBeenCalledWith('plan')
    expect(undo).toHaveBeenCalledOnce()
    expect(redo).not.toHaveBeenCalled()
    expect(host.querySelector('h1')?.textContent).toBe('C-20Space to become more.')
  })
  it('retains keyed image elements and neutral alt/ref metadata across pending to shown roles', () => {
    const ref = vi.fn()
    const show = (role: string) =>
      act(() =>
        root.render(
          <StageFrame aspect="wide">
            <StageImageLayers
              busy={role === 'is-pending'}
              current={false}
              previous="Previous design"
              layers={[
                {
                  key: 'still',
                  role,
                  ref,
                  tier: 'export',
                  angle: 'front',
                  baked: true,
                  image: {
                    src: '/still.webp',
                    alt: 'Previous design: front',
                    srcSet: '/still.webp 1600w',
                  },
                },
              ]}
            />
          </StageFrame>,
        ),
      )
    show('is-pending')
    const image = host.querySelector('img')
    show('is-shown')
    expect(host.querySelector('img')).toBe(image)
    expect(image?.getAttribute('alt')).toBe('Previous design: front')
    expect(image?.dataset.baked).toBe('')
    expect(image?.dataset.tier).toBe('export')
    expect(host.querySelector('.still-stage')?.className).toBe('still-stage is-wide')
    expect(host.querySelector('.still-layers')?.getAttribute('aria-busy')).toBe('false')
    expect(ref).toHaveBeenCalledWith(image)
  })
  it('shares the original filmstrip classes, grouping and callbacks without inventing thumbnails', () => {
    const pick = vi.fn()
    act(() =>
      root.render(
        <StageFilmstrip
          aspect="tall"
          selected="entry"
          onPick={pick}
          items={[
            {
              id: 'front',
              label: 'Front',
              accessibleLabel: 'Front exterior view',
              group: 'exterior',
              url: '/front.webp',
            },
            {
              id: 'entry',
              label: 'Entry',
              accessibleLabel: 'Draft entry',
              group: 'interior',
              placeholder: 'DRAFT',
            },
          ]}
        />,
      ),
    )
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Camera angles')
    expect(host.querySelectorAll('img')).toHaveLength(1)
    const entry = host.querySelectorAll('button')[1]
    expect(entry.className).toBe('film-tile is-current starts-group')
    expect(entry.textContent).toBe('DRAFTEntry')
    act(() => entry.click())
    expect(pick).toHaveBeenCalledWith('entry')
  })
})
