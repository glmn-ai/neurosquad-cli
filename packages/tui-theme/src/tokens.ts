/**
 * The NeuroSquad desktop palette, as source values.
 *
 * Copied from the desktop app's dark theme (it is always dark): HeroUI v3's default dark tokens
 * (`--background`, `--surface`, `--accent`, …), the terminal theme of its agent cards, the canvas
 * edge accent and the brand gradient of the `>S` mark. Keep the OKLCH numbers as written there, so
 * a change on one side is a one-line diff on the other.
 */
import { hex, oklch, over, type Ansi16, type Rgb } from './color.js'

export interface Token extends Rgb {
  /** Where the value comes from (desktop CSS variable or constant). */
  readonly source: string
  /** The ANSI colour that carries the same meaning on a 16-colour terminal (-1 = terminal default). */
  readonly ansi16?: Ansi16
}

const t = (rgb: Rgb, source: string, ansi16?: Ansi16): Token => ({ ...rgb, source, ansi16 })

/** HeroUI v3 dark theme (`[data-theme="dark"]`), as the desktop renders it. */
export const HEROUI_DARK = {
  background: t(oklch(0.12, 0.005, 285.823), '--background', -1),
  foreground: t(oklch(0.9911, 0, 0), '--foreground (--snow)', -1),
  surface: t(oklch(0.2103, 0.0059, 285.89), '--surface', -1),
  surfaceSecondary: t(oklch(0.257, 0.0037, 286.14), '--surface-secondary', 0),
  surfaceTertiary: t(oklch(0.2721, 0.0024, 247.91), '--surface-tertiary', 0),
  muted: t(oklch(0.705, 0.015, 286.067), '--muted', 8),
  default: t(oklch(0.274, 0.006, 286.033), '--default', 0),
  accent: t(oklch(0.6204, 0.195, 253.83), '--accent', 12),
  accentForeground: t(oklch(0.9911, 0, 0), '--accent-foreground', 15),
  success: t(oklch(0.7329, 0.1935, 150.81), '--success', 10),
  warning: t(oklch(0.8203, 0.1388, 76.34), '--warning', 11),
  warningForeground: t(oklch(0.2103, 0.0059, 285.89), '--warning-foreground (--eclipse)', 0),
  danger: t(oklch(0.594, 0.1967, 24.63), '--danger', 9),
  border: t(oklch(0.28, 0.006, 286.033), '--border', 8),
  separator: t(oklch(0.25, 0.006, 286.033), '--separator', 8),
  segment: t(oklch(0.3964, 0.01, 285.93), '--segment', 8)
} as const

/** The agent cards' xterm theme (desktop `TERMINAL_THEME`, `lib/terminalOptions.ts`). */
export const TERMINAL_THEME = {
  background: t(oklch(0.155, 0.005, 285.8), 'TERMINAL_THEME.background', -1),
  foreground: t(oklch(0.93, 0.004, 286), 'TERMINAL_THEME.foreground', -1),
  cursor: t(oklch(0.72, 0.16, 253.83), 'TERMINAL_THEME.cursor', 12),
  black: t(oklch(0.3, 0.006, 286), 'TERMINAL_THEME.black', 0),
  red: t(oklch(0.68, 0.18, 24), 'TERMINAL_THEME.red', 1),
  green: t(oklch(0.7329, 0.1935, 150.81), 'TERMINAL_THEME.green', 2),
  yellow: t(oklch(0.84, 0.14, 80), 'TERMINAL_THEME.yellow', 3),
  blue: t(oklch(0.7, 0.15, 253.83), 'TERMINAL_THEME.blue', 4),
  magenta: t(oklch(0.72, 0.17, 320), 'TERMINAL_THEME.magenta', 5),
  cyan: t(oklch(0.78, 0.11, 210), 'TERMINAL_THEME.cyan', 6),
  white: t(oklch(0.87, 0.004, 286), 'TERMINAL_THEME.white', 7),
  brightBlack: t(oklch(0.66, 0.012, 286), 'TERMINAL_THEME.brightBlack', 8),
  brightRed: t(oklch(0.76, 0.15, 24), 'TERMINAL_THEME.brightRed', 9),
  brightGreen: t(oklch(0.82, 0.17, 150.81), 'TERMINAL_THEME.brightGreen', 10),
  brightYellow: t(oklch(0.9, 0.12, 85), 'TERMINAL_THEME.brightYellow', 11),
  brightBlue: t(oklch(0.79, 0.12, 253.83), 'TERMINAL_THEME.brightBlue', 12),
  brightMagenta: t(oklch(0.8, 0.14, 320), 'TERMINAL_THEME.brightMagenta', 13),
  brightCyan: t(oklch(0.86, 0.09, 210), 'TERMINAL_THEME.brightCyan', 14),
  brightWhite: t(oklch(0.985, 0, 0), 'TERMINAL_THEME.brightWhite', 15)
} as const

