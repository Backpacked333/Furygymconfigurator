import { Vector3, type BufferGeometry } from 'three'

/** Side-surface triangles only: finds unwrap discontinuities, not visual approval. */
export function auditCylinderUV(geometry: BufferGeometry) {
  const positions = geometry.getAttribute('position')
  const normals = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')
  if (!positions || !normals || !uv) throw new Error('Position, normal and UV attributes required')
  const indices = geometry.getIndex()
  const count = indices?.count ?? positions.count
  const at = (i: number) => (indices ? indices.getX(i) : i)
  const a = new Vector3()
  const b = new Vector3()
  let sideTriangles = 0
  let discontinuousTriangles = 0
  let maxUvSpanFeet = 0
  let maxStretchRatio = 0
  for (let i = 0; i < count; i += 3) {
    const ids = [at(i), at(i + 1), at(i + 2)]
    if (ids.some((id) => Math.abs(normals.getY(id)) > 0.9)) continue
    sideTriangles++
    let discontinuous = false
    for (let j = 0; j < 3; j++) {
      const from = ids[j],
        to = ids[(j + 1) % 3]
      a.fromBufferAttribute(positions, from)
      b.fromBufferAttribute(positions, to)
      const worldSpan = a.distanceTo(b)
      const uvSpan = Math.hypot(uv.getX(from) - uv.getX(to), uv.getY(from) - uv.getY(to))
      const ratio = worldSpan > 1e-6 ? uvSpan / worldSpan : 0
      maxUvSpanFeet = Math.max(maxUvSpanFeet, uvSpan)
      maxStretchRatio = Math.max(maxStretchRatio, ratio)
      if (ratio > 4) discontinuous = true
    }
    if (discontinuous) discontinuousTriangles++
  }
  return {
    sideTriangles,
    discontinuousTriangles,
    maxUvSpanFeet,
    maxStretchRatio,
    thresholdRatio: 4,
  }
}
