#!/usr/bin/env node
// Fake coding-agent harnesses: they print what the real CLIs' terminal UIs
// print — the same kinds of escape sequences, redraw patterns and rates —
// without any model, login or network. Deterministic (seeded), so a
// recording can be regenerated.
//
//   node fake-harness.mjs <kind> [--cols 120] [--rows 40] [--seconds 8] [--speed 1] [--cast]
//
// Without --cast it writes to stdout in real time; with --cast it prints an
// asciicast v2 recording (virtual timestamps, one event per write) at once.
//
// Kinds:
//   claude    inline Ink UI: history written once, a live region (spinner, input box, status)
//             erased and redrawn ~12×/s, truecolor, rounded box drawing.
//   codex     inline streaming: words streamed into the scrollback, a status line redrawn with
//             CR + EL, 256-colour diffs with coloured backgrounds.
//   opencode  full-screen alternate-screen TUI: synchronized-output frames (?2026), truecolor
//             panels, only changed lines repainted, a full repaint every few seconds.
//   build     a chatty test/build log: bursts of coloured lines.
//   unicode   CJK, emoji, ZWJ sequences, flags, combining marks, inside and outside a box.

const args = process.argv.slice(2)
const kind = args[0]
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(args[i + 1])
}
const COLS = option('cols', 120)
const ROWS = option('rows', 40)
const SECONDS = option('seconds', 8)
const SPEED = option('speed', 1)

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(0x5eed + (kind ?? '').length)
const pick = (list) => list[Math.floor(random() * list.length)]
const int = (min, max) => min + Math.floor(random() * (max - min + 1))

const WORDS = (
  'the a function returns value cache request handler test suite module config ' +
  'refactor update error retry token session agent stream buffer render frame ' +
  'checkout cart payment user order status hook transcript worktree branch commit ' +
  'diff patch file line column width height layout terminal cursor parser'
).split(' ')
const FILES = [
  'src/cart.ts',
  'src/api/checkout.ts',
  'src/lib/cache.ts',
  'test/cart.test.ts',
  'src/ui/Button.tsx',
  'packages/core/src/status.ts'
]
const sentence = (n = int(6, 16)) => {
  const words = []
  for (let i = 0; i < n; i++) words.push(pick(WORDS))
  const s = words.join(' ')
  return s[0].toUpperCase() + s.slice(1) + '.'
}

const ESC = '\x1b'
const CSI = ESC + '['
const rgb = (r, g, b) => `${CSI}38;2;${r};${g};${b}m`
const bgRgb = (r, g, b) => `${CSI}48;2;${r};${g};${b}m`
const RESET = CSI + '0m'
// A virtual clock: the output (and, with --cast, its timing and event
// boundaries) does not depend on the machine's timers or pipe scheduling.
const CAST = args.includes('--cast')
let clock = 0
const events = []
const out = (s) => {
  if (CAST) events.push([Number((clock / 1000).toFixed(6)), 'o', s])
  else process.stdout.write(s)
}
const sleep = (ms) => {
  clock += ms / SPEED
  return CAST ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms / SPEED))
}
const running = () => clock < (SECONDS * 1000) / SPEED

function wrap(text, width) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else line = line ? line + ' ' + word : word
  }
  if (line) lines.push(line)
  return lines
}

