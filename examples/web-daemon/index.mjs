#!/usr/bin/env node
/**
 * Minimal HTTP + Server-Sent Events demo for @acp-kit/core.
 *
 * Endpoints:
 *   GET  /            -> tiny HTML page with a textarea + live event log
 *   POST /prompt      -> body { prompt: string, agent?: string }
 *                        responds with text/event-stream of normalized
 *                        RuntimeSessionEvents until the turn completes.
 *
 * Each request opens its own one-shot ACP session (runOneShotPrompt) and
 * pipes every event as one SSE message. Disconnect from the client aborts
 * the in-flight prompt.
 *
 * This is a DEMO, not a production server: no auth, no rate limiting,
 * no session reuse, one agent process per request.
 *
 * Usage:
 *   npm install
 *   npm start                 # listens on http://localhost:3000
 *   PORT=4000 npm start       # custom port
 *
 * Then open http://localhost:3000 in a browser, or:
 *   curl -N -X POST http://localhost:3000/prompt \
 *     -H 'content-type: application/json' \
 *     -d '{"prompt":"Summarize this repo","agent":"claude"}'
 */

import http from 'node:http';
import process from 'node:process';
import {
  runOneShotPrompt,
  GitHubCopilot,
  ClaudeCode,
  CodexCli,
  GeminiCli,
  QwenCode,
  OpenCode,
} from '@acp-kit/core';

const AGENTS = {
  copilot: GitHubCopilot,
  claude: ClaudeCode,
  codex: CodexCli,
  gemini: GeminiCli,
  qwen: QwenCode,
  opencode: OpenCode,
};

const DEFAULT_AGENT_KEY = 'claude';
const PORT = Number(process.env.PORT ?? 3000);

const HTML_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>ACP Kit web-daemon demo</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  textarea { width: 100%; height: 6rem; font: inherit; }
  pre { background: #111; color: #eee; padding: 1rem; height: 24rem; overflow: auto; white-space: pre-wrap; }
  select, button { font: inherit; padding: 0.4rem 0.8rem; }
</style>
<h1>ACP Kit web-daemon demo</h1>
<p>POSTs to <code>/prompt</code> and streams normalized <code>RuntimeSessionEvent</code>s over Server-Sent Events.</p>
<p>
  <label>Agent:
    <select id="agent">
      ${Object.keys(AGENTS).map((k) => `<option${k === DEFAULT_AGENT_KEY ? ' selected' : ''}>${k}</option>`).join('')}
    </select>
  </label>
</p>
<textarea id="prompt">Summarize this repository.</textarea>
<p><button id="send">Send</button></p>
<pre id="log"></pre>
<script>
  const log = document.getElementById('log');
  const append = (line) => { log.textContent += line + '\\n'; log.scrollTop = log.scrollHeight; };
  document.getElementById('send').onclick = async () => {
    log.textContent = '';
    const agent = document.getElementById('agent').value;
    const prompt = document.getElementById('prompt').value;
    const res = await fetch('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, prompt }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\\n\\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const evt = JSON.parse(dataLine.slice(6));
          append(evt.type + ' ' + JSON.stringify(evt));
        } catch {
          append(dataLine);
        }
      }
    }
    append('-- stream closed --');
  };
</script>
`;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handlePrompt(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid JSON body');
    return;
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('missing "prompt" string');
    return;
  }

  const agentKey = typeof body.agent === 'string' ? body.agent : DEFAULT_AGENT_KEY;
  const agent = AGENTS[agentKey];
  if (!agent) {
    res
      .writeHead(400, { 'content-type': 'text/plain' })
      .end(`unknown agent "${agentKey}". choose one of: ${Object.keys(AGENTS).join(', ')}`);
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  console.log(`[web-daemon] prompt agent=${agent.id} bytes=${prompt.length}`);

  // runOneShotPrompt returns an async iterator; calling iterator.return() on
  // client disconnect tears down the underlying agent process and session.
  const iterator = runOneShotPrompt({ agent, cwd: process.cwd(), prompt });
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    iterator.return?.().catch(() => {});
  });

  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done || aborted) break;
      send(value);
    }
  } catch (err) {
    if (!aborted) {
      send({
        type: 'session.error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    res.end();
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML_PAGE);
    return;
  }
  if (req.method === 'POST' && req.url === '/prompt') {
    handlePrompt(req, res).catch((err) => {
      console.error('[web-daemon] handler crashed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error');
      } else {
        res.end();
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
});

server.listen(PORT, () => {
  console.log(`ACP Kit web-daemon demo listening on http://localhost:${PORT}`);
  console.log(`Default agent: ${DEFAULT_AGENT_KEY} (override with the dropdown or POST body "agent" field)`);
});
