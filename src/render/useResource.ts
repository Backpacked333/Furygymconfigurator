import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DependencyList,
  type RefObject,
} from 'react'
import type { Material, Object3D } from 'three'
import { retainMaterials } from './materials'

/** Only mounted scene branches acquire scanned maps. Never run builders to discover assets. */
export function useMaterialOwner(
  root: RefObject<Object3D | null>,
  deps: DependencyList,
  scope = 'scene',
) {
  const id = useId()
  const retained = useRef(new Map<Material, () => void>())
  useLayoutEffect(() => {
    const next = new Set<Material>()
    root.current?.traverse((object) => {
      const material = (object as Object3D & { material?: Material | Material[] }).material
      if (material) (Array.isArray(material) ? material : [material]).forEach((m) => next.add(m))
    })
    // Retain additions before releasing removals, so shared maps never bounce through zero.
    next.forEach((m) => {
      if (!retained.current.has(m)) retained.current.set(m, retainMaterials([m], `${scope}:${id}`))
    })
    retained.current.forEach((release, m) => {
      if (!next.has(m)) {
        release()
        retained.current.delete(m)
      }
    })
    // The caller names all changes to its committed subtree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useLayoutEffect(() => {
    const leases = retained.current
    return () => {
      leases.forEach((release) => release())
      leases.clear()
    }
  }, [])
}

/**
 * Creates a disposable GPU resource in an effect, so React StrictMode's mount-unmount-mount cycle
 * never leaves a disposed object in use. Returns null until the resource exists.
 */
export function useResource<T extends { dispose: () => void }>(
  create: () => T,
  deps: DependencyList,
) {
  const [resource, setResource] = useState<{ value: T; deps: DependencyList } | null>(null)
  useEffect(() => {
    const created = create()
    setResource({ value: created, deps: [...deps] })
    return () => {
      created.dispose()
    }
    // The caller's deps fully describe `create`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return resource &&
    deps.length === resource.deps.length &&
    deps.every((dep, i) => Object.is(dep, resource.deps[i]))
    ? resource.value
    : null
}
