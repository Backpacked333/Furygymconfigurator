// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  configSchema,
  DEFAULT_CONFIG,
  encodeConfig,
  layoutIssues,
  type Config,
} from '../lib/config'
import {
  configReducer,
  type EditAction,
  type EditState,
  type EditToken,
} from '../lib/editTransactions'
import { spatialContract } from '../lib/spatial'
import FloorPlan, { type EditInteractionProps } from './FloorPlan'
import ConfigPanel from './ConfigPanel'
import Modal from './Modal'

const initial = (): Config =>
  configSchema.parse({
    ...DEFAULT_CONFIG,
    items: [{ id: 'mat', sku: 'mat', x: -4, z: 0, rotation: 0 }],
  })
let root: Root, container: HTMLDivElement, state: EditState, kind: 'plan' | 'panel', step: number
let editing: EditInteractionProps, fallback: boolean, repairWorkspace: boolean, serial: number
let externalKey: number, disabled: boolean
let onChange: Mock<(config: Config) => void>, notify: Mock<(message: string) => void>
let captures: Set<number>, capture: ReturnType<typeof vi.fn>, release: ReturnType<typeof vi.fn>
let setQualityMode: Mock<(mode: 'auto' | 'ultra' | 'high' | 'lite') => void>

function render() {
  const config = state.preview?.config ?? state.present
  const common = {
    config,
    onChange,
    notify,
    unit: 'ft' as const,
    revision: state.revision,
    interactionKey: externalKey,
    interactionDisabled: disabled,
    ...(fallback ? {} : editing),
  }
  root.render(
    <StrictMode>
      {kind === 'plan' ? (
        <FloorPlan {...common} repairWorkspace={repairWorkspace} />
      ) : (
        <ConfigPanel
          {...common}
          step={step}
          setStep={(next) => {
            step = next
            render()
          }}
          quality="high"
          qualityMode="auto"
          setQualityMode={setQualityMode}
          setQuality={vi.fn()}
          setUnit={vi.fn()}
          onPlan={vi.fn()}
          onTemplate={vi.fn()}
        />
      )}
    </StrictMode>,
  )
}
function apply(action: EditAction) {
  state = configReducer(state, action)
  render()
  return state.result
}
function mount(mode: typeof kind = 'plan', config = initial(), repair = false) {
  kind = mode
  repairWorkspace = repair
  state = {
    past: [],
    future: [],
    present: config,
    revision: 0,
    notice: '',
    repairWorkspace: repair,
  }
  act(render)
}
function query<T extends Element = HTMLElement>(selector: string): T {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`Missing element: ${selector}`)
  return element
}
function button(text: string) {
  const element = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.includes(text) || element.getAttribute('aria-label') === text,
  )
  if (!element) throw new Error(`Missing button: ${text}`)
  return element
}
function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
function key(element: Element, key: string, type = 'keydown', options: KeyboardEventInit = {}) {
  act(() =>
    element.dispatchEvent(
      new KeyboardEvent(type, { bubbles: true, cancelable: true, key, ...options }),
    ),
  )
}
function pointer(element: Element, type: string, x = -40, y = 0, id = 1) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  })
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: id === 1 } })
  act(() => element.dispatchEvent(event))
}
function range(value: number) {
  const input = query<HTMLInputElement>('input[type="range"]')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      String(value),
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const item = () => query<SVGGElement>('[data-item-id="mat"]')
const plan = () => query<SVGSVGElement>('.plan-svg')
const down = () => pointer(item(), 'pointerdown')
const move = (x = -30) => pointer(plan(), 'pointermove', x)
const up = () => pointer(plan(), 'pointerup')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'DOMPoint',
    class {
      constructor(
        public x: number,
        public y: number,
      ) {}
      matrixTransform() {
        return { x: this.x / 10, y: this.y / 10 }
      }
    },
  )
  captures = new Set()
  capture = vi.fn((id: number) => {
    captures.add(id)
  })
  release = vi.fn((id: number) => {
    captures.delete(id)
  })
  Object.defineProperties(SVGSVGElement.prototype, {
    getScreenCTM: { configurable: true, value: () => ({ inverse: () => ({}) }) },
    setPointerCapture: { configurable: true, value: capture },
    hasPointerCapture: { configurable: true, value: (id: number) => captures.has(id) },
    releasePointerCapture: { configurable: true, value: release },
  })
  Object.defineProperties(HTMLInputElement.prototype, {
    setPointerCapture: { configurable: true, value: capture },
    hasPointerCapture: { configurable: true, value: (id: number) => captures.has(id) },
    releasePointerCapture: { configurable: true, value: release },
  })
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false
      },
    },
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  serial = 0
  fallback = false
  step = 3
  externalKey = 0
  disabled = false
  notify = vi.fn()
  setQualityMode = vi.fn()
  onChange = vi.fn((config: Config) => {
    apply({ type: 'set', config })
  })
  editing = {
    onBeginEdit: vi.fn(() => {
      const token = { id: `edit-${++serial}`, baseRevision: state.revision ?? 0 }
      apply({ type: 'begin', token })
      return token
    }),
    onPreviewEdit: vi.fn((token: EditToken, config: Config) =>
      apply({ type: 'preview', token, config }),
    ),
    onCommitEdit: vi.fn((token: EditToken, config?: Config) =>
      apply({ type: 'commit', token, config }),
    ),
    onCancelEdit: vi.fn((token?: EditToken) => apply({ type: 'cancel', token })),
  }
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('plan gesture ownership and history', () => {
  it('selects with an actual pointer click and makes no edit, custom state, or redo change', () => {
    mount()
    act(() => {
      apply({ type: 'set', config: { ...state.present, finish: 'chalk' } })
      apply({ type: 'undo' })
    })
    const before = encodeConfig(state.present),
      revision = state.revision,
      future = state.future
    down()
    up()
    click(item())
    expect(item().getAttribute('aria-pressed')).toBe('true')
    expect(editing.onBeginEdit).not.toHaveBeenCalled()
    expect(encodeConfig(state.present)).toBe(before)
    expect(state.present.package).toBe('strength')
    expect(state.revision).toBe(revision)
    expect(state.future).toBe(future)
    expect(state.past).toHaveLength(0)
    expect(capture).toHaveBeenCalledExactlyOnceWith(1)
    expect(release).toHaveBeenCalledExactlyOnceWith(1)
  })
  it('requires four CSS pixels of intent and commits a real move once; one Undo restores exact bytes', () => {
    mount()
    const before = encodeConfig(state.present)
    down()
    move(-38)
    expect(editing.onBeginEdit).not.toHaveBeenCalled()
    move(-50)
    move(-55)
    expect(state.present.items[0].x).toBe(-4)
    expect(state.past).toHaveLength(0)
    up()
    expect(state.present.items[0].x).toBe(-5.5)
    expect(state.present.package).toBe('custom')
    expect(editing.onBeginEdit).toHaveBeenCalledTimes(1)
    expect(editing.onCommitEdit).toHaveBeenCalledTimes(1)
    expect(state.past).toHaveLength(1)
    act(() => {
      apply({ type: 'undo' })
    })
    expect(encodeConfig(state.present)).toBe(before)
  })
  it('keeps invalid ghosts distinct and rejects release with a reason', () => {
    mount()
    const before = encodeConfig(state.present)
    down()
    move(250)
    expect(item().classList.contains('invalid')).toBe(true)
    expect(query('.plan-status').textContent).toContain('Invalid preview:')
    up()
    expect(encodeConfig(state.present)).toBe(before)
    expect(state.preview).toBeUndefined()
    expect(editing.onCommitEdit).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalled()
  })
  it('preserves redo when a drag returns to the snapped original', () => {
    mount()
    act(() => {
      apply({ type: 'set', config: { ...state.present, time: 10 } })
      apply({ type: 'undo' })
    })
    const future = state.future
    down()
    move()
    move(-40)
    up()
    expect(state.present.package).toBe('strength')
    expect(state.past).toHaveLength(0)
    expect(state.future).toBe(future)
    expect(editing.onCommitEdit).not.toHaveBeenCalled()
  })
  it.each([
    'pointercancel',
    'lostpointercapture',
    'window-blur',
    'modal',
    'view',
    'disabled',
    'delete',
    'revision',
  ])('cancels cleanly on %s', (reason) => {
    mount()
    down()
    move()
    if (reason === 'pointercancel' || reason === 'lostpointercapture') pointer(plan(), reason)
    else
      act(() => {
        if (reason === 'window-blur') window.dispatchEvent(new Event('blur'))
        else if (reason === 'modal') window.dispatchEvent(new Event('fury:modal-open'))
        else if (reason === 'view') {
          externalKey++
          render()
        } else if (reason === 'disabled') {
          disabled = true
          render()
        } else
          apply({
            type: 'set',
            config: { ...state.present, ...(reason === 'delete' ? { items: [] } : { time: 11 }) },
          })
      })
    up()
    expect(state.preview).toBeUndefined()
    expect(editing.onCommitEdit).not.toHaveBeenCalled()
    expect(captures.size).toBe(0)
    if (reason === 'revision') expect(state.present.time).toBe(11)
    if (reason === 'delete') expect(state.present.items).toHaveLength(0)
  })
  it('ignores a second pointer throughout the first gesture', () => {
    mount()
    down()
    pointer(item(), 'pointerdown', -40, 0, 2)
    pointer(plan(), 'pointermove', 200, 0, 2)
    pointer(plan(), 'pointerup', 200, 0, 2)
    expect(editing.onBeginEdit).not.toHaveBeenCalled()
    move()
    up()
    expect(capture).toHaveBeenCalledExactlyOnceWith(1)
    expect(state.present.items[0].x).toBe(-3)
    expect(state.past).toHaveLength(1)
  })
  it('groups a held keyboard movement into one commit, with no background repeats after Escape', () => {
    mount()
    act(() => item().focus())
    key(item(), 'ArrowRight')
    key(item(), 'ArrowRight', 'keydown', { repeat: true })
    key(item(), 'ArrowRight', 'keydown', { repeat: true })
    expect(state.past).toHaveLength(0)
    key(item(), 'ArrowRight', 'keyup')
    expect(state.present.items[0].x).toBe(-3.25)
    expect(state.past).toHaveLength(1)
    key(item(), 'ArrowLeft')
    key(item(), 'Escape')
    key(item(), 'ArrowLeft', 'keydown', { repeat: true })
    key(item(), 'ArrowLeft', 'keyup')
    expect(state.present.items[0].x).toBe(-3.25)
    expect(editing.onCommitEdit).toHaveBeenCalledTimes(1)
    expect(state.preview).toBeUndefined()
  })
  it('cancels a held keyboard gesture on focus loss', () => {
    mount()
    act(() => item().focus())
    key(item(), 'ArrowRight')
    act(() => query<HTMLButtonElement>('.plan-toolbar button').focus())
    key(item(), 'ArrowRight', 'keyup')
    expect(state.preview).toBeUndefined()
    expect(state.past).toHaveLength(0)
  })
  it('supports pointer-only nudges and coordinates without a drag', () => {
    mount()
    click(item())
    click(button('Move right 3 inches'))
    expect(state.present.items[0].x).toBe(-3.75)
    const x = query<HTMLInputElement>('input[name="x"]')
    x.value = '-3'
    act(() => query('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(state.present.items[0].x).toBe(-3)
    expect(state.past).toHaveLength(2)
    expect(layoutIssues(state.present)).toEqual([])
  })
  it('permits incremental move, rotation, and deletion in a still-invalid repair workspace', () => {
    const invalid = initial()
    invalid.items[0].x = 12
    invalid.items.push({ ...invalid.items[0], id: 'other', x: 16 })
    mount('plan', invalid, true)
    click(item())
    click(button('Move left 3 inches'))
    click(button('Rotate'))
    expect(state.present.items[0]).toMatchObject({ x: 11.75, rotation: 90 })
    expect(layoutIssues(state.present).length).toBeGreaterThan(0)
    click(button('Remove'))
    expect(state.present.items.map((item) => item.id)).toEqual(['other'])
    expect(state.past).toHaveLength(3)
    expect(document.activeElement?.getAttribute('data-item-id')).toBe('other')
  })
  it('keeps onChange-only compatibility with local preview and one final write', () => {
    fallback = true
    mount()
    down()
    move()
    move(-55)
    expect(onChange).not.toHaveBeenCalled()
    up()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(state.present.items[0].x).toBe(-5.5)
  })
  it('renders shared G occupied, elevated, opening, and separately labeled context zones', () => {
    const config = {
      ...initial(),
      family: 'container' as const,
      items: [],
      openingConcept: 'raised-glazed' as const,
      addons: { deck: true, roof: true, stairs: true, gazebo: false },
      presentation: { openingPose: 'open' as const, context: 'sunken-lounge' as const },
    }
    mount('plan', config)
    const spatial = spatialContract(config)
    for (const zone of [...spatial.external, ...spatial.overhead, ...spatial.openings]) {
      const element = query(`[data-zone-id="${zone.id}"] rect`)
      expect(Number(element.getAttribute('width'))).toBeCloseTo(
        zone.bounds.max.x - zone.bounds.min.x,
      )
    }
    expect(query('[data-context-id="sunken-lounge"]').textContent).toContain('SITE INQUIRY ONLY')
    expect(container.textContent).toContain('above ground')
    expect(container.textContent).toContain('not a safety certification')
    const contextToggle = Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Site context'))!
      .querySelector('input')!
    click(contextToggle)
    expect(container.querySelector('[data-context-id]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('recovers from a schema-outside ghost without losing the pointer owner', () => {
    mount()
    down()
    move(250)
    expect(item().classList.contains('invalid')).toBe(true)
    expect(state.preview?.config.items[0].x).toBe(-4)
    move(-50)
    up()
    expect(state.present.items[0].x).toBe(-5)
    expect(state.past).toHaveLength(1)
  })
  it('rotates from the committed base when R interrupts a held movement', () => {
    mount()
    act(() => item().focus())
    key(item(), 'ArrowLeft')
    expect(state.preview?.config.items[0].x).toBe(-4.25)
    key(item(), 'r')
    key(item(), 'ArrowLeft', 'keyup')
    expect(state.present.items[0]).toMatchObject({ x: -4, rotation: 90 })
    expect(state.past).toHaveLength(1)
  })
  it('ignores stale callbacks after an external restore without reverting newer state', () => {
    mount()
    down()
    move(-50)
    act(() => {
      apply({
        type: 'restore',
        config: { ...initial(), finish: 'chalk', time: 9 },
        expectedRevision: 0,
      })
    })
    move(-60)
    up()
    expect(state.present).toMatchObject({ finish: 'chalk', time: 9 })
    expect(state.present.items[0].x).toBe(-4)
    expect(editing.onCommitEdit).not.toHaveBeenCalled()
  })
})

describe('daylight grouped edits and concept controls', () => {
  it('commits sixty lighting samples once and preserves the earlier finish for two Undos', () => {
    mount('panel')
    act(() => {
      apply({ type: 'set', config: { ...state.present, finish: 'chalk' } })
    })
    const input = query('input[type="range"]')
    pointer(input, 'pointerdown', 0)
    for (let i = 0; i < 60; i++) range(6 + i * 0.25)
    expect(state.present.time).toBe(16.5)
    expect(state.past).toHaveLength(1)
    expect(container.textContent).toContain('Not part of an export')
    pointer(input, 'pointerup', 100)
    expect(editing.onBeginEdit).toHaveBeenCalledTimes(1)
    expect(editing.onCommitEdit).toHaveBeenCalledTimes(1)
    expect(state.present.time).toBe(20.75)
    expect(state.past).toHaveLength(2)
    act(() => {
      apply({ type: 'undo' })
    })
    expect(state.present.finish).toBe('chalk')
    expect(state.present.time).toBe(16.5)
    act(() => {
      apply({ type: 'undo' })
    })
    expect(state.present.finish).toBe('obsidian')
  })
  it('groups keyboard changes; Escape and continued repeat do not commit', () => {
    mount('panel')
    const input = query('input[type="range"]')
    key(input, 'ArrowRight')
    range(16.75)
    key(input, 'ArrowRight', 'keydown', { repeat: true })
    range(17)
    expect(state.past).toHaveLength(0)
    key(input, 'ArrowRight', 'keyup')
    expect(state.present.time).toBe(17)
    expect(state.past).toHaveLength(1)
    key(input, 'ArrowLeft')
    range(16.75)
    key(input, 'Escape')
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowLeft',
      repeat: true,
    })
    act(() => input.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    key(input, 'ArrowLeft', 'keyup')
    expect(state.present.time).toBe(17)
    expect(state.preview).toBeUndefined()
  })
  it.each(['pointercancel', 'lostpointercapture', 'blur', 'modal', 'step', 'revision'])(
    'cancels daylight on %s',
    (reason) => {
      mount('panel')
      const input = query<HTMLInputElement>('input[type="range"]')
      act(() => input.focus())
      pointer(input, 'pointerdown', 0)
      range(10)
      if (reason === 'pointercancel' || reason === 'lostpointercapture') pointer(input, reason, 0)
      else
        act(() => {
          if (reason === 'blur') input.blur()
          if (reason === 'modal') window.dispatchEvent(new Event('fury:modal-open'))
          if (reason === 'step') {
            step = 0
            render()
          }
          if (reason === 'revision')
            apply({ type: 'set', config: { ...state.present, finish: 'chalk' } })
        })
      expect(state.preview).toBeUndefined()
      expect(state.present.time).toBe(16.5)
      expect(editing.onCommitEdit).not.toHaveBeenCalled()
      expect(captures.size).toBe(0)
    },
  )
  it('presets commit once, repeat selection does not edit, and Auto is optional', () => {
    mount('panel')
    click(button('Golden hour'))
    expect(state.present.time).toBe(17.5)
    expect(state.past).toHaveLength(1)
    click(button('Golden hour'))
    expect(editing.onCommitEdit).toHaveBeenCalledTimes(1)
    click(button('Auto'))
    expect(setQualityMode).toHaveBeenCalledWith('auto')
  })
  it('supports assistive-technology range changes and onChange-only fallback without flooding writes', () => {
    fallback = true
    mount('panel')
    range(10)
    expect(state.present.time).toBe(10)
    expect(onChange).toHaveBeenCalledTimes(1)
    const input = query('input[type="range"]')
    pointer(input, 'pointerdown', 0)
    range(11)
    range(12)
    expect(onChange).toHaveBeenCalledTimes(1)
    pointer(input, 'pointerup', 100)
    expect(state.present.time).toBe(12)
    expect(onChange).toHaveBeenCalledTimes(2)
  })
  it('separates published openings, reference concepts and visual pose without overwriting product choice', () => {
    step = 1
    mount('panel', { ...initial(), family: 'container', items: [] })
    expect(container.textContent).toContain('Published access + openings')
    expect(container.textContent).toContain('not published manufacturer options')
    const concept = query<HTMLButtonElement>('[aria-label="Reference opening concept"] button')
    click(concept)
    expect(state.present.openingConcept).not.toBe('standard')
    const choice = state.present.openingConcept
    click(button('Closed'))
    expect(state.present.presentation.openingPose).toBe('closed')
    expect(state.present.openingConcept).toBe(choice)
    click(button('10′ roll-up door'))
    expect(state.present.openingConcept).toBe('standard')
    expect(state.present.presentation.openingPose).toBe('closed')
    expect(container.textContent).toContain('Reference-backed Container additions')
    expect(container.textContent).not.toContain('Gazebo')
  })
  it('rejects incompatible family changes with a reason and preserves all original features', () => {
    step = 0
    const config = { ...initial(), addons: { ...initial().addons, gazebo: true } }
    mount('panel', config)
    const before = encodeConfig(state.present)
    click(query('[aria-label="Product family"] button:last-child'))
    expect(encodeConfig(state.present)).toBe(before)
    expect(query('[role="status"]').textContent).toMatch(/gazebo/i)
  })
  it('offers honest family-aware packages, empty shell and inquiry-only contexts', () => {
    step = 2
    mount('panel', { ...initial(), family: 'container', items: [] })
    expect(container.textContent).toContain('Pilates / movement')
    click(button('Strength'))
    expect(state.present.items.some((item) => item.sku === 'rack')).toBe(false)
    click(button('Empty'))
    expect(state.present.items).toHaveLength(0)
    act(() => {
      step = 3
      render()
    })
    click(button('Custom wellness'))
    expect(state.present.presentation.context).toBe('custom-wellness')
    expect(container.textContent).toContain('inquiry')
    click(button('Sunken lounge'))
    expect(state.present.presentation.context).toBe('sunken-lounge')
    expect(container.textContent).toContain('not bundled')
  })
})

describe('native dialog focus and background isolation', () => {
  it('contains Tab/Shift+Tab and programmatic focus, cancels gestures and restores its opener', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const modalEvent = vi.fn(),
      backgroundKey = vi.fn(),
      close = vi.fn()
    window.addEventListener('fury:modal-open', modalEvent)
    window.addEventListener('keydown', backgroundKey)
    act(() =>
      root.render(
        <StrictMode>
          <Modal title="Review design" subtitle="Concept only" onClose={close}>
            <input aria-label="Name" />
            <button>Final action</button>
            <div style={{ display: 'none' }}>
              <button>Hidden action</button>
            </div>
          </Modal>
        </StrictMode>,
      ),
    )
    const first = button('Close dialog'),
      last = button('Final action'),
      dialog = query<HTMLDialogElement>('dialog')
    expect(dialog.open).toBe(true)
    expect(modalEvent).toHaveBeenCalled()
    act(() => last.focus())
    key(last, 'Tab')
    expect(document.activeElement).toBe(first)
    key(first, 'Tab', 'keydown', { shiftKey: true })
    expect(document.activeElement).toBe(last)
    act(() => opener.focus())
    expect(dialog.contains(document.activeElement)).toBe(true)
    key(first, 'Delete')
    expect(backgroundKey).not.toHaveBeenCalled()
    act(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })))
    expect(close).toHaveBeenCalledTimes(1)
    act(() => root.render(null))
    expect(document.activeElement).toBe(opener)
    window.removeEventListener('fury:modal-open', modalEvent)
    window.removeEventListener('keydown', backgroundKey)
    opener.remove()
  })
  it('uses a connected fallback when the opener disappears and unique title IDs', () => {
    const fallbackButton = document.createElement('button')
    fallbackButton.dataset.modalFocusFallback = ''
    document.body.append(fallbackButton)
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    act(() =>
      root.render(
        <Modal title="Save" onClose={vi.fn()}>
          <button>Save</button>
        </Modal>,
      ),
    )
    const title = query('dialog').getAttribute('aria-labelledby')
    expect(title).not.toBe('dialog-title')
    expect(document.getElementById(title!)?.textContent).toBe('Save')
    opener.remove()
    act(() => root.render(null))
    expect(document.activeElement).toBe(fallbackButton)
    fallbackButton.remove()
  })
})
