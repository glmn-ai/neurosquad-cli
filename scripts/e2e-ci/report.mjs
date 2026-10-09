// Folds every job's results.json into one Markdown report: per suite, a row
// per check and a column per OS (✅ pass · ❌ fail · ⏭ skipped · — not run),
// with the CLI versions each OS ran.
//
//   node scripts/e2e-ci/report.mjs <dir with results.json files> [--out report.md] [--json all.json]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { args } from './lib.mjs'

const { get, argv } = args()
const dir = argv[0]
const found = []
const walk = (at) => {
  for (const name of readdirSync(at)) {
    const path = join(at, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name === 'results.json') found.push(JSON.parse(readFileSync(path, 'utf8')))
  }
}
walk(dir)

const SUITE_ORDER = ['claude', 'codex', 'opencode-1', 'opencode-2', 'dashboard']
const oses = [...new Set(found.map((r) => r.os))].sort()
const suites = [...new Set(found.map((r) => r.suite))].sort(
  (a, b) => SUITE_ORDER.indexOf(a) - SUITE_ORDER.indexOf(b)
)
// "claude: hello turn working → finished" → "hello turn working → finished" (the suite says which).
const bare = (name) => name.replace(/^(claude|codex|opencode): /, '')
const mark = (check) => (!check ? '—' : check.skipped ? '⏭' : check.ok ? '✅' : '❌')

const lines = ['# nsq live e2e', '']
let total = 0
let failed = 0
for (const suite of suites) {
  const runs = new Map(found.filter((r) => r.suite === suite).map((r) => [r.os, r]))
  const names = []
  for (const run of runs.values())
    for (const part of run.parts)
      for (const check of part.checks)
        if (!names.includes(bare(check.name))) names.push(bare(check.name))
  const passed = (os) => {
    const checks = runs.get(os)?.parts.flatMap((p) => p.checks) ?? []
    return checks.length ? `${checks.filter((c) => c.ok).length}/${checks.length}` : '—'
  }
  lines.push(`## ${suite}`, '')
  lines.push(`| check | ${oses.join(' | ')} |`, `| --- | ${oses.map(() => ':---:').join(' | ')} |`)
  for (const name of names) {
    const cells = oses.map((os) =>
      mark(
        runs
          .get(os)
          ?.parts.flatMap((p) => p.checks)
          .find((c) => bare(c.name) === name)
      )
    )
    lines.push(`| ${name.replace(/\|/g, '\\|')} | ${cells.join(' | ')} |`)
  }
  lines.push(`| **passed** | ${oses.map(passed).join(' | ')} |`, '')
  const versions = [...runs.values()].map(
    (r) =>
      `${r.os}: ${Object.entries(r.versions)
        .map(([name, version]) => `${name} ${version}`)
        .join(', ')}`
  )
  if (versions.length) lines.push('<sub>', ...versions.map((v) => `${v}<br>`), '</sub>', '')
  for (const run of runs.values())
    for (const part of run.parts)
      for (const check of part.checks) {
        total++
        if (!check.ok) failed++
      }
}
lines.splice(2, 0, `**${total - failed}/${total} checks passed** on ${oses.join(', ')}`, '')
const failures = found.flatMap((r) =>
  r.parts.flatMap((p) =>
    p.checks
      .filter((c) => !c.ok)
      .map((c) => ({ os: r.os, suite: r.suite, name: c.name, detail: c.detail }))
  )
)
if (failures.length) {
  lines.push('## Failures', '')
  for (const f of failures)
    lines.push(
      `- **${f.os} · ${f.suite}** — ${f.name}${f.detail === undefined ? '' : `: \`${JSON.stringify(f.detail).slice(0, 300).replace(/`/g, "'")}\``}`
    )
  lines.push('')
}
const markdown = lines.join('\n')
if (get('out')) writeFileSync(get('out'), markdown)
if (get('json')) writeFileSync(get('json'), JSON.stringify(found, null, 2))
console.log(markdown)
