/** Single source of truth for the design system (docs/design/design-system.md). CSS and native outputs are generated from this. */
export const primitive = {
  neutral: { 0: "#FFFFFF", 25: "#FAFAFB", 50: "#F6F7F9", 100: "#EEF0F3", 200: "#E3E6EB", 300: "#CBD0D9", 400: "#9AA1AE", 500: "#596070", 600: "#454B58", 700: "#343944", 800: "#23272F", 900: "#16181D" },
  accent: { 50: "#F1F2FF", 100: "#E4E6FF", 200: "#CFD2FE", 300: "#AAB0FB", 400: "#8087F5", 500: "#6269EF", 600: "#4F46E5", 700: "#4239C9", 800: "#3730A3" },
  success: { 50: "#EAF6EF", 600: "#1B7A47", 700: "#14633A" },
  warning: { 50: "#FFF5DB", 600: "#8F5A00", 700: "#6F4500" },
  danger: { 50: "#FDECEA", 600: "#C0362C", 700: "#9F2B22" },
  dark: { canvas: "#0F1115", surface: "#171A20", raised: "#1E222A", line: "#2A2F39", text: "#ECEEF2", muted: "#A4ABB8", accent: "#A5AAFA", accentBg: "#2A2D5C" },
} as const;

const p = primitive;

export const semantic = {
  light: {
    "bg-canvas": p.neutral[50],
    "bg-surface": p.neutral[0],
    "bg-subtle": p.neutral[25],
    "bg-hover": p.neutral[100],
    "bg-selected": p.accent[50],
    "line": p.neutral[200],
    "line-strong": p.neutral[300],
    "fg": p.neutral[900],
    "fg-muted": p.neutral[600],
    "fg-subtle": p.neutral[500],
    "fg-disabled": p.neutral[400],
    "accent": p.accent[600],
    "accent-hover": p.accent[700],
    "accent-subtle": p.accent[50],
    "accent-fg": p.accent[700],
    "on-accent": p.neutral[0],
    "focus": p.accent[500],
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

export type SemanticName = keyof (typeof semantic)["light"];

export const type = { "2xs": 11, xs: 12, sm: 13, base: 14, md: 16, lg: 20, xl: 24, "2xl": 28 } as const;
/** 4px base scale */
export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;
export const radius = { sm: 4, md: 6, lg: 8, xl: 12 } as const;
export const layout = { sidebar: 248, sidebarRail: 56, topbar: 52, contentMax: 1120 } as const;
export const shadow = { popover: "0 8px 24px rgb(22 24 29 / 0.10), 0 1px 3px rgb(22 24 29 / 0.06)" } as const;
