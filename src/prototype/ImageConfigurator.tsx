import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, RotateCcw } from 'lucide-react'
import Modal from '../components/Modal'
import { AppErrorBoundary } from '../components/AppErrorBoundary'
import {
  ConfiguratorShell,
  ConfiguratorPanelToggle,
  ConfiguratorNotification,
  ConfiguratorSummary,
} from '../components/ConfiguratorShell'
import { StageHeader, type StageView } from '../components/StageHeader'
import {
  StageFrame,
  StageImageLayers,
  StageFilmstrip,
  type StageImageLayer,
} from '../components/StagePresentation'
import { useFitBox, useFullscreen, toggleFullscreen } from '../components/StagePresentationHooks'
import { StageToolbarView } from '../components/StageToolbarView'
import {
  applyDesignCommand,
  transitionDesign,
  type DesignAction,
} from '../domain/designTransitions'
import { defaultDesign, projectDesignToConfig, type DesignEnvelope } from '../domain/design'
import { resolveCamera, resolveLook, type CameraRef } from '../domain/presentation'
import { CUSTOMER_CAMERAS, normalizeCustomerDesign } from '../render-library/views'
import { BuildAnimation } from '../components/LoadingExperience'
import { LibrarySetStatus } from './LibrarySetStatus'
import { LibraryThumbnail } from './LibraryThumbnail'
import { SceneLookControls } from './SceneLookControls'
import { FINISHES, area, distance, type Unit } from '../lib/config'
import { DesignPanel } from './DesignPanel'
import { DesignSpecification } from './DesignSpecification'
import { DesignLibrary } from './DesignLibrary'
import { usePrototypeImage } from './usePrototypeImage'
import { useLocalRenderImage } from './useLocalRenderImage'
import { useDisplayImage } from './useDisplayImage'
import { useCloudDisplayImage } from './useCloudDisplayImage'
import { useNativeLibraryImage, useNativeCatalog } from './useNativeLibraryImage'
import { findNativeImage, nativeThumbUrl } from './nativeLibrary'
import { NativeLibraryGallery } from './NativeLibraryGallery'
import { LiveViewport, LIVE_FADE_MS, type LiveCurtain } from './LiveViewport'
import { prefetchLiveView } from './liveIntent'
import { CLOUD_DISPLAY_LABEL, isCloudDisplaySelection } from './cloudDisplayClient'
import {
  DISPLAY_LABEL,
  displayHolds,
  displayProfileFor,
  isDisplaySelection,
} from '../display/contract'
import {
  isLocalRenderSelection,
  localRenderDesign,
  LOCAL_RENDER_LABEL,
  LOCAL_RENDER_PROFILE,
} from '../image-service/localRenderProtocol'
import {
  designHistory,
  downloadPrototypeFile,
  initialHistory,
  initialNativeHistory,
  rememberNativeSelection,
  type HistoryAction,
} from './state'
import './prototype.css'

// A fixed, local aesthetic reference, NOT a lookup by the selected design/camera/finish.
// Source metadata comes from the unchanged historical manifest. Never relabel its revision.
export const HISTORICAL_REFERENCE = Object.freeze({
  src: '/stills/97f204ffff/4f807d1dd16ad6aa/front-left-wide-1600.7ea9c6eb.webp',
  revision: '97f204ffff',
  design: '4f807d1dd16ad6aa',
  view: 'front-left',
})

const UNAVAILABLE =
  '360°, approved image downloads and strict exports are unavailable in this mock-only phase. No automatic live/cloud fallback.'

const LOCAL_UNAVAILABLE =
  '360°, approved image downloads and strict/Cycles exports remain unavailable in this local unqualified preview. No automatic live/cloud fallback.'

const DISPLAY_UNAVAILABLE =
  '360°, image downloads and strict/Cycles/PDF exports remain unavailable for this unqualified display candidate. Asset rights, fonts, art direction and engineering are held. No live, mock, Lite or paid/cloud fallback.'

/**
 * Whether the live view crossfades with the gallery image. Under reduced motion they are cuts:
 * prototype.css stops every animation there, so timers, never animationend, end the fades.
 */
const liveFades = () => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function ImageConfigurator() {
  const nativeLibrary = new URLSearchParams(window.location.search).get('experience') === 'library'
  const localReal = isLocalRenderSelection(import.meta.env.DEV, window.location.search)
  const privateDisplay = isDisplaySelection(import.meta.env.DEV, window.location.search)
  const cloudDisplay = isCloudDisplaySelection(import.meta.env.DEV, window.location.search)
  return (
    <AppErrorBoundary recoveryMessage="Unsaved edits may be lost on reload. Existing stored designs and recovery copies have not been replaced by this error.">
      <ImageConfiguratorContents
        key={
          nativeLibrary
            ? 'native-library'
            : cloudDisplay
              ? 'private-cloud-display'
              : privateDisplay
                ? 'private-display'
                : localReal
                  ? 'local-real'
                  : 'mock'
        }
        localReal={localReal}
        nativeLibrary={nativeLibrary}
        localDisplay={privateDisplay}
        cloudDisplay={cloudDisplay}
        useImage={
          nativeLibrary
            ? useNativeLibraryImage
            : cloudDisplay
              ? useCloudDisplayImage
              : privateDisplay
                ? useDisplayImage
                : localReal
                  ? useLocalRenderImage
                  : usePrototypeImage
        }
      />
    </AppErrorBoundary>
  )
}