async function claude() {
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴']
  const width = COLS - 2
  let liveLines = 0
  let tick = 0
  let tokens = 0
  const erase = () => {
    // Ink's log-update: erase the previous live region line by line, upward.
    let s = ''
    for (let i = 0; i < liveLines; i++) s += CSI + '2K' + (i < liveLines - 1 ? CSI + '1A' : '')
    if (liveLines) s += CSI + 'G'
    return s
  }
  const live = () => {
    const lines = [
      `${rgb(170, 170, 178)}${SPINNER[tick % SPINNER.length]} ${pick(['Thinking', 'Reading', 'Editing', 'Running'])}…${RESET} ${rgb(153, 153, 153)}(${Math.floor(tick / 12)}s · ↑ ${(tokens / 1000).toFixed(1)}k tokens · esc to interrupt)${RESET}`,
      '',
      `${rgb(136, 136, 136)}╭${'─'.repeat(width - 2)}╮${RESET}`,
      `${rgb(136, 136, 136)}│${RESET} > ${' '.repeat(width - 5)}${rgb(136, 136, 136)}│${RESET}`,
      `${rgb(136, 136, 136)}╰${'─'.repeat(width - 2)}╯${RESET}`,
      `  ${rgb(153, 153, 153)}⏵⏵ accept edits on (shift+tab to cycle)${RESET}`
    ]
    liveLines = lines.length
    return lines.join('\r\n')
  }
  out(`${rgb(170, 170, 178)}>${RESET} Welcome to ${CSI}1mFake Code${RESET}\r\n\r\n`)
  out(live())
  while (running()) {
    tick++
    let history = ''
    if (tick % 4 === 0) {
      // A finished paragraph or a tool call moves from the live region into history.
      if (random() < 0.3) {
        history += `${rgb(78, 186, 101)}⏺${RESET} ${CSI}1m${pick(['Read', 'Edit', 'Bash', 'Grep'])}${RESET}(${pick(FILES)})\r\n`
        history += `  ⎿  ${rgb(153, 153, 153)}${pick(['Read 120 lines', 'Updated with 3 additions and 1 removal', 'Found 4 matches'])}${RESET}\r\n`
      } else {
        const para = wrap(sentence(int(12, 40)), width - 4)
        history += `${CSI}37m⏺${RESET} ` + para.join('\r\n  ') + '\r\n'
      }
      tokens += int(80, 400)
    }
    out(erase() + history + live())
    await sleep(int(60, 100))
  }
  out('\r\n')
}

async function codex() {
  let elapsed = 0
  const status = () =>
    `\r${CSI}2K${CSI}38;5;45m•${RESET} ${CSI}1mWorking${RESET} ${CSI}38;5;244m(${elapsed}s • esc to interrupt)${RESET}`
  out(`${CSI}38;5;244m>_ Fake Codex (research preview)${RESET}\r\n\r\n`)
  while (running()) {
    const roll = random()
    if (roll < 0.5) {
      // Stream a paragraph word by word, with the status line kept under it.
      const words = sentence(int(15, 50)).split(' ')
      out(`\r${CSI}2K`)
      let col = 0
      for (const word of words) {
        if (col + word.length + 1 > COLS - 2) {
          out('\r\n')
          col = 0
        }
        out(word + ' ')
        col += word.length + 1
        if (random() < 0.3) await sleep(int(5, 25))
      }
      out('\r\n\r\n' + status())
    } else if (roll < 0.8) {
      out(
        `\r${CSI}2K${CSI}1m• Edited${RESET} ${pick(FILES)} ${CSI}32m(+${int(1, 9)}${RESET} ${CSI}31m-${int(1, 5)})${RESET}\r\n`
      )
      let line = int(10, 300)
      for (let i = 0; i < int(4, 12); i++) {
        const sign = pick([' ', '+', '-'])
        const style =
          sign === '+' ? `${CSI}38;5;114;48;5;22m` : sign === '-' ? `${CSI}38;5;210;48;5;52m` : ''
        const text = `${String(line++).padStart(4)} ${sign}${'  '.repeat(int(0, 3))}${sentence(int(3, 9)).toLowerCase()}`
        out(`${style}${text.slice(0, COLS - 1)}${CSI}K${RESET}\r\n`)
      }
      out('\r\n' + status())
    } else {
      for (let i = 0; i < 6; i++) {
        elapsed++
        out(status())
        await sleep(int(40, 90))
      }
    }
    await sleep(int(30, 120))
  }
  out('\r\n')
}

