// node --test .github/scripts/pr-labels.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { labelsFor } = require('./pr-labels.cjs')

test('type and scope from the title', () => {
  assert.deepEqual(labelsFor({ title: 'feat(tui): grid' }), ['enhancement', 'tui'])
  assert.deepEqual(labelsFor({ title: 'fix(daemon,phone): x' }), ['bug', 'daemon', 'phone'])
  assert.deepEqual(labelsFor({ title: 'chore(release): version packages' }), ['release'])
  assert.deepEqual(labelsFor({ title: 'chore(deps): bump vitest' }), ['chore', 'dependencies'])
})

test('breaking from ! or the body', () => {
  assert.ok(labelsFor({ title: 'feat(core)!: new api' }).includes('breaking'))
  assert.ok(labelsFor({ title: 'feat: x', body: 'text\nBREAKING CHANGE: y' }).includes('breaking'))
})

test('paths add their areas', () => {
  const labels = labelsFor({
    title: 'fix: x',
    files: ['packages/core/src/providers/openrouter.ts', 'docs/guide/phone.md']
  })
  assert.deepEqual(labels, ['bug', 'core', 'docs', 'harness'])
})

test('test-only PRs get tests', () => {
  assert.ok(
    labelsFor({ title: 'x', files: ['packages/dictation/src/capture/command.test.ts'] }).includes(
      'tests'
    )
  )
})

test('a Version PR is only release', () => {
  assert.deepEqual(
    labelsFor({ title: 'chore(release): version packages', files: ['packages/core/CHANGELOG.md'] }),
    ['release']
  )
})

test('never empty', () => {
  assert.deepEqual(labelsFor({ title: 'Update thing' }), ['needs-triage'])
})

test('dependabot', () => {
  assert.ok(labelsFor({ title: 'Bump x', author: 'dependabot[bot]' }).includes('dependencies'))
})
