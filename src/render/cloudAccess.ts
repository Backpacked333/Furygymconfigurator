import { useSyncExternalStore } from 'react'

type Access = { url: string; token: string; expiresAt: number }
let access: Access | null = null
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function lockCloud() {
  clearTimeout(timer)
  access = null
  listeners.forEach((listener) => listener())
}

export function cloudAuthorization(url: string): Record<string, string> {
  return access?.url === url && access.expiresAt > Date.now()
    ? { authorization: `Bearer ${access.token}` }
    : {}
}

export function useCloudAccess() {
  return useSyncExternalStore(
    subscribe,
    () => access,
    () => null,
  )
}

export async function unlockCloud(url: string, pin: string, signal?: AbortSignal) {
  const response = await fetch(`${url}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
    signal,
  })
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? 'Incorrect PIN. Please try again.'
        : response.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : 'Cloud access is unavailable. Please try again shortly.',
    )
  }
  const result = (await response.json()) as { token: string; expiresAt: number }
  if (
    typeof result.token !== 'string' ||
    !Number.isFinite(result.expiresAt) ||
    result.expiresAt <= Date.now()
  ) {
    throw new Error('Invalid cloud access response.')
  }
  clearTimeout(timer)
  access = { url, ...result }
  timer = setTimeout(lockCloud, result.expiresAt - Date.now())
  listeners.forEach((listener) => listener())
}
