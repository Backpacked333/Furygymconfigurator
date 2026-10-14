import { useEffect, useMemo } from 'react'
import { CanvasTexture, DoubleSide, ExtrudeGeometry, Path, Shape, SRGBColorSpace } from 'three'
import { MeshReflectorMaterial, RoundedBox } from '@react-three/drei'
import { FINISHES, FLOORS, type Config } from '../lib/config'
import { Equipment } from './Equipment'
import { SurfaceMaterial } from './SurfaceMaterial'
import type { Surface } from '../lib/visuals'

function roundedPath<T extends Shape | Path>(
  shape: T,
  width: number,
  height: number,
  radius: number,
  inset: number,
): T {
  const x = -width / 2 + inset,
    y = inset,
    w = width - inset * 2,
    h = height - inset * 2,
    r = radius - inset
  shape.moveTo(x + r, y)
  shape.lineTo(x + w - r, y)
  shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  shape.lineTo(x + w, y + h - r)
  shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  shape.lineTo(x + r, y + h)
  shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  shape.lineTo(x, y + r)
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  return shape
}
function Portal({
  length,
  depth,
  z,
  color,
}: {
  length: number
  depth: number
  z: number
  color: string
}) {
  const geometry = useMemo(() => {
    const shape = roundedPath(new Shape(), length, 10, 1.1, 0)
    shape.holes.push(roundedPath(new Path(), length, 10, 1.1, 0.36))
    return new ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSize: 0.035,
      bevelThickness: 0.035,
      bevelSegments: 3,
      steps: 1,
      curveSegments: 20,
    })
  }, [length, depth])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh geometry={geometry} position={[0, 0.3, z]} castShadow receiveShadow>
      <SurfaceMaterial kind="metal" color={color} roughness={0.36} metalness={0.55} />
    </mesh>
  )
}
function Box({
  p,
  s,
  color,
  roughness = 0.7,
  metal = 0,
  surface,
}: {
  p: [number, number, number]
  s: [number, number, number]
  color: string
  roughness?: number
  metal?: number
  surface?: Surface
}) {
  return (
    <mesh position={p} castShadow receiveShadow>
      <boxGeometry args={s} />
      {surface ? (
        <SurfaceMaterial kind={surface} color={color} roughness={roughness} metalness={metal} />
      ) : (
        <meshStandardMaterial color={color} roughness={roughness} metalness={metal} />
      )}
    </mesh>
  )
}
function Rail({
  length,
  x,
  z,
  alongZ = false,
}: {
  length: number
  x: number
  z: number
  alongZ?: boolean
}) {
  const count = Math.ceil(length / 3.3)
  return (
    <group position={[x, 10.4, z]} rotation={[0, alongZ ? Math.PI / 2 : 0, 0]}>
      <Box p={[0, 3.5, 0]} s={[length, 0.09, 0.1]} color="#454b45" metal={0.4} />
      {Array.from({ length: count + 1 }, (_, i) => (
        <Box
          key={i}
          p={[-length / 2 + (i * length) / count, 1.75, 0]}
          s={[0.08, 3.5, 0.08]}
          color="#454b45"
        />
      ))}
      {[0.55, 1.15, 1.75, 2.35, 2.95].map((y) => (
        <Box key={y} p={[0, y, 0]} s={[length, 0.025, 0.025]} color="#73776e" metal={0.7} />
      ))}
    </group>
  )
}
function Signature({ length }: { length: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 128
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#d9d9cc'
    ctx.font = '600 66px sans-serif'
    ctx.fillText('F U R Y', 10, 86)
    ctx.font = '24px sans-serif'
    ctx.fillText(`S / ${length}     —     PERSONAL STUDIO`, 390, 76)
    const map = new CanvasTexture(canvas)
    map.colorSpace = SRGBColorSpace
    return map
  }, [length])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh position={[-length / 2 + 3.8, 10.13, 4.042]}>
      <planeGeometry args={[5.6, 0.32]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  )
}

