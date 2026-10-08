// Small interactive pieces of the dashboard: a one-line text field and the
// modal dialogs built on it. Each handles its own keys and draws itself into
// the canvas; the dashboard owns which one is open.
import { seg, type Line, type StyleSpec } from '@neurosquad/tui-theme'
import type { KeyEvent, PasteEvent } from './keys.js'

export class TextField {
  value: string
  cursor: number

  constructor(
    value = '',
    readonly placeholder = ''
  ) {
    this.value = value
    this.cursor = value.length
  }

  /** Handles an editing key; false when the key is not an edit. */
  handle(event: KeyEvent | PasteEvent): boolean {
    if (event.type === 'paste') {
      this.insert(event.text.replace(/\r?\n/g, ' '))
      return true
    }
    const { name, ctrl, alt } = event
    if (name === 'backspace') {
      if (ctrl || alt) {
        const before = this.value.slice(0, this.cursor).replace(/\S+\s*$/, '')
        this.value = before + this.value.slice(this.cursor)
        this.cursor = before.length
      } else if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor)
        this.cursor--
      }
      return true
    }
    if (name === 'delete') {
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1)
      return true
    }
    if (name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1)
      return true
    }
    if (name === 'right') {
      this.cursor = Math.min(this.value.length, this.cursor + 1)
      return true
    }
    if (name === 'home' || (ctrl && name === 'a')) {
      this.cursor = 0
      return true
    }
    if (name === 'end' || (ctrl && name === 'e')) {
      this.cursor = this.value.length
      return true
    }
    if (ctrl && name === 'u') {
      this.value = this.value.slice(this.cursor)
      this.cursor = 0
      return true
    }
    if (name === 'space' && !ctrl && !alt) {
      this.insert(' ')
      return true
    }
    if (!ctrl && !alt && [...name].length === 1) {
      this.insert(name === name.toLowerCase() && event.shift ? name.toUpperCase() : name)
      return true
    }
    return false
  }

  private insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor)
    this.cursor += text.length
  }

  /** The field as a line of `width` cells; the cursor shown as an inverted cell when `focused`. */
  render(width: number, focused: boolean, style: StyleSpec = { fg: 'text', bg: 'chipBg' }): Line {
    if (!this.value && !focused)
      return [seg(fitText(this.placeholder, width), { ...style, fg: 'faintText' })]
    // Keep the cursor in view.
    const start = Math.max(0, this.cursor - width + 1)
    const visible = this.value.slice(start, start + width)
    const at = this.cursor - start
    const before = visible.slice(0, at)
    const under = visible[at] ?? ' '
    const after = visible.slice(at + 1)
    if (!focused) return [seg(fitText(visible, width), style)]
    const text = before + under + after
    const pad = Math.max(0, width - text.length)
    return [
      seg(before, style),
      seg(under, { ...style, inverse: true }),
      seg(after + ' '.repeat(pad), style)
    ]
  }
}

export function fitText(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length > width) return text.slice(0, Math.max(0, width - 1)) + '…'
  return text + ' '.repeat(width - text.length)
}

/** A list with a filter and a selection (the model picker, the harness picker). */
export class PickList<T> {
  selected = 0
  scroll = 0
  readonly filter = new TextField()

  constructor(
    public items: T[],
    readonly label: (item: T) => string,
    readonly detail: (item: T) => string = () => ''
  ) {}

  visible(): T[] {
    const words = this.filter.value.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return this.items
    return this.items.filter((item) => {
      const text = `${this.label(item)} ${this.detail(item)}`.toLowerCase()
      return words.every((word) => text.includes(word))
    })
  }

  current(): T | undefined {
    return this.visible()[this.selected]
  }

  handle(event: KeyEvent | PasteEvent): boolean {
    if (
      event.type === 'key' &&
      (event.name === 'up' ||
        event.name === 'down' ||
        event.name === 'pageup' ||
        event.name === 'pagedown')
    ) {
      const count = this.visible().length
      const step =
        event.name === 'up' ? -1 : event.name === 'down' ? 1 : event.name === 'pageup' ? -10 : 10
      this.selected = Math.max(0, Math.min(count - 1, this.selected + step))
      return true
    }
    if (this.filter.handle(event)) {
      this.selected = 0
      this.scroll = 0
      return true
    }
    return false
  }
}
