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
import './styles.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)
// `?render` is the headless still harness the render worker drives; it never ships UI.
if (new URLSearchParams(window.location.search).has('render'))
  import('./render-harness/RenderHarness').then(({ default: RenderHarness }) =>
    root.render(<RenderHarness />),
  )
else
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  )
