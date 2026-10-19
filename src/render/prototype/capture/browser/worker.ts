import { installPrivatePage } from './entry'

// Intentionally no customer bootstrap and no on-error fallback image. The owned runner treats
// missing handshake as startup failure and retains its console/network receipts.
void installPrivatePage().catch(() => {
  console.error('Private local capture bootstrap failed; no renderer or image is ready.')
})
