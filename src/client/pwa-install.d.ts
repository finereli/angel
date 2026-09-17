// pwa-kit: install/src/pwa-install.d.ts v1
// Ambient types for the install flow: the event captured by the inline script
// in index.html, and iOS's non-standard navigator.standalone. Put next to the
// app's own d.ts (src/), it's picked up by tsconfig's include.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
interface Window {
  __pwaInstallPrompt?: BeforeInstallPromptEvent
}
interface Navigator {
  standalone?: boolean
}
