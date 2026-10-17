export type Vec3 = [number, number, number]

export function noise(x: number, y: number, seed = 1) {
  let n = Math.imul(x + seed * 374761393, 668265263) ^ Math.imul(y, 1274126177)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Artistic summer day: sunrise at 06:00, sunset at 20:30, 60° noon elevation. */
export const SOLAR = { sunrise: 6, sunset: 20.5, maxElevation: (60 * Math.PI) / 180 }

function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}

/**
 * Sun direction for the time-of-day slider. The sun rises on +x, crosses the sky in front of the
 * glazed (+z) facade, and sets on -x; after 20:30 it continues below the horizon into twilight.
 */
export function sunAt(time: number) {
  const progress = (time - SOLAR.sunrise) / (SOLAR.sunset - SOLAR.sunrise)
  const elevation = SOLAR.maxElevation * Math.sin(progress * Math.PI)
  const azimuth = progress * Math.PI
  const horizontal = normalize([Math.cos(azimuth), 0, 0.45 + 0.55 * Math.sin(azimuth)])
  const direction: Vec3 = [
    horizontal[0] * Math.cos(elevation),
    Math.sin(elevation),
    horizontal[2] * Math.cos(elevation),
  ]
  return { elevation, azimuth, direction }
}

export type SkyParams = {
  turbidity: number
  rayleigh: number
  mieCoefficient: number
  mieDirectionalG: number
}

export const SKY_PRESETS: Record<
  'residences' | 'campus' | 'backyard' | 'courtyard' | 'desert' | 'studio',
  SkyParams
> = {
  /** Suburban haze over a mid-rise courtyard. */
  residences: { turbidity: 3, rayleigh: 1.05, mieCoefficient: 0.005, mieDirectionalG: 0.82 },
  /** Clear, dry coastal-California light. */
  campus: { turbidity: 2.2, rayleigh: 1.2, mieCoefficient: 0.0035, mieDirectionalG: 0.84 },
  backyard: { turbidity: 2.6, rayleigh: 1.1, mieCoefficient: 0.0045, mieDirectionalG: 0.82 },
  courtyard: { turbidity: 2.4, rayleigh: 1.1, mieCoefficient: 0.004, mieDirectionalG: 0.82 },
  desert: { turbidity: 4.2, rayleigh: 0.85, mieCoefficient: 0.006, mieDirectionalG: 0.86 },
  studio: { turbidity: 2, rayleigh: 1, mieCoefficient: 0.004, mieDirectionalG: 0.8 },
}

// Constants of three's SkyMesh (Preetham analytic daylight), mirrored so CPU-side fog, sun color,
// and tests agree with the GPU sky.
const TOTAL_RAYLEIGH: Vec3 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5]
const MIE_CONST: Vec3 = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14]
const CUTOFF_ANGLE = 1.6110731556870734
const STEEPNESS = 1.5
const EE = 1000

function scatteringCoefficients(sun: Vec3, sky: SkyParams) {
  const zenithAngleCos = Math.max(-1, Math.min(1, sun[1]))
  const sunE =
    EE * Math.max(0, 1 - Math.exp(-(CUTOFF_ANGLE - Math.acos(zenithAngleCos)) / STEEPNESS))
  const betaR = TOTAL_RAYLEIGH.map((v) => v * sky.rayleigh) as Vec3
  const c = 0.2 * sky.turbidity * 10e-18
  const betaM = MIE_CONST.map((v) => 0.434 * c * v * sky.mieCoefficient) as Vec3
  return { sunE, betaR, betaM }
}

/** Atmospheric extinction along a view direction (per channel transmittance). */
export function extinction(direction: Vec3, sun: Vec3, sky: SkyParams): Vec3 {
  const { betaR, betaM } = scatteringCoefficients(sun, sky)
  const zenithAngle = Math.acos(Math.max(0, direction[1]))
  const inverse =
    1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253))
  return [0, 1, 2].map((i) =>
    Math.exp(-(betaR[i] * 8.4e3 * inverse + betaM[i] * 1.25e3 * inverse)),
  ) as Vec3
}

