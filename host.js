// dsh-a2a-agent — Host half
//
// This file is the `code.host` body for a DeepSeek Harness dynamic Cordis
// Plugin. Paste its contents into the `code.host` field of `cordis_define`.
//
// It exposes the A2A endpoints on the host `webServer`, registers the
// package-private `get-status` RPC consumed by client.js, and (when
// `enableStreaming` is true) streams `message/stream` replies over SSE.

return {
  apply(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) {
      console.error('[a2a] webServer service unavailable; plugin inactive')
      return
    }

    // 可选择启用：改为 false 即禁用 SSE 流式（message/stream）
    const enableStreaming = true

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

    function startSse(res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
    }

    function sendSse(res, event, data) {
      if (event) res.write('event: ' + event + '\n')
      res.write('data: ' + JSON.stringify(data) + '\n\n')
    }

    const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : webServer.host
    const baseUrl = 'http://' + host + ':' + webServer.port

    const agentCard = {
      protocolVersion: '1.0',
      name: 'DSH A2A Agent',
      description:
        'A DeepSeek Harness coding agent exposed over the Agent2Agent (A2A) protocol.',
      url: baseUrl + '/a2a',
      version: '0.3.0',
      capabilities: {
        streaming: enableStreaming,
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

    function buildLlmContext() {
      const llm = ctx.get('llm')
      const modelSel = ctx.get('agentDefaultModel')
      if (llm === undefined || modelSel === undefined) return null
      let sel
      try {
        sel = modelSel.currentSelection()
      } catch (e) {
        return null
      }
      const provider = sel && sel.provider
      const model = sel && sel.model
      if (!provider || !model) return null
      return { llm, provider, model }
    }

    async function generateReply(text) {
      const c = buildLlmContext()
      if (c === null) return echo(text)
      try {
        const messages = [
          {
            id: makeId('m'),
            role: 'user',
            content: [{ type: 'text', text: text }],
            source: { kind: 'user' },
          },
        ]
        let out = ''
        for await (const chunk of c.llm.stream({
          provider: c.provider,
          model: c.model,
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

    // SSE message/stream：把 llm.stream() 的 token 增量实时推送出去。
    async function handleStream(payload, req, res) {
      const id = payload && payload.id
      const params = (payload && payload.params) || {}
      const message = params.message
      if (!message || typeof message !== 'object') {
        sendJson(res, 200, rpcError(id, -32602, 'Invalid params: message is required'))
        return
      }

      startSse(res)
      let cancelled = false
      req.on('close', () => {
        cancelled = true
      })

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

      sendSse(res, 'status-update', {
        kind: 'status-update',
        taskId: taskId,
        contextId: contextId,
        status: { state: 'working' },
        final: false,
      })

      const artifactId = makeId('art')
      let fullText = ''
      const c = buildLlmContext()
      if (c !== null) {
        try {
          const messages = [
            {
              id: makeId('m'),
              role: 'user',
              content: [{ type: 'text', text: text }],
              source: { kind: 'user' },
            },
          ]
          for await (const chunk of c.llm.stream({
            provider: c.provider,
            model: c.model,
            messages: messages,
            system:
              'You are an agent answering messages received over the A2A protocol. Reply concisely and helpfully.',
          })) {
            if (cancelled) break
            if (chunk.type === 'text-delta') {
              fullText += chunk.text
              sendSse(res, 'artifact-update', {
                kind: 'artifact-update',
                taskId: taskId,
                contextId: contextId,
                artifact: {
                  artifactId: artifactId,
                  name: 'reply',
                  parts: [{ kind: 'text', text: chunk.text }],
                },
                append: true,
              })
            } else if (
              chunk.type === 'finish' &&
              chunk.reason &&
              chunk.reason.kind === 'error'
            ) {
              break
            }
          }
        } catch (err) {
          console.error('[a2a] stream failed, finishing with echo:', err && err.message)
        }
      }

      if (cancelled) {
        task.status = 'canceled'
        res.end()
        return
      }

      if (!fullText.trim()) fullText = echo(text)

      const replyMessage = {
        kind: 'message',
        messageId: makeId('msg'),
        role: 'agent',
        parts: [{ kind: 'text', text: fullText }],
        contextId: contextId,
        taskId: taskId,
      }
      task.status = 'completed'
      task.history.push(replyMessage)
      task.artifacts.push({
        artifactId: artifactId,
        name: 'reply',
        parts: [{ kind: 'text', text: fullText }],
      })
      messageCount += 1

      sendSse(res, 'message', replyMessage)
      sendSse(res, 'status-update', {
        kind: 'status-update',
        taskId: taskId,
        contextId: contextId,
        status: { state: 'completed' },
        final: true,
      })
      res.end()
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
        case 'message/stream':
          return rpcError(
            id,
            enableStreaming ? -32603 : -32601,
            enableStreaming
              ? 'message/stream requires SSE transport; not available in batch'
              : 'Method not found: message/stream (streaming disabled)',
          )
        case 'tasks/get':
          return handleGet(params, id)
        case 'tasks/cancel':
          return handleCancel(params, id)
        default:
          return rpcError(id, -32601, 'Method not found: ' + String(method))
      }
    }

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
      // SSE 流式走独立通道
      if (enableStreaming && payload && payload.method === 'message/stream') {
        await handleStream(payload, req, res)
        return
      }
      sendJson(res, 200, await dispatch(payload))
    }

    harness.handle('get-status', async () => ({
      endpointUrl: baseUrl + '/a2a',
      agentCardUrl: baseUrl + '/.well-known/agent.json',
      messageCount: messageCount,
      taskCount: tasks.size,
      streaming: enableStreaming,
    }))

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
      console.log('[a2a] agent card:      ' + baseUrl + '/.well-known/agent.json')
      console.log('[a2a] JSON-RPC endpoint: ' + baseUrl + '/a2a')
      console.log(
        '[a2a] streaming: ' +
          (enableStreaming ? 'enabled (message/stream via SSE)' : 'disabled'),
      )
      return () => {
        d3()
        d2()
        d1()
        console.log('[a2a] A2A agent stopped')
      }
    })
  },
}
