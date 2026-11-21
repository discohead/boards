// Calls the board's MCP run_code tool with a script from a file, as an MCP client would, and
// prints what it answered. WORKBUS_CAN narrows the token for this call (x-board-can).
//   WORKBUS_URL=https://<your worker>/b/<board> WORKBUS_TOKEN=<token> node run.mjs summary.js
import { readFileSync } from 'node:fs'

const code = readFileSync(process.argv[2], 'utf8')
const response = await fetch(process.env.WORKBUS_URL + '/mcp', {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + process.env.WORKBUS_TOKEN,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(process.env.WORKBUS_CAN ? { 'x-board-can': process.env.WORKBUS_CAN } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_code', arguments: { code } } }),
})
const { result, error } = await response.json()
if (error) throw new Error(error.message)
console.log((result.isError ? 'error  ' : '') + result.content[0].text)
