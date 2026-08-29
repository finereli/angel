// DIAGNOSTIC MODE - replace with real app once issue is found
const el = document.getElementById('app')!
const log = (msg: string) => {
  const p = document.createElement('pre')
  p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  el.appendChild(p)
  console.log(msg)
}

log('App script loaded')

const pin = localStorage.getItem('pin')
log(`PIN in localStorage: ${pin ? 'yes (' + pin.length + ' chars)' : 'no'}`)

if (!pin) {
  log('No PIN - would show login screen. Stopping here.')
} else {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${location.host}/ws`
  log(`Connecting to ${url}`)

  const ws = new WebSocket(url)

  ws.onopen = () => {
    log('WebSocket open - sending auth')
    ws.send(JSON.stringify({ type: 'auth', pin }))
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'auth:ok') {
        log(`auth:ok - ${msg.agents?.length || 0} agents, ${msg.activeStreams?.length || 0} active streams`)
        if (msg.agents) {
          for (const a of msg.agents) {
            log(`  agent: ${a.name} (${a.id}), conv: ${a.conversationId}`)
          }
        }
      } else if (msg.type === 'auth:fail') {
        log('auth:fail - bad PIN')
      } else {
        log(`Message: ${msg.type} ${JSON.stringify(msg).slice(0, 200)}`)
      }
    } catch (e) {
      log(`Parse error: ${e}`)
      log(`Raw data: ${String(event.data).slice(0, 500)}`)
    }
  }

  ws.onerror = (e) => {
    log(`WebSocket error: ${e}`)
  }

  ws.onclose = (e) => {
    log(`WebSocket closed: code=${e.code} reason=${e.reason} clean=${e.wasClean}`)
  }

  // Timeout check
  setTimeout(() => {
    log(`After 5s: readyState=${ws.readyState} (0=connecting, 1=open, 2=closing, 3=closed)`)
  }, 5000)
}
