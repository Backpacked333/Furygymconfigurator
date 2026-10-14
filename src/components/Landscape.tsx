import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Object3D,
} from 'three'
import type { Config } from '../lib/config'
import { noise } from '../lib/visuals'
import { SurfaceMaterial } from './SurfaceMaterial'
import type { Quality } from '../render/renderer'

type Position = [number, number, number]

function Block({
  position,
  size,
  color,
  stone = false,
}: {
  position: Position
  size: Position
  color: string
  stone?: boolean
}) {
  return (
    <mesh position={position} receiveShadow castShadow>
      <boxGeometry args={size} />
      <SurfaceMaterial kind={stone ? 'stone' : 'plaster'} color={color} />
    </mesh>
  )
}

const Tree = memo(function Tree({
  position,
  scale = 1,
  desert,
  lite,
}: {
  position: Position
  scale?: number
  desert: boolean
  lite: boolean
}) {
  const leaves = useRef<InstancedMesh>(null)
  const count = lite ? 1600 : 4800
  useLayoutEffect(() => {
    if (!leaves.current) return
    const object = new Object3D()
    const palette = desert
      ? ['#9a9e73', '#777f51', '#acac82', '#596543']
      : ['#71805a', '#8e9968', '#536944', '#a5ae7f']
    for (let i = 0; i < count; i++) {
      const cluster = i % 19,
        angle = cluster * 2.39996
      const radius = 0.6 + noise(cluster, 4) * 2.3
      const a = noise(i, 1) * Math.PI * 2
      const r = Math.sqrt(noise(i, 2)) * 1.65
      object.position.set(
        Math.cos(angle) * radius + Math.cos(a) * r,
        5.8 + noise(cluster, 7) * 3.1 + (noise(i, 3) - 0.5) * 2.4,
        Math.sin(angle) * radius + Math.sin(a) * r,
      )
      object.rotation.set(noise(i, 5) * Math.PI, noise(i, 6) * Math.PI, noise(i, 8) * Math.PI)
      object.scale.set(0.07 + noise(i, 9) * 0.08, 0.16 + noise(i, 10) * 0.16, 0.035)
      object.updateMatrix()
      leaves.current.setMatrixAt(i, object.matrix)
      leaves.current.setColorAt(i, new Color(palette[i % palette.length]))
    }
    leaves.current.instanceMatrix.needsUpdate = true
    if (leaves.current.instanceColor) leaves.current.instanceColor.needsUpdate = true
    leaves.current.computeBoundingSphere()
  }, [count, desert])
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 3, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.23, 6, 12]} />
        <SurfaceMaterial kind="cedar" color="#817260" />
      </mesh>
      {Array.from({ length: 9 }, (_, i) => (
        <group key={i} rotation={[0, i * 2.4, 0]} position={[0, 3.6 + (i % 3) * 0.6, 0]}>
          <mesh position={[0.8, 1.4, 0]} rotation={[0, 0, -0.55]} castShadow>
            <cylinderGeometry args={[0.025, 0.09, 3.4, 8]} />
            <SurfaceMaterial kind="cedar" color="#817260" />
          </mesh>
        </group>
      ))}
      <instancedMesh
        ref={leaves}
        args={[undefined, undefined, count]}
        castShadow
        receiveShadow={!lite}
      >
        <sphereGeometry args={[1, 5, 3]} />
        <meshStandardMaterial roughness={0.85} side={DoubleSide} />
      </instancedMesh>
    </group>
  )
})

const Planting = memo(function Planting({
  x,
  desert,
  lite,
}: {
  x: number
  desert: boolean
  lite: boolean
}) {
  const blades = useRef<InstancedMesh>(null)
  const count = lite ? 800 : 2400
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        [-0.025, 0, 0, 0.025, 0, 0, -0.024, 0.5, 0.12, 0.024, 0.5, 0.12, 0, 1, 0.38],
        3,
      ),
    )
    g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4])
    g.computeVertexNormals()
    return g
  }, [])
  useLayoutEffect(() => {
    if (!blades.current) return
    const object = new Object3D()
    for (let i = 0; i < count; i++) {
      const tuft = i % 26
      object.position.set(
        (noise(tuft, 15) - 0.5) * 1.4 + (noise(i, 14) - 0.5) * 0.4,
        0,
        noise(tuft, 16) * 12 - 6 + (noise(i, 17) - 0.5) * 0.4,
      )
      object.rotation.set(0, noise(i, 18) * Math.PI * 2, (noise(i, 19) - 0.5) * 0.8)
      const height = 0.5 + noise(i, 20) * 1.1
      object.scale.setScalar(height)
      object.updateMatrix()
      blades.current.setMatrixAt(i, object.matrix)
      blades.current.setColorAt(
        i,
        new Color(
          (desert ? ['#b0a17a', '#8d9167', '#c4b491'] : ['#899264', '#576d46', '#afae79'])[i % 3],
        ),
      )
    }
    blades.current.instanceMatrix.needsUpdate = true
    if (blades.current.instanceColor) blades.current.instanceColor.needsUpdate = true
    blades.current.computeBoundingSphere()
  }, [count, desert])
  return (
    <group position={[x, 0.18, 4]}>
      <Block
        position={[0, -0.15, 0]}
        size={[2.1, 0.22, 14]}
        color={desert ? '#aa957b' : '#686e5b'}
        stone
      />
      <instancedMesh
        ref={blades}
        args={[geometry, undefined, count]}
        castShadow={!lite}
        receiveShadow={!lite}
      >
        <meshStandardMaterial roughness={1} side={DoubleSide} />
      </instancedMesh>
    </group>
  )
})

