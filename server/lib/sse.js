/** Server-Sent Events writer with heartbeat, backpressure-aware and abort-safe. */
export function openSSE(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n');
  let closed = false;
  const hb = setInterval(() => { if (!closed) res.write(':hb\n\n'); }, 15000);
  const close = () => { if (closed) return; closed = true; clearInterval(hb); try { res.end(); } catch {} };
  req.on('close', close);
  return {
    get closed() { return closed; },
    send(event, data) { if (closed) return; res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    close,
  };
}
