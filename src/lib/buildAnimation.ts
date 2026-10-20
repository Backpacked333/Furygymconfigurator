import type { Config } from './config'

export function buildAnimation(config?: Config): string {
  if (!config) return 'no-excuses'
  if (config.family === 'container') {
    if (config.length === 40) return 'container-40'
    switch (config.containerOpening) {
      case 'center':
        return 'container-center'
      case 'partial':
        return 'container-partial'
      case 'full':
        return 'container-full'
      default:
        return 'container'
    }
  }
  if (config.studioLayout === 'stacked' || config.studioLayout === 'multi-level')
    return 'studio-stacked'
  if (config.studioLayout === 'double-wide' || config.studioLayout === 'connected')
    return 'studio-double'
  if (config.length === 40) return 'studio-long'
  const { deck, gazebo, roof, stairs } = config.addons
  if (deck && gazebo && roof && stairs) return 'studio-full'
  if (roof || stairs) return 'studio-roof'
  if (deck || gazebo) return 'studio-deck'
  return 'studio-single'
}
