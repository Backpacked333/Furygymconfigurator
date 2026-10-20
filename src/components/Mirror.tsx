import type { MirrorSurface } from '../render/mirror'

/** The pane of a mirror, of the glass `useMirror` (render/mirror.ts) made. */
export function Mirror({
  width,
  height,
  surface,
}: {
  width: number
  height: number
  surface: MirrorSurface
}) {
  return (
    <mesh material={surface.material} userData={{ noProbe: true }}>
      <planeGeometry args={[width, height]} />
      {surface.target && <primitive object={surface.target} />}
    </mesh>
  )
}
