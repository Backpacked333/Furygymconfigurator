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

/** Linear sky radiance without clouds or sun disc, matching three's SkyMesh output. */
export function skyRadiance(direction: Vec3, sun: Vec3, sky: SkyParams): Vec3 {
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
  return [0, 1, 2].map((i) => {
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i])
    let lin = Math.pow(sunE * ratio * (1 - fex[i]), 1.5)
    lin *= 1 + (Math.pow(sunE * ratio * fex[i], 0.5) - 1) * horizonBlend
    const l0 = 0.1 * fex[i]
    return (lin + l0) * 0.04 + [0, 0.0003, 0.00075][i]
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
