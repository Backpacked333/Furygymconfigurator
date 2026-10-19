/** Dynamic entry failures must not leave a blank page or start a different renderer. */
export async function startApplication(root: HTMLElement, mount: () => Promise<void>) {
  const loading = document.createElement('p')
  loading.setAttribute('role', 'status')
  loading.textContent = 'Loading Fury configurator…'
  root.replaceChildren(loading)
  root.setAttribute('aria-busy', 'true')
  try {
    await mount()
  } catch {
    const fallback = document.createElement('div')
    fallback.className = 'graphics-fallback'
    fallback.setAttribute('role', 'alert')
    const title = document.createElement('strong')
    title.textContent = 'The configurator could not start.'
    const detail = document.createElement('p')
    detail.textContent = 'Your stored designs have not been changed. Reload to try again.'
    const retry = document.createElement('button')
    retry.className = 'primary'
    retry.textContent = 'Reload'
    retry.addEventListener('click', () => window.location.reload())
    fallback.append(title, detail, retry)
    root.replaceChildren(fallback)
  } finally {
    root.removeAttribute('aria-busy')
  }
}
