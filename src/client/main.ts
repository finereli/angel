import App from './App.svelte'
import './app.css'

const app = new App({ target: document.getElementById('app')! })
export default app

// Register the service worker so the app is installable as a PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
