import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { flagBool, flagString, parseArgs, parseSince } from './args.js'
import { costLabel, elapsed, harnessFromAlias, statusLabel, textWidth, truncate } from './format.js'
import { LineDecoder, encode } from './protocol.js'
import { macNotificationScript, toastXml } from './daemon/notify.js'
import { AgentStore } from './daemon/store.js'
import { answerKeys } from './daemon/answers.js'
import { claudeProjectSlug } from './daemon/usage.js'
import { parseDetachKey } from './attach.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('args', () => {
  it('flags, values, and everything after --', () => {
    const args = parseArgs([
      'claude',
      'fix it',
      '--name',
      'api',
      '--worktree',
      '--model=x/y',
      '-w',
      '--',
      'npm',
      'test'
    ])
    expect(args.positional).toEqual(['claude', 'fix it'])
    expect(flagString(args, 'name')).toBe('api')
    expect(flagString(args, 'model')).toBe('x/y')
    expect(flagBool(args, 'worktree')).toBe(true)
    expect(flagBool(args, 'w')).toBe(true)
    expect(args.rest).toEqual(['npm', 'test'])
  })

  it('durations', () => {
    expect(parseSince('7d', 1_000_000_000)).toBe(1_000_000_000 - 7 * 86_400_000)
    expect(parseSince('soon')).toBeUndefined()
  })
})

describe('format', () => {
  it('aliases, labels, elapsed', () => {
    expect(harnessFromAlias('Claude')).toBe('claude-code')
    expect(harnessFromAlias('oc')).toBe('opencode')
    expect(harnessFromAlias('vim')).toBeUndefined()
    expect(statusLabel({ status: 'needs-input' })).toBe('needs you')
    expect(elapsed(1000, 1000 + 125_000)).toBe('2m')
  })

  it('cost: never $0 for requests without a price', () => {
    expect(costLabel({})).toBe('—')
    expect(costLabel({ costPico: '0', unpricedRequests: 3 })).toBe('no price')
    expect(costLabel({ costPico: '1870000000000', unpricedRequests: 0 })).toBe('$1.87')
    expect(costLabel({ costPico: '1870000000000', unpricedRequests: 1 })).toBe('$1.87+')
  })

  it('width-aware truncation', () => {
    expect(textWidth('日本')).toBe(4)
    expect(truncate('hello world', 6)).toBe('hello…')
    expect(textWidth(truncate('日本語のテキスト', 7))).toBeLessThanOrEqual(7)
  })
})

describe('protocol', () => {
  it('decodes lines split across chunks and skips garbage', () => {
    const got: unknown[] = []
    const decoder = new LineDecoder<unknown>((message) => got.push(message))
    const text = encode({ t: 'a' }) + 'not json\n' + encode({ t: 'b', s: 'x\ny' })
    decoder.push(text.slice(0, 5))
    decoder.push(text.slice(5))
    expect(got).toEqual([{ t: 'a' }, { t: 'b', s: 'x\ny' }])
  })
})

describe('notifications', () => {
  it('toast XML and AppleScript are escaped', () => {
    expect(toastXml('a <b>', 'x & "y"', true)).toContain('a &lt;b&gt;')
    expect(toastXml('t', 'x & "y"', false)).toContain('x &amp; &quot;y&quot;')
    expect(toastXml('t', 'b', false)).toContain('silent="true"')
    expect(macNotificationScript('say "hi"', 'back\\slash', true)).toBe(
      'display notification "back\\\\slash" with title "say \\"hi\\"" sound name "Glass"'
    )
  })
})

describe('store', () => {
  it('persists, finds by name or id prefix, and names uniquely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsq-store-'))
    dirs.push(dir)
    const file = join(dir, 'agents.json')
    const store = new AgentStore(file)
    const base = {
      harness: 'claude-code' as const,
      workspace: dir,
      cwd: dir,
      createdAt: 1,
      wantRunning: true
    }
    store.put({
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      name: store.uniqueName('api fix'),
      ...base
    })
    store.put({
      id: '1f8fad5b-d9cb-469f-a165-70867728950e',
      name: store.uniqueName('api fix'),
      ...base
    })
    const again = new AgentStore(file)
    expect(again.all().map((a) => a.name)).toEqual(['api-fix', 'api-fix-2'])
    expect(again.find('API-FIX-2')?.id).toBe('1f8fad5b-d9cb-469f-a165-70867728950e')
    expect(again.find('0f8f')?.name).toBe('api-fix')
    expect(again.find('nope')).toBeUndefined()
  })
})

describe('daemon helpers', () => {
  it('answer keys per harness', () => {
    expect(answerKeys('claude-code', 'yes')).toBe('1')
    expect(answerKeys('codex-cli', 'no')).toBe('\x1b')
    expect(answerKeys('command', 'yes')).toBeNull()
  })

  it("Claude Code's project folder name", () => {
    expect(claudeProjectSlug('E:\\Github\\vibe')).toBe('E--Github-vibe')
    expect(claudeProjectSlug('/home/me/my.app')).toBe('-home-me-my-app')
  })

  it('detach key', () => {
    expect(parseDetachKey(undefined)).toBe('\x1d')
    expect(parseDetachKey('ctrl+a')).toBe('\x01')
    expect(parseDetachKey('ctrl+]')).toBe('\x1d')
  })
})
