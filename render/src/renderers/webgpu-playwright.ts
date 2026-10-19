import { chromium, type Browser, type Page } from 'playwright'
import type { Server } from 'node:http'
import { RENDERER_ID } from '../../../src/lib/renderKey'
import { serveBuild } from '../serve'
import type { RenderCapture, RenderJob, StillRenderer } from './types'

export type WebGpuOptions = {
  /** The app's production build (`dist`). */
  dist: string
  /** Render pages open at once; roughly one per 4 GB of video memory. */
  pages: number
  /** Accept a WebGL 2 or software adapter (CI smoke tests only; never for published stills). */
  allowFallback?: boolean
  /** Force the WebGL 2 backend: software WebGPU is unreliable on GPU-less smoke-test machines. */
  webgl?: boolean
  /** Pages are reloaded after this many jobs, so leaked GPU memory never accumulates. */
  recycleAfter?: number
  timeoutMs?: number
}

/**
 * Chromium flags for hardware WebGPU in a headless Linux container (NVIDIA with the Vulkan
 * driver capability). `--enable-unsafe-swiftshader` lets a GPU-less machine fall back to
 * software, which `allowFallback` must then accept explicitly.
 */
const FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,VulkanFromANGLE',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
]

type Slot = { page: Page; jobs: number; busy: boolean }

/** Drives the app's `?render` harness in headless Chromium. */
export class WebGpuPlaywrightRenderer implements StillRenderer {
  readonly id = RENDERER_ID
  private browser?: Browser
  private server?: Server
  private url = ''
  private slots: Slot[] = []
  private waiting: ((slot: Slot) => void)[] = []

  constructor(private options: WebGpuOptions) {}

  async init() {
    const served = await serveBuild(this.options.dist)
    this.server = served.server
    if (this.options.webgl && !this.options.allowFallback)
      throw new Error('WebGL rendering is for smoke tests only; pass --allow-fallback too.')
    this.url = `${served.url}/?render${this.options.webgl ? '&renderer=webgl' : ''}`
    this.browser = await chromium.launch({ args: FLAGS })
    for (let i = 0; i < this.options.pages; i++)
      this.slots.push({ page: await this.openPage(), jobs: 0, busy: false })
  }

  private async openPage() {
    const page = await this.browser!.newPage({ viewport: { width: 2048, height: 1152 } })
    page.on('pageerror', (e) => console.error(`[page] ${e.message}`))
    await page.goto(this.url)
    await page.waitForFunction(() => window.__fury && window.__fury.state !== 'booting', null, {
      timeout: 120_000,
    })
    const { state, backend, error } = await page.evaluate(() => ({
      state: window.__fury!.state,
      backend: window.__fury!.backend,
      error: window.__fury!.error,
    }))
    if (state === 'error') throw new Error(`Render page failed to start: ${error}`)
    const adapter = await page.evaluate(async () => {
      type Adapter = { info: { vendor: string; architecture: string; description: string } }
      const gpu = (navigator as { gpu?: { requestAdapter: () => Promise<Adapter | null> } }).gpu
      const a = await gpu?.requestAdapter()
      return a ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}`.trim() : 'none'
    })
    const software = /swiftshader|llvmpipe|software/i.test(adapter)
    if ((backend !== 'webgpu' || software) && !this.options.allowFallback)
      throw new Error(
        `Refusing to render published stills on ${backend} (${adapter}). Fix the GPU setup, or pass --allow-fallback for a smoke test.`,
      )
    return page
  }

  private acquire(): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy)
    if (free) {
      free.busy = true
      return Promise.resolve(free)
    }
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release(slot: Slot) {
    const next = this.waiting.shift()
    if (next) next(slot)
    else slot.busy = false
  }

  async render(job: RenderJob): Promise<RenderCapture> {
    const slot = await this.acquire()
    try {
      if (slot.jobs >= (this.options.recycleAfter ?? 200)) {
        await slot.page.close()
        slot.page = await this.openPage()
        slot.jobs = 0
      }
      slot.jobs++
      await slot.page.setViewportSize({ width: job.width, height: job.height })
      const capture = await Promise.race([
        slot.page.evaluate((j) => window.__fury!.run(j), job),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Job ${job.id} timed out`)),
            this.options.timeoutMs ?? 180_000,
          ),
        ),
      ])
      const state = await slot.page.evaluate(() => [window.__fury!.state, window.__fury!.error])
      if (state[0] === 'error') throw new Error(`Render page error: ${state[1]}`)
      return capture
    } catch (error) {
      // A page that failed or timed out is replaced before it takes another job.
      slot.jobs = Infinity
      throw error
    } finally {
      this.release(slot)
    }
  }

  async close() {
    await this.browser?.close()
    this.server?.close()
  }
}
