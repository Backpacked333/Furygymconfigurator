import { useCallback, useEffect, useReducer } from 'react'
import { encodeConfig, initialConfig, type Config } from './config'

type State = { past: Config[]; present: Config; future: Config[]; notice: string }
type Action = { type: 'set'; config: Config } | { type: 'undo' } | { type: 'redo' }
export function configReducer(state: State, action: Action): State {
  if (action.type === 'undo' && state.past.length)
    return {
      ...state,
      past: state.past.slice(0, -1),
      present: state.past.at(-1)!,
      future: [state.present, ...state.future],
    }
  if (action.type === 'redo' && state.future.length)
    return {
      ...state,
      past: [...state.past, state.present],
      present: state.future[0],
      future: state.future.slice(1),
    }
  if (action.type === 'set' && JSON.stringify(action.config) !== JSON.stringify(state.present))
    return {
      ...state,
      past: [...state.past.slice(-49), state.present],
      present: action.config,
      future: [],
    }
  return state
}
export function useConfig() {
  const [state, dispatch] = useReducer(configReducer, undefined, () => {
    const initial = initialConfig()
    return { past: [], present: initial.config, future: [], notice: initial.notice }
  })
  const setConfig = useCallback((config: Config) => dispatch({ type: 'set', config }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])
  useEffect(() => {
    try {
      localStorage.setItem('fury-draft-v1', encodeConfig(state.present))
    } catch {
      /* The live build still works without persistence. */
    }
  }, [state.present])
  return {
    config: state.present,
    setConfig,
    undo,
    redo,
    canUndo: !!state.past.length,
    canRedo: !!state.future.length,
    initialNotice: state.notice,
  }
}
