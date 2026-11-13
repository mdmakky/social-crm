/** Single source of truth for the design system (docs/design/design-system.md, docs/design/ux-track.md). CSS and native outputs are generated from this.
 *  Direction: "Soft Studio" (chosen by the product owner from docs/design/options, option D): lavender canvas, white surfaces, violet accent, Plus Jakarta Sans. */
export const primitive = {
  // Ink carries a faint violet cast so text and surfaces feel like one family.
  neutral: { 0: "#FFFFFF", 25: "#FAFAFB", 50: "#F7F7F9", 100: "#F0F0F4", 150: "#E6E6EC", 200: "#EFEFF3", 300: "#D2D2DB", 400: "#A0A0B0", 500: "#6A6A7C", 600: "#55556A", 700: "#3D3D52", 800: "#2A2A3C", 900: "#1E1D2B" },
  accent: { 50: "#F5F4FE", 100: "#EEEDFB", 200: "#D8D4F7", 300: "#B5AEF3", 400: "#8F85EE", 500: "#7468EA", 600: "#5B4BF0", 700: "#4637D6", 800: "#3629A8" },
  success: { 50: "#E4F1EA", 600: "#17603A", 700: "#17603A" },
  warning: { 50: "#F6EED6", 600: "#6B4E00", 700: "#6B4E00" },
  danger: { 50: "#F7E6E4", 600: "#C0362C", 700: "#9B2C1F" },
  dark: { canvas: "#0F1115", surface: "#171A20", raised: "#1E222A", line: "#2A2F39", text: "#ECEEF2", muted: "#A4ABB8", accent: "#A5AAFA", accentBg: "#2A2D5C" },
} as const;

const p = primitive;

/** Identity and status hues (avatars, lifecycle stages, tags, stage columns). Soft tint with dark readable ink of the same hue. 1 lilac, 2 mint, 3 butter, 4 peach, 5 sky, 6 rose. */
export const hues = {
  1: { bg: "#ECEAF8", fg: "#4B4199", dot: "#8379D6" },
  2: { bg: "#E4F1EA", fg: "#25593B", dot: "#4FA57A" },
  3: { bg: "#F6EED6", fg: "#6B5313", dot: "#C79A2B" },
  4: { bg: "#F8E8DE", fg: "#7C3F1C", dot: "#D98A5A" },
  5: { bg: "#E3EEF8", fg: "#264F7B", dot: "#5B97CF" },
  6: { bg: "#F7E6E4", fg: "#8A3328", dot: "#D4685C" },
} as const;
const darkHues = { 1: { bg: "#2A2D5C", fg: "#B9BDFB", dot: "#8F95F5" }, 2: { bg: "#10332F", fg: "#7AD9CC", dot: "#3CB8A8" }, 3: { bg: "#3A2B0A", fg: "#F0C36A", dot: "#E0A33A" }, 4: { bg: "#3D2414", fg: "#F2B08A", dot: "#E58A52" }, 5: { bg: "#10304A", fg: "#8CC8F0", dot: "#4FA6E0" }, 6: { bg: "#3D1822", fg: "#F2A0B2", dot: "#E56B85" } } as const;
const hueVars = (h: typeof hues | typeof darkHues) => Object.fromEntries(Object.entries(h).flatMap(([k, v]) => [[`hue-${k}-bg`, v.bg], [`hue-${k}-fg`, v.fg], [`hue-${k}-dot`, v.dot]])) as Record<string, string>;

export const semantic = {
  light: {
    "bg-canvas": p.neutral[50],
    "bg-surface": p.neutral[0],
    "bg-subtle": p.neutral[25],
    "bg-hover": p.neutral[100],
    "bg-selected": p.accent[50],
    "line": p.neutral[150],
    "line-strong": p.neutral[300],
    /** Role tokens: one value per UI role, so a single edit restyles every screen. */
    "line-control": p.neutral[150],
    "line-card": p.neutral[200],
    "bg-row-hover": p.neutral[25],
    "fg": p.neutral[900],
    "fg-muted": p.neutral[600],
    "fg-subtle": p.neutral[500],
    "fg-disabled": p.neutral[400],
    "accent": p.accent[600],
    "accent-hover": p.accent[700],
    "accent-subtle": p.accent[100],
    "accent-fg": p.accent[700],
    "on-accent": p.neutral[0],
    "focus": p.accent[600],
    "success-bg": p.success[50],
    "success-fg": p.success[700],
    "warning-bg": p.warning[50],
    "warning-fg": p.warning[700],
    "danger": p.danger[600],
    "danger-bg": p.danger[50],
    "danger-fg": p.danger[700],
  },
  dark: {
    "bg-canvas": p.dark.canvas,
    "bg-surface": p.dark.surface,
    "bg-subtle": p.dark.canvas,
    "bg-hover": p.dark.raised,
    "bg-selected": p.dark.accentBg,
    "line": p.dark.line,
    "line-strong": "#3A404C",
    "line-control": "#3A404C",
    "line-card": p.dark.line,
    "bg-row-hover": p.dark.raised,
    "fg": p.dark.text,
    "fg-muted": p.dark.muted,
    "fg-subtle": "#8E96A5",
    "fg-disabled": "#5F6674",
    "accent": "#4F46E5",
    "accent-hover": "#5B52EA",
    "accent-subtle": p.dark.accentBg,
    "accent-fg": p.dark.accent,
    "on-accent": "#FFFFFF",
    "focus": p.dark.accent,
    "success-bg": "#12301F",
    "success-fg": "#6FD39B",
    "warning-bg": "#3A2B0A",
    "warning-fg": "#F0C36A",
    "danger": "#E5655B",
    "danger-bg": "#3B1815",
    "danger-fg": "#F29A92",
  },
} as const;

export const hueVarsLight = hueVars(hues);
export const hueVarsDark = hueVars(darkHues);

export type SemanticName = keyof (typeof semantic)["light"];

/** Scale (px): 13 body, 22 page title. Calm and compact; colour is reserved for the primary action, links and the active icon. */
export const type = { "2xs": 11, xs: 12, sm: 12.5, base: 13, md: 16, lg: 17, xl: 22, "2xl": 26 } as const;
/** 4px base scale */
export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;
export const radius = { sm: 5, md: 8, lg: 12, xl: 16 } as const;
export const layout = { sidebar: 232, sidebarRail: 56, topbar: 52, contentMax: 1160 } as const;
export const shadow = {
  popover: "0 10px 28px rgb(30 29 43 / 0.12), 0 2px 6px rgb(30 29 43 / 0.07)",
  /** Primary surfaces (tables, panels, columns). */
  sheet: "0 1px 2px rgb(30 29 43 / 0.05), 0 0 0 1px rgb(30 29 43 / 0.04)",
  control: "0 1px 2px rgb(30 29 43 / 0.04)",
  lift: "0 14px 32px rgb(20 16 60 / 0.18), 0 2px 6px rgb(20 16 60 / 0.10)",
} as const;
/** One easing and three durations for the whole product. Reduced-motion collapses them in CSS. */
export const motion = { ease: "cubic-bezier(0.16, 1, 0.3, 1)", fast: "90ms", base: "150ms", slow: "240ms" } as const;

/** Role dimensions (px). Components read these via CSS variables; never hardcode a radius or control height. */
export const role = { "radius-control": radius.md, "radius-card": radius.lg, "radius-sheet": radius.xl, "control-h": 30, "control-h-touch": 44, "row-h": 40, "page-gutter": 24, "page-gap": 16 } as const;
