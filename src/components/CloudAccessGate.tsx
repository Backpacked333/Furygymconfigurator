import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, LockKeyhole } from 'lucide-react'
import { cloudUrl } from '../render/traceStatus'
import { unlockCloud, useCloudAccess } from '../render/cloudAccess'

export default function CloudAccessGate({ children }: { children: ReactNode }) {
  const url = cloudUrl()
  const access = useCloudAccess()
  const [pin, setPin] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  if (!url || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url) || access?.url === url)
    return children

  return (
    <main className="cloud-gate">
      <section className="cloud-gate-card" aria-labelledby="cloud-gate-title">
        <span className="eyebrow">FURY / PRIVATE STUDIO</span>
        <div className="cloud-gate-icon">
          <LockKeyhole size={24} aria-hidden="true" />
        </div>
        <h1 id="cloud-gate-title">Your space starts here.</h1>
        <p>Enter your access PIN to open the configurator with cloud-powered rendering.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            if (pending) return
            const controller = new AbortController()
            request.current = controller
            setPending(true)
            setError('')
            try {
              await unlockCloud(url, pin, controller.signal)
              setPin('')
            } catch (reason) {
              if (!controller.signal.aborted)
                setError(
                  reason instanceof Error ? reason.message : 'Unable to connect. Please try again.',
                )
            } finally {
              if (!controller.signal.aborted) setPending(false)
            }
          }}
        >
          <label htmlFor="cloud-pin">Access PIN</label>
          <input
            id="cloud-pin"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? 'cloud-pin-error' : undefined}
            disabled={pending}
          />
          {error && (
            <p id="cloud-pin-error" role="alert" className="cloud-gate-error">
              {error}
            </p>
          )}
          <button className="primary" type="submit" disabled={pending || !pin}>
            {pending ? 'Unlocking…' : 'Enter the studio'}{' '}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </form>
        <small>Private preview · Access lasts one hour in this tab.</small>
      </section>
    </main>
  )
}
