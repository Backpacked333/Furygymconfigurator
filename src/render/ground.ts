import { Color, MeshStandardNodeMaterial, Vector2 } from 'three/webgpu'
import {
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalMap,
  positionWorld,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import {
  loadedMaps,
  standInMaps,
  textureMaps,
  texturesArrived,
  type Maps,
  type TextureSet,
} from './materials'

/** Built once per scan and tint and kept, like the material library, so switching back is free. */
const groundMaterials = new Map<string, MeshStandardNodeMaterial>()

/**
 * The ground's material (Landscape's Ground), at once: scanned ground with anti-tiling, two
 * scales of the same scan blended by low-frequency noise and modulated by a macro brightness
 * field, so a 600-foot plane never shows a repeat.
 *
 * Until its scans are in it is bound to the library's neutral stand-ins, of the same shape as the
 * scans, which are then swapped into its texture nodes, and into its path-traced stand-in, in
 * place: the ground keeps one material through their arrival, as every library surface does, and
 * nothing recompiles. A material made for the scans cost the spin its first exterior frames on
 * every page load (pathtrace.ts sceneParts reads what a mesh is made of by its material's
 * identity, as a finish is a material swapped); the frames rendered before the scans are
 * rendered again once they are in (spin.ts, the textures' stage), as for every other surface.
 */
export function groundMaterial(set: TextureSet, size: number, tint: string) {
  const key = `${set}|${size}|${tint}`
  const existing = groundMaterials.get(key)
  if (existing) return existing
  const loaded = loadedMaps(set)
  const maps = loaded ?? standInMaps()
  if (!maps.albedo) throw new Error(`${set} has no albedo map`)
  // Scan scale and tint are uniforms so both biomes share one compiled ground shader.
  const p = positionWorld.xz
  const uvA = p.div(uniform(size))
  const uvB = p.div(uniform(size * 3.3)).add(vec2(0.37, 0.71))
  const blend = mx_noise_float(vec3(p.mul(0.04), 0))
    .mul(0.5)
    .add(0.5)
    .smoothstep(0.32, 0.68)
  const macro = mx_fractal_noise_float(vec3(p.mul(0.011), 0.5), 3, 2, 0.5)
    .mul(0.22)
    .add(1)
  const albedo = [texture(maps.albedo, uvA), texture(maps.albedo, uvB)]
  const arm = [texture(maps.arm, uvA), texture(maps.arm, uvB)]
  const normal = texture(maps.normal, uvA)
  const m = new MeshStandardNodeMaterial()
  m.colorNode = mix(albedo[0].rgb, albedo[1].rgb, blend)
    .mul(uniform(new Color(tint)))
    .mul(macro)
  m.roughnessNode = mix(arm[0].g, arm[1].g, blend)
  m.normalNode = normalMap(normal, vec2(0.8, 0.8))
  // The path tracers sample the scan through the plane's UVs, which are laid out in feet; until
  // it is in, the plain tint, as the raster ground looks with the stand-ins.
  const traced: Record<string, unknown> = {
    color: new Color(tint).multiplyScalar(1.05),
    roughness: 1,
    normalScale: new Vector2(0.8, 0.8),
  }
  m.userData.pathTrace = traced
  const bind = (scans: Maps) => {
    if (!scans.albedo) throw new Error(`${set} has no albedo map`)
    for (const node of albedo) node.value = scans.albedo
    for (const node of arm) node.value = scans.arm
    normal.value = scans.normal
    Object.assign(traced, { map: scans.albedo, normalMap: scans.normal, roughnessMap: scans.arm })
  }
  if (loaded) bind(loaded)
  else
    void textureMaps(set).then((scans) => {
      bind(scans)
      texturesArrived()
    })
  groundMaterials.set(key, m)
  return m
}