/** The per-direction terms of three's SkyMesh, shared by the clear sky and its clouds. */
function skyTerms(direction: Vec3, sun: Vec3, sky: SkyParams) {
  const d = normalize(direction)
  const s = normalize(sun)
  const { sunE, betaR, betaM } = scatteringCoefficients(s, sky)
  const fex = extinction(d, s, sky)
  const cosTheta = d[0] * s[0] + d[1] * s[1] + d[2] * s[2]
  const c = cosTheta * 0.5 + 0.5
  const rPhase = 0.05968310365946075 * (1 + c * c)
  const g = sky.mieDirectionalG
  const mPhase =
    0.07957747154594767 * (1 - g * g) * (1 / Math.pow(1 - 2 * g * cosTheta + g * g, 1.5))
  const horizonBlend = Math.max(0, Math.min(1, Math.pow(1 - s[1], 5)))
  const lin = [0, 1, 2].map((i) => {
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i])
    const value = Math.pow(sunE * ratio * (1 - fex[i]), 1.5)
    return value * (1 + (Math.pow(sunE * ratio * fex[i], 0.5) - 1) * horizonBlend)
  }) as Vec3
  return { d, s, sunE, fex, cosTheta, lin }
}

const SKY_FLOOR: Vec3 = [0, 0.0003, 0.00075]

/** Linear sky radiance without clouds or sun disc, matching three's SkyMesh output. */
export function skyRadiance(direction: Vec3, sun: Vec3, sky: SkyParams): Vec3 {
  const { fex, lin } = skyTerms(direction, sun, sky)
  return [0, 1, 2].map((i) => (lin[i] + 0.1 * fex[i]) * 0.04 + SKY_FLOOR[i]) as Vec3
}

// --- Clouds: a CPU port of SkyMesh's procedural cloud layer -------------------------------------

export type CloudLayer = { coverage: number; density: number; scale: number; elevation: number }

const fract = (x: number) => x - Math.floor(x)
/** SkyMesh's sinless lattice gradient, so the CPU and GPU skies draw the same clouds. */
function gradient(ix: number, iy: number): [number, number] {
  let px = fract(ix * 0.1031),
    py = fract(iy * 0.103),
    pz = fract(ix * 0.0973)
  const t = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33)
  px += t
  py += t
  pz += t
  return [fract((px + py) * pz) * 2 - 1, fract((px + pz) * py) * 2 - 1]
}
function gradientNoise(x: number, y: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y)
  const fx = x - ix,
    fy = y - iy
  const fade = (f: number) => f * f * f * (f * (f * 6 - 15) + 10)
  const ux = fade(fx),
    uy = fade(fy)
  const dot = (cx: number, cy: number) => {
    const [gx, gy] = gradient(ix + cx, iy + cy)
    return gx * (fx - cx) + gy * (fy - cy)
  }
  const a = dot(0, 0),
    b = dot(1, 0),
    c = dot(0, 1),
    d = dot(1, 1)
  return (a + (b - a) * ux + (c + (d - c) * ux - (a + (b - a) * ux)) * uy) * 1.6
}
function fbm(x: number, y: number) {
  let result = 0,
    amplitude = 1
  for (let i = 0; i < 4; i++) {
    result += amplitude * gradientNoise(x, y)
    amplitude *= 0.5
    x *= 2
    y *= 2
  }
  return result
}

/** Sky radiance with SkyMesh's cloud layer composited in (no sun disc). */
export function cloudySkyRadiance(
  direction: Vec3,
  sun: Vec3,
  sky: SkyParams,
  clouds: CloudLayer,
): Vec3 {
  const { d, s, sunE, fex, cosTheta, lin } = skyTerms(direction, sun, sky)
  const color = [0, 1, 2].map((i) => (lin[i] + 0.1 * fex[i]) * 0.04 + SKY_FLOOR[i]) as Vec3
  if (d[1] <= 0 || clouds.coverage <= 0) return color
  const elevation = 1 - 0.9 * clouds.elevation
  const u = (d[0] / (d[1] * elevation)) * clouds.scale,
    v = (d[2] / (d[1] * elevation)) * clouds.scale
  const density = Math.max(0, Math.min(1, fbm(u * 1000, v * 1000) * 0.7 + 0.5))
  const region = gradientNoise(u * 300, v * 300) * 0.37 + 0.5
  const coverage = Math.max(0, Math.min(1, clouds.coverage + (region - 0.5) * 0.6))
  const threshold = 1 - coverage
  const horizonFade = smoothstep(0, 0.03 + 0.06 * clouds.elevation, d[1])
  const mask = smoothstep(threshold, threshold + 0.3, density) * horizonFade
  const day = Math.max(smoothstep(-0.08, 0.3, s[1]), 0.03)
  const depth = Math.max(0, density - threshold)
  const beer = Math.exp(-4 * depth)
  const shade = 0.45 + 0.55 * Math.min(1, Math.max(0, beer * (1 - beer * beer) * 2.6))
  const silver = Math.min(3, Math.max(0, 0.51 / Math.pow(1.49 - cosTheta * 1.4, 1.5)))
  const edge = mask * (1 - mask) * 4
  const alpha = (1 - Math.exp(-12 * depth * clouds.density)) * horizonFade
  return [0, 1, 2].map((i) => {
    const sunColor = sunE * fex[i] * 0.22 * 0.04
    const cloud =
      (lin[i] * 0.04 + SKY_FLOOR[i] + sunColor * shade + sunColor * silver * edge * 0.6) * day
    const behind = color[i] - 0.1 * fex[i] * 0.04 * alpha
    const aerial = behind + (cloud - behind) * fex[i]
    return behind + (aerial - behind) * alpha
  }) as Vec3
}