/** Canvas arrows and selection (desktop `EDGE_ACCENT`, same value as `--accent`). */
export const EDGE_ACCENT = t(oklch(0.6204, 0.195, 253.83), 'EDGE_ACCENT', 12)

/** The `>S` mark's gradient (desktop `components/Logo.tsx`): lime → emerald. A fixed brand value. */
export const BRAND = {
  lime: t(hex('#a3e635'), 'brand lime #a3e635', 10),
  emerald: t(hex('#10b981'), 'brand emerald #10b981', 2)
} as const

export const BRAND_GRADIENT: readonly Rgb[] = [BRAND.lime, BRAND.emerald]

/**
 * Semantic roles a TUI paints with. Derived from the tokens above the way the desktop composes
 * them (e.g. the selection is the accent at 38 % over the terminal background, like
 * `TERMINAL_THEME.selectionBackground`).
 */
export const ROLE_SOURCES = {
  /** Behind everything (title bar, gutters). */
  appBg: HEROUI_DARK.background,
  /** The left sidebar (workspaces → agents). */
  sidebarBg: t(
    over(HEROUI_DARK.surface, HEROUI_DARK.background, 0.55),
    'sidebar: --surface 55% over --background',
    -1
  ),
  /** A terminal tile's body — the agent cards' terminal background. */
  tileBg: TERMINAL_THEME.background,
  /** Header / status line strip. */
  headerBg: HEROUI_DARK.surface,
  /** Key hints, chips. */
  chipBg: HEROUI_DARK.surfaceSecondary,
  text: HEROUI_DARK.foreground,
  /** Terminal-like body text (slightly softer than `text`). */
  bodyText: TERMINAL_THEME.foreground,
  mutedText: HEROUI_DARK.muted,
  /** Exited agents, disabled hints: the desktop uses the foreground at 22 %; 32 % here so it stays legible on a terminal. */
  faintText: t(
    over(HEROUI_DARK.foreground, HEROUI_DARK.background, 0.32),
    '--foreground 32% over --background',
    8
  ),
  border: t(
    over(HEROUI_DARK.foreground, HEROUI_DARK.background, 0.2),
    'tile border (brighter than --border so it reads on a terminal)',
    8
  ),
  separator: HEROUI_DARK.separator,
  focusBorder: EDGE_ACCENT,
  accent: HEROUI_DARK.accent,
  accentText: TERMINAL_THEME.brightBlue,
  accentFg: HEROUI_DARK.accentForeground,
  selectionBg: t(
    over(EDGE_ACCENT, TERMINAL_THEME.background, 0.38),
    'TERMINAL_THEME.selectionBackground (accent 38%)',
    4
  ),
  selectionFg: HEROUI_DARK.foreground,
  success: HEROUI_DARK.success,
  warning: HEROUI_DARK.warning,
  warningFg: HEROUI_DARK.warningForeground,
  danger: HEROUI_DARK.danger,
  /** "Needs you" — the warning colour, plus a brighter peak for its pulse. */
  needsYou: HEROUI_DARK.warning,
  needsYouGlow: t(
    over(hex('#fff4d6'), HEROUI_DARK.warning, 0.55),
    'needs-you pulse peak (warning lifted toward white)',
    11
  ),
  needsYouDim: t(
    over(HEROUI_DARK.warning, TERMINAL_THEME.background, 0.45),
    'needs-you pulse trough (warning 45%)',
    3
  ),
  brandLime: BRAND.lime,
  brandEmerald: BRAND.emerald
} as const

export type Role = keyof typeof ROLE_SOURCES
