// A scripted OpenAI-compatible model for restart/recovery checks. It calls no external service.
//   PORT=9921 node test/tools/scripted-model.mjs
//   POST /__script  [ {"text":"...", "calls":[{"name":"create_note","args":{...}}], "hold":true}, ... ]   one step per request, in order
//   GET  /__count   how many chat requests the model has received (a restart must not add any)
//   POST /__reset   clears the script and the count
// A step with "hold" streams its text and then never finishes: the request stays open until the client goes away, which is
// how a reply "still being generated" is made while the server process is killed.
import http from 'node:http'

let script = [], count = 0
const body = req => new Promise(resolve => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => resolve(raw ? JSON.parse(raw) : {})) })
http.createServer(async (req, res) => {
  if (req.url === '/__script') { script = await body(req); res.end('{}'); return }
  if (req.url === '/__count') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ count })); return }
  if (req.url === '/__reset') { script = []; count = 0; res.end('{}'); return }
  if (!req.url.includes('/chat/completions')) { res.statusCode = 404; res.end(); return }
  const q = await body(req); count++
  const step = script.shift() ?? { text: '（默认回答）' }
  const chunk = delta => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`
  if (!q.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: step.text ?? '' }, finish_reason: 'stop' }] })); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (step.text) for (const piece of step.text.match(/.{1,6}/gs)) res.write(chunk({ content: piece }))
  ;(step.calls ?? []).forEach((call, index) => res.write(chunk({ tool_calls: [{ index, id: `call-${count}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } }] })))
  if (step.hold) return                                        // never finishes
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.calls?.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`); res.end()
}).listen(Number(process.env.PORT) || 9921, '127.0.0.1')
