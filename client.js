// dsh-a2a-agent — Client half
//
// This file is the `code.client` body for a DeepSeek Harness dynamic Cordis
// Plugin. Paste its contents into the `code.client` field of `cordis_define`.
//
// It registers a status card into the `tool.view.cordis` slot (the Run card in
// the conversation flow), polling the host's `get-status` RPC every 2 seconds.

return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    ctx.effect(() =>
      styles.insert(`
      .a2a-status-card {
        font-family: ui-monospace, SFMono-Regular, 'Cascadia Code', Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.5;
        border: 1px solid rgba(128, 128, 128, 0.28);
        border-radius: 10px;
        padding: 14px 16px;
        background: rgba(128, 128, 128, 0.06);
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-width: 500px;
      }
      .a2a-status-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
      }
      .a2a-status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #22c55e;
        display: inline-block;
        flex-shrink: 0;
      }
      .a2a-status-urls {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 3px 12px;
      }
      .a2a-status-label { opacity: 0.55; }
      .a2a-status-value { word-break: break-all; }
      .a2a-status-counts {
        display: flex;
        gap: 24px;
      }
      .a2a-status-count { font-size: 22px; font-weight: 700; line-height: 1.1; }
      .a2a-status-error { color: #ef4444; }
      .a2a-status-badge {
        display: inline-block;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.15);
        color: #16a34a;
      }
    `),
    )

    function StatusCard() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        let active = true
        const refresh = async () => {
          try {
            const s = await host.call('get-status')
            if (active) {
              setStatus(s)
              setError(null)
            }
          } catch (e) {
            if (active) setError(String(e && e.message))
          }
        }
        refresh()
        const dispose = ctx.interval(refresh, 2000)
        return () => {
          active = false
          dispose()
        }
      }, [])

      return React.createElement(
        'div',
        { className: 'a2a-status-card' },
        React.createElement(
          'div',
          { className: 'a2a-status-header' },
          React.createElement('span', { className: 'a2a-status-dot' }),
          'A2A Agent · 运行中',
          status && status.streaming
            ? React.createElement('span', { className: 'a2a-status-badge' }, 'SSE 流式')
            : null,
        ),
        React.createElement(
          'div',
          { className: 'a2a-status-urls' },
          React.createElement('span', { className: 'a2a-status-label' }, '端点'),
          React.createElement(
            'code',
            { className: 'a2a-status-value' },
            status ? status.endpointUrl : '…',
          ),
          React.createElement('span', { className: 'a2a-status-label' }, 'Agent Card'),
          React.createElement(
            'code',
            { className: 'a2a-status-value' },
            status ? status.agentCardUrl : '…',
          ),
        ),
        React.createElement(
          'div',
          { className: 'a2a-status-counts' },
          React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              { className: 'a2a-status-count' },
              String(status ? status.messageCount : 0),
            ),
            React.createElement('div', { className: 'a2a-status-label' }, '已接收消息'),
          ),
          React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              { className: 'a2a-status-count' },
              String(status ? status.taskCount : 0),
            ),
            React.createElement('div', { className: 'a2a-status-label' }, '活动任务'),
          ),
        ),
        error
          ? React.createElement(
              'div',
              { className: 'a2a-status-error' },
              '状态获取失败：' + error,
            )
          : null,
      )
    }

    slots.inject('tool.view.cordis', () =>
      slots.register(
        { name: 'tool.view.cordis', key: 'self' },
        () => React.createElement(StatusCard),
      ),
    )
  },
}
