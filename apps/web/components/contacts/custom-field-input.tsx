"use client";
import type { CustomField } from "@crm/contracts";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";

/** One input per custom field type. Values are kept in their native JSON types so they match the API contract. */
export function CustomFieldInput({ def, value, onChange, error }: { def: CustomField; value: unknown; onChange: (v: unknown) => void; error?: string | null }) {
  const label = def.required ? `${def.label} (required)` : def.label;
  if (def.type === "boolean")
    return <Checkbox label={def.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  if (def.type === "multiselect") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium text-fg">{label}</legend>
        <div className="flex flex-wrap gap-x-4">
          {def.options.map((o) => (
            <Checkbox key={o} label={o} checked={selected.includes(o)} onChange={(e) => onChange(e.target.checked ? [...selected, o] : selected.filter((x) => x !== o))} />
          ))}
        </div>
        {error && <p role="alert" className="text-xs text-danger-fg">{error}</p>}
      </fieldset>
    );
  }
  return (
    <Field label={label} error={error}>
      {(p) =>
        def.type === "select" ? (
          <Select {...p} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">Not set</option>
            {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        ) : def.type === "number" ? (
          <Input {...p} type="number" inputMode="decimal" value={typeof value === "number" ? String(value) : ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
        ) : def.type === "date" ? (
          <Input {...p} type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />
        ) : def.type === "url" ? (
          <Input {...p} type="url" inputMode="url" placeholder="https://" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />
        ) : (
          <Input {...p} type="text" maxLength={500} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />
        )
      }
    </Field>
  );
}
