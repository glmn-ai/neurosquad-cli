// The host's end of the herdr socket: newline-delimited JSON, one request per
// connection, answered and closed (./protocol.ts).
//
// Unix: a Unix domain socket at the path, owner-only. Windows: herdr's socket
// there is a named pipe named after the path (`\\.\pipe\<path>`), which Node
// serves itself — the shim at HERDR_BIN_PATH and pipe clients reach it. But a
// direct socket client written in Go (Crush) dials AF_UNIX at the path even
// on Windows (charmbracelet/crush#3837), and Node cannot listen on AF_UNIX
// there (libuv binds named pipes only). So on Windows a small Windows
// PowerShell process also listens on AF_UNIX at the same path (a .NET
// Framework socket with AddressFamily.Unix; Windows 10 1803+), prints each
// request line on stdout and answers ok itself; it exits with the host. A
// report it relays still goes through the host's checks — it only cannot
// carry an error back to the agent.
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { encodeHerdrRequest, herdrError, herdrPipeName, requestIdOf } from './protocol.js'

/** `sun_path` holds 104–108 bytes, and Go refuses a longer one. */
export const MAX_HERDR_SOCKET_PATH = 100

/** A request line is a few hundred bytes (a resume command at most 8 KiB). */
const MAX_LINE = 256 * 1024

export interface HerdrServerOptions {
  /** The socket path (short: see MAX_HERDR_SOCKET_PATH), in a directory only this user can enter. */
  socketPath: string
  /** One request line in, the reply line out. */
  handle(line: string): string
  /** Diagnostics. */
  log?(line: string): void
  /** Windows: also listen on AF_UNIX at the path (for Go clients). Default true. */
  unixOnWindows?: boolean
  platform?: NodeJS.Platform
}

export interface HerdrServer {
  readonly socketPath: string
  /** Windows: whether the AF_UNIX listener is up too. */
  readonly unixListener: boolean
  close(): Promise<void>
}

