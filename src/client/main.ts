import App from './App.svelte'
import './app.css'
import { updates } from './updates'

updates.init()

const app = new App({ target: document.getElementById('app')! })
export default app
