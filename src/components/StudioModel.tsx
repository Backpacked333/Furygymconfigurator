import { useMemo } from 'react'
import { ExtrudeGeometry, Path, Shape } from 'three'
import { RoundedBox } from '@react-three/drei'
import { FINISHES, FLOORS, openingGeometry, productHeight, type Config } from '../lib/config'
import { Equipment } from './Equipment'

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
    return new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 })
  }, [length, depth])
  return (
    <mesh geometry={geometry} position={[0, 0.3, z]} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={0.52} metalness={0.25} />
    </mesh>
  )
}
function Box({
  p,
  s,
  color,
  roughness = 0.7,
  metal = 0,
}: {
  p: [number, number, number]
  s: [number, number, number]
  color: string
  roughness?: number
  metal?: number
}) {
  return (
    <mesh position={p} castShadow receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} roughness={roughness} metalness={metal} />
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
function ContainerShell({ config: c, color }: { config: Config; color: string }) {
  const L = c.length,
    H = productHeight(c),
    opening = openingGeometry(c)
  const left = opening.center - opening.width / 2,
    right = opening.center + opening.width / 2
  return (
    <group>
      <Box p={[0, H + 0.15, 0]} s={[L, 0.3, 8]} color={color} metal={0.35} />
      {[-1, 1].map((side) => (
        <group key={side}>
          <Box
            p={[side * (L / 2 - 0.16), H / 2 + 0.3, 0]}
            s={[0.32, H, 8]}
            color={color}
            metal={0.3}
          />
          {Array.from({ length: 14 }, (_, i) => (
            <Box
              key={i}
              p={[(side * L) / 2, H / 2 + 0.3, -3.6 + i * 0.55]}
              s={[0.08, H - 0.8, 0.14]}
              color={color}
              metal={0.3}
            />
          ))}
        </group>
      ))}
      <Box p={[(-L / 2 + left) / 2, H / 2 + 0.3, 3.86]} s={[left + L / 2, H, 0.28]} color={color} />
      <Box
        p={[(right + L / 2) / 2, H / 2 + 0.3, 3.86]}
        s={[L / 2 - right, H, 0.28]}
        color={color}
      />
      {Array.from({ length: L * 2 }, (_, i) => -L / 2 + 0.25 + i * 0.5)
        .filter((x) => x < left - 0.12 || x > right + 0.12)
        .map((x) => (
          <Box
            key={x}
            p={[x, H / 2 + 0.3, 4.02]}
            s={[0.13, H - 0.8, 0.08]}
            color={color}
            metal={0.3}
          />
        ))}
      <Box p={[opening.center, H - 0.15, 3.87]} s={[opening.width, 0.9, 0.32]} color={color} />
      {[left, right].map((x) => (
        <Box
          key={x}
          p={[x, H / 2 + 0.25, 3.87]}
          s={[0.16, H - 0.7, 0.42]}
          color={c.integratedFinish ? color : '#838a80'}
        />
      ))}
      {c.containerOpening === 'roll-up' && (
        <Box
          p={[opening.center, H - 0.1, 3.6]}
          s={[10, 0.65, 0.85]}
          color={c.integratedFinish ? color : '#838a80'}
          metal={0.5}
        />
      )}
      {Array.from({ length: L }, (_, i) => (
        <Box
          key={i}
          p={[-L / 2 + i + 0.5, H + 0.32, 0]}
          s={[0.08, 0.045, 7.6]}
          color={color}
          metal={0.3}
        />
      ))}
    </group>
  )
}
export function StudioModel({ config: c, cutaway = false }: { config: Config; cutaway?: boolean }) {
  const L = c.length,
    H = productHeight(c),
    finish = FINISHES.find((f) => f.id === c.finish)!.color,
    floor = FLOORS.find((f) => f.id === c.flooring)!.color
  const n = L === 20 ? 6 : 12
  return (
    <group>
      {!cutaway &&
        (c.family === 'studio' ? (
          <Portal length={L} depth={8} z={-4} color={finish} />
        ) : (
          <ContainerShell config={c} color={finish} />
        ))}
      {cutaway &&
        [-1, 1].map((side) => (
          <Box key={side} p={[side * (L / 2 - 0.18), 3, 0]} s={[0.36, 5.4, 8]} color={finish} />
        ))}
      <Box p={[0, H / 2 + 0.2, -3.86]} s={[L - 1.2, H - 0.4, 0.25]} color={finish} />
      <Box p={[0, H / 2 + 0.1, -3.69]} s={[L - 1.3, H - 1.2, 0.1]} color="#d1c6af" />
      <Box p={[0, 0.65, 0]} s={[L - 0.6, 0.5, 7.7]} color={finish} />
      <Box p={[0, 0.92, 0]} s={[L - 1.25, 0.08, 7.15]} color={floor} roughness={0.95} />
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
        <mesh position={[-L * 0.16, 4.9, -3.61]}>
          <boxGeometry args={[L * 0.48, 5.8, 0.035]} />
          <meshStandardMaterial color="#889d93" metalness={0.93} roughness={0.08} />
        </mesh>
      )}
      <Box p={[L * 0.3, 4.1, -3.57]} s={[L * 0.12, 0.025, 0.07]} color="#373e34" />
      {c.accent &&
        [-1, 1].flatMap((side) =>
          Array.from({ length: 27 }, (_, i) => (
            <Box
              key={`${side}-${i}`}
              p={[side * (L / 2 + 0.018), 5.15, -3.65 + i * 0.265]}
              s={[0.09, 7.8, 0.15]}
              color={i % 3 === 0 ? '#9e7852' : '#b08a5d'}
            />
          )),
        )}
      {!cutaway && c.family === 'studio' && (
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
          <mesh position={[0, 5.2, 3.85]}>
            <planeGeometry args={[L - 1, 8.9]} />
            <meshPhysicalMaterial
              color="#b8d2c6"
              transparent
              opacity={0.12}
              metalness={0.25}
              roughness={0.06}
              depthWrite={false}
            />
          </mesh>
          <Box p={[0, 9.75, 3.82]} s={[L - 1.5, 0.13, 0.2]} color="#202922" />
          <Box p={[0, 0.98, 3.82]} s={[L - 1.5, 0.1, 0.2]} color="#202922" />
          {[-0.22, 0.22].map((x) => (
            <Box key={x} p={[x, 4.6, 4.02]} s={[0.045, 1.5, 0.065]} color="#afad99" metal={0.8} />
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
          <mesh position={[0, H - 0.4, -3.5]}>
            <boxGeometry args={[L - 1.5, 0.06, 0.07]} />
            <meshStandardMaterial color="#ffe1a1" emissive="#ffc57a" emissiveIntensity={3} />
          </mesh>
          <mesh position={[0, 1.05, -3.5]}>
            <boxGeometry args={[L - 1.5, 0.045, 0.07]} />
            <meshStandardMaterial emissive="#ffcb87" emissiveIntensity={2} color="#ffcb87" />
          </mesh>
          <pointLight
            position={[0, 7.5, 0]}
            color="#ffd19b"
            intensity={c.time > 18 ? 130 : 30}
            distance={L}
            decay={2}
          />
          {L === 40 && (
            <pointLight
              position={[-12, 7.5, 0]}
              color="#ffd19b"
              intensity={70}
              distance={24}
              decay={2}
            />
          )}
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
            />
          ))}
          <Box p={[0, 0.25, 12.45]} s={[L * 0.6, 0.3, 1]} color="#9b896c" />
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