export function StudioModel({
  config: c,
  cutaway = false,
  quality = 'high',
}: {
  config: Config
  cutaway?: boolean
  quality?: 'high' | 'lite'
}) {
  const L = c.length,
    finish = FINISHES.find((f) => f.id === c.finish)!.color,
    floor = FLOORS.find((f) => f.id === c.flooring)!.color
  const n = L === 20 ? 6 : 12
  return (
    <group>
      {!cutaway && <Portal length={L} depth={8} z={-4} color={finish} />}
      {cutaway &&
        [-1, 1].map((side) => (
          <Box key={side} p={[side * (L / 2 - 0.18), 3, 0]} s={[0.36, 5.4, 8]} color={finish} />
        ))}
      <Box p={[0, 5.2, -3.86]} s={[L - 1.2, 9.6, 0.25]} color={finish} />
      <Box p={[0, 5.1, -3.69]} s={[L - 1.3, 8.8, 0.1]} color="#ddd5c6" surface="plaster" />
      <Box p={[0, 0.65, 0]} s={[L - 0.6, 0.5, 7.7]} color={finish} />
      <Box
        p={[0, 0.92, 0]}
        s={[L - 1.25, 0.08, 7.15]}
        color={floor}
        roughness={0.88}
        surface={c.flooring}
      />
      <Box p={[0, 1.15, -3.57]} s={[L - 1.3, 0.25, 0.08]} color="#3d403a" metal={0.4} />
      {!cutaway && (
        <>
          <Signature length={L} />
          <Box p={[0, 9.82, 0]} s={[L - 1.3, 0.12, 7.2]} color="#c0a582" surface="cedar" />
          {Array.from({ length: Math.floor(L / 0.5) }, (_, i) => (
            <Box
              key={`ceiling-${i}`}
              p={[-L / 2 + 0.8 + i * 0.5, 9.73, 0]}
              s={[0.028, 0.025, 6.9]}
              color="#76654d"
            />
          ))}
          {[-1, 1].map((side) => (
            <Box
              key={side}
              p={[side * (L / 2 - 0.44), 5, 0]}
              s={[0.12, 8.3, 7.1]}
              color="#c7baa5"
              surface="plaster"
            />
          ))}
        </>
      )}
      {c.flooring === 'oak' &&
        Array.from({ length: 18 }, (_, i) => (
          <Box
            key={i}
            p={[0, 0.965, -3.35 + i * 0.38]}
            s={[L - 1.3, 0.006, 0.012]}
            color="#856a48"
          />
        ))}
      {c.mirror && (
        <group position={[-L * 0.16, 4.9, -3.57]}>
          <Box p={[0, 0, -0.04]} s={[L * 0.48 + 0.12, 5.92, 0.07]} color="#252c27" metal={0.7} />
          <mesh>
            <planeGeometry args={[L * 0.48, 5.8]} />
            {quality === 'high' ? (
              <MeshReflectorMaterial
                resolution={512}
                mirror={0.92}
                mixStrength={1}
                mixBlur={0}
                color="#e6ebe7"
                metalness={0.15}
                roughness={0.08}
              />
            ) : (
              <meshStandardMaterial color="#b5c4bd" metalness={0.95} roughness={0.12} />
            )}
          </mesh>
          {Array.from({ length: Math.floor(L / 8) }, (_, i) => (
            <Box
              key={i}
              p={[-L * 0.24 + (i + 1) * ((L * 0.48) / (Math.floor(L / 8) + 1)), 0, 0.009]}
              s={[0.016, 5.8, 0.012]}
              color="#6b726c"
            />
          ))}
        </group>
      )}
      <Box p={[L * 0.3, 4.1, -3.57]} s={[L * 0.12, 0.025, 0.07]} color="#373e34" />
      <Box p={[L * 0.31, 4.05, -3.51]} s={[0.52, 0.8, 0.1]} color="#343b37" metal={0.4} />
      <Box p={[L * 0.31, 4.15, -3.45]} s={[0.35, 0.35, 0.014]} color="#95b8b0" />
      {[-1, 1].map((side) => (
        <group key={`vent-${side}`} position={[side * L * 0.36, 8.8, -3.53]}>
          <Box p={[0, 0, 0]} s={[2.6, 0.55, 0.09]} color="#44453e" />
          {[0, 1, 2, 3].map((i) => (
            <Box
              key={i}
              p={[0, -0.18 + i * 0.12, 0.06]}
              s={[2.5, 0.045, 0.04]}
              color="#b7b4a6"
              metal={0.5}
            />
          ))}
        </group>
      ))}
      {c.accent &&
        [-1, 1].flatMap((side) =>
          Array.from({ length: 27 }, (_, i) => (
            <Box
              key={`${side}-${i}`}
              p={[side * (L / 2 + 0.018), 5.15, -3.65 + i * 0.265]}
              s={[0.09, 7.8, 0.15]}
              color={i % 3 === 0 ? '#9e7852' : '#b08a5d'}
              surface="cedar"
            />
          )),
        )}
      {!cutaway && (
        <>
          {Array.from({ length: n - 1 }, (_, i) => (
            <Box
              key={i}
              p={[-(L - 0.8) / 2 + ((i + 1) * (L - 0.8)) / n, 5.3, 3.81]}
              s={[0.13, 9.1, 0.18]}
              color="#252c27"
              metal={0.5}
            />
          ))}
          {Array.from({ length: n }, (_, i) => (
            <mesh
              key={`glass-${i}`}
              position={[-(L - 0.8) / 2 + (i + 0.5) * ((L - 0.8) / n), 5.3, 3.85]}
            >
              <planeGeometry args={[(L - 0.8) / n - 0.13, 8.8]} />
              <meshPhysicalMaterial
                color="#c0d6d2"
                transparent
                opacity={0.2}
                metalness={0.55}
                roughness={0.045}
                clearcoat={1}
                clearcoatRoughness={0.03}
                envMapIntensity={1.8}
                side={DoubleSide}
                depthWrite={false}
              />
            </mesh>
          ))}
          <Box p={[0, 9.75, 3.82]} s={[L - 1.5, 0.13, 0.2]} color="#202922" />
          <Box p={[0, 0.98, 3.82]} s={[L - 1.5, 0.1, 0.2]} color="#202922" />
          {[-0.22, 0.22].map((x) => (
            <group key={x}>
              <Box
                p={[x, 4.6, 4.07]}
                s={[0.055, 1.5, 0.08]}
                color="#b5b8b4"
                roughness={0.22}
                metal={0.95}
              />
              {[-0.58, 0.58].map((y) => (
                <Box
                  key={y}
                  p={[x, 4.6 + y, 3.99]}
                  s={[0.09, 0.09, 0.22]}
                  color="#9fa49e"
                  metal={0.9}
                />
              ))}
            </group>
          ))}
          {Array.from({ length: Math.floor(L / 2) }, (_, i) => (
            <Box
              key={i}
              p={[-L / 2 + 1.5 + i * 1.8, 10.31, 0]}
              s={[0.025, 0.025, 6.2]}
              color={finish}
            />
          ))}
        </>
      )}
      {c.lights && (
        <>
          <mesh position={[0, 9.6, -3.5]}>
            <boxGeometry args={[L - 1.5, 0.06, 0.07]} />
            <meshStandardMaterial color="#ffe1a1" emissive="#ffc57a" emissiveIntensity={3} />
          </mesh>
          <mesh position={[0, 1.05, -3.5]}>
            <boxGeometry args={[L - 1.5, 0.045, 0.07]} />
            <meshStandardMaterial emissive="#ffcb87" emissiveIntensity={2} color="#ffcb87" />
          </mesh>
          {Array.from({ length: L / 5 }, (_, i) => (
            <group key={`downlight-${i}`} position={[-L / 2 + 2.5 + i * 5, 9.58, 0.8]}>
              <mesh>
                <cylinderGeometry args={[0.16, 0.16, 0.08, 16]} />
                <meshStandardMaterial color="#363a35" />
              </mesh>
              <mesh position={[0, -0.045, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <circleGeometry args={[0.11, 16]} />
                <meshStandardMaterial color="#fff2d6" emissive="#ffdb9b" emissiveIntensity={3} />
              </mesh>
            </group>
          ))}
          {Array.from({ length: L / 10 }, (_, i) => (
            <pointLight
              key={`light-${i}`}
              position={[-L / 2 + 5 + i * 10, 7.8, 0]}
              color="#ffe2b7"
              intensity={90}
              distance={15}
              decay={2}
            />
          ))}
        </>
      )}
      {c.items.map((item) => (
        <Equipment key={item.id} item={item} />
      ))}
      {c.addons.deck && (
        <>
          <RoundedBox
            args={[L, 0.7, 8]}
            radius={0.25}
            position={[0, 0.4, 8]}
            castShadow
            receiveShadow
          >
            <meshStandardMaterial color={finish} />
          </RoundedBox>
          {Array.from({ length: 24 }, (_, i) => (
            <Box
              key={i}
              p={[0, 0.78, 4.2 + i * 0.322]}
              s={[L - 0.5, 0.1, 0.3]}
              color={i % 3 === 0 ? '#b29973' : '#a98d66'}
              surface="oak"
            />
          ))}
          <Box p={[0, 0.25, 12.45]} s={[L * 0.6, 0.3, 1]} color="#ad9674" surface="oak" />
          {c.lights && (
            <mesh position={[0, 0.36, 12.01]}>
              <boxGeometry args={[L - 1, 0.045, 0.03]} />
              <meshStandardMaterial color="#ffe1a1" emissive="#ffd49a" emissiveIntensity={2} />
            </mesh>
          )}
        </>
      )}
      {c.addons.gazebo && !cutaway && (
        <>
          <Portal length={L} depth={0.3} z={11.65} color={finish} />
          {[-1, 1].map((side) => (
            <Box
              key={side}
              p={[side * (L / 2 - 0.18), 10.1, 8]}
              s={[0.35, 0.35, 8]}
              color={finish}
            />
          ))}
          {Array.from({ length: Math.round(L / 0.65) }, (_, i) => (
            <Box
              key={i}
              p={[-L / 2 + 0.7 + i * 0.65, 10, 8]}
              s={[0.16, 0.35, 7.9]}
              color="#a4875e"
              surface="cedar"
            />
          ))}
        </>
      )}
      {c.addons.roof && !cutaway && (
        <>
          <Box p={[0, 10.37, 0]} s={[L - 1.5, 0.12, 7.5]} color="#a08d70" />
          <Rail length={L - 1.5} x={0} z={-3.6} />
          <Rail length={L - 1.5} x={0} z={3.6} />
          <Rail length={7.2} x={-L / 2 + 0.75} z={0} alongZ />
          {!c.addons.stairs && <Rail length={7.2} x={L / 2 - 0.75} z={0} alongZ />}
        </>
      )}
      {c.addons.stairs && (
        <group position={[L / 2 + 2, 0, 0]}>
          {Array.from({ length: 17 }, (_, i) => (
            <group key={i} position={[0, (i + 1) * (10.4 / 17), 11.5 - i * 0.83]}>
              <Box p={[0, 0, 0]} s={[3.5, 0.12, 0.88]} color="#8b8170" />
              {[-1.7, 1.7].map((x) => (
                <Box key={x} p={[x, 1.75, 0]} s={[0.06, 3.5, 0.06]} color={finish} />
              ))}
            </group>
          ))}
          {[-1.7, 1.7].map((x) => (
            <group key={x} position={[x, 8.7, 4.85]} rotation={[-0.635, 0, 0]}>
              <Box p={[0, 0, 0]} s={[0.09, 0.1, 16.5]} color={finish} />
            </group>
          ))}
          <Box p={[-0.6, 10.35, -2.8]} s={[4.6, 0.15, 2.2]} color="#8b8170" />
        </group>
      )}
    </group>
  )
}
