import { MeshStandardMaterial, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { box, cylinder } from './geometry'
import {
  acquireBatches,
  batch,
  batchKeys,
  cachedBatches,
  part,
  releaseBatches,
  type Part,
} from './parts'

describe('batched geometry', () => {
  it('is named by its content, so a model rebuilt from the same parts reads as the same shape', () => {
    const paint = new MeshStandardMaterial()
    const build = (finish: MeshStandardMaterial, lift = 0) => [
      part(box(2, 1, 1), finish, [0, lift, 0]),
      part(cylinder(0.2, 0.2, 1), finish, [1, 0, 0], [0, 0, 1]),
      part(box(1, 1, 1), finish, [0, 0, 2], undefined, [1, 1, -1]),
    ]
    const first = batch(build(paint))
    const again = batch(build(paint))
    expect(first).toHaveLength(1)
    expect(first[0].geometry).not.toBe(again[0].geometry)
    expect(first[0].geometry.userData.key).toMatch(/^batch:[0-9a-f]+$/)
    expect(again[0].geometry.userData.key).toBe(first[0].geometry.userData.key)
    // Another finish on the same parts: the same shape.
    expect(batch(build(new MeshStandardMaterial()))[0].geometry.userData.key).toBe(
      first[0].geometry.userData.key,
    )
    // A part placed elsewhere, or another part: another shape.
    expect(batch(build(paint, 0.5))[0].geometry.userData.key).not.toBe(
      first[0].geometry.userData.key,
    )
    expect(batch(build(paint).slice(1))[0].geometry.userData.key).not.toBe(
      first[0].geometry.userData.key,
    )
    // The generators name their geometries too.
    expect(box(2, 1, 1).userData.key).toBe(box(2, 1, 1).userData.key)
    expect(box(2, 1, 1).userData.key).not.toBe(box(2, 1, 1.5).userData.key)
  })
})

describe('merged geometry shared by content (the live 360° view)', () => {
  /** The cache sweeps on a later task. */
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))
  let lift = 100
  /** A part list of its own shape: the cache is shared by every test in the file. */
  const shape = () => {
    const y = lift++
    return (finish = new MeshStandardMaterial(), trim = new MeshStandardMaterial()): Part[] => [
      part(box(2, 1, 1), finish, [0, y, 0]),
      part(cylinder(0.2, 0.2, 1), finish, [1, y, 0], [0, 0, 1]),
      part(box(1, 1, 1), trim, [0, y, 2], undefined, [1, 1, -1], false),
    ]
  }
  const disposals = (geometry: BufferGeometry) => {
    const counted = { count: 0 }
    geometry.addEventListener('dispose', () => counted.count++)
    return counted
  }

  it('hands a list rebuilt in other materials the same geometry, with the batches batch makes', () => {
    const build = shape()
    const first = cachedBatches(build())
    const again = cachedBatches(build())
    expect(first).toHaveLength(2)
    expect(again.map((b) => b.geometry)).toEqual(first.map((b) => b.geometry))
    expect(again[0].material).not.toBe(first[0].material)
    // Named as batch names them, with their key, in the same order.
    expect(first.map((b) => b.key)).toEqual(batchKeys(build()).map((b) => b.key))
    expect(first.map((b) => b.geometry.userData.key)).toEqual(first.map((b) => b.key))
    expect(first.map((b) => b.shadow)).toEqual([true, false])
    const own = batch(build())
    expect(own.map((b) => b.geometry.getAttribute('position').count)).toEqual(
      first.map((b) => b.geometry.getAttribute('position').count),
    )
    // Another shape: another geometry.
    expect(cachedBatches(shape()())[0].geometry).not.toBe(first[0].geometry)
  })

  it('keeps what a commit lets go of and takes up again, and disposes it once nothing holds it', async () => {
    const build = shape()
    const shown = cachedBatches(build())
    const counts = shown.map((b) => disposals(b.geometry))
    acquireBatches(shown)
    await nextTask()
    expect(counts.map((c) => c.count)).toEqual([0, 0])
    // A finish edit: the list's effect lets go of its batches and the rebuilt list's takes them
    // up, in one commit.
    const edited = cachedBatches(build())
    releaseBatches(shown)
    acquireBatches(edited)
    await nextTask()
    await nextTask()
    expect(counts.map((c) => c.count)).toEqual([0, 0])
    expect(cachedBatches(build())[0].geometry).toBe(shown[0].geometry)
    // Unmounted: disposed on a later task, once, and merged afresh after.
    releaseBatches(edited)
    expect(counts.map((c) => c.count)).toEqual([0, 0])
    await nextTask()
    await nextTask()
    expect(counts.map((c) => c.count)).toEqual([1, 1])
    // Let go of again (a stray cleanup): nothing more.
    releaseBatches(edited)
    await nextTask()
    expect(counts.map((c) => c.count)).toEqual([1, 1])
    expect(cachedBatches(build())[0].geometry).not.toBe(shown[0].geometry)
  })

  it('never keeps what a render that did not commit merged', async () => {
    const build = shape()
    const thrown = cachedBatches(build())
    const counts = thrown.map((b) => disposals(b.geometry))
    await nextTask()
    await nextTask()
    expect(counts.map((c) => c.count)).toEqual([1, 1])
    expect(cachedBatches(build())[0].geometry).not.toBe(thrown[0].geometry)
  })

  it('spares an entry handed out again after its sweep was scheduled', async () => {
    const build = shape()
    const first = cachedBatches(build())
    const count = disposals(first[0].geometry)
    // A sweep is due; before it runs, a new render is handed the entry and its commit comes later.
    await Promise.resolve()
    const later = cachedBatches(build())
    expect(later[0].geometry).toBe(first[0].geometry)
    await nextTask()
    expect(count.count).toBe(0)
    acquireBatches(later)
    await nextTask()
    await nextTask()
    expect(count.count).toBe(0)
    releaseBatches(later)
    await nextTask()
    await nextTask()
    expect(count.count).toBe(1)
  })

  it('takes back an entry swept before the commit that was handed it, rather than losing it', async () => {
    const build = shape()
    const handed = cachedBatches(build())
    // A render that yielded past the sweep: its commit comes after the entry was disposed.
    await nextTask()
    await nextTask()
    acquireBatches(handed)
    // The mesh's geometry is the cache's again, and held.
    expect(cachedBatches(build())[0].geometry).toBe(handed[0].geometry)
    const count = disposals(handed[0].geometry)
    await nextTask()
    await nextTask()
    expect(count.count).toBe(0)
    releaseBatches(handed)
    await nextTask()
    await nextTask()
    expect(count.count).toBe(1)
  })

  it('counts each holder: a renderer rebuilt after a lost device holds the same entries twice', async () => {
    const build = shape()
    const old = cachedBatches(build())
    acquireBatches(old)
    // The new root mounts before the old one unmounts.
    const rebuilt = cachedBatches(build())
    acquireBatches(rebuilt)
    expect(rebuilt[0].geometry).toBe(old[0].geometry)
    const count = disposals(old[0].geometry)
    releaseBatches(old)
    await nextTask()
    await nextTask()
    expect(count.count).toBe(0)
    releaseBatches(rebuilt)
    await nextTask()
    await nextTask()
    expect(count.count).toBe(1)
  })

  it('leaves batch alone: each call merges geometry of its own, for its caller to dispose', () => {
    const build = shape()
    const cached = cachedBatches(build())
    const own = batch(build())
    expect(own[0].geometry).not.toBe(cached[0].geometry)
    expect(own[0].geometry.userData.key).toBe(cached[0].key)
    // Not the cache's: holding or letting go of it does nothing.
    const count = disposals(own[0].geometry)
    acquireBatches(own.map((b) => ({ ...b, key: b.geometry.userData.key as string })))
    releaseBatches(own.map((b) => ({ ...b, key: b.geometry.userData.key as string })))
    expect(count.count).toBe(0)
  })
})
