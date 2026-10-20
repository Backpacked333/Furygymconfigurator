import { useEffect, useState } from 'react'
import { Grid2X2 } from 'lucide-react'
import Modal from '../components/Modal'
import type { DesignEnvelope } from '../domain/design'
import { CUSTOMER_CAMERA_REFS, resolveCamera } from '../domain/presentation'
import { normalizeCustomerDesign } from '../render-library/views'
import { FINISHES, FLOORS, INTERIORS } from '../lib/config'
import {
  decodeNativeImage,
  nativeThumbUrl,
  type NativeEntry,
  type NativeLibrary,
} from './nativeLibrary'

function SavedImage({ entry }: { entry: NativeEntry }) {
  const [image, setImage] = useState<{ key: string; src?: string; failed?: true } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let release: (() => void) | undefined
    void decodeNativeImage(entry, controller.signal).then(
      (decoded) => {
        if (controller.signal.aborted) return decoded.release()
        release = decoded.release
        setImage({ key: entry.imageSha256, src: decoded.src })
      },
      () => {
        if (!controller.signal.aborted) setImage({ key: entry.imageSha256, failed: true })
      },
    )
    return () => {
      controller.abort()
      release?.()
    }
  }, [entry])
  const current = image?.key === entry.imageSha256 ? image : null
  return (
    <div className="native-saved-image" aria-busy={!current}>
      {current?.src ? (
        <img
          src={current.src}
          width={entry.width}
          height={entry.height}
          alt={`Saved closed-door ${entry.design.config.product.family} ${entry.design.config.product.lengthFt} ft · ${resolveCamera(entry.design.presentation.cameraRef).name.replace('DRAFT — ', '')}`}
        />
      ) : (
        <p role="status">
          {current?.failed
            ? 'Could not load the saved image. Select another view or reopen this preview to retry. No render was requested.'
            : 'Loading saved image…'}
        </p>
      )}
    </div>
  )
}

export function NativeLibraryGallery({
  library,
  onLoad,
}: {
  library: NativeLibrary | null
  onLoad: (design: DesignEnvelope) => void
}) {
  const [open, setOpen] = useState(false)
  const [family, setFamily] = useState('all')
  const [size, setSize] = useState('all')
  const [saved, setSaved] = useState<NativeEntry | null>(null)
  const savedViews = saved
    ? (library?.entries.filter(
        (entry) =>
          entry.configId === saved.configId &&
          entry.design.presentation.lookRef === saved.design.presentation.lookRef &&
          entry.design.presentation.aspect === saved.design.presentation.aspect &&
          (CUSTOMER_CAMERA_REFS as readonly string[]).includes(entry.design.presentation.cameraRef),
      ) ?? [])
    : []
  const presets =
    library?.entries.filter(
      (entry) =>
        entry.design.presentation.cameraRef === 'front-left-draft@1' &&
        entry.design.presentation.lookRef === 'studio-day-draft@1',
    ) ?? []
  const filtered = presets.filter(
    ({
      design: {
        config: { product },
      },
    }) =>
      (family === 'all' || product.family === family) &&
      (size === 'all' || String(product.lengthFt) === size),
  )
  return (
    <>
      <button className="nav-btn native-browse" onClick={() => setOpen(true)}>
        <Grid2X2 size={16} />
        <span>Rendered builds</span>
      </button>
      {open && (
        <Modal
          title={
            saved
              ? `Saved Container ${saved.design.config.product.lengthFt} ft`
              : 'Find your starting point'
          }
          subtitle={
            saved
              ? 'Original closed-door images · no new rendering'
              : `${presets.length} starting points · Studio Day 5/5 · Studio Night 1/5 in the original collection`
          }
          wide
          onClose={() => {
            setOpen(false)
            setSaved(null)
          }}
        >
          {saved ? (
            <section aria-label="Saved closed-door images">
              <p className="native-library-intro">
                These are the original saved images with doors closed. The current Container
                configuration shows doors open and uses a separate image set. Your saved images and
                current design are unchanged.
              </p>
              <SavedImage entry={saved} />
              <div className="native-saved-views" role="group" aria-label="Original saved views">
                {savedViews.map((entry) => (
                  <button
                    key={entry.id}
                    className="secondary"
                    aria-pressed={entry.id === saved.id}
                    onClick={() => setSaved(entry)}
                  >
                    {resolveCamera(entry.design.presentation.cameraRef).name.replace(
                      'DRAFT — ',
                      '',
                    )}
                  </button>
                ))}
              </div>
              <p className="prototype-fine">
                Original camera framing. These closed-door images are not substituted for a new
                open-door design.
              </p>
              <div className="native-saved-actions">
                <button className="secondary" onClick={() => setSaved(null)}>
                  Back to rendered builds
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    onLoad(normalizeCustomerDesign(saved.design))
                    setSaved(null)
                    setOpen(false)
                  }}
                >
                  Configure open-door version
                </button>
              </div>
            </section>
          ) : (
            <>
              <div className="native-library-filters">
                <label>
                  Collection
                  <select value={family} onChange={(event) => setFamily(event.target.value)}>
                    <option value="all">All collections</option>
                    <option value="studio">S-Series Studio</option>
                    <option value="container">Container Gym</option>
                  </select>
                </label>
                <label>
                  Length
                  <select value={size} onChange={(event) => setSize(event.target.value)}>
                    <option value="all">All sizes</option>
                    <option value="20">20 ft</option>
                    <option value="40">40 ft</option>
                  </select>
                </label>
                <span>{filtered.length} builds</span>
              </div>
              <p className="native-library-intro">
                Start with a rendered build, then make it yours. All configuration options stay
                available. Each exact design and scene has five views; missing views can be
                requested when rendering is enabled.
              </p>
              <div className="native-library-grid">
                {filtered.map((entry) => {
                  const { product, appearance } = entry.design.config
                  const finish = FINISHES.find((value) => value.id === appearance.finish)!
                  const changesDoorPose =
                    normalizeCustomerDesign(entry.design).presentation.doorPose !==
                    entry.design.presentation.doorPose
                  return (
                    <button
                      key={entry.configId}
                      className="native-library-card"
                      onClick={() => {
                        if (changesDoorPose) {
                          setSaved(entry)
                          return
                        }
                        onLoad(entry.design)
                        setOpen(false)
                      }}
                    >
                      <img
                        src={nativeThumbUrl(entry)}
                        width={384}
                        height={240}
                        loading="lazy"
                        alt={`${product.family === 'studio' ? 'Studio' : 'Container Gym'} ${product.lengthFt}, ${finish.name}`}
                      />
                      <span className="native-card-meta">
                        <strong>
                          {product.family === 'studio' ? 'S' : 'C'}-{product.lengthFt}{' '}
                          <span>{finish.name}</span>
                        </strong>
                        <small>
                          {INTERIORS.find((value) => value.id === appearance.interior)?.name} ·{' '}
                          {FLOORS.find((value) => value.id === appearance.floor)?.name}
                          {appearance.accent ? ' · Accent' : ''}
                        </small>
                        <small>Studio Day · 5/5 views · Night starts at 1/5</small>
                        {changesDoorPose && <small>View saved closed-door images</small>}
                      </span>
                    </button>
                  )
                })}
              </div>
              {!library && (
                <p role="status">
                  The rendered library is loading. Close this panel and retry if your connection is
                  unavailable.
                </p>
              )}
              <p className="prototype-fine">
                Draft design previews, not engineering approval or strict reference exports. The
                live image set checks for newer images; these counts describe the original
                collection only.
              </p>
            </>
          )}
        </Modal>
      )}
    </>
  )
}
