// E2E-Treiber über CDP: spricht mit der ECHTEN (gepackten) App über deren
// reguläre Renderer-API (window.api.*) — identischer Pfad wie ein User-Klick.
const port = process.env.CDP_PORT ?? '9223'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('FAIL: kein page-Target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
function send(method, params) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
export async function evalInApp(expression, { timeoutMs = 30_000 } = {}) {
  const result = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`evaluate timeout: ${expression.slice(0, 60)}`)), timeoutMs))
  ])
  if (result.result?.exceptionDetails) {
    throw new Error(`App-Exception: ${JSON.stringify(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text).slice(0, 300)}`)
  }
  return result.result?.result?.value
}
export function closeCdp() { ws.close() }