const Gravel = memo(function Gravel({ length, desert }: { length: number; desert: boolean }) {
  const mesh = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    if (!mesh.current) return
    const object = new Object3D()
    for (let i = 0; i < 700; i++) {
      const side = i % 2 ? 1 : -1
      object.position.set(
        side * (length / 2 + 1.5 + noise(i, 21) * 2.1),
        0.08,
        noise(i, 22) * 23 - 8,
      )
      object.rotation.set(noise(i, 23), noise(i, 24) * Math.PI, 0)
      const size = 0.035 + noise(i, 25) * 0.11
      object.scale.set(size * 1.3, size * 0.55, size)
      object.updateMatrix()
      mesh.current.setMatrixAt(i, object.matrix)
      mesh.current.setColorAt(
        i,
        new Color(
          (desert ? ['#bbad91', '#a3947e', '#d0c3a8'] : ['#84877d', '#a9a99b', '#c5c1b2'])[i % 3],
        ),
      )
    }
    mesh.current.instanceMatrix.needsUpdate = true
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true
    mesh.current.computeBoundingSphere()
  }, [length, desert])
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, 700]} receiveShadow>
      <icosahedronGeometry args={[1, 1]} />
      <meshStandardMaterial roughness={1} />
    </instancedMesh>
  )
})

export function Landscape({ config: c, quality }: { config: Config; quality: Quality }) {
  const desert = c.environment === 'desert',
    lite = quality === 'lite',
    L = c.length
  return (
    <group>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.14, 0]}>
        <planeGeometry args={[600, 600]} />
        <meshStandardMaterial
          roughness={1}
          color={c.environment === 'studio' ? '#bfc0b9' : desert ? '#c7b397' : '#a3a68f'}
        />
      </mesh>
      {c.environment !== 'studio' && (
        <>
          <Block
            position={[0, -0.12, 3.5]}
            size={[L + 3, 0.22, 23]}
            color={desert ? '#d1bfa4' : '#c8c6b7'}
            stone
          />
          {Array.from({ length: Math.ceil((L + 2) / 4) }, (_, i) => (
            <Block
              key={`joint-${i}`}
              position={[-L / 2 - 1 + i * 4, 0.003, 3.5]}
              size={[0.018, 0.008, 22.9]}
              color="#9b9b8b"
            />
          ))}
          {[-4, 0, 4, 8, 12].map((z) => (
            <Block
              key={z}
              position={[0, 0.003, z]}
              size={[L + 2.9, 0.008, 0.018]}
              color="#9b9b8b"
            />
          ))}
          {Array.from({ length: 7 }, (_, i) => (
            <Block
              key={`path-${i}`}
              position={[0, -0.02, 16.2 + i * 2.5]}
              size={[5.2, 0.2, 1.95]}
              color="#c9c5b6"
              stone
            />
          ))}
          <Block
            position={[0, 1.8, -12]}
            size={[L + 24, 3.8, 0.55]}
            color={desert ? '#b7a58c' : '#b2b3a2'}
          />
          <Block position={[0, 3.76, -12]} size={[L + 24.2, 0.14, 0.8]} color="#c2c0ae" stone />
          {[-1, 1].map((side) => (
            <group key={side}>
              <Planting x={side * (L / 2 + 3)} desert={desert} lite={lite} />
              <Tree
                position={[side * (L / 2 + 6), 0, -8]}
                scale={1.65}
                desert={desert}
                lite={lite}
              />
              <Tree
                position={[side * (L / 2 + 14), 0, -19]}
                scale={2.1}
                desert={desert}
                lite={lite}
              />
              {[1, 10].map((z) => (
                <group key={z} position={[side * (L / 2 + 1.75), 0, z]}>
                  <Block position={[0, 0.55, 0]} size={[0.18, 1.1, 0.18]} color="#3e453c" />
                  <mesh position={[0, 1, 0]}>
                    <boxGeometry args={[0.19, 0.12, 0.19]} />
                    <meshStandardMaterial
                      color="#dad0b5"
                      emissive="#ffd7a0"
                      emissiveIntensity={c.lights ? 2 : 0}
                    />
                  </mesh>
                </group>
              ))}
            </group>
          ))}
          <Gravel length={L} desert={desert} />
          <group position={[-L / 2 - 0.8, 0, 11.5]}>
            <mesh position={[0, 0.9, 0]} castShadow receiveShadow>
              <cylinderGeometry args={[0.72, 0.55, 1.8, 32]} />
              <SurfaceMaterial kind="stone" color="#8c8a77" />
            </mesh>
            <Tree position={[0, 0.7, 0]} scale={0.55} desert={desert} lite={lite} />
          </group>
        </>
      )}
    </group>
  )
}
