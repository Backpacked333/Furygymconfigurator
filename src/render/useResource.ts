import { useEffect, useState, type DependencyList } from 'react'

/**
 * Creates a disposable GPU resource in an effect, so React StrictMode's mount-unmount-mount cycle
 * never leaves a disposed object in use. Returns null until the resource exists.
 */
export function useResource<T extends { dispose: () => void }>(
  create: () => T,
  deps: DependencyList,
) {
  const [resource, setResource] = useState<T | null>(null)
  useEffect(() => {
    const created = create()
    setResource(created)
    return () => {
      created.dispose()
    }
    // The caller's deps fully describe `create`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return resource
}
