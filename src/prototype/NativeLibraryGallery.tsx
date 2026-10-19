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
          subtitle={`${presets.length} configurations · ${library?.entries.length ?? 0} real GPU images · Studio Day & Night`}
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
            Choose a complete build, then explore its cameras and finishes. Changes remain editable;
            combinations outside this image library are clearly marked.
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
            Rendered design previews, not engineering approval or strict reference exports. Outdoor
            landscapes and unlisted combinations are not included in this batch.
          </p>
        </Modal>
      )}
    </>
  )
}