function serveConnection(socket: Socket, handle: (line: string) => string): void {
  let pending = ''
  let answered = false
  socket.setEncoding('utf8')
  socket.setTimeout(5000, () => socket.destroy())
  socket.on('data', (chunk: string) => {
    if (answered) return
    pending += chunk
    const newline = pending.indexOf('\n')
    if (newline < 0) {
      if (pending.length > MAX_LINE) socket.destroy()
      return
    }
    answered = true
    const line = pending.slice(0, newline).replace(/\r$/, '')
    let reply: string
    try {
      reply = handle(line)
    } catch {
      reply = herdrError(requestIdOf(line), 'internal_error', 'the report could not be handled')
    }
    socket.end(reply)
  })
  socket.on('error', () => socket.destroy())
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

// The Windows AF_UNIX listener. Arguments: the socket path and the host's pid
// (the listener stops when that process is gone, so a killed host leaves
// nothing behind). It answers each request with ok, echoing a simple string id.
const UNIX_LISTENER_CS = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

public sealed class NsqHerdrUnixPath : EndPoint {
  private readonly string path;
  public NsqHerdrUnixPath(string path) { this.path = path; }
  public override AddressFamily AddressFamily { get { return AddressFamily.Unix; } }
  public override SocketAddress Serialize() {
    byte[] bytes = Encoding.UTF8.GetBytes(path);
    SocketAddress address = new SocketAddress(AddressFamily.Unix, 110);
    for (int i = 0; i < bytes.Length && i < 107; i++) address[2 + i] = bytes[i];
    return address;
  }
  public override EndPoint Create(SocketAddress address) { return new NsqHerdrUnixPath(path); }
}

public static class NsqHerdrUnixListener {
  static readonly Regex Id = new Regex("\"id\"\\s*:\\s*\"([A-Za-z0-9_.:-]{0,128})\"");

  static bool Alive(int pid) {
    try { return !Process.GetProcessById(pid).HasExited; } catch { return false; }
  }

  static string ReadLine(Socket client) {
    MemoryStream line = new MemoryStream();
    byte[] one = new byte[1];
    while (line.Length < 262144) {
      int n = client.Receive(one);
      if (n == 0 || one[0] == 10) break;
      line.WriteByte(one[0]);
    }
    return Encoding.UTF8.GetString(line.ToArray()).TrimEnd('\r');
  }

  public static void Run(string path, int parent) {
    // The lines are relayed as they came (UTF-8), not in the console's OEM code page.
    try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
    if (File.Exists(path)) File.Delete(path);
    Socket server = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
    server.Bind(new NsqHerdrUnixPath(path));
    server.Listen(32);
    Console.Out.WriteLine("READY");
    Console.Out.Flush();
    while (Alive(parent)) {
      if (!server.Poll(1000000, SelectMode.SelectRead)) continue;
      Socket client = null;
      try {
        client = server.Accept();
        client.ReceiveTimeout = 2000;
        string line = ReadLine(client);
        if (line.Length > 0) {
          Console.Out.WriteLine(line);
          Console.Out.Flush();
          Match id = Id.Match(line);
          string reply = "{\"id\":\"" + (id.Success ? id.Groups[1].Value : "") + "\",\"result\":{\"type\":\"ok\"}}\n";
          client.Send(Encoding.UTF8.GetBytes(reply));
        }
        client.Shutdown(SocketShutdown.Both);
      } catch {
      } finally {
        if (client != null) client.Close();
      }
    }
    server.Close();
    if (File.Exists(path)) File.Delete(path);
  }
}
`

function powershellExe(): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function startUnixListener(
  socketPath: string,
  onLine: (line: string) => void,
  log: (line: string) => void
): Promise<ChildProcess | null> {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Progress records would reach stderr as CLIXML.
    "$ProgressPreference = 'SilentlyContinue'",
    `Add-Type -TypeDefinition ${quote(UNIX_LISTENER_CS)}`,
    `[NsqHerdrUnixListener]::Run(${quote(socketPath)}, ${process.pid})`
  ].join('\n')
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(
        powershellExe(),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      log(`herdr: the AF_UNIX listener did not start: ${String(error)}`)
      resolve(null)
      return
    }
    let ready = false
    let buffered = ''
    const timer = setTimeout(() => {
      if (ready) return
      log('herdr: the AF_UNIX listener did not come up in time')
      child.kill()
      resolve(null)
    }, 10_000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, '')
        buffered = buffered.slice(newline + 1)
        if (!ready && line === 'READY') {
          ready = true
          clearTimeout(timer)
          resolve(child)
        } else if (ready && line) {
          onLine(line)
        }
        newline = buffered.indexOf('\n')
      }
      if (buffered.length > MAX_LINE) buffered = ''
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      log(`herdr: AF_UNIX listener: ${chunk.trim().slice(0, 300)}`)
    })
    child.on('error', (error) => log(`herdr: AF_UNIX listener: ${String(error)}`))
    child.on('exit', () => {
      if (!ready) {
        clearTimeout(timer)
        resolve(null)
      }
    })
  })
}

export async function startHerdrServer(options: HerdrServerOptions): Promise<HerdrServer> {
  const { socketPath, handle } = options
  const log = options.log ?? (() => {})
  const platform = options.platform ?? process.platform
  if (Buffer.byteLength(socketPath) > MAX_HERDR_SOCKET_PATH) {
    throw new Error(`herdr socket path too long for AF_UNIX: ${socketPath}`)
  }
  const windows = platform === 'win32'
  const server = createServer((socket) => serveConnection(socket, handle))
  if (!windows && existsSync(socketPath)) rmSync(socketPath, { force: true })
  await listen(server, windows ? herdrPipeName(socketPath) : socketPath)
  if (!windows) chmodSync(socketPath, 0o600)
  let unix: ChildProcess | null = null
  if (windows && options.unixOnWindows !== false) {
    unix = await startUnixListener(
      socketPath,
      (line) => {
        try {
          handle(line)
        } catch {
          // The listener already answered.
        }
      },
      log
    )
  }
  return {
    socketPath,
    unixListener: unix !== null,
    close: async () => {
      try {
        unix?.kill()
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        rmSync(socketPath, { force: true })
      } catch {
        // The temp directory is cleaned eventually anyway.
      }
    }
  }
}

/**
 * Sends one request to a herdr socket and returns the reply line (the shim at
 * HERDR_BIN_PATH, and tests). Windows: through the named pipe.
 */
export function sendHerdrRequest(
  socketPath: string,
  request: object,
  options: { timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<string> {
  const platform = options.platform ?? process.platform
  const address = platform === 'win32' ? herdrPipeName(socketPath) : socketPath
  return new Promise((resolve, reject) => {
    const socket = connect(address)
    let reply = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('herdr: no reply in time'))
    }, options.timeoutMs ?? 2000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(encodeHerdrRequest(request)))
    socket.on('data', (chunk: string) => {
      reply += chunk
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(reply.split('\n')[0] ?? '')
    })
  })
}
