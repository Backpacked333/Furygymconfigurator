import { useState } from 'react'
import { Grid2X2 } from 'lucide-react'
import Modal from '../components/Modal'
import type { DesignEnvelope } from '../domain/design'
import { FINISHES, FLOORS, INTERIORS } from '../lib/config'
import { nativeThumbUrl, type NativeLibrary } from './nativeLibrary'

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
          title="Find your starting point"
          subtitle={`${presets.length} starting points · Studio Day 5/5 · Studio Night 1/5 in the original collection`}
          wide
          onClose={() => setOpen(false)}
        >
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
            available. Each exact design and scene has five views; missing views can be requested
            when rendering is enabled.
          </p>
          <div className="native-library-grid">
            {filtered.map((entry) => {
              const { product, appearance } = entry.design.config
              const finish = FINISHES.find((value) => value.id === appearance.finish)!
              return (
                <button
                  key={entry.configId}
                  className="native-library-card"
                  onClick={() => {
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
            Draft design previews, not engineering approval or strict reference exports. The live
            image set checks for newer images; these counts describe the original collection only.
          </p>
        </Modal>
      )}
    </>
  )
}
