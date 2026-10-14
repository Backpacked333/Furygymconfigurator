import { BufferGeometry, CylinderGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { auditCylinderUV } from './uvAudit'

function feetCylinder() {
  const g = new CylinderGeometry(1, 1, 2, 32)
  const uv = g.getAttribute('uv')
  for (let i = 0; i < 66; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2, uv.getY(i) * 2)
  return g
}

describe('cylindrical UV diagnostic', () => {
  it('accepts a split, continuous cylindrical unwrap in feet', () => {
    const g = feetCylinder()
    expect(auditCylinderUV(g)).toMatchObject({ sideTriangles: 64, discontinuousTriangles: 0 })
    g.dispose()
  })
  it('detects an injected seam span without encoding the production defect as desired behavior', () => {
    const g = feetCylinder()
    const uv = g.getAttribute('uv')
    uv.setX(16, uv.getX(16) - Math.PI * 2)
    expect(auditCylinderUV(g).discontinuousTriangles).toBeGreaterThan(0)
    expect(auditCylinderUV(g).maxStretchRatio).toBeGreaterThan(4)
    g.dispose()
  })
  it('rejects missing attribute data instead of reporting a false pass', () => {
    expect(() => auditCylinderUV(new BufferGeometry())).toThrow('attributes required')
  })
})
