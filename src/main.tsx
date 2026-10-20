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
import { startApplication } from './lib/startup'
import './styles.css'

// Deliberately no static legacy imports: even its module initialization starts renderer work.
// The native image library is available on its explicit route; the ordinary route still boots v3.
if (
  new URLSearchParams(window.location.search).get('experience') === 'library' ||
  (import.meta.env.DEV && new URLSearchParams(window.location.search).get('prototype') === 'images')
) {
  void startApplication(document.getElementById('root')!, async () => {
    const { ImageConfigurator } = await import('./prototype/ImageConfigurator')
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ImageConfigurator />
      </React.StrictMode>,
    )
  })
} else {
  void startApplication(document.getElementById('root')!, async () => {
    const { mountLegacy } = await import('./legacyEntry')
    mountLegacy()
  })
}
