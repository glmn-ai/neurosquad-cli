// Copies the phone page (plain HTML/CSS/JS, no build step) next to the compiled server.
import { cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'src', 'phone', 'web')
const to = join(root, 'dist', 'phone', 'web')
rmSync(to, { recursive: true, force: true })
cpSync(from, to, { recursive: true })
