import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-800.css'
import { FixedReview } from './FixedReview'
import './review.css'

class ReviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <main className="review-warning" role="alert">
        <h1>The review could not be displayed.</h1>
        <p>
          Unsaved changes may not be recoverable. This workspace does not migrate your legacy
          designs.
        </p>
        <button onClick={() => window.location.reload()}>Reload workspace</button>
      </main>
    ) : (
      this.props.children
    )
  }
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ReviewBoundary>
        <FixedReview />
      </ReviewBoundary>
    </StrictMode>,
  )
} else {
  document.getElementById('root')!.textContent =
    'This unapproved review workspace is development-only.'
}
