import { createHash } from 'node:crypto'

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidAppId(appId: string): boolean {
  return APP_ID.test(appId)
}

/**
 * A notification id every backend accepts as a tag/group (Windows caps a tag
 * at 64 characters): the id itself when it is short and plain, else a hash.
 */
export function notificationKey(id: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(id)) return id
  return 'h' + createHash('sha256').update(id).digest('hex').slice(0, 40)
}

/**
 * Text safe for every channel: no control characters (they are invalid in
 * toast XML and would end an OSC sequence early), newlines kept as spaces
 * only where the channel needs one line.
 */
export function cleanText(text: string, max = 1000): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned
}

export function oneLine(text: string, max = 240): string {
  return cleanText(text.replace(/\s*[\r\n\t]+\s*/g, ' '), max).trim()
}