/**
 * Direct sunlight reaching the site: color from atmospheric extinction along the sun path and
 * an intensity that fades through the horizon into twilight.
 */
export function sunlightAt(time: number, sky: SkyParams) {
  const { direction, elevation } = sunAt(time)
  const transmittance = extinction(direction, direction, sky)
  const peak = Math.max(...transmittance)
  const color = transmittance.map((v) => v / peak) as Vec3
  const luminance =
    0.2126 * transmittance[0] + 0.7152 * transmittance[1] + 0.0722 * transmittance[2]
  const visible = smoothstep(-0.035, 0.06, elevation)
  return { direction, color, intensity: luminance * visible, elevation }
}

/** Average horizon radiance around the compass, used for distance fog that meets the sky. */
export function horizonRadiance(sun: Vec3, sky: SkyParams): Vec3 {
  const total: Vec3 = [0, 0, 0]
  const samples = 16
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2
    const r = skyRadiance([Math.cos(a), 0.04, Math.sin(a)], sun, sky)
    for (let c = 0; c < 3; c++) total[c] += r[c] / samples
  }
  return total
}

/** 0 in daylight, 1 once the sky has gone dark (drives moonlight and night exposure). */
export function nightAt(time: number) {
  return 1 - smoothstep(-0.12, 0.02, sunAt(time).elevation)
}

// --- Camera exposure, shared by the live view and the path-traced stills ------------------------

/**
 * The camera's exposure outside in daylight, before AgX tone mapping. The live view and the stills
 * are exposed alike, with no gain between them: a still is the traced light at the exposure the
 * 360° View shows, the same on every device and tier, and the raster is tuned to the traced light
 * (docs/benchmarks.md, "Live view vs stills").
 */
export const DAYLIGHT_EXPOSURE = 1.64
/** A camera inside opens up for the dimmer room, as a photographer would: about half a stop. */
export const INTERIOR_EXPOSURE = 1.37
/** Eyes adapt after dark: this much more exposure once the sky has gone dark. */
export const NIGHT_EXPOSURE = 1.35

/** The exposure outside and in the room at a time of day; nothing else enters it. */
export function exposureAt(time: number) {
  const exterior = DAYLIGHT_EXPOSURE * (1 + nightAt(time) * NIGHT_EXPOSURE)
  return { exterior, interior: exterior * INTERIOR_EXPOSURE }
}

// --- Sky calibration shared by the real-time sky and the path tracer ----------------------------

export type Environment = keyof typeof SKY_PRESETS

/**
 * three's Preetham sky is calibrated for a ~0.5 exposure with a 60,000-unit sun disc. Scaling its
 * radiance down puts clear-sky illuminance at roughly 1/3.5 of direct sun, as measured outdoors.
 */
export const SKY_SCALE = 0.13
/**
 * Preetham's single-scattering zenith is ~12x darker than its horizon; measured clear skies are
 * 2-4x. A fill proportional to the horizon stands in for multiple scattering, so dark glossy
 * finishes facing the sky reflect it as they do in photographs.
 */
