/* eslint-disable react-refresh/only-export-components -- Owned private entry; never an HMR/customer module. */
import { Component, useEffect, type ReactNode } from 'react'
import { createRoot, extend, unmountComponentAtNode, useFrame } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import type { Material, Mesh, WebGLRenderer } from 'three'
import { Atmosphere } from '../../../components/Atmosphere'
import { InteriorProbe, SiteProbe } from '../../../components/InteriorProbe'
import { Landscape } from '../../../components/Landscape'
import { StudioModel } from '../../../components/StudioModel'
import { DISPLAY_LIMITS, DISPLAY_PROTOCOL, type DisplayBuild } from '../../../display/contract'
import { validateDisplayJob, type DisplayJob, type DisplayReceipt } from '../../../display/session'
import { type Config } from '../../../lib/config'
import {
  materialLoaded,
  whenMaterialLoaded,
  onMaterialsChanged,
  setMaxAnisotropy,
} from '../../materials'
import { createPipeline, type Pipeline } from '../../pipeline'
import { backendOf, beginFrame, createRenderer } from '../../renderer'
import { disposePrivateSiteFieldWorker } from '../../siteLightNode'
import { displaySceneInput, displayCameraDigest } from '../input'
import type { RigObservation } from '../observation'
import { RevisionResources } from '../revisions'
import { observeDisplayResources } from './resources'

extend({
  Group: THREE.Group,
  Mesh: THREE.Mesh,
  InstancedMesh: THREE.InstancedMesh,
  PlaneGeometry: THREE.PlaneGeometry,
  CircleGeometry: THREE.CircleGeometry,
  MeshStandardMaterial: THREE.MeshStandardMaterial,
  DirectionalLight: THREE.DirectionalLight,
  SpotLight: THREE.SpotLight,
  PointLight: THREE.PointLight,
  RectAreaLight: THREE.RectAreaLight,
})

