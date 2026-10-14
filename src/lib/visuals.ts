export type Surface = 'cedar' | 'oak' | 'rubber' | 'stone' | 'plaster' | 'metal'

export function noise(x: number, y: number, seed = 1) {
  let n = Math.imul(x + seed * 374761393, 668265263) ^ Math.imul(y, 1274126177)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

// Periodic grain keeps the generated, locally bundled surfaces seamless.
export function surfacePixels(surface: Surface, size = 256) {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2,
        v = (y / size) * Math.PI * 2
      const fine = noise(x, y, 17)
      let value = 0.92 + (fine - 0.5) * 0.1
      if (surface === 'cedar' || surface === 'oak') {
        const bend = Math.sin(v) * 0.65 + Math.sin(v * 3 + u) * 0.2
        const grain = Math.sin(u * 22 + bend * 4) * Math.sin(u * 7 + bend)
        value = 0.82 + grain * 0.045 + Math.sin(u * 3 + bend) * 0.025 + fine * 0.06
      } else if (surface === 'rubber') {
        value = fine > 0.96 ? 0.95 : 0.48 + fine * 0.23
      } else if (surface === 'stone' || surface === 'plaster') {
        value = 0.92 + Math.sin(u * 3 + Math.cos(v * 2)) * 0.009 + (fine - 0.5) * 0.055
      }
      const i = (y * size + x) * 4
      data[i] = data[i + 1] = data[i + 2] = Math.round(Math.max(0, Math.min(1, value)) * 255)
      data[i + 3] = 255
    }
  }
  return data
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function lightingAt(time: number) {
  const daylight = smoothstep(6, 8, time) * (1 - smoothstep(17, 20.5, time))
  const warmth = smoothstep(15, 18.5, time) * (1 - smoothstep(19, 21, time))
  return { daylight, warmth, elevation: Math.max(0.1, Math.sin(((time - 6) / 15) * Math.PI)) }
}
