import {
  BoxGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  NearestFilter,
  NoColorSpace,
  PerspectiveCamera,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  UnsignedByteType,
  type BufferGeometry,
  type Material,
} from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'

export const NEUTRAL_STAGE = {
  version: 'neutral-stage-1',
  units: 'feet',
  exposure: 1,
  toneMapping: 'AgX',
  output: 'sRGB',
  camera: { position: [10, 7, 14], target: [0, 2, 0], fov: 42, near: 0.05, far: 100 },
  grayLinearReflectance: 0.18,
  checkerCellFeet: 1,
  profiles: {
    day: { keyColor: '#ffffff', keyIntensity: 3, fillIntensity: 1 },
    warm: { keyColor: '#ffd4aa', keyIntensity: 3, fillIntensity: 1 },
  },
} as const

export const MATERIAL_ROLES = {
  albedo: { colorSpace: SRGBColorSpace, channel: 'RGB' },
  normal: {
    colorSpace: NoColorSpace,
    channel: 'RGB',
    convention: 'OpenGL +Y',
    neutral: [128, 128, 255],
  },
  arm: { colorSpace: NoColorSpace, channels: { ao: 'R', roughness: 'G', metalness: 'B' } },
} as const

export type StageSwatch = { name: string; material: Material }

export function createCheckerTexture() {
  const data = new Uint8Array([
    210, 210, 210, 255, 62, 62, 62, 255, 62, 62, 62, 255, 210, 210, 210, 255,
  ])
  const texture = new DataTexture(data, 2, 2, RGBAFormat, UnsignedByteType)
  texture.name = 'One-foot checker (two feet per full tile)'
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.repeat.set(0.5, 0.5)
  texture.magFilter = texture.minFilter = NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/** No production material cache is disposed here; supplied comparison swatches are borrowed. */
export function createNeutralStage(
  profile: keyof typeof NEUTRAL_STAGE.profiles = 'day',
  swatches: readonly StageSwatch[] = [],
) {
  const scene = new Scene()
  scene.name = 'FURY development-only neutral material stage'
  scene.background = new Color('#737373')
  const camera = new PerspectiveCamera(42, 16 / 9, 0.05, 100)
  camera.position.set(...NEUTRAL_STAGE.camera.position)
  camera.lookAt(...NEUTRAL_STAGE.camera.target)
  const geometry = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const checker = createCheckerTexture()
  const group = new Group()
  scene.add(group)

  function standard(name: string, color: Color | string, roughness: number, metalness = 0) {
    const material = new MeshStandardNodeMaterial({ color, roughness, metalness })
    material.name = name
    materials.add(material)
    return material
  }
  function mesh(name: string, g: BufferGeometry, m: Material, position: [number, number, number]) {
    geometry.add(g)
    const object = new Mesh(g, m)
    object.name = name
    object.position.set(...position)
    object.castShadow = object.receiveShadow = true
    group.add(object)
    return object
  }
  function box(
    name: string,
    size: [number, number, number],
    m: Material,
    position: [number, number, number],
  ) {
    const g = new BoxGeometry(...size)
    // Per-face UV spans are physical feet; no normal-based projection across bevels.
    const uv = g.getAttribute('uv')
    const faces = [
      [size[2], size[1]],
      [size[2], size[1]],
      [size[0], size[2]],
      [size[0], size[2]],
      [size[0], size[1]],
      [size[0], size[1]],
    ]
    for (let i = 0; i < uv.count; i++) {
      const [u, v] = faces[Math.floor(i / 4)]
      uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v)
    }
    return mesh(name, g, m, position)
  }

  const gray = standard('18% linear gray (not 18% sRGB)', new Color().setRGB(0.18, 0.18, 0.18), 1)
  const matte = standard('Neutral floor / wall', '#949494', 0.9)
  const checks = standard('Checker dielectric', '#ffffff', 1)
  checks.map = checker
  box('Floor — top at y=0', [16, 0.2, 12], matte, [0, -0.1, 0])
  box('Wall — front at z=-4', [16, 8, 0.2], matte, [0, 4, -4.1])
  box('18% gray reference', [2, 2, 0.08], gray, [-5, 4, -3.94])
  box('One-foot floor checker', [4, 0.02, 4], checks, [-4.5, 0.01, 1])
  box('One-foot vertical checker', [4, 2, 0.04], checks, [-0.5, 5, -3.96])
  mesh(
    'Dielectric sphere',
    new SphereGeometry(0.85, 48, 32),
    standard('Dielectric', '#b8b8b8', 0.35),
    [-1.5, 0.85, 0.6],
  )
  mesh(
    'Metal sphere',
    new SphereGeometry(0.85, 48, 32),
    standard('Metal', '#d7d9da', 0.22, 1),
    [0.6, 0.85, 0.6],
  )
  const glass = new MeshPhysicalNodeMaterial({
    color: '#ffffff',
    transmission: 1,
    roughness: 0.03,
    ior: 1.52,
    thickness: 0.08,
  })
  glass.name = 'Glass — compare transmitted checker and grazing edge'
  materials.add(glass)
  box('Glazing slab', [2, 3, 0.08], glass, [3.3, 1.5, 0.2])
  box('Checker behind glass', [2, 3, 0.04], checks, [3.3, 1.5, -0.8])
  swatches.forEach((swatch, index) => {
    const x = -5.6 + (index % 6) * 2.1
    const z = 3.9 - Math.floor(index / 6) * 2.2
    box(`Comparison: ${swatch.name}`, [1.8, 0.08, 1.8], swatch.material, [x, 0.05, z])
    box(`Vertical comparison: ${swatch.name}`, [1.8, 1.8, 0.08], swatch.material, [
      x,
      2.5,
      -3.94 + Math.floor(index / 6) * 0.12,
    ])
  })
  const p = NEUTRAL_STAGE.profiles[profile]
  const key = new DirectionalLight(p.keyColor, p.keyIntensity)
  key.name = 'Fixed key'
  key.position.set(-6, 10, 6)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = key.shadow.camera.bottom = -12
  key.shadow.camera.right = key.shadow.camera.top = 12
  key.shadow.camera.near = 0.5
  key.shadow.camera.far = 40
  key.shadow.normalBias = 0.015
  scene.add(key, new HemisphereLight('#dfe8f3', '#68665f', p.fillIntensity))
  let disposed = false
  return {
    scene,
    camera,
    profile,
    ownedResourceCounts: { geometries: geometry.size, materials: materials.size, textures: 1 },
    dispose() {
      if (disposed) return
      disposed = true
      geometry.forEach((g) => g.dispose())
      materials.forEach((m) => m.dispose())
      checker.dispose()
      key.shadow.dispose()
      scene.clear()
    },
  }
}
