// Drives the Board capability over Cap'n Web from Node: a WebSocket session and HTTP batches.
//   node test/capnweb-client.mjs <board url> <token>
import { newHttpBatchRpcSession, newWebSocketRpcSession } from 'capnweb'

const [url, token] = process.argv.slice(2)
if (!url || !token) throw new Error('usage: node test/capnweb-client.mjs <board url> <token>')
const headers = { authorization: 'Bearer ' + token }
const out = (label, value) => console.log(label.padEnd(28) + ' ' + (typeof value === 'string' ? value : JSON.stringify(value)))
const refused = async (work) => {
  try {
    await work()
    return 'allowed'
  } catch (error) {
    return 'refused: ' + error.message
  }
}

// -- WebSocket: one session, many calls, stubs that live across them ------------------------------
{
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/rpc', { headers })
  const board = newWebSocketRpcSession(socket)
  out('ws name', await board.name)
  const me = await board.me()
  out('ws me', me.actor?.id ?? me.actor)
  const { message } = await board.post('work', { text: 'over a socket', id: 'ws-' + Date.now() })
  out('ws post', message.id + ' ' + message.channel + ' ' + JSON.stringify(message.text))
  await board.reply(message.id, 'a reply over the socket')
  const thread = await board.read(message.id)
  out('ws read', thread.replies.map((reply) => reply.text))
  const agent = board.as('scout')
  const posted = await agent.post('work', 'as a profile')
  out('ws as(scout)', posted.message.by.actor)

  // Attenuation: a channel's Board can't reach past it.
  const work = board.channel('work/')
  out('ws channel(work/) post', (await work.post('work/sub', 'inside')).message.channel)
  out('ws channel(work/) outside', await refused(() => work.post('elsewhere', 'outside')))
  out('ws narrow widens?', await refused(() => work.narrow('*=all').post('elsewhere', 'still outside')))

  // A held wait over the socket: events with wait, woken by a post on another call.
  const head = (await board.events({ last: 1 })).cursor
  const waiting = board.events({ after: head, channel: 'pings', wait: 20 })
  const started = Date.now()
  setTimeout(() => void board.post('pings', 'ring'), 1500)
  const page = await waiting
  out('ws events wait', page.events.length + ' event(s) after ' + (Date.now() - started) + 'ms: ' + page.events[0]?.type)

  // A claim is an object; dropping its stub leaves the task claimed.
  const { task } = await board.tasks.create({ channel: 'jobs', text: 'build it ' + Date.now() })
  const claim = await board.tasks.claim({ id: task.id }, { lease: 120 })
  out('ws claim', 'epoch ' + (await claim.epoch) + ' until ' + (await claim.until))
  claim[Symbol.dispose]()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const after = await board.read(task.id)
  out('ws after dispose', after.message.task.state + ' by ' + after.message.task.claim?.actor)
  const again = await refused(() => board.tasks.claim({ id: task.id }))
  out('ws claim again', again)
  board[Symbol.dispose]()
  socket.close()
}

// -- HTTP batch: each batch is one request; pipelined calls ride in it --------------------------
{
  const batch = () => newHttpBatchRpcSession(new Request(url + '/rpc', { headers }))
  let board = batch()
  // One round trip: post, then reply to what it answers, then claim a ready task, then complete it.
  const posted = board.post('work', 'over a batch')
  const reply = board.reply(posted.message.id, 'pipelined reply')
  const made = board.tasks.create({ channel: 'jobs', text: 'batch job ' + Date.now(), claim: true })
  const done = made.claim.complete('shipped')
  const [p, r, d] = await Promise.all([posted, reply, done])
  out('batch post', p.message.id)
  out('batch pipelined reply', r.message.re + ' <- ' + JSON.stringify(r.message.text))
  out('batch claim+complete', d.task.task.state + ': ' + d.task.task.result)

  board = batch()
  out('batch channel refused', await refused(() => board.channel('jobs').post('work', 'no')))
  board = newHttpBatchRpcSession(new Request(url + '/rpc', { headers: { authorization: 'Bearer nope' } }))
  out('batch bad token', await refused(() => board.me()))
}
