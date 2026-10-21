<script lang="ts">
  import SettingsPage from './SettingsPage.svelte'
  import Chevron from './Chevron.svelte'
  import { angel } from '../../lib/streamManager.svelte'
  import { modelLabel, resolveModel } from '../../../worker/models'

  const name = $derived(angel.agent?.name || 'Angel')
  const angelSub = $derived(angel.agentLoaded ? modelLabel(resolveModel(angel.agent?.model)) : 'Model, voice, thinking effort')
  const connectorsSub = $derived.by(() => {
    if (!angel.connectorsLoaded) return 'Services Angel can use'
    const n = angel.connectors.length
    if (!n) return 'None yet'
    const ok = angel.connectors.filter(c => c.status === 'connected').length
    const waiting = n - ok
    if (!ok) return `${waiting} need${waiting === 1 ? 's' : ''} attention`
    return `${ok} connected${waiting ? `, ${waiting} need${waiting === 1 ? 's' : ''} attention` : ''}`
  })
  const accountSub = $derived(angel.user?.email || (angel.devSession ? 'Local development session' : 'Sign-in, your data, version'))
</script>

<SettingsPage title="Settings">
  <ul class="rows">
    <li>
      <a href="#/settings/angel">
        <span class="row-text"><span class="row-title">{name}</span><span class="row-sub">{angelSub}</span></span>
        <Chevron />
      </a>
    </li>
    <li>
      <a href="#/settings/connectors">
        <span class="row-text"><span class="row-title">Connectors</span><span class="row-sub">{connectorsSub}</span></span>
        <Chevron />
      </a>
    </li>
    <li>
      <a href="#/settings/account">
        <span class="row-text"><span class="row-title">Account</span><span class="row-sub">{accountSub}</span></span>
        <Chevron />
      </a>
    </li>
  </ul>
</SettingsPage>
