import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import Scene, { type SceneProps } from '../../components/Scene'
import { createCaptureRegistry, type CaptureResult } from '../../lib/capture'
import type { PresentationState } from '../../lib/presentation'
import { textureProgress } from '../../render/progress'
import type { Backend, DeviceProfile, Quality } from '../../render/quality'
import { VISUAL_FIXTURES } from './fixtures'
import {
  fixtureScenePolicy,
  fixtureValidity,
  inspectFixture,
  seedFixtureCamera,
} from './viewerModel'

if (!import.meta.env.DEV) throw new Error('Fixture viewer is development-only')
const params = new URLSearchParams(location.search)
const fixture = VISUAL_FIXTURES.find((f) => f.id === params.get('fixture')) ?? VISUAL_FIXTURES[0]
const shot = fixture.shots.find((s) => s.id === params.get('shot')) ?? fixture.shots[0]
const resolved = inspectFixture(fixture.id, shot.id)
const quality: Quality =
  params.get('quality') === 'lite' ? 'lite' : params.get('quality') === 'high' ? 'high' : 'ultra'
const width = Math.min(1920, Math.max(320, Number(params.get('width')) || 1280))
const height = Math.min(1080, Math.max(180, Number(params.get('height')) || 720))
const getAssets = () => textureProgress.snapshot('scene')
const validity = fixtureValidity()
const scenePolicy = fixtureScenePolicy(resolved)
type CaptureMetadata =
  Omit<Extract<CaptureResult, { blob: Blob }>, 'blob'> | Exclude<CaptureResult, { blob: Blob }>

