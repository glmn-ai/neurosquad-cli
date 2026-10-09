// What a Claude Code session ran on, and the user's own model setting — for
// going back from OpenRouter to the user's own login on the same session.
//
// `claude --resume <id>` restores the session's model when it looks like a
// Claude model — an OpenRouter slug such as `anthropic/claude-sonnet-5.5`
// included — so after OpenRouter the own login would get a slug it does not
// know. The caller then passes the user's own model (`--model`) explicitly.
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

/**
 * The model of every assistant message of a Claude Code session, oldest first
 * (`projects/<cwd slug>/<session id>.jsonl`; synthetic entries skipped).
 * Never throws; [] when the transcript is not here.
 */
export function claudeSessionModels(
  sessionId: string,
  projectsRoot: string = join(claudeConfigDir(), 'projects')
): string[] {
  let dirs: string[]
  try {
    dirs = readdirSync(projectsRoot)
  } catch {
    return []
  }
  for (const dir of dirs) {
    let text: string
    try {
      text = readFileSync(join(projectsRoot, dir, `${sessionId}.jsonl`), 'utf-8')
    } catch {
      continue
    }
    const models: string[] = []
    for (const line of text.split('\n')) {
      if (!line.includes('"assistant"')) continue
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { model?: unknown } }
        const model = entry.message?.model
        if (entry.type === 'assistant' && typeof model === 'string' && !model.startsWith('<'))
          models.push(model)
      } catch {
        // a torn last line
      }
    }
    return models
  }
  return []
}

/** `model` from the user's Claude Code settings (`settings.json`), if set. Never throws. */
export function claudeSettingsModel(configDir: string = claudeConfigDir()): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8')) as {
      model?: unknown
    }
    return typeof settings.model === 'string' && settings.model.trim()
      ? settings.model.trim()
      : undefined
  } catch {
    return undefined
  }
}
