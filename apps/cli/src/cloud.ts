// `nsq login` / `nsq logout` / `nsq whoami`: the optional NeuroSquad account
// (@neurosquad/remote). Nothing in nsq requires it; it is the door to cloud
// features. Tokens live in the OS keyring only.
import { hostname } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  CloudHttp,
  CloudSession,
  FileSessionStore,
  KeyringVault,
  LoginError,
  resolveCloudOrigins
} from '@neurosquad/remote'
import { paths } from './paths.js'
import { VERSION } from './version.js'

export function cloudSession(): CloudSession {
  const origins = resolveCloudOrigins()
  return new CloudSession({
    http: new CloudHttp(origins.api, origins.web, fetch, `nsq/${VERSION}`),
    vault: new KeyringVault(),
    store: new FileSessionStore(join(paths.home(), 'cloud.json')),
    device: { deviceName: hostname(), platform: process.platform, appVersion: VERSION }
  })
}

function openInBrowser(url: string): void {
  if (process.env['NSQ_NO_BROWSER'] === '1') return
  try {
    const [command, args] =
      process.platform === 'win32'
        ? ['explorer.exe', [url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Printed anyway.
  }
}

export async function cmdCloud(verb: 'login' | 'logout' | 'whoami'): Promise<void> {
  const out = (line: string): void => void process.stdout.write(`${line}\n`)
  const session = cloudSession()
  if (verb === 'logout') {
    await session.logout()
    out('signed out')
    return
  }
  if (verb === 'whoami') {
    const status = await session.status()
    if (status.state === 'signed-out') out(`not signed in (${status.reason}) — nsq login`)
    else out(`${status.user.email}${status.offline ? ' (offline)' : ''}`)
    return
  }
  const abort = new AbortController()
  const onSigint = (): void => abort.abort()
  process.once('SIGINT', onSigint)
  try {
    const status = await session.login({
      signal: abort.signal,
      onCode: (code) => {
        out(`Confirm the code ${code.userCode} in your browser:`)
        out(`  ${code.verifyUrl}`)
        openInBrowser(code.verifyUrl)
      }
    })
    out(`signed in as ${status.user.email}`)
  } catch (error) {
    if (error instanceof LoginError) throw new Error(`sign-in failed: ${error.message}`)
    throw error
  } finally {
    process.off('SIGINT', onSigint)
  }
}