export default function Viewer() {
  const [chosenFixture, setChosenFixture] = useState(fixture.id)
  const [registry] = useState(createCaptureRegistry)
  const [memory] = useState(() =>
    resolved.inspection.status === 'accepted' ? seedFixtureCamera(resolved) : { current: {} },
  )
  const [presentation, setPresentation] = useState<PresentationState | null>(null)
  const [backend, setBackend] = useState<Backend | null>(null)
  const [device, setDevice] = useState<DeviceProfile | null>(null)
  const [graphics, setGraphics] = useState('initializing')
  const [progress, setProgress] = useState('No capture requested')
  const [result, setResult] = useState<CaptureMetadata | null>(null)
  const [download, setDownload] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const onGraphicsStatus = useCallback<NonNullable<SceneProps['onGraphicsStatus']>>(
    (status, reason) => setGraphics(`${status}${reason ? `: ${reason}` : ''}`),
    [],
  )
  const onFallback = useCallback(
    () => setGraphics('Scene unavailable; no replacement scene rendered'),
    [],
  )
  const assets = useSyncExternalStore(textureProgress.subscribe, getAssets)
  const readiness = useMemo(
    () => ({
      pending: assets.pending,
      degraded: assets.degraded > 0,
      revision: `${assets.generation}:${assets.revision}`,
    }),
    [assets],
  )
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(
    () => () => {
      if (download) URL.revokeObjectURL(download)
    },
    [download],
  )
  const provider = registry.get()
  const currentSize = presentation?.rendered ?? { width: 0, height: 0 }
  const target16x9 = { width: 1920, height: 1080 }
  const selected = VISUAL_FIXTURES.find((f) => f.id === chosenFixture)!
  const canCapture =
    !!provider &&
    !!presentation &&
    ['settled', 'degraded'].includes(presentation.stage) &&
    !presentation.animating &&
    !busy

  async function capture(mode: 'current' | 'presentation') {
    const active = registry.get()
    if (!active || busy) return
    const state = active.getState()
    const size = mode === 'current' ? state.rendered : target16x9
    const capability = active.preflight(size)
    if (!capability.allowed) {
      setResult({
        status: 'unavailable',
        reason: capability.reason ?? 'Capture unavailable',
        alternatives: capability.alternatives,
      })
      return
    }
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setResult(null)
    setDownload(null)
    try {
      const captured = await active.capture({
        ...size,
        token: { ...state.token },
        mode,
        framing: mode === 'current' ? 'current' : 'center-crop',
        signal: abort.signal,
        onProgress: (phase, fraction) => setProgress(`${phase}: ${Math.round(fraction * 100)}%`),
      })
      if ('blob' in captured) {
        const { blob, ...metadata } = captured
        setResult(metadata)
        setDownload(URL.createObjectURL(blob))
      } else setResult(captured)
      setProgress(captured.status)
    } catch (error) {
      setResult({
        status: 'unavailable',
        reason: error instanceof Error ? error.message : 'Capture failed',
      })
    } finally {
      setBusy(false)
      controller.current = null
    }
  }

  return (
    <>
      <header>
        <h1>Production Scene fixtures · development only</h1>
        <p>
          Actual production geometry, materials, renderer and capture provider. No visual approval,
          native 4K or physical-device performance claim.
        </p>
        <form method="get">
          <label>
            Fixture
            <select
              name="fixture"
              value={chosenFixture}
              onChange={(event) => setChosenFixture(event.target.value as typeof chosenFixture)}
            >
              {VISUAL_FIXTURES.map((f) => (
                <option key={f.id}>{f.id}</option>
              ))}
            </select>
          </label>
          <label>
            Shot
            <select
              key={chosenFixture}
              name="shot"
              defaultValue={chosenFixture === fixture.id ? shot.id : selected.shots[0].id}
            >
              {selected.shots.map((s) => (
                <option key={s.id}>{s.id}</option>
              ))}
            </select>
          </label>
          <label>
            Tier
            <select name="quality" defaultValue={quality}>
              <option>lite</option>
              <option>high</option>
              <option>ultra</option>
            </select>
          </label>
          <label>
            Requested backend
            <select
              name="renderer"
              defaultValue={params.get('renderer') === 'webgl2' ? 'webgl2' : 'webgpu'}
            >
              <option>webgpu</option>
              <option>webgl2</option>
            </select>
          </label>
          <label>
            CSS width
            <input name="width" type="number" min="320" max="1920" defaultValue={width} />
          </label>
          <label>
            CSS height
            <input name="height" type="number" min="180" max="1080" defaultValue={height} />
          </label>
          <button type="submit">Load exact shot / reset camera</button>
        </form>
        <p>
          {fixture.id} / {shot.id}: {fixture.story}
        </p>
        {resolved.candidateAdjustments.map((note) => (
          <p className="notice" key={note}>
            {note}
          </p>
        ))}
        {shot.view === 'neutral-stage' && (
          <p className="notice">
            This viewer shows the production candidate with this shot’s camera in exterior mode, not
            neutral calibration.{' '}
            <a href={`./index.html?light=${shot.time >= 19 ? 'warm' : 'day'}`}>
              Open the separate neutral stage
            </a>
            .
          </p>
        )}
        <p>
          Camera seeded exactly once; orbiting changes the actual camera token. Reload to restore.
          Scene owns clipping planes (0.1–2000), time/view-dependent exposure and DPR policy;
          requested shot clipping/exposure are reported, not overridden.
        </p>
        {scenePolicy.orbitConstraintWarning && (
          <p className="notice">{scenePolicy.orbitConstraintWarning}</p>
        )}
        <p role="status">
          Graphics: {graphics}; backend: {backend ?? 'not initialized'}; presentation:{' '}
          {presentation?.stage ?? 'initializing'}; maps: {assets.ready}/{assets.requested} ready,{' '}
          {assets.pending} pending, {assets.degraded} degraded.
        </p>
      </header>
      <div className="canvas-scroll">
        <div className="scene" style={{ width, height }}>
          {resolved.inspection.status === 'accepted' ? (
            <Scene
              config={resolved.inspection.config}
              view={shot.view === 'interior' ? 'interior' : 'exterior'}
              dimensions={false}
              unit="ft"
              reset={0}
              autoRotate={false}
              quality={quality}
              qualityMode={quality}
              revision={1}
              isPreviewing={false}
              cameraMemory={memory}
              assets={readiness}
              onCaptureProvider={registry.register}
              onPresentation={setPresentation}
              onBackend={setBackend}
              onDeviceProfile={setDevice}
              onGraphicsStatus={onGraphicsStatus}
              onFallback={onFallback}
            />
          ) : (
            <p role="alert">
              Fixture is not accepted: {resolved.inspection.issues.join('; ')}. No normalization or
              item dropping is permitted.
            </p>
          )}
        </div>
      </div>
      <aside>
        <div className="actions">
          <button disabled={!canCapture} onClick={() => void capture('current')}>
            Capture current native buffer
          </button>
          <button disabled={!canCapture} onClick={() => void capture('presentation')}>
            Capture 1920×1080 / center crop
          </button>
          <button disabled={!busy} onClick={() => controller.current?.abort()}>
            Cancel capture
          </button>
          <button
            disabled={!assets.canRetry || busy}
            onClick={() => textureProgress.retry('scene')}
          >
            Retry failed scene maps
          </button>
          {download && (
            <a
              download={`${fixture.id}-${shot.id}-${backend}-${presentation?.token.quality}.png`}
              href={download}
            >
              Download actual PNG
            </a>
          )}
        </div>
        <p role="status">Capture: {progress}</p>
        <details open>
          <summary>Exact runtime / camera / capability metadata</summary>
          <pre id="fixture-metadata">
            {JSON.stringify(
              {
                fixture: fixture.id,
                shot: shot.id,
                assetVersion: resolved.assetVersion,
                inspection: resolved.inspection.status,
                candidateAdjustments: resolved.candidateAdjustments,
                requested: {
                  quality,
                  backend: params.get('renderer') ?? 'webgpu',
                  camera: shot.camera,
                  exposure: shot.exposure,
                  time: shot.time,
                  css: [width, height],
                  browserDpr: window.devicePixelRatio,
                },
                backend,
                device,
                graphics,
                scenePolicy,
                presentation,
                cameraMemory: memory.current,
                assets,
                capability: {
                  current: provider?.preflight(currentSize),
                  presentation: provider?.preflight(target16x9),
                },
                capture: result,
              },
              null,
              2,
            )}
          </pre>
        </details>
        <details>
          <summary>All 38 candidate validity results (D2)</summary>
          <pre id="fixture-validity">{JSON.stringify(validity, null, 2)}</pre>
        </details>
      </aside>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Viewer />)
