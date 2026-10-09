// Labels for a pull request, from its Conventional Commits title and the files
// it touches. Labels are only ever added, never removed, so a maintainer's
// manual labels stay. Used by .github/workflows/pr-labels.yml.

// type → label
const TYPES = {
  feat: 'enhancement',
  fix: 'bug',
  docs: 'docs',
  test: 'tests',
  ci: 'ci',
  build: 'ci',
  perf: 'performance',
  refactor: 'refactor',
  chore: 'chore'
}

// scope → label
const SCOPES = {
  core: 'core',
  harness: 'harness',
  harnesses: 'harness',
  tui: 'tui',
  'term-view': 'tui',
  'tui-theme': 'tui',
  daemon: 'daemon',
  dictation: 'dictation',
  phone: 'phone',
  remote: 'phone',
  notify: 'notify',
  push: 'phone',
  deps: 'dependencies',
  'deps-dev': 'dependencies',
  security: 'security',
  release: 'release',
  docs: 'docs',
  ci: 'ci'
}

// path prefix → label (first match per file wins within a rule, all rules apply)
const PATHS = [
  [/^packages\/core\/src\/(harnesses|providers)\//, 'harness'],
  [/^packages\/core\//, 'core'],
  [/^(packages\/term-view|packages\/tui-theme|apps\/cli\/src\/tui)\//, 'tui'],
  [/^apps\/cli\/src\/daemon\//, 'daemon'],
  [/^packages\/dictation\//, 'dictation'],
  [/^(packages\/remote|apps\/cli\/src\/(phone|remote))\//, 'phone'],
  [/^apps\/cli\/src\/daemon\/push\.ts$/, 'phone'],
  [/^packages\/notify\//, 'notify'],
  [/^(docs\/|README\.md$|CONTRIBUTING\.md$|SECURITY\.md$|.*\/README\.md$)/, 'docs'],
  [/^(\.github\/|scripts\/e2e-ci\/)/, 'ci']
]

const TITLE = /^(\w+)(?:\(([^)]*)\))?(!)?:/

/** Pure: the labels this PR should have. */
function labelsFor({ title = '', body = '', files = [], author = '' }) {
  const labels = new Set()
  const match = TITLE.exec(title.trim())
  if (match) {
    const [, type, scope, bang] = match
    if (TYPES[type]) labels.add(TYPES[type])
    for (const part of (scope || '').split(/[,/ ]+/).filter(Boolean)) {
      if (SCOPES[part]) labels.add(SCOPES[part])
    }
    if (bang) labels.add('breaking')
    if (type === 'chore' && scope === 'release') labels.delete('chore')
  }
  if (/^BREAKING[ -]CHANGE:/m.test(body)) labels.add('breaking')
  if (/^dependabot/.test(author)) labels.add('dependencies')

  // A Version PR only bumps versions and changelogs: its paths say nothing.
  if (labels.has('release') && /^chore\(release\)/.test(title.trim())) return [...labels].sort()

  const tests = files.filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f))
  if (files.length > 0 && tests.length === files.length) labels.add('tests')
  for (const file of files) {
    for (const [pattern, label] of PATHS) if (pattern.test(file)) labels.add(label)
  }
  // Every PR gets at least one label.
  if (labels.size === 0) labels.add('needs-triage')
  return [...labels].sort()
}

/** Label one PR through the GitHub API (actions/github-script context). */
async function labelPull({ github, owner, repo, pull }) {
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pull.number,
    per_page: 100
  })
  const wanted = labelsFor({
    title: pull.title,
    body: pull.body || '',
    files: files.map((f) => f.filename),
    author: pull.user?.login || ''
  })
  const have = new Set((pull.labels || []).map((l) => (typeof l === 'string' ? l : l.name)))
  const missing = wanted.filter((l) => !have.has(l))
  if (missing.length > 0) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: pull.number, labels: missing })
  }
  return missing
}

module.exports = { labelsFor, labelPull }
