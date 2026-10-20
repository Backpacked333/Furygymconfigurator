import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { BAKE, bakeDesigns, bakeRefusal, reportBake } from './lib/bake'
import { RENDER_VERSION } from './lib/stillKey'

/** Original v3 boot, loaded only when the DEV prototype is not selected. */
export function mountLegacy() {
  if (BAKE?.list) {
    window.__bakeDesigns = bakeDesigns()
    reportBake({ version: RENDER_VERSION })
  } else {
    if (BAKE) reportBake({ state: 'loading', version: RENDER_VERSION })
    else {
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
}