function Assembly({
  config,
  view,
  observation,
}: {
  config: Config
  view: 'interior' | 'exterior'
  observation: RigObservation
}) {
  return (
    <>
      <Atmosphere config={config} view={view} quality="ultra" observation={observation} />
      <Landscape config={config} quality="ultra" />
      <StudioModel config={config} quality="ultra" />
      <InteriorProbe config={config} quality="ultra" observation={observation} />
      <SiteProbe config={config} quality="ultra" observation={observation} />
      <Commit observation={observation} />
    </>
  )
}
function Commit({ observation }: { observation: RigObservation }) {
  useEffect(() => {
    observation.complete('react-commit')
  }, [observation])
  useFrame(() => {}, 1)
  return null
}
class Boundary extends Component<
  { children: ReactNode; fail: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    this.props.fail(error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
/** Catch effect-created meshes (notably the planar mirror) and late React commits as well
 * as material streaming. UUID membership is stable across renders, unlike transient probes. */
export function sceneResources(scene: THREE.Scene) {
  const entries: string[] = []
  let mirrors = 0
  scene.traverse((object) => {
    const mesh = object as Mesh
    const values = mesh.material
      ? Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      : []
    if (object.userData.noProbe && values.some((m) => m.userData.pathTrace)) mirrors++
    entries.push(
      `${object.uuid}:${object.parent?.uuid}:${mesh.geometry?.uuid ?? ''}:${values.map((m) => m.uuid).join(',')}`,
    )
  })
  return { key: entries.join('|'), mirrors }
}
function materials(scene: THREE.Scene) {
  const values = new Set<Material>()
  scene.traverse((o) => {
    const m = (o as Mesh).material
    if (m) for (const item of Array.isArray(m) ? m : [m]) values.add(item)
  })
  return [...values] as THREE.MeshStandardNodeMaterial[]
}
export function assertDisplayCamera(
  camera: THREE.PerspectiveCamera,
  input: ReturnType<typeof displaySceneInput>,
) {
  const pose = input.camera,
    aspect = input.profile.width / input.profile.height
  const expected = new THREE.PerspectiveCamera(pose.fov, aspect, pose.near, pose.far)
  expected.position.set(pose.position[0], pose.position[1], pose.position[2])
  expected.up.set(pose.up[0], pose.up[1], pose.up[2])
  expected.lookAt(pose.target[0], pose.target[1], pose.target[2])
  expected.updateMatrixWorld()
  expected.updateProjectionMatrix()
  camera.updateMatrixWorld()
  if (
    camera.aspect !== aspect ||
    camera.fov !== pose.fov ||
    camera.near !== pose.near ||
    camera.far !== pose.far ||
    camera.zoom !== 1 ||
    camera.matrixWorld.elements.some(
      (v, i) => Math.abs(v - expected.matrixWorld.elements[i]) > 1e-9,
    ) ||
    camera.projectionMatrix.elements.some(
      (v, i) => Math.abs(v - expected.projectionMatrix.elements[i]) > 1e-9,
    )
  )
    throw new Error('Mounted display camera mismatch.')
}

/** Positive vendor evidence plus non-fallback adapter; absence of a software substring is NOT evidence. */
type ObservedAdapter = {
  info: {
    vendor: string
    architecture: string
    device: string
    description: string
    isFallbackAdapter?: boolean
  }
  isFallbackAdapter?: boolean
}
type DisplayGPU = { requestAdapter(options?: unknown): Promise<ObservedAdapter | null> }
type DisplayDevice = EventTarget & {
  queue: { onSubmittedWorkDone(): Promise<void> }
  destroy(): void
}
export function observedHardwareAdapter(adapter: ObservedAdapter) {
  const info = adapter.info
  const label = [info.vendor, info.architecture, info.device, info.description].join(' ').trim()
  const fallback = adapter.isFallbackAdapter ?? info.isFallbackAdapter
  if (
    fallback !== false ||
    !/nvidia|intel|amd|ati|apple|qualcomm/i.test(info.vendor) ||
    /swiftshader|llvmpipe|lavapipe|software|basic render|unknown/i.test(label) ||
    label.length > 512
  )
    throw new Error('Hardware WebGPU adapter not positively established.')
  return label
}

/** One real renderer/root/scene and shared library caches survive all successful designs. */
export async function createDisplayScene(build: DisplayBuild, sessionId: string) {
  const gpu = (navigator as Navigator & { gpu?: DisplayGPU }).gpu
  if (THREE.REVISION !== build.threeRevision || !gpu || !globalThis.createImageBitmap)
    throw new Error('Required hardware WebGPU browser unavailable.')
  const network = observeDisplayResources()
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  // The shared renderer can auto-fallback for the customer UI; this owned canvas cannot.
  const getContext = canvas.getContext.bind(canvas)
  canvas.getContext = ((kind: string, options?: unknown) => {
    if (kind !== 'webgpu') throw new Error('Private display forbids non-WebGPU contexts.')
    return getContext(kind, options)
  }) as typeof canvas.getContext
  // Observe the adapter actually chosen by the existing trusted createRenderer, not a second probe.
  const requestAdapter = gpu.requestAdapter
  let observed: ObservedAdapter | null = null
  gpu.requestAdapter = async function (options) {
    const adapter = await requestAdapter.call(this, options)
    if (!adapter) throw new Error('No WebGPU adapter.')
    observedHardwareAdapter(adapter)
    observed = adapter
    return adapter
  }
  let renderer: THREE.WebGPURenderer
  try {
    renderer = await createRenderer(canvas)
  } catch (error) {
    network.close()
    canvas.remove()
    throw error
  } finally {
    gpu.requestAdapter = requestAdapter
  }
  if (backendOf(renderer) !== 'webgpu' || !observed) {
    renderer.dispose()
    network.close()
    canvas.remove()
    throw new Error('Private display rejects fallback renderer.')
  }
  const adapter = observedHardwareAdapter(observed)
  const browserVersion = navigator.userAgent.match(/(?:HeadlessChrome|Chrome)\/[\d.]+/)?.[0]
  if (!browserVersion) throw new Error('Unidentified browser.')
  const runtime: DisplayReceipt['runtime'] = {
    backend: 'webgpu',
    acceleration: 'hardware',
    adapter,
    browserVersion,
  }
  const device = (renderer.backend as unknown as { device: DisplayDevice }).device
  const revisions = new RevisionResources()
  let failure: unknown,
    closed = false,
    busy = false,
    lastRevision = 0,
    changes = 0
  const fail = (error: unknown) => {
    failure = error
    revisions.poison(error)
  }
  renderer.onDeviceLost = fail
  renderer.debug.checkShaderErrors = true
  renderer.debug.onShaderError = () => fail(new Error('Private shader error.'))
  const deviceError = () => fail(new Error('Private GPU error.'))
  device.addEventListener('uncapturederror', deviceError)
  const unsubscribe = onMaterialsChanged((kind) => {
    if (kind === 'textures') changes++
  })
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera()
  const root = createRoot(canvas)
  let pipeline: Pipeline | undefined
  const check = () => {
    network.check()
    revisions.check()
    if (closed || failure) throw new Error('Private scene poisoned.', { cause: failure })
  }
  setMaxAnisotropy(renderer.getMaxAnisotropy())
  await root.configure({
    gl: renderer as unknown as WebGLRenderer,
    scene,
    camera,
    frameloop: 'never',
    dpr: 1,
    shadows: 'percentage',
    size: { width: 1600, height: 1000, top: 0, left: 0 },
  })
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setPixelRatio(1)
  const wait = async <T,>(promise: Promise<T>) => {
    const value = await promise
    check()
    return value
  }
  const pause = () => wait(new Promise<void>((resolve) => setTimeout(resolve, 25)))
  const gpuDone = async () => {
    await wait(device.queue.onSubmittedWorkDone())
    check()
  }
  const strictWarm = async (value: Pipeline) => {
    // Legacy warm() intentionally allSettles. Observe its actual compile promises and reject failures here.
    const compile = renderer.compileAsync
    const compiles: Promise<unknown>[] = []
    renderer.compileAsync = function (...args) {
      const pending = compile.apply(this, args)
      compiles.push(pending)
      return pending
    }
    try {
      await wait(value.warm())
      if (!compiles.length) throw new Error('Pipeline warm did not observe a compilation.')
      await wait(Promise.all(compiles))
      await gpuDone()
    } finally {
      renderer.compileAsync = compile
    }
  }
  return {
    runtime,
    async render(input: unknown) {
      check()
      if (busy) throw new Error('Overlapping private scene mutation denied.')
      busy = true
      const started = performance.now()
      try {
        const job: DisplayJob = await wait(validateDisplayJob(input, build))
        if (job.sessionId !== sessionId || job.revision !== lastRevision + 1)
          throw new Error('Stale scene revision.')
        lastRevision = job.revision
        const plan = displaySceneInput(job.design),
          pose = plan.camera
        const config: Config = {
          ...plan.config,
          items: plan.config.items.map((item) => ({ ...item })),
        }
        const profile = plan.profile
        camera.fov = pose.fov
        camera.near = pose.near
        camera.far = pose.far
        camera.aspect = profile.width / profile.height
        camera.zoom = 1
        camera.position.set(pose.position[0], pose.position[1], pose.position[2])
        camera.up.set(pose.up[0], pose.up[1], pose.up[2])
        camera.lookAt(pose.target[0], pose.target[1], pose.target[2])
        camera.updateProjectionMatrix()
        camera.updateMatrixWorld()
        await wait(
          root.configure({
            size: { width: profile.width, height: profile.height, top: 0, left: 0 },
          }),
        )
        renderer.setSize(profile.width, profile.height, false)
        pipeline?.dispose()
        pipeline = undefined
        let observation = revisions.begin(job.revision)
        const mount = () =>
          root.render(
            <Boundary fail={fail}>
              <Assembly config={config} view={plan.view} observation={observation} />
            </Boundary>,
          )
        let store = mount(),
          materialSerial = changes,
          sceneKey = ''
        let settled = false
        for (let frames = 0; frames < profile.maxFrames; frames++) {
          check()
          if (performance.now() - started > DISPLAY_LIMITS.jobMs)
            throw new Error('Scene job deadline.')
          if (
            revisions.has('materials') &&
            (changes !== materialSerial || sceneResources(scene).key !== sceneKey)
          ) {
            // Late valid scan changes invalidate probes and ALL temporal content, not just a ready flag.
            observation = revisions.restart()
            materialSerial = changes
            pipeline?.dispose()
            pipeline = undefined
            store = mount()
          }
          if (!revisions.has('react-commit')) {
            await pause()
            continue
          }
          if (!revisions.has('materials')) {
            const resources = sceneResources(scene)
            // useMirror is effect-created after the parent's commit. A commit alone is not a
            // mounted mirror. Removal is equally explicit and must not retain the old pane.
            if (resources.mirrors !== (config.mirror ? 1 : 0)) {
              await pause()
              continue
            }
            const mounted = materials(scene)
            if (mounted.length < 10 || !scene.children.some((o) => o.userData.unit === true))
              throw new Error('Incomplete architecture.')
            const loaded = await wait(Promise.all(mounted.map(whenMaterialLoaded)))
            if (loaded.some((v) => !v) || mounted.some((m) => !materialLoaded(m)))
              throw new Error('Required material failed.')
            if (!network.ready() || sceneResources(scene).key !== resources.key) {
              await pause()
              continue
            }
            materialSerial = changes
            sceneKey = resources.key
            observation.complete('materials') // actual applied maps; rechecked for each revision, including cache hits
          }
          beginFrame(renderer)
          store.getState().advance(performance.now(), true)
          check()
          if (revisions.resourcesReady() && !revisions.has('pipeline-warm')) {
            pipeline?.dispose()
            pipeline = createPipeline(renderer, scene, camera, 'ultra')
            pipeline.setPlace(plan.view)
            if (!pipeline.shutter || pipeline.settleFrames !== 40)
              throw new Error('Unexpected Ultra pipeline.')
            pipeline.shutter.value = 0
            await strictWarm(pipeline)
            observation.complete('pipeline-warm')
          }
          if (pipeline && revisions.has('pipeline-warm')) {
            pipeline.render()
            await gpuDone()
          }
          if (changes !== materialSerial) {
            await pause()
            continue
          }
          settled = revisions.frame()
          if (settled) break
          await pause()
        }
        if (!settled || !network.ready()) throw new Error('Display readiness/frame cap.')
        assertDisplayCamera(camera, plan)
        const serial = changes
        const blob = await wait(
          new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (value) => (value ? resolve(value) : reject(new Error('PNG encode failed.'))),
              'image/png',
            ),
          ),
        )
        if (blob.type !== 'image/png' || blob.size < 44 || blob.size > DISPLAY_LIMITS.pngBytes)
          throw new Error('PNG encode bound.')
        const bitmap = await wait(createImageBitmap(blob))
        try {
          if (bitmap.width !== profile.width || bitmap.height !== profile.height)
            throw new Error('PNG decode dimensions.')
        } finally {
          bitmap.close()
        }
        const bytes = new Uint8Array(await wait(blob.arrayBuffer()))
        const hash = new Uint8Array(await wait(crypto.subtle.digest('SHA-256', bytes)))
        const checksum = `sha256:${Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')}`
        const cameraDigest = await wait(displayCameraDigest(job.design))
        if (changes !== serial || sceneResources(scene).key !== sceneKey || !network.ready())
          throw new Error('Resources changed during encoding.')
        assertDisplayCamera(camera, plan)
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 16384)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
        const receipt: DisplayReceipt = {
          protocol: DISPLAY_PROTOCOL,
          kind: 'private-three-display',
          jobId: job.jobId,
          sessionId,
          revision: job.revision,
          binding: job.binding,
          cameraDigest,
          checksum,
          width: profile.width,
          height: profile.height,
          byteLength: bytes.length,
          readiness: revisions.gate.receipt(),
          runtime,
          elapsedMs: performance.now() - started,
          hostShutdownProven: false,
          billingFinal: false,
        }
        revisions.finish()
        return { receipt, base64: btoa(binary) }
      } catch (error) {
        fail(error)
        throw error
      } finally {
        busy = false
      }
    },
    async close() {
      if (closed) return
      closed = true
      revisions.poison(new Error('Private scene closing.'))
      unsubscribe()
      network.close()
      disposePrivateSiteFieldWorker()
      pipeline?.dispose()
      pipeline = undefined
      await new Promise<void>((resolve) => unmountComponentAtNode(canvas, () => resolve()))
      device.removeEventListener('uncapturederror', deviceError)
      renderer.dispose()
      device.destroy()
      canvas.remove()
      canvas.width = canvas.height = 0
    },
  }
}
