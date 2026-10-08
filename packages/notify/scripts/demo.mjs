// Manual check on a real machine:  npm run demo -w packages/notify [-- options]
//
//   --once       one "finished" notification, no replace/withdraw sequence
//   --muted      no sound
//   --terminal   terminal fallback only (no native toast)
//   --always     native toast and terminal signal together
//
// Prints what this machine supports, then shows "nsq test notification"
// (needs-input), replaces it with a "finished" one, and withdraws it.
import { createNotifier } from '../dist/index.js'

const flags = new Set(process.argv.slice(2))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const notifier = createNotifier({
  appName: 'NeuroSquad CLI',
  appId: 'ai.neurosquad.cli',
  muted: flags.has('--muted'),
  native: !flags.has('--terminal'),
  terminal: { mode: flags.has('--always') ? 'always' : 'auto' },
  log: (message) => console.log(`  log: ${message}`)
})

console.log('status:', await notifier.status())

if (flags.has('--once')) {
  console.log(
    'show finished:',
    await notifier.show({
      id: 'nsq-demo',
      title: 'nsq test notification',
      body: 'If you can read this, notifications work.',
      kind: 'finished'
    })
  )
} else {
  console.log(
    'show needs-input:',
    await notifier.show({
      id: 'nsq-demo',
      title: 'nsq test notification',
      body: 'demo-agent needs you: Allow Bash (npm test)?',
      kind: 'needs-input'
    })
  )
  await wait(4000)
  console.log(
    'replace with finished:',
    await notifier.show({
      id: 'nsq-demo',
      title: 'nsq test notification',
      body: 'demo-agent finished',
      kind: 'finished'
    })
  )
  await wait(4000)
  await notifier.withdraw('nsq-demo')
  console.log('withdrawn')
}

await wait(1500) // let the sound finish
await notifier.dispose()
