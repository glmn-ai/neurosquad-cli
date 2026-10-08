// libuiohook virtual key codes (the values `uiohook-napi` reports as
// `event.keycode`), kept here so accelerators can be parsed without loading
// the native hook.

const BASE: Record<string, number> = {
  Space: 0x0039,
  Return: 0x001c,
  Enter: 0x001c,
  Esc: 0x0001,
  Escape: 0x0001,
  Tab: 0x000f,
  Backspace: 0x000e,
  Delete: 0x0e53,
  Insert: 0x0e52,
  Home: 0x0e47,
  End: 0x0e4f,
  PageUp: 0x0e49,
  PageDown: 0x0e51,
  Up: 0xe048,
  Down: 0xe050,
  Left: 0xe04b,
  Right: 0xe04d,
  ',': 0x0033,
  '.': 0x0034,
  '/': 0x0035,
  '\\': 0x002b,
  ';': 0x0027,
  "'": 0x0028,
  '[': 0x001a,
  ']': 0x001b,
  '-': 0x000c,
  '=': 0x000d,
  '`': 0x0029,
  Capslock: 0x003a,
  Numlock: 0x0045,
  Scrolllock: 0x0046,
  PrintScreen: 0x0e37,
  numadd: 0x004e,
  numsub: 0x004a,
  nummult: 0x0037,
  numdiv: 0x0e35,
  numdec: 0x0053
}

const LETTERS = 'QWERTYUIOP ASDFGHJKL ZXCVBNM'
const LETTER_ROW_START = [0x10, 0x1e, 0x2c]
const DIGITS = [0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a] // 0..9
const NUMPAD_DIGITS = [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49] // num0..num9
const FUNCTION_KEYS = [
  0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x5b, 0x5c, 0x5d, 0x63,
  0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b
] // F1..F24

/** Accelerator key name -> keycode. Names follow Electron's accelerator vocabulary. */
export const KEY_BY_NAME: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = { ...BASE }
  LETTERS.split(' ').forEach((row, rowIndex) => {
    for (let i = 0; i < row.length; i++) table[row[i]] = LETTER_ROW_START[rowIndex] + i
  })
  DIGITS.forEach((code, digit) => (table[String(digit)] = code))
  NUMPAD_DIGITS.forEach((code, digit) => (table[`num${digit}`] = code))
  FUNCTION_KEYS.forEach((code, index) => (table[`F${index + 1}`] = code))
  return table
})()

export type ModifierSlot = 'ctrl' | 'alt' | 'shift' | 'meta'

/** Raw modifier keycode (left and right) -> modifier slot. */
export const MODIFIER_SLOT_BY_KEYCODE: Readonly<Record<number, ModifierSlot>> = {
  0x001d: 'ctrl',
  0x0e1d: 'ctrl',
  0x0038: 'alt',
  0x0e38: 'alt',
  0x002a: 'shift',
  0x0036: 'shift',
  0x0e5b: 'meta',
  0x0e5c: 'meta'
}
