import { RoundedBox } from '@react-three/drei'
import type { PlacedItem } from '../lib/config'

type BProps = {
  p: [number, number, number]
  s: [number, number, number]
  color?: string
  metal?: number
  glow?: string
}
function B({ p, s, color = '#272c29', metal = 0.2, glow }: BProps) {
  return (
    <mesh position={p} castShadow receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial
        color={color}
        metalness={metal}
        roughness={0.58}
        emissive={glow}
        emissiveIntensity={glow ? 0.8 : 0}
      />
    </mesh>
  )
}
function Cylinder({
  p,
  r,
  h,
  rotation = [0, 0, 0],
  color = '#272c29',
}: {
  p: [number, number, number]
  r: number
  h: number
  rotation?: [number, number, number]
  color?: string
}) {
  return (
    <mesh position={p} rotation={rotation} castShadow>
      <cylinderGeometry args={[r, r, h, 20]} />
      <meshStandardMaterial color={color} roughness={0.6} metalness={0.25} />
    </mesh>
  )
}
export function Equipment({ item }: { item: PlacedItem }) {
  const chrome = '#a8aaa5',
    wood = '#a67b50',
    cushion = '#656c57'
  return (
    <group position={[item.x, 0.95, item.z]} rotation={[0, (-item.rotation * Math.PI) / 180, 0]}>
      {item.sku === 'rack' && (
        <>
          {[-2.15, 2.15].flatMap((x) =>
            [-1.35, 1.35].map((z) => (
              <group key={`${x}-${z}`}>
                <B p={[x, 3.7, z]} s={[0.19, 7.4, 0.19]} />
                {Array.from({ length: 13 }, (_, i) => (
                  <B
                    key={i}
                    p={[x, 1.2 + i * 0.36, z + 0.102]}
                    s={[0.06, 0.06, 0.01]}
                    color="#90958b"
                  />
                ))}
              </group>
            )),
          )}
          {[-2.15, 2.15].map((x) => (
            <group key={x}>
              <B p={[x, 0.1, 0]} s={[0.34, 0.2, 3.2]} />
              <B p={[x, 7.2, 0]} s={[0.15, 0.15, 2.8]} />
              <B p={[x, 3.4, 0]} s={[0.15, 0.15, 2.8]} />
            </group>
          ))}
          <B p={[0, 7.25, -1.35]} s={[4.4, 0.25, 0.22]} />
          <Cylinder
            p={[0, 6.9, 1.35]}
            r={0.07}
            h={4.4}
            rotation={[0, 0, Math.PI / 2]}
            color={chrome}
          />
          <Cylinder
            p={[0, 4.1, 0.9]}
            r={0.055}
            h={4.8}
            rotation={[0, 0, Math.PI / 2]}
            color={chrome}
          />
          {[-1, 1].map((x) => (
            <Cylinder
              key={x}
              p={[x * 2.03, 4.1, 0.9]}
              r={0.72}
              h={0.24}
              rotation={[0, 0, Math.PI / 2]}
            />
          ))}
        </>
      )}
      {item.sku === 'bench' && (
        <>
          <RoundedBox args={[1.15, 0.27, 3.8]} radius={0.13} position={[0, 1.55, 0]} castShadow>
            <meshStandardMaterial color="#353b35" roughness={0.9} />
          </RoundedBox>
          <B p={[0, 1.1, 0]} s={[0.22, 0.45, 3.4]} />
          {[-1.5, 1.5].map((z) => (
            <group key={z}>
              <B p={[0, 0.65, z]} s={[0.2, 1.3, 0.2]} />
              <B p={[0, 0.1, z]} s={[1.85, 0.2, 0.3]} />
            </group>
          ))}
        </>
      )}
      {item.sku === 'weights' && (
        <>
          {[-1.9, 1.9].map((x) => (
            <B key={x} p={[x, 1.3, 0]} s={[0.18, 2.6, 1.5]} />
          ))}
          {[1, 2.2].map((y) => (
            <group key={y}>
              <B p={[0, y, 0]} s={[4.2, 0.13, 1.8]} />
              {Array.from({ length: 5 }, (_, i) => (
                <group key={i} position={[-1.65 + i * 0.82, y + 0.34, 0]}>
                  <Cylinder
                    p={[0, 0, 0]}
                    r={0.045}
                    h={1.2}
                    rotation={[Math.PI / 2, 0, 0]}
                    color={chrome}
                  />
                  {[-0.5, 0.5].map((z) => (
                    <Cylinder
                      key={z}
                      p={[0, 0, z]}
                      r={0.27}
                      h={0.3}
                      rotation={[Math.PI / 2, 0, 0]}
                    />
                  ))}
                </group>
              ))}
            </group>
          ))}
        </>
      )}
      {item.sku === 'sauna' && (
        <>
          <B p={[0, 3.5, -2.1]} s={[4.8, 7, 0.2]} color={wood} />
          <B p={[0, 6.9, 0]} s={[4.8, 0.2, 4.4]} color={wood} />
          {[-2.3, 2.3].map((x) => (
            <B key={x} p={[x, 3.5, 0]} s={[0.2, 7, 4.4]} color={wood} />
          ))}
          {Array.from({ length: 20 }, (_, i) => (
            <B
              key={i}
              p={[-2.22 + i * 0.235, 3.5, -1.98]}
              s={[0.025, 6.8, 0.035]}
              color="#735239"
            />
          ))}
          <B p={[0, 1.5, -0.8]} s={[4.4, 0.18, 1.7]} color="#ceab78" />
          <B p={[0, 0.65, 0.5]} s={[4.4, 0.15, 1.2]} color="#ceab78" />
          <mesh position={[0, 3.5, 2.13]}>
            <boxGeometry args={[4.4, 6.8, 0.04]} />
            <meshPhysicalMaterial
              color="#ccb28b"
              transparent
              opacity={0.18}
              roughness={0.08}
              metalness={0.1}
              depthWrite={false}
            />
          </mesh>
          <B p={[0.55, 3.1, 2.25]} s={[0.09, 1.3, 0.13]} color={wood} />
          <B p={[0, 6.6, -1.9]} s={[4.3, 0.06, 0.06]} color="#ffe4b0" glow="#ffd085" />
        </>
      )}
      {item.sku === 'plunge' && (
        <>
          <RoundedBox args={[2.9, 2.65, 5.2]} radius={0.3} position={[0, 1.33, 0]} castShadow>
            <meshStandardMaterial color="#bba47c" roughness={0.7} />
          </RoundedBox>
          <RoundedBox args={[2.42, 0.1, 4.6]} radius={0.04} position={[0, 2.68, 0]}>
            <meshPhysicalMaterial color="#6c9a95" roughness={0.08} metalness={0.45} />
          </RoundedBox>
          {[-1.43, 1.43].map((x) =>
            Array.from({ length: 19 }, (_, i) => (
              <B
                key={`${x}-${i}`}
                p={[x, 1.3, -2.35 + i * 0.26]}
                s={[0.02, 2.2, 0.03]}
                color="#7c6446"
              />
            )),
          )}
        </>
      )}
      {item.sku === 'bike' && (
        <>
          {[-1.5, 1.5].map((z) => (
            <B key={z} p={[0, 0.12, z]} s={[1.9, 0.2, 0.22]} />
          ))}
          <B p={[0, 0.5, 0]} s={[0.22, 0.7, 3]} />
          <Cylinder p={[0, 1.1, -0.8]} r={0.78} h={0.18} rotation={[0, 0, Math.PI / 2]} />
          <B p={[0, 1.85, 0.7]} s={[0.18, 2.5, 0.18]} />
          <B p={[0, 3.1, 0.7]} s={[0.65, 0.14, 0.75]} />
          <B p={[0, 2.3, -1.4]} s={[0.16, 3, 0.16]} />
          <B p={[0, 3.7, -1.4]} s={[1.5, 0.12, 0.25]} />
          <B p={[0, 4.05, -1.5]} s={[0.95, 0.6, 0.07]} color="#7e9487" />
        </>
      )}
      {item.sku === 'treadmill' && (
        <>
          <B p={[0, 0.24, 0]} s={[2.7, 0.48, 5.8]} />
          <B p={[0, 0.5, 0.25]} s={[2.15, 0.05, 4.7]} color="#41473f" />
          {[-1.2, 1.2].map((x) => (
            <group key={x}>
              <B p={[x, 2.2, -2.5]} s={[0.16, 3.7, 0.16]} />
              <B p={[x, 3.25, -1.65]} s={[0.13, 0.13, 1.8]} />
            </group>
          ))}
          <B p={[0, 4.05, -2.5]} s={[2.5, 0.7, 0.25]} />
          <B p={[0, 4.1, -2.35]} s={[1.2, 0.4, 0.02]} color="#82928a" />
        </>
      )}
      {item.sku === 'mat' && (
        <>
          <RoundedBox args={[2.2, 0.06, 5.4]} radius={0.025} position={[0, 0.035, 0]}>
            <meshStandardMaterial color="#8f9670" roughness={1} />
          </RoundedBox>
          <B p={[0, 0.25, -1.8]} s={[0.6, 0.45, 0.9]} color="#b69768" />
        </>
      )}
      {item.sku === 'reformer' && (
        <>
          {[-1.05, 1.05].map((x) => (
            <B key={x} p={[x, 0.65, 0]} s={[0.2, 0.9, 6.5]} color={wood} />
          ))}
          <B p={[0, 1.05, 0.5]} s={[1.8, 0.3, 3.7]} color={cushion} />
          <B p={[0, 0.9, -2.8]} s={[2.2, 0.3, 0.55]} color={wood} />
          {[-1.05, 1.05].flatMap((x) =>
            [-2.8, 2.8].map((z) => (
              <B key={`${x}-${z}`} p={[x, 0.3, z]} s={[0.2, 0.6, 0.2]} color={wood} />
            )),
          )}
        </>
      )}
      {item.sku === 'lounge' && (
        <>
          <RoundedBox args={[2.5, 0.65, 4.8]} radius={0.28} position={[0, 1, 0]} castShadow>
            <meshStandardMaterial color="#d1c4ac" roughness={0.95} />
          </RoundedBox>
          <group rotation={[-0.38, 0, 0]} position={[0, 1.65, -1.4]}>
            <B p={[0, 0, 0]} s={[2.4, 0.5, 1.8]} color="#d1c4ac" />
          </group>
          <B p={[0, 0.45, 0]} s={[1.9, 0.7, 3.8]} color={wood} />
        </>
      )}
    </group>
  )
}