// eslint-disable-next-line no-control-regex -- real ESC bytes
const visibleLength = (s) => [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length
const padVisible = (s, width) => s + ' '.repeat(Math.max(0, width - visibleLength(s)))

async function opencode() {
  const SIDEBAR = 32
  const main = COLS - SIDEBAR
  const panel = bgRgb(30, 30, 46)
  const side = bgRgb(24, 24, 37)
  const messages = []
  const screen = new Array(ROWS).fill('')
  let frame = 0
  out(`${CSI}?1049h${CSI}?25l${CSI}?2004h${CSI}?1006h${CSI}?1002h`)
  const compose = () => {
    const lines = []
    const body = messages.slice(-(ROWS - 4))
    for (let y = 0; y < ROWS; y++) {
      let left
      if (y === 0)
        left = `${bgRgb(49, 50, 68)}${rgb(205, 214, 244)} ◆ fake-opencode  ${CSI}1mbuild${CSI}22m · model-x`
      else if (y === ROWS - 2)
        left = `${panel}${rgb(166, 173, 200)} ┃ ${rgb(205, 214, 244)}type a message…`
      else if (y === ROWS - 1)
        left = `${panel}${rgb(108, 112, 134)} ${'⣾⣽⣻⢿⡿⣟⣯⣷'[frame % 8]} working  ctrl+x h help`
      else {
        const m = body[y - 1]
        left = m ? `${panel}${m.color}  ${m.text}` : panel
      }
      const sideText =
        y === 1
          ? `${CSI}1mSession${CSI}22m`
          : y === 3
            ? `tokens ${(frame * 37).toLocaleString('en-US')}`
            : y === 4
              ? `cost $${(frame * 0.0013).toFixed(4)}`
              : y >= 6 && y < 6 + FILES.length
                ? FILES[y - 6]
                : ''
      lines.push(
        `${padVisible(left, main)}${side}${rgb(186, 194, 222)}${padVisible(' ' + sideText, SIDEBAR)}${RESET}`
      )
    }
    return lines
  }
  while (running()) {
    frame++
    if (frame % 3 === 0) {
      const colors = [
        rgb(205, 214, 244),
        rgb(166, 227, 161),
        rgb(249, 226, 175),
        rgb(137, 180, 250)
      ]
      for (const line of wrap(sentence(int(8, 30)), main - 6))
        messages.push({ text: line, color: pick(colors) })
    }
    const next = compose()
    const full = frame % 90 === 1
    let s = `${CSI}?2026h`
    for (let y = 0; y < ROWS; y++) {
      if (!full && next[y] === screen[y]) continue
      s += `${CSI}${y + 1};1H${next[y]}`
      screen[y] = next[y]
    }
    out(s + `${CSI}?2026l`)
    await sleep(33)
  }
  out(`${CSI}?1002l${CSI}?1006l${CSI}?2004l${CSI}?25h${CSI}?1049l`)
}

async function build() {
  let n = 0
  while (running()) {
    let burst = ''
    for (let i = 0; i < int(5, 60); i++) {
      n++
      const ok = random() > 0.05
      burst += ok
        ? ` ${CSI}32m✓${RESET} ${pick(FILES).replace('.ts', `${n}.test.ts`)} ${CSI}2m(${int(1, 40)} tests)${RESET} ${CSI}33m${int(1, 900)}ms${RESET}\r\n`
        : ` ${CSI}31m✗${RESET} ${CSI}1;31m${pick(FILES)}${RESET} > ${sentence(5)}\r\n   ${CSI}31mAssertionError: expected ${int(1, 9)} to be ${int(10, 20)}${RESET}\r\n`
    }
    out(burst)
    await sleep(int(10, 60))
  }
}

async function unicode() {
  const samples = [
    '中文输入法 日本語のテキスト 한국어 텍스트',
    'emoji 😀 🚀 ✅ ❤️ 👍🏽 and ZWJ 👨‍👩‍👧 👩‍💻 🏳️‍🌈',
    'flags 🇺🇸 🇯🇵 🇩🇪 combining: é ä ñ Å',
    'box ┌─┬─┐ │中│文│ └─┴─┘ arrows ← → ↑ ↓ ⏺ ⎿ ⏵',
    'mixed: ｆｕｌｌｗｉｄｔｈ ＡＢＣ and half ｱｲｳ'
  ]
  let row = 0
  while (running()) {
    const s = pick(samples)
    out(`${CSI}3${int(1, 6)}m${s}${RESET}\r\n`)
    row++
    if (row % 5 === 0) {
      // A box with wide content redrawn in place.
      out(`${CSI}s${CSI}1;${COLS - 24}H${CSI}44m 状态 ${row} 🚀 ok ${RESET}${CSI}u`)
    }
    await sleep(int(20, 80))
  }
}

const KINDS = { claude, codex, opencode, build, unicode }
if (!KINDS[kind]) {
  console.error(`usage: fake-harness.mjs <${Object.keys(KINDS).join('|')}>`)
  process.exit(2)
}
await KINDS[kind]()
if (CAST) {
  // asciicast v2 on stdout, one event per write, virtual timestamps.
  let text = JSON.stringify({ version: 2, width: COLS, height: ROWS, title: `fake-${kind}` }) + '\n'
  for (const event of events) text += JSON.stringify(event) + '\n'
  process.stdout.write(text)
}
