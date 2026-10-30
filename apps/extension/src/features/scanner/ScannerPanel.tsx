import { ListFilter, Search, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAssistant } from '../assistant/use-assistant'
import { workflowError } from '../assistant/workflow-errors'
import type { ScanField } from './scanner.types'
import { FillPreview } from '../filling/FillPreview'

const reasonLabels = { disabled: 'Disabled', 'read-only': 'Read only', consent: 'Consent · manual only', 'uncertain-label': 'Uncertain label · manual review', limit: 'Options truncated · manual review', 'no-enabled-options': 'No enabled options · manual only' }
function FieldInventory({ field }: { field: ScanField }) {
  return <li className="space-y-2 py-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">{field.label}</h4><Badge variant={field.eligible ? 'secondary' : 'outline'}>{field.eligible ? 'Eligible metadata' : 'Excluded'}</Badge></div>
    <p className="text-xs text-muted-foreground">{field.fieldType}{field.required ? ' · Required' : ' · Optional'} · Visible · {field.enabled ? 'Enabled' : 'Disabled'}</p>
    {field.exclusionReasons.length > 0 && <p className="text-xs leading-5 text-amber-900">{field.exclusionReasons.map((reason) => reasonLabels[reason]).join(' · ')}</p>}
    {field.labelUncertain && <p className="text-xs text-muted-foreground">Label fallback: {field.labelSource}. Confirm the meaning manually.</p>}
    {field.options.length > 0 && <ul aria-label={`Options for ${field.label}`} className="space-y-1 pl-3 text-xs text-muted-foreground">{field.options.map((option) => <li key={option.optionId} className="break-words [overflow-wrap:anywhere]">{option.label}{option.disabled ? ' · Disabled' : ''}</li>)}</ul>}
    <dl className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{Object.entries(field.constraints).map(([key, value]) => <div key={key}><dt className="inline">{key}: </dt><dd className="inline">{String(value)}</dd></div>)}</dl>
    <details className="text-[10px] text-muted-foreground"><summary className="cursor-pointer">Opaque identifier</summary><code className="break-all">{field.fieldId}</code></details>
  </li>
}
export function ScannerPanel() {
  const { state: workflow, controller } = useAssistant()
  const inventory = workflow.scan?.inventory
  const state = { stage: workflow.staleReason ? 'stale' : workflow.stage === 'scanning' ? 'loading' : workflow.stage === 'error' && !inventory ? 'error' : !inventory ? 'idle' : inventory.forms.some(form => form.fields.length) ? 'ready' : 'empty', message: workflow.staleReason ? 'This scan or session changed. Inspect again before continuing. Previous approvals cannot be reused.' : workflow.error ? workflowError(workflow.error) : '' }
  const fields = inventory?.forms.flatMap((form) => form.fields) ?? []
  return <section aria-label="Read-only form scanner" className="space-y-4 rounded-2xl border border-emerald-950/15 bg-white/95 shadow-sm p-4">
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-lg bg-emerald-950/10 text-emerald-900">
        <ListFilter aria-hidden="true" className="size-4" />
      </div>
      <h2 className="text-sm font-semibold text-emerald-950">Inspect a real form</h2>
      <Badge variant="outline" className="ml-auto bg-emerald-950/5 border-emerald-950/15 text-emerald-900 text-[10px]">Read only</Badge>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">Inspection starts a temporary conversation. Click Piko’s toolbar icon on the target tab first. Inspection reads labels, types, options, and constraints. Existing answers are never collected.</p>
    <Button variant="outline" className="min-h-11 w-full bg-emerald-900 hover:bg-emerald-800 text-white font-medium rounded-xl shadow-xs transition-all flex items-center justify-center gap-2" disabled={state.stage === 'loading' || workflow.stage === 'filling'} onClick={() => void controller.scan()}><Search aria-hidden="true" className="size-4" />{state.stage === 'loading' ? 'Inspecting…' : state.stage === 'idle' ? 'Inspect this page' : 'Inspect again'}</Button>
    {workflow.scan && <p role="status" className="text-xs font-medium text-emerald-900 bg-emerald-50 px-2.5 py-1.5 rounded-lg border border-emerald-950/10">Live workflow: {workflow.stage} · Questions → Review → Exact approval → Verified results</p>}
    {state.stage === 'loading' && <div role="status" aria-label="Scanning page" aria-busy="true" className="space-y-2"><p className="text-xs">Reading field metadata…</p><Skeleton className="h-16 w-full motion-reduce:animate-none" /></div>}
    {state.stage === 'idle' && <p className="text-[11px] text-muted-foreground">No page inspected. Scanning begins only when you click.</p>}
    {(state.stage === 'stale' || state.stage === 'error') && <Alert role={state.stage === 'stale' ? 'status' : 'alert'} variant={state.stage === 'error' ? 'destructive' : 'default'}><TriangleAlert aria-hidden="true" className="size-4" /><AlertTitle>{state.stage === 'stale' ? 'Scan is stale' : 'Page could not be inspected'}</AlertTitle><AlertDescription className="text-xs leading-5">{state.message}</AlertDescription></Alert>}
    {inventory && <>
      <div className="space-y-1"><p className="break-all text-xs font-medium">{inventory.origin}</p><p role="status" className="text-xs text-muted-foreground">{fields.length} supported fields · {fields.filter((field) => field.eligible).length} eligible · {inventory.forms.length} {inventory.forms.length === 1 ? 'form' : 'forms'}</p></div>
      {state.stage === 'empty' && <p className="text-sm">No supported visible fields were found. The page may use unsupported widgets or excluded controls.</p>}
      {Object.values(inventory.exclusions).some(Boolean) && <div className="space-y-1 rounded-lg bg-muted p-3 text-xs"><h3 className="font-medium">Exclusions and manual-only fields</h3>{Object.entries(inventory.exclusions).filter(([, count]) => count > 0).map(([reason, count]) => <p key={reason}>{reason}: {count}</p>)}<p className="pt-1 leading-5 text-muted-foreground">Sensitive and hidden controls are counted without labels or values. Exclusion counts may overlap.</p></div>}
      {inventory.truncated && <p role="alert" className="text-xs text-amber-900">The metadata limit was reached. This is a partial inventory.</p>}
      <div className={state.stage === 'stale' ? 'opacity-60' : ''}>{inventory.forms.map((form) => <section aria-label={form.label} key={form.formId} className="mt-4"><h3 className="border-b pb-2 text-xs font-semibold">{form.label}</h3><ul className="divide-y">{form.fields.map((field) => <FieldInventory key={field.fieldId} field={field} />)}</ul></section>)}</div>
      <p className="text-[11px] leading-5 text-muted-foreground">Top frame and standard light-DOM controls only. Visibility is approximate. Custom widgets, shadow DOM, and iframe contents are not scanned. Inspection makes no changes.</p>
      {workflow.scan && <FillPreview state={workflow} controller={controller} />}
    </>}
    {workflow.session && <div aria-label="Temporary session memory" className="space-y-2 border-t pt-3 text-xs"><p>{workflow.session.facts.length} confirmed facts · This origin only · Expires {new Date(workflow.session.expiresAt).toLocaleTimeString()}</p><p>Transcripts, recordings and unapproved proposals stay in memory. Only answers you separately opt to remember are kept for this browser session, for at most 30 minutes.</p>{workflow.session.facts.length > 0 && <details><summary className="cursor-pointer">Remembered answers for this session</summary><ul className="mt-2 space-y-1">{workflow.session.facts.map(fact => <li key={fact.factId}>{fact.key.replace(/_/g, ' ')}: {fact.value}</li>)}</ul></details>}</div>}
    <Button variant="ghost" className="min-h-9 w-full" disabled={workflow.stage === 'filling'} onClick={() => void controller.clearSession()}>Clear session</Button>
    {state.stage !== 'idle' && <Button variant="ghost" className="min-h-9 w-full" disabled={workflow.stage === 'filling'} onClick={() => controller.clearScan()}>Clear scan</Button>}
  </section>
}
