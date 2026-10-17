import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { BAKE, bakeDesigns, bakeRefusal, reportBake } from './lib/bake'
import { RENDER_VERSION } from './lib/stillKey'
import './styles.css'

// `?bake=list` (scripts/bake-stills.mjs) asks only which designs there are to bake, and by
// which renderer.
if (BAKE?.list) {
  window.__bakeDesigns = bakeDesigns()
  reportBake({ version: RENDER_VERSION })
} else {
  if (BAKE) reportBake({ state: 'loading', version: RENDER_VERSION })
  else {
    // Asked to bake where it may not: the script hears why at once; the page is an ordinary visit.
    const refused = bakeRefusal(window.location.search, navigator.webdriver === true)
    if (refused) reportBake({ state: 'failed', version: RENDER_VERSION, error: refused })
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  )
}
