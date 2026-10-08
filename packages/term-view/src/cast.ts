// asciicast v2 (https://docs.asciinema.org/manual/asciicast/v2/): a header
// line, then one `[seconds, "o", data]` event per output chunk. The format
// the recorded sample streams use; also handy to replay a session into a view.

export interface CastHeader {
  version: 2
  width: number
  height: number
  title?: string
}

export interface CastEvent {
  /** Seconds since the start. */
  time: number
  data: string
}

export interface Cast {
  header: CastHeader
  events: CastEvent[]
}

export function parseCast(text: string): Cast {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new Error('empty asciicast')
  const header = JSON.parse(lines[0]) as CastHeader
  if (header.version !== 2)
    throw new Error(`unsupported asciicast version ${String(header.version)}`)
  const events: CastEvent[] = []
  for (let i = 1; i < lines.length; i++) {
    const [time, type, data] = JSON.parse(lines[i]) as [number, string, string]
    if (type === 'o') events.push({ time, data })
  }
  return { header, events }
}

export function formatCast(cast: Cast): string {
  let text = JSON.stringify(cast.header) + '\n'
  for (const event of cast.events) {
    text += JSON.stringify([Number(event.time.toFixed(6)), 'o', event.data]) + '\n'
  }
  return text
}
