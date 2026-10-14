// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BoxGeometry, MeshStandardMaterial } from 'three'
import * as modelParts from '../render/parts'
import { Parts } from './Parts'

describe('mounted architectural batch ownership', () => {
  it('does not dispose borrowed materials or a StrictMode-recommitted geometry', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = new BoxGeometry(1, 1, 1)
    const geometryDispose = vi.spyOn(source, 'dispose')
    const created: ReturnType<typeof vi.fn>[][] = []
    const originalBatch = modelParts.batch
    const batch = vi.spyOn(modelParts, 'batch').mockImplementation((parts) => {
      const batches = originalBatch(parts)
      created.push(
        batches.map(({ geometry }) => {
          const disposed = vi.fn()
          geometry.addEventListener('dispose', disposed)
          return disposed
        }),
      )
      return batches
    })
    const material = new MeshStandardMaterial()
    const materialDispose = vi.spyOn(material, 'dispose')
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      const first = [modelParts.part(source, material, [0, 0, 0])]
      const draw = async (parts: typeof first) => {
        await act(async () => {
          root.render(
            <StrictMode>
              <Parts parts={parts} />
            </StrictMode>,
          )
        })
      }
      await draw(first)
      expect(host.querySelector('mesh')).not.toBeNull()
      expect(source.attributes.position.count).toBeGreaterThan(0)
      expect(materialDispose).not.toHaveBeenCalled()
      expect(geometryDispose).not.toHaveBeenCalled()
      const totalDisposals = () =>
        created.flat().reduce((sum, disposed) => sum + disposed.mock.calls.length, 0)
      expect(totalDisposals()).toBe(0)
      await draw([modelParts.part(source, material, [2, 0, 0])])
      expect(totalDisposals()).toBe(1)
      expect(materialDispose).not.toHaveBeenCalled()
      expect(geometryDispose).not.toHaveBeenCalled()
      await act(async () => root.unmount())
      expect(totalDisposals()).toBe(2)
      created
        .flat()
        .forEach((disposed) => expect(disposed.mock.calls.length).toBeLessThanOrEqual(1))
      expect(materialDispose).not.toHaveBeenCalled()
      expect(geometryDispose).not.toHaveBeenCalled()
    } finally {
      warnings.mockRestore()
      batch.mockRestore()
      geometryDispose.mockRestore()
      materialDispose.mockRestore()
      source.dispose()
      material.dispose()
      vi.unstubAllGlobals()
    }
  })
})
