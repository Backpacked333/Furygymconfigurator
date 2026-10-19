import { Check } from 'lucide-react'
import { ENVIRONMENTS, type Config } from '../lib/config'
import { boostOption, focusSection, leaveSection } from '../render/prefetch'
import { DayNightSetting } from './DayNightSetting'
import { StageToolbarView } from './StageToolbarView'
import { SCENE_LANDSCAPES } from '../domain/presentation'

function focusEnvironment() {
  focusSection('environment')
  return () => leaveSection('environment')
}

/** Legacy adapter: Config mutations and still prefetch never enter the shared toolbar view. */
export function StageToolbar({
  config,
  onChange,
  ...tools
}: {
  live: boolean
  interior: boolean
  config: Config
  onChange: (config: Config) => void
  onMoreSettings: () => void
  onToggleLive: () => void
  dimensions: boolean
  onDimensions: () => void
  autoRotate: boolean
  onAutoRotate: () => void
  onReset: () => void
  onDownload: () => void
  downloading: boolean
  fullscreen: boolean | null
  onFullscreen: () => void
}) {
  return (
    <StageToolbarView
      {...tools}
      onSettingsOpen={focusEnvironment}
      settings={
        <>
          <div className="section-label">Setting</div>
          <div className="scene-settings">
            {ENVIRONMENTS.filter((env) => SCENE_LANDSCAPES.some(({ id }) => id === env.id)).map(
              (env) => (
                <button
                  key={env.id}
                  onPointerEnter={() => boostOption('environment', env.id)}
                  onFocus={() => boostOption('environment', env.id)}
                  aria-pressed={config.environment === env.id}
                  className={config.environment === env.id ? 'selected' : ''}
                  onClick={() => onChange({ ...config, environment: env.id })}
                >
                  {env.name}
                  {config.environment === env.id && <Check size={13} aria-hidden="true" />}
                </button>
              ),
            )}
          </div>
          <DayNightSetting
            label="Time of day"
            time={config.time}
            onChange={(time) => onChange({ ...config, time })}
          />
        </>
      }
    />
  )
}
