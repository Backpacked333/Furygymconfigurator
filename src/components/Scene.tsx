import { memo, useMemo, type ComponentProps } from 'react'
import { skyLook } from '../lib/visuals'
import { RenderEffects } from './RenderEffects'
import { SceneSurface } from './SceneSurface'

type Props = Omit<ComponentProps<typeof SceneSurface>, 'effects'> &
  Pick<ComponentProps<typeof RenderEffects>, 'trace' | 'covered' | 'onCaptureReady' | 'onSlow'>

export default memo(function Scene(props: Props) {
  const look = useMemo(
    () => skyLook(props.config.environment, props.config.time),
    [props.config.environment, props.config.time],
  )
  return (
    <SceneSurface
      {...props}
      effects={<RenderEffects {...props} look={look} hero={props.camera ?? [0.48, 0.24, 0.84]} />}
    />
  )
})