// Mode is fixed for this keyed mount. Only one hook runs: private modes cannot start mock work.
function ImageConfiguratorContents({
  nativeLibrary,
  localReal,
  localDisplay,
  cloudDisplay,
  useImage,
}: {
  nativeLibrary: boolean
  localReal: boolean
  localDisplay: boolean
  cloudDisplay: boolean
  useImage:
    | typeof usePrototypeImage
    | typeof useLocalRenderImage
    | typeof useDisplayImage
    | typeof useCloudDisplayImage
    | typeof useNativeLibraryImage
}) {
  const privateDisplay = localDisplay || cloudDisplay
  const displayLabel = cloudDisplay ? CLOUD_DISPLAY_LABEL : DISPLAY_LABEL
  const verifiedMode = nativeLibrary || localReal || privateDisplay
  const catalog = useNativeCatalog(nativeLibrary)
  const [history, dispatch] = useReducer(
    designHistory,
    undefined,
    nativeLibrary ? initialNativeHistory : initialHistory,
  )
  const design = history.present
  const selectionHash = useRef(window.location.hash)
  useEffect(() => {
    if (nativeLibrary)
      selectionHash.current = rememberNativeSelection(design, selectionHash.current)
  }, [nativeLibrary, design])
  const [unit, setUnit] = useState<Unit>('ft')
  const [notice, setNotice] = useState(
    nativeLibrary
      ? ''
      : 'Local DEV prototype. Your edits are kept in memory; save explicitly in My builds.',
  )
  const noticeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (noticeTimeout.current !== null) clearTimeout(noticeTimeout.current)
    },
    [],
  )
  const [display, setDisplay] = useState<'reference' | 'mock'>('reference')
  const [referenceFailed, setReferenceFailed] = useState(false)
  const [dialog, setDialog] = useState<'specification' | 'help' | 'image' | null>(null)
  const [plan, setPlan] = useState(false)
  const [live, setLive] = useState(false)
  const [viewerStarted, setViewerStarted] = useState(false)
  const [viewerReady, setViewerReady] = useState(false)
  const [dimensions, setDimensions] = useState(false)
  const [autoRotate, setAutoRotate] = useState(false)
  const [resetView, setResetView] = useState(0)
  /**
   * Opening the 360° view on this design's own rendered image, the image stays on the stage and
   * the canvas draws unseen over it ('still') until the camera leaves the image's pose; the canvas
   * then fades in over it ('lifting'). Once per opening: Reset view never brings the image back,
   * which would set the two renderers' looks side by side at the same framing.
   */
  const [curtain, setCurtain] = useState<LiveCurtain>(null)
  /** Closing: the live view's last frame fades off the gallery image under it. */
  const [leaving, setLeaving] = useState(false)
  const [mobilePanel, setMobilePanel] = useState(true)
  const [step, setStep] = useState(0)
  const frame = useRef<HTMLDivElement>(null)
  const aspect = design.presentation.aspect
  const box = useFitBox(frame, aspect === 'wide' ? 16 / 10 : 4 / 5)
  const fullscreen = useFullscreen(frame)
  const selectedCamera = resolveCamera(design.presentation.cameraRef)
  const view: StageView = plan ? 'plan' : selectedCamera.group
  const lastCameras = useRef<Record<'exterior' | 'interior', CameraRef>>({
    exterior: 'front-left-draft@1',
    interior: 'entry-draft@1',
  })
  const image = useImage(design)
  const setState = 'library' in image ? image.library : undefined
  const unavailable = nativeLibrary
    ? 'Strict exports are not available. New saved images require an explicit render request and operator approval.'
    : privateDisplay
      ? DISPLAY_UNAVAILABLE
      : localReal
        ? LOCAL_UNAVAILABLE
        : UNAVAILABLE
  const notify = useCallback((message: string, duration?: number) => {
    if (noticeTimeout.current !== null) clearTimeout(noticeTimeout.current)
    noticeTimeout.current = null
    setNotice(message)
    if (duration) noticeTimeout.current = setTimeout(() => setNotice(''), duration)
  }, [])
  const changeHistory = useCallback(
    (action: HistoryAction) => {
      if (action.type === 'undo' && !history.past.length) return
      if (action.type === 'redo' && !history.future.length) return
      notify('')
      dispatch(action)
    },
    [history.past.length, history.future.length, notify],
  )
  const load = useCallback(
    (next: DesignEnvelope) => {
      changeHistory({ type: 'commit', design: normalizeCustomerDesign(next) })
    },
    [changeHistory],
  )
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        document.querySelector('dialog[open]') ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        changeHistory({ type: event.shiftKey ? 'redo' : 'undo' })
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [changeHistory])
  function action(action: DesignAction) {
    try {
      const next = transitionDesign(design, action)
      if (!next.changed) return
      changeHistory({ type: 'commit', design: applyDesignCommand(design, next.command, true) })
      if (action.type === 'set-product') {
        const { family, lengthFt } = next.next.config.product
        const reset =
          family !== design.config.product.family ? ' Model-specific options reset.' : ''
        notify(
          `${family === 'studio' ? 'Studio' : 'Container Gym'} · ${lengthFt} ft selected.${reset} Undo available.`,
          6000,
        )
      } else if (next.adjustments.length) {
        notify('Door options adjusted to match your selection. Undo available.', 6000)
      }
    } catch {
      notify('That option is not supported by the draft catalog. Your design is unchanged.')
    }
  }
  function pickCamera(cameraRef: CameraRef) {
    setAutoRotate(false)
    lastCameras.current[selectedCamera.group] = selectedCamera.ref
    lastCameras.current[resolveCamera(cameraRef).group] = cameraRef
    setPlan(false)
    action({ type: 'update-presentation', patch: { cameraRef } })
  }
  function pickView(next: StageView) {
    if (next === 'plan') {
      setPlan(true)
      setStep(2)
    } else
      pickCamera(next === selectedCamera.group ? selectedCamera.ref : lastCameras.current[next])
  }
  function toggleLive() {
    setViewerStarted(true)
    setLive(!live)
    setAutoRotate(false)
    // Closing cuts over the image itself, from a view that never drew, or to no image at all.
    setCurtain(!live && entryImage && !dimensions ? 'still' : null)
    setLeaving(live && viewerReady && curtain === null && layers.length > 0 && liveFades())
  }
  function moreSettings() {
    setStep(3)
    setMobilePanel(true)
    requestAnimationFrame(() => document.getElementById('prototype-tab-3')?.focus())
  }
  const product = design.config.product
  const finish = FINISHES.find((entry) => entry.id === design.config.appearance.finish)!
  const shown = image.shown?.reply.mode === 'mock' ? image.shown.reply : undefined
  const nativeShown = image.shown?.reply.mode === 'native-library' ? image.shown.reply : undefined
  // This design's own rendered image is on the stage (not the previous one, kept while it loads):
  // the live view opens at its exact camera, so it can stand for the view until the view moves.
  const entryImage = nativeLibrary && image.current && !!nativeShown
  // It stops standing for it with an edit, dimensions (labels in the scene) or auto-rotation. A
  // view that has not drawn yet has nothing to fade in.
  if (curtain === 'still' && (!entryImage || dimensions || autoRotate))
    setCurtain(viewerReady && liveFades() ? 'lifting' : null)
  useEffect(() => {
    if (curtain !== 'lifting') return
    const timer = setTimeout(() => setCurtain(null), LIVE_FADE_MS)
    return () => clearTimeout(timer)
  }, [curtain])
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setLeaving(false), LIVE_FADE_MS)
    return () => clearTimeout(timer)
  }, [leaving])
  const leaveEntry = useCallback(
    () => setCurtain((value) => (value === 'still' ? (liveFades() ? 'lifting' : null) : value)),
    [],
  )
  const localShown = image.shown?.reply.mode === 'local-real' ? image.shown.reply : undefined
  const displayShown =
    image.shown?.reply.mode === 'private-display' ||
    image.shown?.reply.mode === 'private-cloud-display'
      ? image.shown.reply
      : undefined
  const displayBinding =
    displayShown?.mode === 'private-cloud-display'
      ? displayShown.recipe.binding
      : displayShown?.binding
  const displayProfile = displayProfileFor(design)
  const progress = image.progress
  const nativeTransition = 'finishTransition' in image ? image : undefined
  const previousNative = nativeTransition?.previous
  const stateLabel =
    nativeLibrary && image.current
      ? 'Image ready'
      : privateDisplay && image.current
        ? 'Current candidate'
        : localReal && image.current
          ? 'Local preview'
          : progress.state === 'pending'
            ? 'Pending'
            : progress.state === 'error'
              ? 'Failed'
              : progress.state === 'unavailable'
                ? 'Unavailable'
                : image.current
                  ? 'Mock preview'
                  : 'Previous'
  const status = nativeLibrary
    ? progress.state === 'pending'
      ? 'Loading the exact rendered image. Your controls remain available.'
      : progress.state === 'ready'
        ? 'Exact cached render · image checksum and dimensions verified. No GPU job starts when you change options.'
        : progress.message
    : cloudDisplay
      ? `${
          progress.state === 'pending'
            ? 'Private cloud display pending. No matching image is displayed; controls, save and history remain available.'
            : progress.state === 'ready'
              ? `${displayShown?.artifact.cacheStatus === 'verified-exact-hit' ? 'Verified exact cloud cache — cache hit, not a render job' : 'New private GPU display'} — PNG hash, dimensions and decode verified. Exact matching candidate; visual quality is not approved.`
              : progress.message
        } Rights, fonts, art direction and engineering remain held. No provider termination or final billing is inferred from an image.`
      : privateDisplay
        ? `${
            progress.state === 'pending'
              ? 'Private display pending. No matching image is displayed; controls, save and history remain available.'
              : progress.state === 'ready'
                ? `${displayShown?.artifact.cacheStatus === 'verified-exact-hit' ? 'Verified exact display cache' : 'New private display'} — PNG hash, dimensions and decode verified. Exact matching candidate, not an approved image or qualified renderer.`
                : progress.message
          } Rights, fonts, art direction and engineering remain held.`
        : localReal
          ? progress.state === 'pending'
            ? 'Local render pending. No matching rendered preview is displayed; controls, save and history remain available.'
            : progress.state === 'ready'
              ? `${localShown?.artifact.cacheStatus === 'verified-exact-hit' ? 'Verified exact local cache' : 'New local capture'} — PNG bytes, dimensions and decode verified. Unqualified preview, not an approved image.`
              : progress.message
          : progress.state === 'pending'
            ? shown
              ? display === 'mock'
                ? 'Updating mock preview — showing previous configuration diagnostic.'
                : 'Updating mock preview — previous diagnostic retained, not displayed. Historical reference remains on stage.'
              : 'Requesting mock preview. No current configuration image is available.'
            : progress.state === 'ready'
              ? 'Mock preview ready for the selected revision — not an approved current image.'
              : progress.message
  const caption = nativeLibrary
    ? 'GPU-rendered design preview'
    : privateDisplay
      ? displayLabel
      : localReal
        ? LOCAL_RENDER_LABEL
        : display === 'reference'
          ? 'Historical reference — not this configuration'
          : 'Mock preview — not a current design image'
  const source = nativeLibrary
    ? nativeShown && image.current
      ? `${nativeShown.artifact.width} × ${nativeShown.artifact.height} · Cycles OptiX · 1,024 samples · ${finish.name} · ${resolveLook(design.presentation.lookRef).name.replace('DRAFT — ', '')}`
      : 'No exact image available for the selected combination. No substitute is shown.'
    : privateDisplay
      ? `${displayProfile.id} · ${displayProfile.width}×${displayProfile.height} / Ultra / AgX / sRGB / DPR 1${image.current && displayShown ? ` · ${finish.name} · selected request ${displayBinding!.requested.requestDigest.slice(7, 23)}` : ' · requested profile; no matching verified image displayed'}`
      : localReal
        ? `${LOCAL_RENDER_PROFILE.id} · 640×400 / Lite / AgX / 4x MSAA / sRGB / DPR 1${image.current && localShown ? ` · ${localShown.artifact.provenance.runtime.backend} / ${localShown.artifact.provenance.runtime.acceleration} · ${finish.name}` : ' · requested profile; no matching verified image displayed'}`
        : display === 'reference'
          ? `Source revision ${HISTORICAL_REFERENCE.revision} · fixed ${HISTORICAL_REFERENCE.view} · does not follow controls`
          : shown
            ? `Source ${shown.artifact.provenance.generatorVersion} · ${image.current ? 'selected' : 'PREVIOUS'} request ${shown.requested.requestDigest.slice(7, 23)}`
            : 'No decoded mock diagnostic yet. No photorealistic output is being generated.'
  const layers: StageImageLayer[] = nativeLibrary
    ? nativeShown && image.shown && 'src' in image.shown
      ? [
          ...(previousNative
            ? [
                {
                  key: previousNative.src,
                  role: 'is-shown',
                  image: {
                    className: 'prototype-local-render',
                    src: previousNative.src,
                    alt: '',
                    'aria-hidden': true as const,
                  },
                },
              ]
            : []),
          {
            key: image.shown.src,
            role: previousNative ? 'is-entering' : 'is-shown',
            image: {
              className: 'prototype-local-render',
              src: image.shown.src,
              width: nativeShown.artifact.width,
              height: nativeShown.artifact.height,
              alt: image.current
                ? `${product.family} ${product.lengthFt}, ${finish.name}, ${selectedCamera.name.replace('DRAFT — ', '')}, ${resolveLook(design.presentation.lookRef).name.replace('DRAFT — ', '')}. Exact rendered design preview.`
                : 'Previous design — loading the selected view.',
              onAnimationEnd: (event) =>
                nativeTransition?.finishTransition(event.currentTarget.src),
            },
          },
        ]
      : []
    : privateDisplay
      ? image.current && displayShown && image.shown && 'src' in image.shown
        ? [
            {
              key: image.shown.src,
              role: 'is-shown',
              image: {
                className: 'prototype-local-render',
                src: image.shown.src,
                width: displayShown.artifact.width,
                height: displayShown.artifact.height,
                alt: `${displayLabel}. Selected ${product.family} ${product.lengthFt}, ${finish.name}, ${selectedCamera.name}, ${aspect}, ${design.presentation.lookRef}. Exact matching candidate, not approved art or a strict export.`,
              },
            },
          ]
        : []
      : localReal
        ? image.current && localShown && image.shown && 'src' in image.shown
          ? [
              {
                key: image.shown.src,
                role: 'is-shown',
                image: {
                  className: 'prototype-local-render',
                  src: image.shown.src,
                  width: localShown.artifact.width,
                  height: localShown.artifact.height,
                  alt: `${LOCAL_RENDER_LABEL}. Selected Studio-20 ${finish.name}, front-left wide. 640×400 Lite. Not an approved image.`,
                },
              },
            ]
          : []
        : display === 'reference'
          ? referenceFailed
            ? []
            : [
                {
                  key: HISTORICAL_REFERENCE.src,
                  role: 'is-shown',
                  image: {
                    className: 'prototype-reference',
                    src: HISTORICAL_REFERENCE.src,
                    width: 1600,
                    height: 1000,
                    fetchPriority: 'high',
                    alt: 'Historical Fury reference, not the selected configuration. Fixed archived front three-quarter view, source revision 97f204ffff.',
                    onError: () => setReferenceFailed(true),
                  },
                },
              ]
          : shown
            ? [
                {
                  key: shown.artifact.src,
                  role: 'is-shown',
                  image: {
                    className: 'prototype-diagnostic',
                    src: shown.artifact.src,
                    width: shown.artifact.width,
                    height: shown.artifact.height,
                    alt: `${image.current ? 'Selected' : 'Previous'} request mock diagnostic. Not a current design image. Source ${shown.artifact.provenance.generatorVersion}.`,
                  },
                },
              ]
            : []
  function downloadDiagnostic() {
    if (!image.current || !shown) return
    try {
      downloadPrototypeFile(
        `Fury-MOCK-${shown.requested.requestDigest.slice(7)}.svg`,
        decodeURIComponent(shown.artifact.src.split(',')[1]),
        'image/svg+xml',
      )
      notify(
        'Downloaded the selected mock diagnostic SVG, with its embedded disclaimer. Not a rendered product image.',
      )
    } catch {
      notify('Mock diagnostic download failed. No image was substituted.')
    }
  }
  return (
    <ConfiguratorShell
      className={`fury-prototype${nativeLibrary ? ' fury-native-library' : ''}`}
      mobilePanel={mobilePanel}
      configurationId="prototype-configuration"
      onSkip={(event) => {
        event.preventDefault()
        setMobilePanel(true)
        document.getElementById('prototype-configuration')?.focus()
        requestAnimationFrame(() => document.getElementById('prototype-configuration')?.focus())
      }}
      onBrand={() => setDialog('help')}
      headerActions={
        <>
          {nativeLibrary && (
            <NativeLibraryGallery
              library={catalog}
              onLoad={(next) => {
                load(next)
                setPlan(false)
              }}
            />
          )}
          <DesignLibrary
            design={design}
            onLoad={load}
            notify={notify}
            onHelp={() => setDialog('help')}
          />
        </>
      }
      workspace={
        <>
          <section
            className={`stage ${live && viewerReady ? 'is-live' : 'is-gallery'}${plan ? ' is-plan' : ''}`}
            aria-label="Gym visualization"
          >
            <StageHeader
              collection={
                product.family === 'studio' ? 'THE S-SERIES COLLECTION' : 'CONTAINER GYMS'
              }
              title={
                <>
                  {product.family === 'studio' ? 'S' : 'C'}-{product.lengthFt}
                </>
              }
              meta={
                <>
                  {area(product.lengthFt * 8, unit)}
                  <i />
                  {finish.name}
                  <i />
                  DRAFT · Quote required
                </>
              }
              note={
                nativeLibrary
                  ? undefined
                  : 'LOCAL DEV · Four fixed DRAFT arrangements · Engineering & rights holds remain open'
              }
              view={view}
              onView={pickView}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              onUndo={() => changeHistory({ type: 'undo' })}
              onRedo={() => changeHistory({ type: 'redo' })}
              status={
                !nativeLibrary && (
                  <div className="scene-status">
                    <strong>{plan ? 'READ-ONLY PLAN' : stateLabel}</strong>
                    <span className="scene-note">
                      {nativeLibrary ? 'GPU-rendered · Draft design' : 'No approved current image'}
                    </span>
                  </div>
                )
              }
            />
            <div className="stage-body">
              <StageFrame
                frameRef={frame}
                aspect={aspect}
                box={nativeLibrary && !layers.length && !plan && !live ? undefined : box}
              >
                {viewerStarted && nativeLibrary && (
                  <LiveViewport
                    design={design}
                    active={live && !plan}
                    unit={unit}
                    dimensions={dimensions}
                    autoRotate={autoRotate}
                    reset={resetView}
                    curtain={curtain}
                    leaving={leaving}
                    onReadyChange={setViewerReady}
                    onLeaveEntry={leaveEntry}
                  />
                )}
                {!plan && (
                  <>
                    <figure
                      hidden={live && viewerReady && curtain === null}
                      className="prototype-hero"
                      data-image-state={
                        nativeLibrary
                          ? image.current
                            ? 'current-native-library'
                            : layers.length
                              ? 'previous-native-library'
                              : progress.state
                          : privateDisplay
                            ? image.current
                              ? cloudDisplay
                                ? 'current-cloud-display-unqualified'
                                : 'current-display-unqualified'
                              : progress.state
                            : localReal
                              ? image.current
                                ? 'current-local-unqualified'
                                : progress.state
                              : display === 'reference'
                                ? referenceFailed
                                  ? 'unavailable'
                                  : 'historical'
                                : image.current
                                  ? 'current-mock'
                                  : shown
                                    ? 'previous'
                                    : progress.state
                      }
                    >
                      <StageImageLayers
                        layers={layers}
                        busy={(verifiedMode || display === 'mock') && progress.state === 'pending'}
                        current={nativeLibrary && image.current}
                        previous={
                          nativeLibrary && !image.current && layers.length
                            ? 'Previous design · Loading selected view'
                            : undefined
                        }
                      >
                        {!layers.length &&
                          (nativeLibrary && setState ? (
                            <LibrarySetStatus
                              design={design}
                              library={setState}
                              catalog={catalog}
                              hasImage={false}
                              imageLoading={progress.state === 'pending'}
                              imageError={progress.state === 'error' ? progress.message : undefined}
                              onRetryImage={image.retry}
                              onDetails={() => setDialog('image')}
                            />
                          ) : (
                            <div className="prototype-image-empty">
                              {verifiedMode
                                ? status
                                : display === 'reference'
                                  ? 'Historical reference unavailable. Your design controls still work.'
                                  : `Mock image ${progress.state === 'pending' ? 'pending' : progress.state === 'error' ? 'failed' : 'unavailable'}. No live renderer will start.`}
                            </div>
                          ))}
                      </StageImageLayers>
                      <figcaption className={nativeLibrary ? 'sr-only' : 'prototype-image-label'}>
                        <strong>{caption}</strong>
                        <span>{source}</span>
                      </figcaption>
                    </figure>
                    <StageToolbarView
                      live={live}
                      interior={selectedCamera.group === 'interior'}
                      liveLabel={live ? 'Close the 360° View' : 'Explore in 360°'}
                      liveDisabledReason={nativeLibrary ? undefined : unavailable}
                      onToggleLive={toggleLive}
                      onLiveIntent={nativeLibrary ? prefetchLiveView : undefined}
                      dimensions={dimensions}
                      onDimensions={() => setDimensions(!dimensions)}
                      autoRotate={autoRotate}
                      onAutoRotate={() => setAutoRotate(!autoRotate)}
                      onReset={() => setResetView((value) => value + 1)}
                      downloadLabel={
                        privateDisplay
                          ? 'Display candidate export unavailable'
                          : localReal
                            ? 'Local preview export unavailable'
                            : 'Download mock diagnostic'
                      }
                      downloadDisabledReason={
                        verifiedMode
                          ? unavailable
                          : image.current && shown
                            ? undefined
                            : 'Only the selected validated mock diagnostic can be downloaded. Pending, previous, failed or unavailable images cannot be exported.'
                      }
                      onDownload={downloadDiagnostic}
                      fullscreen={fullscreen}
                      onFullscreen={() => toggleFullscreen(frame.current)}
                      onMoreSettings={moreSettings}
                      settings={
                        <>
                          <SceneLookControls
                            lookRef={design.presentation.lookRef}
                            onChange={(lookRef) =>
                              action({ type: 'update-presentation', patch: { lookRef } })
                            }
                          />
                          <div className="section-label">Draft aspect</div>
                          <div className="scene-settings" role="group" aria-label="Draft aspect">
                            {(['wide', 'tall'] as const).map((value) => (
                              <button
                                key={value}
                                aria-pressed={aspect === value}
                                onClick={() =>
                                  action({ type: 'update-presentation', patch: { aspect: value } })
                                }
                              >
                                {value === 'wide' ? 'Wide · 16:10' : 'Tall · 4:5'}
                              </button>
                            ))}
                          </div>
                        </>
                      }
                    />
                  </>
                )}
              </StageFrame>
              {!plan && (
                <>
                  <StageFilmstrip
                    label={nativeLibrary ? 'Rendered camera views' : 'Five draft cameras'}
                    aspect={aspect}
                    selected={design.presentation.cameraRef}
                    onPick={pickCamera}
                    items={CUSTOMER_CAMERAS.map((camera) => ({
                      id: camera.ref,
                      label: camera.name.replace('DRAFT — ', ''),
                      accessibleLabel: `${camera.name.replace('DRAFT — ', '')} DRAFT · ${camera.group}`,
                      group: camera.group,
                      url:
                        nativeLibrary && catalog
                          ? (() => {
                              const entry = findNativeImage(catalog, {
                                ...design,
                                presentation: { ...design.presentation, cameraRef: camera.ref },
                              })
                              return entry ? nativeThumbUrl(entry) : undefined
                            })()
                          : undefined,
                      placeholder: (() => {
                        const view = setState?.snapshot?.views.find(
                          (view) => view.cameraRef === camera.ref,
                        )
                        if (view?.status === 'ready') return <LibraryThumbnail image={view.image} />
                        if (nativeLibrary && view?.status === 'pending')
                          return (
                            <span className="film-build">
                              <BuildAnimation config={projectDesignToConfig(design)} />
                              <small>{view.stage === 'queued' ? 'Queued' : 'Rendering'}</small>
                            </span>
                          )
                        return (
                          <span className="prototype-camera-placeholder">
                            {camera.name.replace('DRAFT — ', '')}
                            <small>
                              {nativeLibrary
                                ? view?.status === 'missing'
                                  ? 'Not yet rendered'
                                  : view?.status === 'pending'
                                    ? 'In progress'
                                    : view?.status === 'failed'
                                      ? 'Stopped'
                                      : 'Checking availability'
                                : 'DRAFT'}
                            </small>
                          </span>
                        )
                      })(),
                    }))}
                  />
                  {/* Only after the closing fade: it takes height from the stage, and a canvas
                      resized under the fade would lose the frame that is fading. */}
                  {nativeLibrary && !live && !leaving && (
                    <div className="native-image-status-slot">
                      {setState && image.current ? (
                        <LibrarySetStatus
                          design={design}
                          library={setState}
                          catalog={catalog}
                          hasImage
                          onDetails={() => setDialog('image')}
                        />
                      ) : null}
                    </div>
                  )}
                  {!nativeLibrary && (
                    <div className="prototype-image-status">
                      {!verifiedMode && (
                        <div className="view-switch" role="group" aria-label="Image source">
                          <button
                            aria-pressed={display === 'reference'}
                            className={display === 'reference' ? 'active' : ''}
                            onClick={() => setDisplay('reference')}
                          >
                            Historical reference
                          </button>
                          <button
                            aria-pressed={display === 'mock'}
                            className={display === 'mock' ? 'active' : ''}
                            onClick={() => setDisplay('mock')}
                          >
                            View mock preview
                          </button>
                        </div>
                      )}
                      {localReal && (
                        <button
                          className="text-link"
                          onClick={() => {
                            if (
                              !window.confirm(
                                'Use the Studio-20 Obsidian front-left wide preview setup? This replaces only your in-memory design as one Undo step. Saved builds are unchanged.',
                              )
                            )
                              return
                            load(localRenderDesign('obsidian'))
                            setPlan(false)
                            notify(
                              'Studio-20 preview setup selected. Choose Bronze in Exterior for the second supported finish. Other full designs remain editable but have no matching rendered preview.',
                            )
                          }}
                        >
                          Use Studio-20 preview setup
                        </button>
                      )}
                      <span role="status" aria-live="polite">
                        {stateLabel}
                        {!image.current && (shown || localShown || displayShown)
                          ? privateDisplay
                            ? ' · Previous display image hidden; not this configuration'
                            : localReal
                              ? ' · Previous local image hidden; not this configuration'
                              : ' · Previous diagnostic retained'
                          : ''}
                        <span
                          className={
                            !verifiedMode &&
                            (progress.state === 'pending' || progress.state === 'ready')
                              ? 'sr-only'
                              : undefined
                          }
                        >
                          {' '}
                          — {status}
                        </span>
                      </span>
                      {!verifiedMode &&
                        (progress.state === 'error' || progress.state === 'unavailable') && (
                          <button
                            className="text-link"
                            onClick={image.retry}
                            disabled={!progress.retryable}
                          >
                            Retry mock preview
                          </button>
                        )}
                      <button className="text-link" onClick={() => setDialog('image')}>
                        Image status & limits
                      </button>
                      {nativeLibrary && progress.state === 'error' && (
                        <button className="text-link" onClick={image.retry}>
                          Retry image
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
              <ConfiguratorPanelToggle
                open={mobilePanel}
                onToggle={() => setMobilePanel(!mobilePanel)}
                configurationId="prototype-configuration"
              />
              {plan && <DesignSpecification design={design} unit={unit} showPlan compact />}
            </div>
          </section>
          <div className="panel-wrapper">
            <DesignPanel
              design={design}
              renderedLibrary={nativeLibrary}
              onAction={action}
              unit={unit}
              setUnit={setUnit}
              step={step}
              setStep={setStep}
              onPlan={() => pickView('plan')}
            />
          </div>
        </>
      }
    >
      <ConfiguratorSummary
        monogram={
          <>
            {product.family === 'studio' ? 'S' : 'C'}
            {product.lengthFt}
          </>
        }
        title={<>Your {product.family === 'studio' ? 'Studio' : 'Container Gym'}</>}
        detail={
          <>
            {distance(product.lengthFt, unit)} × {distance(8, unit)} · {finish.name} · Fixed DRAFT
            arrangement
          </>
        }
        estimate={
          <>
            <button onClick={() => setDialog('specification')}>
              <span>SELECTED BUILD · DRAFT</span>
              <strong>
                Quote required <ChevronDown size={15} />
              </strong>
            </button>
            <small>No priced estimate · Approvals outstanding</small>
          </>
        }
        action={
          <button className="primary brief-cta" onClick={() => setDialog('specification')}>
            <span>
              Design specification<small>Your complete draft, independent of imagery.</small>
            </span>
            <ArrowRight size={19} />
          </button>
        }
      />
      <ConfiguratorNotification message={notice} onDismiss={() => notify('')} />
      {dialog === 'specification' && (
        <Modal
          title="Design specification"
          subtitle="DRAFT · Quote and approvals required. No strict image or PDF export."
          onClose={() => setDialog(null)}
          wide
        >
          <DesignSpecification design={design} unit={unit} showPlan={false} />
          <p className="prototype-fine">
            A priced estimate is unavailable for this draft catalog. No sales request is submitted;
            product, site and engineering review are required before a quote.
          </p>
          <button
            className="secondary"
            onClick={() => {
              setDialog(null)
              pickView('plan')
            }}
          >
            Read-only plan
          </button>
        </Modal>
      )}
      {dialog === 'image' && (
        <Modal title="Image status & limits" onClose={() => setDialog(null)}>
          <p className="prototype-warning">{caption}</p>
          <p>{source}</p>
          <p>
            Requested: {selectedCamera.name} · {design.presentation.aspect} ·{' '}
            {design.presentation.lookRef}. Displayed:{' '}
            {nativeLibrary
              ? image.current
                ? 'exact native GPU render for this design'
                : 'no matching rendered image'
              : privateDisplay
                ? image.current
                  ? 'selected exact display candidate, unqualified'
                  : displayShown
                    ? 'none; previous display image hidden, not selected'
                    : 'no verified display image'
                : localReal
                  ? image.current
                    ? 'selected exact local preview, unqualified'
                    : localShown
                      ? 'none; previous local image hidden, not selected'
                      : 'no verified local image'
                  : display === 'reference'
                    ? `fixed historical ${HISTORICAL_REFERENCE.view}`
                    : image.current
                      ? 'selected request diagnostic, not an approved image'
                      : shown
                        ? 'previous request diagnostic, not selected'
                        : 'no decoded diagnostic'}
            .
          </p>
          <p role="status">
            {status}
            {!verifiedMode && display === 'reference' && ' Historical reference remains on stage.'}
          </p>
          {nativeLibrary && (
            <section className="prototype-local-provenance">
              {setState?.message && (
                <>
                  <p role="status">{setState.message}</p>
                  <button className="text-link" onClick={setState.refresh}>
                    Check status
                  </button>
                </>
              )}
              <p>
                This library contains real Blender/Cycles images rendered privately on Modal L40S
                GPUs. Each exact design and scene has five customer views: four exterior views and
                one interior entry. The original Studio Day collection supplies five views; its
                Studio Night sets start with one front three-quarter view. Only an explicit request
                can complete missing images, when rendering is enabled. No paid backfill runs here.
              </p>
              <p>
                Art direction, fonts, materials and engineering remain draft. These are not strict
                reference exports. Images are delivered as high-quality WebP; cached delivery is
                separate from original GPU rendering time.
              </p>
              {nativeShown && image.current && (
                <dl>
                  {Object.entries(
                    'imageSha256' in nativeShown.artifact
                      ? {
                          imageChecksum: nativeShown.artifact.imageSha256,
                          historicalRecipeDigest: nativeShown.artifact.recipeDigest,
                          originalRenderSeconds: nativeShown.artifact.renderSeconds.toFixed(2),
                        }
                      : {
                          imageChecksum: nativeShown.artifact.sha256,
                          recipeRelease: nativeShown.artifact.recipeRelease.id,
                          provenance: nativeShown.artifact.provenance.kind,
                        },
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          )}
          {!verifiedMode && (progress.state === 'error' || progress.state === 'unavailable') && (
            <button className="secondary" onClick={image.retry} disabled={!progress.retryable}>
              Retry mock preview
            </button>
          )}
          {privateDisplay && (
            <section
              className="prototype-local-provenance"
              aria-label={
                cloudDisplay ? 'Private cloud display provenance' : 'Private display provenance'
              }
            >
              <p>
                Full supported designs use the fixed aspect-appropriate Ultra display profile, not
                the two-sample Lite lane. The requested profile is not evidence of GPU execution,
                visual quality, memory stability or response speed. No renderer is finally selected.
              </p>
              {cloudDisplay ? (
                <p>
                  Cloud execution is held in this build. Separate capped approval, a reviewed
                  runtime package and secure hardware proof are required; a local permit never
                  authorizes it. Cache hits are not render jobs. Image completion, process exit,
                  provider termination and final billing remain separate facts. This receipt is
                  external-private-three-display, never local or mock provenance. No browser setting
                  authorizes work. Share links preserve the design but open ordinary mock mode; this
                  mode requires explicit DEV imageMode=private-cloud-display selection. No automatic
                  retry or fallback.
                </p>
              ) : (
                <p>
                  Execution requires a separately provisioned local operator permit and hardware. No
                  browser setting authorizes work. No automatic retry or fallback. Image completion
                  proves neither host shutdown nor final billing. Share links preserve the design
                  and intentionally open ordinary mock mode; this mode requires the explicit local
                  DEV imageMode=private-display selection.
                </p>
              )}
              <ul>
                {displayHolds(design).map((hold) => (
                  <li key={hold}>{hold}</li>
                ))}
              </ul>
              {displayShown && (
                <>
                  <strong>
                    {image.current
                      ? 'Selected exact candidate provenance'
                      : 'PREVIOUS candidate provenance — image hidden, not this configuration'}
                  </strong>
                  <p>
                    {displayBinding!.profile.id} · {displayShown.artifact.width}×
                    {displayShown.artifact.height} · {displayShown.artifact.cacheStatus}
                  </p>
                  <dl>
                    {Object.entries({
                      ...displayBinding!.requested,
                      displayDigest: displayBinding!.displayDigest,
                      ...displayBinding!.build,
                      provenance: displayShown.artifact.provenance.kind,
                      ...(displayShown.mode === 'private-cloud-display'
                        ? {
                            recipeDigest: displayShown.recipe.recipeDigest,
                            workerPackageDigest: displayShown.recipe.workerPackageDigest,
                            cameraDigest: displayShown.recipe.cameraDigest,
                            proofDigest: displayShown.artifact.provenance.proofDigest,
                          }
                        : {}),
                      checksum: displayShown.artifact.checksum,
                      receiptDigest: displayShown.artifact.receiptDigest,
                      sessionId: displayShown.artifact.provenance.sessionId,
                      revision: displayShown.artifact.provenance.revision,
                    }).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <ul>
                    {displayShown.artifact.provenance.holds.map((hold) => (
                      <li key={hold}>{hold}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          {localReal && (
            <section className="prototype-local-provenance" aria-label="Local render provenance">
              <p>
                Only the complete Studio-20 front-left wide default Obsidian or Bronze design
                matches this slice. No approved current image, G1, visual parity, photorealism or
                production-speed claim. No paid fallback.
              </p>
              <p>
                Lite omits ambient occlusion, screen-space GI/reflections, bloom and path tracing.
                Mirror is probe-lit approximation, not planar reflection; thin glass/transmission
                and site light field are limited. Actual per-capture details follow when verified.
              </p>
              <p>
                Capture failures, capacity limits and uncertain timeouts require operator review.
                Retry cannot safely authorize another capture; none is started automatically. Share
                links preserve the design but intentionally open ordinary mock mode; add
                imageMode=local-real to the local DEV URL to use this mode.
              </p>
              {localShown && (
                <>
                  <strong>
                    {image.current
                      ? 'Selected verified preview'
                      : 'PREVIOUS preview provenance — image hidden, not this configuration'}
                  </strong>
                  <p>
                    {localShown.artifact.provenance.runtime.backend} /{' '}
                    {localShown.artifact.provenance.runtime.acceleration} ·{' '}
                    {localShown.artifact.provenance.runtime.adapter}
                  </p>
                  <p>
                    Browser: {localShown.artifact.provenance.runtime.browserVersion} ·{' '}
                    {localShown.artifact.provenance.runtime.userAgent}
                  </p>
                  <p>
                    {localShown.artifact.cacheStatus === 'verified-exact-hit'
                      ? 'Verified exact local cache'
                      : 'New local capture'}{' '}
                    · {localShown.artifact.provenance.sampleId}
                  </p>
                  <dl>
                    {Object.entries({
                      ...localShown.requested,
                      captureDigest: localShown.capture.captureDigest,
                      ...localShown.capture.build,
                      checksum: localShown.artifact.checksum,
                      receiptDigest: localShown.artifact.provenance.receiptDigest,
                      jobId: localShown.artifact.provenance.jobId,
                    }).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <ul>
                    {localShown.artifact.provenance.runtime.effects.map((effect) => (
                      <li key={effect.id}>
                        {effect.id}: {effect.state} — {effect.detail}
                      </li>
                    ))}
                  </ul>
                  <ul>
                    {localShown.artifact.provenance.holds.map((hold) => (
                      <li key={hold}>{hold}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          <p className="prototype-fine" id="prototype-unavailable">
            {unavailable}
          </p>
          <button className="secondary" disabled aria-describedby="prototype-unavailable">
            Strict image / PDF export
          </button>
          <p className="prototype-warning">
            All four arrangements are DRAFT. Engineering, ceiling, door, access, rights, art,
            camera, renderer, performance and G1 gates remain open. Save, share, JSON and history do
            not require an image.
          </p>
        </Modal>
      )}
      {dialog === 'help' && (
        <Modal
          title="A clearer starting point."
          subtitle="Local DEV image prototype · Not a production cutover."
          onClose={() => setDialog(null)}
        >
          <div className="help-grid">
            <div>
              <span>01</span>
              <strong>Shape your space</strong>
              <p>
                Choose footprint, finishes and structure. Required adjustments apply together as one
                Undo step.
              </p>
            </div>
            <div>
              <span>02</span>
              <strong>Fixed DRAFT arrangement</strong>
              <p>
                Floor plan is read-only. Ceiling, doors, access and engineering remain on hold. No
                equipment editing or approvals.
              </p>
            </div>
            <div>
              <span>03</span>
              <strong>Keep the possibilities</strong>
              <p>
                Save explicitly in My builds, share the complete draft or export design JSON, even
                without an image. Original data is never silently migrated.
              </p>
            </div>
          </div>
          <p className="prototype-warning">
            {unavailable} Quotes, rights, art, camera, renderer, performance and G1 approval remain
            outstanding. No sales request is submitted.
          </p>
          <button
            className="secondary full"
            onClick={() => {
              if (
                !window.confirm(
                  'Reset to the original draft? Saved builds and recovery copies will not be deleted. Undo remains available.',
                )
              )
                return
              changeHistory({ type: 'commit', design: defaultDesign() })
              setPlan(false)
              setDialog(null)
              notify('Your draft is reset. Undo restores the complete previous design.')
            }}
          >
            <RotateCcw size={16} />
            Start fresh
          </button>
        </Modal>
      )}
    </ConfiguratorShell>
  )
}