export const SKY_FILL = 0.12
/** Direct-sun irradiance at full daylight, in scene units. */
export const SUN_INTENSITY = 4.2
/** The sun's angular radius (0.53° disc). */
export const SUN_ANGULAR_RADIUS = (0.2665 * Math.PI) / 180
/** Airglow and scattered starlight keep a moonless sky deep blue rather than black. */
export const NIGHT_SKY: Vec3 = [0.0022, 0.0034, 0.0078]
export const CLOUDS: Record<Environment, number> = {
  residences: 0.3,
  campus: 0.1,
  backyard: 0.24,
  courtyard: 0.32,
  desert: 0.12,
  studio: 0,
}
export const CLOUD_LAYER = { density: 0.55, scale: 0.00018, elevation: 0.55 }
/** Mean albedo of the ground each setting reflects into the sky capture. */
export const GROUND_ALBEDO: Record<Environment, Vec3> = {
  residences: [0.24, 0.21, 0.18],
  campus: [0.34, 0.32, 0.28],
  backyard: [0.2, 0.23, 0.15],
  courtyard: [0.2, 0.23, 0.15],
  desert: [0.42, 0.34, 0.25],
  studio: [0.4, 0.39, 0.37],
}

/** Photo-studio cyclorama and its softboxes: width, height, intensity, and position (feet). */
export const STUDIO_BACKDROP: Vec3 = [0.42, 0.41, 0.39]
export const STUDIO_SOFTBOXES: [number, number, number, number, number, number][] = [
  [30, 22, 5.5, 0, 34, 6],
  [10, 26, 3.2, -30, 12, 18],
  [10, 26, 2.2, 32, 10, -6],
  [40, 6, 1.6, 0, 6, 36],
]
/** Every softbox aims at this point. */
export const STUDIO_AIM: Vec3 = [0, 4, 0]

/** Everything the sky, ground bounce, and fog need for one setting at one time of day. */
export function skyLook(environment: Environment, time: number) {
  const preset = SKY_PRESETS[environment]
  const sunlight = sunlightAt(time, preset)
  const sun = sunlight.direction
  const night = nightAt(time)
  const horizon = horizonRadiance(sun, preset)
  const horizonFill = horizon.map((v) => v * SKY_SCALE * SKY_FILL) as Vec3
  const fill = horizonFill.map((v, i) => v + NIGHT_SKY[i] * night) as Vec3
  const zenith = skyRadiance([0, 1, 0], sun, preset).map(
    (v, i) => v * SKY_SCALE + horizonFill[i] + NIGHT_SKY[i] * night,
  )
  const direct = (SUN_INTENSITY * sunlight.intensity * Math.max(0, sun[1])) / Math.PI
  const ground = GROUND_ALBEDO[environment].map(
    (a, i) => a * (direct * sunlight.color[i] + zenith[i] * Math.PI),
  ) as Vec3
  return {
    environment,
    preset,
    sunlight,
    night,
    /** Multiple-scattering fill added to the sky, weighted toward the zenith. */
    fill,
    /** Radiance of the ground seen below the horizon. */
    ground,
    clouds: { coverage: CLOUDS[environment], ...CLOUD_LAYER } as CloudLayer,
    /** Distance fog meets the sky at the average horizon. */
    fog: horizon.map((v) => v * SKY_SCALE) as Vec3,
  }
}
export type SkyLook = ReturnType<typeof skyLook>

/** Radiance arriving from a direction at the site: clouded sky above, sunlit ground below. */
export function environmentRadiance(direction: Vec3, look: SkyLook): Vec3 {
  const d = normalize(direction)
  if (d[1] < 0) return look.ground
  const sky = cloudySkyRadiance(d, look.sunlight.direction, look.preset, look.clouds)
  const up = Math.pow(d[1], 0.6)
  return sky.map((v, i) => v * SKY_SCALE + look.fill[i] * up) as Vec3
}

/**
 * The circumsolar sky: the bright glow within about 25° of the sun (Perez et al.'s circumsolar
 * region), where a clear sky is ten times brighter than elsewhere. Solar engineering counts its
 * light with the sun's beam, because whatever shades a surface from the sun almost always shades
 * it from the glow too: a building's shadow is dark for that reason. The live view does the same
 * (Atmosphere): its radiance captures leave the glow out, and the sun light carries it, shadowed.
 * Its share of a direction's sky falls smoothly from 1 inside `inner` to 0 outside `outer`.
 */
export const CIRCUMSOLAR = { inner: (20 * Math.PI) / 180, outer: (30 * Math.PI) / 180 } as const

/** How much of the sky `angle` radians from the sun is circumsolar. */
export function circumsolarShare(angle: number) {
  return 1 - smoothstep(CIRCUMSOLAR.inner, CIRCUMSOLAR.outer, angle)
}

/**
 * The circumsolar sky's irradiance on a surface facing the sun (linear RGB, scene units): the
 * sky above the horizon within `CIRCUMSOLAR.outer` of the sun, weighted by `circumsolarShare` and
 * by the cosine to the sun.
 */
