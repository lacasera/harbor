import { createServer, type Server } from 'node:net'
import { existsSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../core/paths.js'
import type { IpcRouter } from '../ipc/index.js'

/** Where the CLI looks for a running Harbor. */
export function cliSocketPath(): string {
  return join(paths.run, 'harbor.sock')
}

interface Request {
  id: number
  channel: string
  args: unknown[]
}

/**
 * A local socket the `harbor` command talks to.
 *
 * The CLI is a client, deliberately. It could construct its own HarborApp and
 * act on `~/.harbor` directly — and would then be a second process writing the
 * same config, starting the same daemons and holding its own idea of what is
 * running. That is the failure this codebase has already produced several
 * times over: whichever process writes last wins, and the other one's changes
 * vanish without a trace. One owner, and everything else asks it.
 *
 * The protocol is newline-delimited JSON over a unix socket in `~/.harbor/run`,
 * which is the file system permissions doing the access control: only this user
 * can reach it, and nothing is listening on a port.
 */
export function startCliServer(router: IpcRouter, onError: (message: string) => void): Server {
  const socket = cliSocketPath()
  // A socket left by a process that did not exit cleanly blocks the bind.
  if (existsSync(socket)) rmSync(socket, { force: true })

  const server = createServer((connection) => {
    let buffer = ''
    connection.on('data', (chunk) => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim()) void dispatch(line)
      }
    })
    connection.on('error', () => connection.destroy())

    const dispatch = async (line: string): Promise<void> => {
      let request: Request
      try {
        request = JSON.parse(line) as Request
      } catch {
        connection.write(`${JSON.stringify({ id: 0, error: 'malformed request' })}\n`)
        return
      }
      const handler = router.get(request.channel)
      if (!handler) {
        connection.write(
          `${JSON.stringify({ id: request.id, error: `unknown command: ${request.channel}` })}\n`
        )
        return
      }
      try {
        const result = await handler(...(request.args ?? []))
        connection.write(`${JSON.stringify({ id: request.id, result })}\n`)
      } catch (err) {
        connection.write(`${JSON.stringify({ id: request.id, error: (err as Error).message })}\n`)
      }
    }
  })

  server.on('error', (err) => onError(err.message))
  server.listen(socket, () => {
    // Only this user. The socket is in ~/.harbor, but say so explicitly rather
    // than relying on whatever umask happens to be set.
    try {
      chmodSync(socket, 0o600)
    } catch {
      /* best effort */
    }
  })
  return server
}

export function stopCliServer(server: Server | null): void {
  server?.close()
  rmSync(cliSocketPath(), { force: true })
}
