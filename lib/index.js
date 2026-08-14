/**
 * dsh-a2a-agent — npm package form (Host half)
 *
 * A DeepSeek Harness (DSH) Cordis plugin that exposes the running agent over
 * the Agent2Agent (A2A) protocol. Mount this package in the HOST composition:
 *
 *   - id: a2a-agent
 *     name: dsh-a2a-agent
 *
 * Endpoints:
 *   - GET  /.well-known/agent.json      -> A2A 1.0 Agent Card
 *   - GET  /.well-known/agent-card.json -> legacy (0.2.x) alias
 *   - POST /a2a                         -> JSON-RPC 2.0 endpoint
 *   - GET  /a2a/status                  -> JSON status (message/task counters)
 *
 * JSON-RPC methods: message/send, tasks/get, tasks/cancel.
 *
 * NOTE: the status card UI lives in the dynamic-plugin form (client.js), which
 * polls the host through the package-private `get-status` RPC. In this npm
 * form the same counters are available over the `/a2a/status` HTTP endpoint so
 * any frontend can render them without the DSH Typert build chain.
 */

export const name = 'dsh-a2a-agent'

export const inject = ['webServer']

export default function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[a2a] webServer service unavailable; plugin inactive')
    return
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  let counter = 0
  function makeId(prefix) {
    counter += 1
    return (
      prefix +
      '-' +
      Date.now().toString(36) +
      '-' +
      counter.toString(36) +
      '-' +
      Math.floor(Math.random() * 0xffffffff).toString(36)
    )
  }

  /** In-memory task store. Cleared when the plugin is stopped. */
  const tasks = new Map()
  let messageCount = 0

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let body = ''
      let settled = false
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        if (settled) return
        body += chunk
        if (body.length > (limit || 1048576)) {
          settled = true
          reject(new Error('request body too large'))
          req.destroy()
        }
      })
      req.on('end', () => {
        if (!settled) {
          settled = true
          resolve(body)
        }
      })
      req.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
    })
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj)
    const bytes = new TextEncoder().encode(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': bytes.length,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    res.end(body)
  }

  function handleOptions(res) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    })
    res.end()
  }

  // ── agent identity ─────────────────────────────────────────────────────────
  const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : webServer.host
  const baseUrl = 'http://' + host + ':' + webServer.port

  const agentCard = {
    protocolVersion: '1.0',
    name: 'DSH A2A Agent',
    description:
      'A DeepSeek Harness coding agent exposed over the Agent2Agent (A2A) protocol.',
    url: baseUrl + '/a2a',
    version: '0.2.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'chat',
        name: 'Conversational chat',
        description:
          'Replies to a message using the DeepSeek model, with a deterministic echo fallback.',
        tags: ['chat', 'text'],
        examples: ['Hello', 'What can you do?'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
  }

  // ── message handling ───────────────────────────────────────────────────────
  function extractText(message) {
    const parts = (message && message.parts) || []
    const texts = []
    for (const part of parts) {
      if (part && part.kind === 'text' && typeof part.text === 'string') {
        texts.push(part.text)
      }
    }
    return texts.join('\n')
  }

  function echo(text) {
    return '[A2A echo] ' + (text && text.trim() ? text : '(empty message)')
  }

  /** Generate a reply with the host `llm` service, falling back to echo. */
  async function generateReply(text) {
    const llm = ctx.get('llm')
    const modelSel = ctx.get('agentDefaultModel')
    if (llm === undefined || modelSel === undefined) return echo(text)
    try {
      const sel = modelSel.currentSelection()
      const provider = sel && sel.provider
      const model = sel && sel.model
      if (!provider || !model) return echo(text)
      const messages = [
        {
          id: makeId('m'),
          role: 'user',
          content: [{ type: 'text', text: text }],
          source: { kind: 'user' },
        },
      ]
      let out = ''
      for await (const chunk of llm.stream({
        provider: provider,
        model: model,
        messages: messages,
        system:
          'You are an agent answering messages received over the A2A protocol. Reply concisely and helpfully.',
      })) {
        if (chunk.type === 'text-delta') out += chunk.text
        else if (
          chunk.type === 'finish' &&
          chunk.reason &&
          chunk.reason.kind === 'error'
        ) {
          return echo(text)
        }
      }
      const reply = out.trim()
      return reply ? reply : echo(text)
    } catch (err) {
      console.error(
        '[a2a] LLM reply failed, falling back to echo:',
        err && err.message,
      )
      return echo(text)
    }
  }

  // ── JSON-RPC ───────────────────────────────────────────────────────────────
  function rpcResult(id, result) {
    return { jsonrpc: '2.0', id: id, result: result }
  }

  function rpcError(id, code, message, data) {
    const err = { code: code, message: message }
    if (data !== undefined) err.data = data
    return { jsonrpc: '2.0', id: id, error: err }
  }

  async function handleSend(params, id) {
    const message = params && params.message
    if (!message || typeof message !== 'object') {
      return rpcError(id, -32602, 'Invalid params: message is required')
    }
    const text = extractText(message)
    const contextId =
      (typeof message.contextId === 'string' && message.contextId) ||
      makeId('ctx')
    const taskId = makeId('task')
    const task = {
      id: taskId,
      contextId: contextId,
      status: 'working',
      history: [message],
      artifacts: [],
    }
    tasks.set(taskId, task)

    let replyText
    try {
      replyText = await generateReply(text)
    } catch (err) {
      task.status = 'failed'
      return rpcError(id, -32603, 'Internal error: ' + String(err && err.message))
    }

    const replyMessage = {
      kind: 'message',
      messageId: makeId('msg'),
      role: 'agent',
      parts: [{ kind: 'text', text: replyText }],
      contextId: contextId,
      taskId: taskId,
    }
    const artifact = {
      artifactId: makeId('art'),
      name: 'reply',
      parts: [{ kind: 'text', text: replyText }],
    }
    task.status = 'completed'
    task.history.push(replyMessage)
    task.artifacts.push(artifact)
    messageCount += 1
    return rpcResult(id, task)
  }

  function handleGet(params, id) {
    const taskId = params && params.id
    if (typeof taskId !== 'string') {
      return rpcError(id, -32602, 'Invalid params: id is required')
    }
    const task = tasks.get(taskId)
    if (!task) return rpcError(id, -32001, 'Task not found')
    return rpcResult(id, task)
  }

  function handleCancel(params, id) {
    const taskId = params && params.id
    if (typeof taskId !== 'string') {
      return rpcError(id, -32602, 'Invalid params: id is required')
    }
    const task = tasks.get(taskId)
    if (!task) return rpcError(id, -32001, 'Task not found')
    if (
      task.status === 'submitted' ||
      task.status === 'working' ||
      task.status === 'input-required'
    ) {
      task.status = 'canceled'
    }
    return rpcResult(id, task)
  }

  async function dispatch(payload) {
    const id = payload && typeof payload === 'object' ? payload.id : null
    const method = payload && payload.method
    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.jsonrpc !== '2.0'
    ) {
      return rpcError(id, -32600, 'Invalid Request')
    }
    const params = (payload && payload.params) || {}
    switch (method) {
      case 'message/send':
        return await handleSend(params, id)
      case 'tasks/get':
        return handleGet(params, id)
      case 'tasks/cancel':
        return handleCancel(params, id)
      default:
        return rpcError(id, -32601, 'Method not found: ' + String(method))
    }
  }

  // ── HTTP routes ────────────────────────────────────────────────────────────
  function agentCardHandler(req, res) {
    if (req.method === 'OPTIONS') {
      handleOptions(res)
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }
    sendJson(res, 200, agentCard)
  }

  function statusHandler(req, res) {
    if (req.method === 'OPTIONS') {
      handleOptions(res)
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }
    sendJson(res, 200, {
      endpointUrl: baseUrl + '/a2a',
      agentCardUrl: baseUrl + '/.well-known/agent.json',
      messageCount: messageCount,
      taskCount: tasks.size,
    })
  }

  async function a2aHandler(req, res) {
    if (req.method === 'OPTIONS') {
      handleOptions(res)
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, rpcError(null, -32600, 'Invalid Request: POST required'))
      return
    }
    let body
    try {
      body = await readBody(req, 1048576)
    } catch (err) {
      sendJson(
        res,
        400,
        rpcError(null, -32700, 'Parse error: ' + String(err && err.message)),
      )
      return
    }
    let payload
    try {
      payload = body ? JSON.parse(body) : null
    } catch (err) {
      sendJson(res, 200, rpcError(null, -32700, 'Parse error'))
      return
    }
    if (Array.isArray(payload)) {
      const results = []
      for (const item of payload) results.push(await dispatch(item))
      sendJson(res, 200, results)
      return
    }
    sendJson(res, 200, await dispatch(payload))
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const d1 = webServer.register({
      kind: 'exact',
      path: '/.well-known/agent.json',
      handler: agentCardHandler,
    })
    const d2 = webServer.register({
      kind: 'exact',
      path: '/.well-known/agent-card.json',
      handler: agentCardHandler,
    })
    const d3 = webServer.register({
      kind: 'exact',
      path: '/a2a',
      handler: a2aHandler,
    })
    const d4 = webServer.register({
      kind: 'exact',
      path: '/a2a/status',
      handler: statusHandler,
    })
    console.log('[a2a] agent card:      ' + baseUrl + '/.well-known/agent.json')
    console.log('[a2a] JSON-RPC endpoint: ' + baseUrl + '/a2a')
    console.log('[a2a] status endpoint:   ' + baseUrl + '/a2a/status')
    return () => {
      d4()
      d3()
      d2()
      d1()
      console.log('[a2a] A2A agent stopped')
    }
  })
}
