/** `{{name}}` placeholders, names are [a-z][a-z0-9_]*. One pass over the template: substituted values are never re-scanned (no recursion, no eval, no expressions). */
export class TemplateError extends Error {
  constructor(readonly kind: "missing_variable" | "unknown_variable" | "invalid_template", readonly variable?: string) {
    super(`template ${kind}${variable ? `: ${variable}` : ""}`);
    this.name = "TemplateError";
  }
}
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;

export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    if (!NAME.test(m[1]!)) throw new TemplateError("invalid_template", m[1]!.slice(0, 40));
    names.add(m[1]!);
  }
  return [...names];
}

/** A variable used in the template but not supplied is an error (never an empty string). Extra supplied variables are ignored. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  templateVariables(template);
  return template.replace(TOKEN, (_m, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new TemplateError("missing_variable", name);
    return vars[name]!;
  });
}

/** Save-time check: the template may only use the variables its capability provides. */
export function checkTemplate(template: string, allowed: readonly string[]): void {
  for (const v of templateVariables(template)) if (!allowed.includes(v)) throw new TemplateError("unknown_variable", v);
}