export function circumsolarIrradiance(look: SkyLook): Vec3 {
  const s = normalize(look.sunlight.direction)
  // Two axes perpendicular to the sun.
  const helper: Vec3 = Math.abs(s[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u = normalize([
    helper[1] * s[2] - helper[2] * s[1],
    helper[2] * s[0] - helper[0] * s[2],
    helper[0] * s[1] - helper[1] * s[0],
  ])
  const v: Vec3 = [s[1] * u[2] - s[2] * u[1], s[2] * u[0] - s[0] * u[2], s[0] * u[1] - s[1] * u[0]]
  const rings = 24,
    spokes = 48
  const dTheta = CIRCUMSOLAR.outer / rings,
    dPhi = (2 * Math.PI) / spokes
  const sum: Vec3 = [0, 0, 0]
  for (let i = 0; i < rings; i++) {
    const theta = (i + 0.5) * dTheta
    const weight = circumsolarShare(theta) * Math.cos(theta) * Math.sin(theta) * dTheta * dPhi
    for (let j = 0; j < spokes; j++) {
      const phi = (j + 0.5) * dPhi
      const a = Math.sin(theta) * Math.cos(phi),
        b = Math.sin(theta) * Math.sin(phi),
        c = Math.cos(theta)
      const d: Vec3 = [0, 1, 2].map((k) => c * s[k] + a * u[k] + b * v[k]) as Vec3
      if (d[1] <= 0) continue
      const radiance = environmentRadiance(d, look)
      for (let k = 0; k < 3; k++) sum[k] += radiance[k] * weight
    }
  }
  return sum
}

/**
 * The live view's sun light (linear RGB irradiance, scene units): the sun's beam and, outdoors,
 * the circumsolar sky's. The traced stills take both from the sky itself.
 */
export function sunBeam(look: SkyLook): Vec3 {
  const { color, intensity } = look.sunlight
  const glow: Vec3 = look.environment === 'studio' ? [0, 0, 0] : circumsolarIrradiance(look)
  return color.map((c, i) => c * SUN_INTENSITY * intensity + glow[i]) as Vec3
}

/** Radiance of the photo studio seen from its center: softboxes in a neutral cyclorama. */
export function studioRadiance(direction: Vec3): Vec3 {
  const d = normalize(direction)
  let nearest = Infinity
  let radiance = STUDIO_BACKDROP
  for (const [width, height, intensity, x, y, z] of STUDIO_SOFTBOXES) {
    const n = normalize([STUDIO_AIM[0] - x, STUDIO_AIM[1] - y, STUDIO_AIM[2] - z])
    const facing = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]
    if (facing >= 0) continue
    const t = (x * n[0] + y * n[1] + z * n[2]) / facing
    if (t <= 0 || t >= nearest) continue
    const hit = [d[0] * t - x, d[1] * t - y, d[2] * t - z]
    // The panel's axes as Object3D.lookAt orients them: x = up × n, y = n × x.
    const ax = normalize([n[2], 0, -n[0]])
    const ay: Vec3 = [
      n[1] * ax[2] - n[2] * ax[1],
      n[2] * ax[0] - n[0] * ax[2],
      n[0] * ax[1] - n[1] * ax[0],
    ]
    const u = hit[0] * ax[0] + hit[1] * ax[1] + hit[2] * ax[2]
    const v = hit[0] * ay[0] + hit[1] * ay[1] + hit[2] * ay[2]
    if (Math.abs(u) > width / 2 || Math.abs(v) > height / 2) continue
    nearest = t
    radiance = [intensity, intensity * 0.98, intensity * 0.94]
  }
  return radiance
}

/**
 * Equirectangular radiance map in the path tracer's layout: row 0 looks straight down, u = 0.5
 * looks along +x, and u increases toward +z. RGBA float, alpha 1.
 */
export function equirectRadiance(
  width: number,
  height: number,
  radiance: (direction: Vec3) => Vec3,
) {
  const data = new Float32Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    const polar = Math.PI * (1 - (row + 0.5) / height)
    const y = Math.cos(polar),
      r = Math.sin(polar)
    for (let col = 0; col < width; col++) {
      const azimuth = ((col + 0.5) / width - 0.5) * Math.PI * 2
      const value = radiance([r * Math.cos(azimuth), y, r * Math.sin(azimuth)])
      const o = (row * width + col) * 4
      data[o] = value[0]
      data[o + 1] = value[1]
      data[o + 2] = value[2]
      data[o + 3] = 1
    }
  }
  return data
}
