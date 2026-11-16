"use client";
import * as React from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, FileUp } from "lucide-react";
import { endpoints, type ImportPlanBody, type ImportPreview, type ImportResult, type ImportUpload } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import { Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { browserApi, errorMessage } from "@/lib/client-api";
import type { ApiError } from "@crm/api-client";

type Step = 1 | 2 | 3 | 4;
type Dup = "skip" | "update" | "create";
const STEPS = ["Upload file", "Match columns", "Review", "Done"];
const TEMPLATE = "Name,Email,Phone,Company,Lifecycle stage,Owner email,Tags\nAna Costa,ana@example.com,+1 555 010 0000,Acme,New,,vip; lead\n";
const DUP_LABEL: Record<Dup, string> = { skip: "Skip them", update: "Update the existing contact", create: "Import them anyway" };

const IMPORT_MESSAGES: Record<string, string> = {
  too_large: "That file is too large. Split it into files up to 5 MB and 5,000 rows.",
  rate_limited: "You started too many imports. Wait a few minutes and try again.",
  import_expired: "This upload expired. Nothing was imported. Upload it again.",
  already_committed: "This import has already been completed. Check your contacts, or upload another file.",
  import_busy: "Another import is running in this workspace. Wait a moment, then try again.",
};
const STATUS_CODE: Record<number, string> = { 413: "too_large", 429: "rate_limited" };
/** Import-specific wording; unknown codes fall back to the shared messages. */
function importError(e: ApiError): { message: string; restart: boolean } {
  const code = e.kind === "http" ? (IMPORT_MESSAGES[e.code] ? e.code : STATUS_CODE[e.status] ?? e.code) : e.code;
  return { message: IMPORT_MESSAGES[code] ?? errorMessage(e), restart: code === "import_expired" || code === "already_committed" };
}
const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

export function ImportWizard({ workspaceId }: { workspaceId: string }) {
  const [step, setStep] = React.useState<Step>(1);
  const [upload, setUpload] = React.useState<ImportUpload | null>(null);
  const [mapping, setMapping] = React.useState<(string | null)[]>([]);
  const [onDuplicate, setOnDuplicate] = React.useState<Dup>("skip");
  const [rowDecisions, setRowDecisions] = React.useState<Record<string, Dup>>({});
  const [skipInvalid, setSkipInvalid] = React.useState(false);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; restart: boolean } | null>(null);
  const [previewKey, setPreviewKey] = React.useState<string | null>(null);
  const previewSeq = React.useRef(0);
  const invalidAtStep = React.useRef(0);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const p = { workspaceId };

  // With problem rows the error summary is what the user needs to hear first.
  React.useEffect(() => { (step === 3 && invalidAtStep.current > 0 ? summaryRef : headingRef).current?.focus(); }, [step]);

  const plan = (extra: Partial<ImportPlanBody> = {}): ImportPlanBody => ({ mapping: mapping as ImportPlanBody["mapping"], onDuplicate, rowDecisions: Object.keys(rowDecisions).length ? rowDecisions : undefined, skipInvalid, ...extra });

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 5 * 1024 * 1024) return setError({ message: IMPORT_MESSAGES.too_large!, restart: false });
    setBusy(true);
    const csv = await file.text();
    const r = await browserApi.call(endpoints.uploadImport, { params: p, body: { filename: file.name, csv } });
    setBusy(false);
    if (!r.ok) return setError(importError(r.error));
    setUpload(r.data); setMapping(r.data.suggestedMapping); setStep(2);
  }

  async function runPreview(body: ImportPlanBody) {
    if (!upload) return;
    const mine = ++previewSeq.current;
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.previewImport, { params: { ...p, importId: upload.id }, body });
    if (mine !== previewSeq.current) return; // a newer preview owns the screen
    setBusy(false);
    if (!r.ok) return setError(importError(r.error));
    invalidAtStep.current = r.data.invalid;
    setPreview(r.data); setPreviewKey(JSON.stringify(body)); setStep(3);
  }

  async function commit() {
    if (!upload) return;
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.commitImport, { params: { ...p, importId: upload.id }, body: plan() });
    setBusy(false);
    if (!r.ok) { setError(importError(r.error)); return; }
    setResult(r.data); setStep(4);
  }

  const mappedFields = new Set(mapping.filter(Boolean));
  const hasIdentity = ["name", "first_name", "last_name", "email", "phone"].some((f) => mappedFields.has(f));
  const importCount = preview ? preview.willCreate + preview.willUpdate : 0;
  const blocked = !!preview && preview.invalid > 0 && !skipInvalid;
  const stale = !!preview && previewKey !== JSON.stringify(plan()); // the shown preview is not the plan that would be committed
  const startOver = () => { setUpload(null); setPreview(null); setPreviewKey(null); setResult(null); setRowDecisions({}); setOnDuplicate("skip"); setSkipInvalid(false); setError(null); setStep(1); };
  const download = () => {
    if (!preview) return;
    const csv = ["Row,Problems", ...preview.errors.map((e) => `${e.row + 1},${csvCell(e.messages.join("; "))}`)].join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "problem-rows.csv"; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="grid max-w-4xl gap-4">
      <nav aria-label="Import steps">
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={step === i + 1 ? "step" : undefined} className={step === i + 1 ? "font-semibold text-fg" : i + 1 < step ? "text-fg-muted" : "text-fg-subtle"}>
              <span className="tnum">{i + 1}.</span> {s}
            </li>
          ))}
        </ol>
      </nav>
      {error && <Alert tone="error">{error.message}{error.restart && <> <Button variant="secondary" size="sm" onClick={startOver}>Upload a new file</Button></>}</Alert>}

      {step === 1 && (
        <Panel className="p-6">
          <h2 ref={headingRef} tabIndex={-1} className="text-md font-semibold text-fg outline-none">Choose a CSV file</h2>
          <p className="mt-1 text-sm text-fg-muted">Up to 5,000 rows and 5 MB, with column names in the first row.</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control bg-accent px-3 text-base font-medium text-on-accent hover:bg-accent-hover pointer-coarse:h-11 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus">
              <FileUp className="size-4" aria-hidden />
              {busy ? "Reading file…" : "Choose file"}
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onFile(f); }} aria-label="CSV file" />
            </label>
            <Button asChild variant="ghost"><a download="contacts-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}>Download a template</a></Button>
          </div>
          <p className="mt-4 text-sm text-fg-subtle">Nothing is saved until the last step.</p>
        </Panel>
      )}

      {step === 2 && upload && (
        <Panel>
          <div className="border-b border-line px-4 py-3">
            <h2 ref={headingRef} tabIndex={-1} className="text-md font-semibold text-fg outline-none">Match columns</h2>
            <p className="mt-0.5 text-sm text-fg-muted">{upload.rowCount.toLocaleString("en-US")} rows found. We matched what we could; check each column.</p>
          </div>
          <Table>
            <THead><tr><TH>Column in your file</TH><TH>Examples</TH><TH>Import as</TH></tr></THead>
            <TBody>
              {upload.headers.map((h, i) => (
                <TR key={`${h}-${i}`}>
                  <TD className="font-medium">{h || <span className="text-fg-subtle">(no heading)</span>}</TD>
                  <TD className="max-w-56 truncate text-fg-muted">{upload.sample.map((r) => r[i]).filter(Boolean).slice(0, 3).join(" · ") || "—"}</TD>
                  <TD>
                    <Select aria-label={`Import column ${h || i + 1} as`} value={mapping[i] ?? ""} onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? e.target.value || null : m)))}>
                      <option value="">Don’t import</option>
                      {upload.fields.map((f) => <option key={f.id} value={f.id} disabled={mappedFields.has(f.id) && mapping[i] !== f.id}>{f.label}</option>)}
                    </Select>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-4">
            <p className="text-sm text-fg-muted">{hasIdentity ? "Ready to check your data." : "Match at least a name, email or phone column to continue."}</p>
            <div className="flex gap-2"><Button variant="ghost" onClick={startOver}>Choose another file</Button><Button variant="primary" disabled={!hasIdentity} loading={busy} onClick={() => { setOnDuplicate("skip"); setRowDecisions({}); setSkipInvalid(false); void runPreview(plan({ onDuplicate: "skip", rowDecisions: undefined, skipInvalid: false })); }}>Check my data</Button></div>
          </div>
        </Panel>
      )}

      {step === 3 && upload && preview && (
        <>
          <Panel className="p-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-md font-semibold text-fg outline-none">Review before importing</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[["Rows in file", preview.total], ["Will be added", preview.willCreate], ["Will update existing", preview.willUpdate], ["Skipped", preview.willSkip + preview.invalid]].map(([k, v]) => (
                <div key={String(k)}><dt className="text-xs text-fg-muted">{k}</dt><dd className="tnum text-lg font-semibold text-fg">{(v as number).toLocaleString("en-US")}</dd></div>
              ))}
            </dl>
          </Panel>

          {preview.invalid > 0 && (
            <div ref={summaryRef} role="alert" tabIndex={-1} className="rounded-card border border-line bg-danger-bg p-4 text-danger-fg">
              <h3 className="flex items-center gap-2 text-base font-semibold"><AlertCircle className="size-4" aria-hidden />{preview.invalid} {preview.invalid === 1 ? "row has" : "rows have"} problems</h3>
              <ul className="mt-2 max-h-56 overflow-y-auto text-sm">
                {preview.errors.map((e) => <li key={e.row}><span className="font-medium">Row {e.row + 1}:</span> {e.messages.join("; ")}</li>)}
              </ul>
              {preview.truncated && <p className="mt-1 text-sm">Only the first 100 are listed.</p>}
              <div className="mt-3 text-fg"><Checkbox label={`Skip the ${preview.invalid} problem ${preview.invalid === 1 ? "row" : "rows"} and import the rest`} checked={skipInvalid} disabled={busy} onChange={(e) => { setSkipInvalid(e.target.checked); void runPreview(plan({ skipInvalid: e.target.checked })); }} /></div>
              <Button variant="secondary" size="sm" className="mt-3" onClick={download}>Download problem rows</Button>
              <p className="mt-1 text-xs">Row numbers count the heading row as row 1, like a spreadsheet.</p>
            </div>
          )}

          {preview.duplicates.length > 0 && (
            <Panel>
              <div className="border-b border-line px-4 py-3">
                <h3 className="text-base font-semibold text-fg">{preview.duplicates.length}{preview.truncated ? "+" : ""} possible {preview.duplicates.length === 1 ? "duplicate" : "duplicates"}</h3>
                <fieldset className="mt-2">
                  <legend className="text-sm text-fg-muted">For rows that match a contact you already have, or repeat an earlier row:</legend>
                  <div className="mt-1 flex flex-wrap gap-x-4">
                    {(Object.keys(DUP_LABEL) as Dup[]).map((d) => (
                      <label key={d} className="inline-flex min-h-6 cursor-pointer items-center gap-2 text-base pointer-coarse:min-h-11">
                        <input type="radio" name="dup" disabled={busy} checked={onDuplicate === d} onChange={() => { setOnDuplicate(d); setRowDecisions({}); void runPreview(plan({ onDuplicate: d, rowDecisions: undefined })); }} />{DUP_LABEL[d]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <Table>
                <THead><tr><TH>Row</TH><TH>Matches</TH><TH>Decision</TH></tr></THead>
                <TBody>
                  {preview.duplicates.map((d) => (
                    <TR key={d.row}>
                      <TD className="tnum">{d.row + 1}</TD>
                      <TD>{d.existing ? <>Existing contact <Link className="font-medium text-accent-fg underline underline-offset-2" href={`/w/${workspaceId}/contacts/${d.existing.id}`} target="_blank">{d.existing.name}</Link> (same {d.matchedOn})</> : <>Row {d.duplicateOfRow! + 1} in this file (same {d.matchedOn})</>}</TD>
                      <TD>
                        <Select aria-label={`Decision for row ${d.row + 1}`} disabled={busy} value={rowDecisions[String(d.row)] ?? d.action} onChange={(e) => { const next = { ...rowDecisions, [String(d.row)]: e.target.value as Dup }; setRowDecisions(next); void runPreview(plan({ rowDecisions: next })); }}>
                          {(Object.keys(DUP_LABEL) as Dup[]).map((o) => <option key={o} value={o}>{DUP_LABEL[o]}</option>)}
                        </Select>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Panel>
          )}

          {!!preview.warnings?.length && (
            <Panel className="p-4">
              <h3 className="text-base font-semibold text-fg">{preview.warnings.length}{preview.truncated ? "+" : ""} {preview.warnings.length === 1 ? "row" : "rows"} will be skipped</h3>
              <p className="mt-0.5 text-sm text-fg-muted">These rows cannot be imported with the choices above.</p>
              <ul className="mt-2 max-h-56 overflow-y-auto text-sm">
                {preview.warnings.map((w) => <li key={w.row}><span className="font-medium">Row {w.row + 1}:</span> {w.message}</li>)}
              </ul>
            </Panel>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}>Back to columns</Button>
            <div className="flex items-center gap-3">
              {blocked && <span className="text-sm text-fg-muted">Fix the file or choose to skip the problem rows.</span>}
              {stale && !busy && <Button variant="secondary" onClick={() => void runPreview(plan())}>Refresh preview</Button>}
              <Button variant="primary" loading={busy} disabled={blocked || stale || importCount === 0} onClick={() => void commit()}>
                {importCount === 0 ? "Nothing to import" : `Import ${importCount.toLocaleString("en-US")} ${importCount === 1 ? "contact" : "contacts"}`}
              </Button>
            </div>
          </div>
        </>
      )}

      {step === 4 && result && (
        <Panel className="p-6" role="status">
          <CheckCircle2 className="mb-2 size-5 text-success-fg" aria-hidden />
          <h2 ref={headingRef} tabIndex={-1} className="text-md font-semibold text-fg outline-none">Import complete</h2>
          <p className="mt-1 text-sm text-fg-muted">{result.created} added · {result.updated} updated · {result.skipped} skipped.</p>
          <div className="mt-4 flex gap-2"><Button asChild variant="primary"><Link href={`/w/${workspaceId}/contacts`}>View contacts</Link></Button><Button variant="ghost" onClick={startOver}>Import another file</Button></div>
        </Panel>
      )}
    </div>
  );
}
