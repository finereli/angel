// pwa-kit: shell/src/main.ts v6
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { updates } from '$shared/lib/updates.svelte'
import { angel } from './lib/streamManager.svelte'
import { setAccent, storedAccent } from './lib/accent'

setAccent(storedAccent())

// A new version never reloads a live session. Veto the moments a silent reload
// would hurt - while a reply is streaming.
updates.init({ canReload: () => !Object.values(angel.convStates).some(c => c.streamState === 'streaming') })

// Optimistic boot: a stored token shows the app while it re-validates.
angel.boot()

export default mount(App, { target: document.getElementById('app')! })