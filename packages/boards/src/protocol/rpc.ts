// Cap'n Web at /b/<name>/rpc: the Board capability over a WebSocket (GET with Upgrade) or an HTTP
// batch (POST). The Gateway authenticates the request as it does any other (a bearer token, with
// x-board-profile and x-board-can), and the session's main object is the Board for that caller.
import { newWorkersRpcResponse } from 'capnweb'
import { boardFor } from '../binding.ts'
import { failureResponse } from '../errors.ts'
import { GATEWAY, route } from './routes.ts'

route({ name: 'rpc', method: 'GET', path: '/rpc', gateway: true })
route({ name: 'rpcBatch', method: 'POST', path: '/rpc', gateway: true })

export const regionOf = (request: Request) => String((request as { cf?: { continent?: string } }).cf?.continent ?? 'xx').toLowerCase()

const serve: (typeof GATEWAY)[string] = async (request, env, { mount, caller }) => {
  if (!caller) return failureResponse({ status: 401, code: 'unauthorized', message: 'missing bearer token' })
  if (request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return failureResponse({ status: 426, code: 'upgrade_required', message: "GET /rpc is a Cap'n Web WebSocket: send Upgrade: websocket, or POST a batch" })
  return newWorkersRpcResponse(request, boardFor(env, mount, { ...caller, via: 'rpc' }, regionOf(request)))
}

GATEWAY.rpc = serve
GATEWAY.rpcBatch = serve
