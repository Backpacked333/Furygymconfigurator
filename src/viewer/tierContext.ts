import { createContext, useContext } from 'react'
import type { Quality } from './quality'
import { TIERS, type TierSpec } from './tiers'

export type TierContext = { quality: Quality; spec: TierSpec }
export const Tier = createContext<TierContext>({ quality: 'high', spec: TIERS.high })

/** The tier the viewer renders at, for product content that scales with it. */
export function useTier() {
  return useContext(Tier)
}
