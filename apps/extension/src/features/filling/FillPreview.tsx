import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { WorkflowState } from '../assistant/workflow.types'
import type { AssistantOrchestrator } from '../assistant/assistant.orchestrator'
import { eligibleFields, emptyDraft, selectedItems, validDraft, unverifiedRequired } from '../assistant/conversation-selectors'
import { factValue } from '../assistant/session-facts.validation'
import { liveContext } from '../assistant/workflow-guards'
import { questionQueue } from '../assistant/question-queue'
import { FillResults } from './FillResults'
import { InterpretationPanel } from '../interpretation/InterpretationPanel'
import { workflowError } from '../assistant/workflow-errors'



export function FillPreview({ state, controller }: { state: WorkflowState; controller: AssistantOrchestrator }) {
  const scan = state.scan!
  const fields = eligibleFields(state), items = selectedItems(state), review = state.review
  const busy = state.stage === 'filling' || state.stage === 'approving'
  const active = liveContext(state)
  const invalid = fields.some(field => state.drafts[field.fieldId]?.selected && !validDraft(field, state.drafts[field.fieldId]))
  const unresolved = questionQueue(state)
  return <section aria-label="Manual form filling" className="space-y-3 border-t pt-4">
    <InterpretationPanel state={state} controller={controller} />
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-emerald-950">Prepare manual answers</h3>
      <p className="text-xs leading-5 text-muted-foreground">Edit proposals or enter answers manually, include specific fields, then review. Manual edits are protected from later model answers. Remembering answers is a separate choice at approval.</p>
    </div>
    {state.session?.facts.length ? <p className="text-xs font-medium text-emerald-900 bg-emerald-50 px-2.5 py-1.5 rounded-lg border border-emerald-950/10">{state.session.facts.length} confirmed session facts available. Reused values are unselected proposals.</p> : null}
    <fieldset disabled={!active || busy} className="min-w-0 space-y-3">{fields.map(field => {
      const draft = state.drafts[field.fieldId] ?? emptyDraft(), id = `proposal-${field.fieldId}`
      return <div key={field.fieldId} className="min-w-0 space-y-2.5 rounded-xl border border-emerald-950/15 bg-white p-3.5 text-xs shadow-2xs hover:border-emerald-950/25 transition-all">
        <label className="flex items-center gap-2 cursor-pointer font-medium text-emerald-950"><input type="checkbox" className="size-4 rounded accent-emerald-800" checked={draft.selected} onChange={event => controller.edit(field.fieldId, { selected: event.target.checked })} aria-label={`Include ${field.label}`} /><span className="break-words font-semibold text-sm">{field.label}</span></label>
        {draft.source === 'session' && <p className="text-[11px] text-emerald-800 font-medium">From confirmed session memory · Review before reuse</p>}
        {draft.protected && <p className="text-[11px] text-muted-foreground">Manual choice · Protected from model replacement</p>}
        <label htmlFor={id} className="block text-[11px] font-medium text-muted-foreground">Proposed value for {field.label} · {field.fieldType}</label>
        {['checkbox', 'select', 'radio'].includes(field.fieldType)
          ? <select id={id} className="min-h-10 w-full min-w-0 rounded-lg border border-emerald-950/20 bg-white p-2 text-sm focus-visible:outline-emerald-800" value={draft.text} onChange={event => controller.edit(field.fieldId, { text: event.target.value })}><option value="">Choose explicitly…</option>{field.fieldType === 'checkbox' ? <><option value="true">Checked</option><option value="false">Unchecked</option></> : field.options.map(option => <option key={option.optionId} value={option.optionId} disabled={option.disabled}>{option.label}</option>)}</select>
          : field.fieldType === 'textarea' ? <Textarea id={id} className="rounded-lg border-emerald-950/20 text-sm" value={draft.text} maxLength={1024} onChange={event => controller.edit(field.fieldId, { text: event.target.value })} /> : <Input id={id} type="text" autoComplete="off" className="min-h-10 rounded-lg border-emerald-950/20 text-sm bg-white" value={draft.text} maxLength={1024} onChange={event => controller.edit(field.fieldId, { text: event.target.value })} />}
        <label className="flex items-start gap-2 pt-1 text-muted-foreground cursor-pointer"><input type="checkbox" className="mt-0.5 size-3.5 rounded accent-emerald-800" checked={draft.overwrite} onChange={event => controller.edit(field.fieldId, { overwrite: event.target.checked })} aria-label={`Allow overwrite for ${field.label}`} /><span className="text-[11px] leading-tight">Separately allow replacing an existing answer for this field</span></label>
      </div>
    })}</fieldset>
    <Button variant="outline" className="min-h-11 w-full bg-emerald-900 hover:bg-emerald-800 text-white font-medium rounded-xl shadow-xs transition-all disabled:bg-muted disabled:text-muted-foreground" disabled={!active || busy || state.stage === 'interpreting' || !items.length || invalid} onClick={() => void controller.review()}>{busy ? 'Checking or filling…' : 'Review selected values'}</Button>
    {state.error && <><p role="alert" className="text-xs text-destructive font-medium">{workflowError(state.error)}</p>{active && <Button variant="outline" className="w-full text-xs" onClick={() => controller.recover()}>Continue with typed or manual answers</Button>}</>}
    {unresolved.length > 0 && <p className="text-xs text-amber-900 bg-amber-50 p-2.5 rounded-lg border border-amber-200">{unresolved.length} required or ambiguous fields remain unresolved, including skipped questions. You may review a partial batch or finish manually.</p>}
    {state.outcome && <FillResults outcome={state.outcome} inventory={scan.inventory} />}
    {state.stage === 'results' && <div className="space-y-2 bg-emerald-50/50 p-3 rounded-xl border border-emerald-950/10"><p className="text-xs leading-5 text-emerald-950">{unverifiedRequired(state).length} required fields have not been verified on this scan. Submission remains manual. Verified results apply to this scan only. New or changed fields require another inspection and approval.</p><Button variant="outline" className="w-full bg-white text-xs font-medium" disabled={!active} onClick={() => controller.collect()}>Continue conversation</Button></div>}
    {review && active && state.stage === 'review' && <section aria-label="Exact batch approval" className="space-y-3.5 rounded-2xl border-2 border-emerald-800/25 bg-white p-4 text-xs shadow-sm">
      <div className="flex items-center justify-between border-b pb-2">
        <h4 className="font-semibold text-emerald-950 text-sm">Review the exact destination and values</h4>
      </div>
      <p className="break-all text-[11px] text-muted-foreground">{scan.inventory.origin} · Tab {scan.tabId}</p>
      <ul className="space-y-2.5 divide-y divide-emerald-950/5">{review.items.map(item => {
        const form = scan.inventory.forms.find(form => form.fields.some(field => field.fieldId === item.fieldId))!, field = form.fields.find(field => field.fieldId === item.fieldId)!
        return <li key={item.fieldId} className="pt-2.5 first:pt-0"><p className="font-medium text-emerald-950">{form.label} / {field.label}</p><pre className="mt-1 p-2 rounded-lg bg-emerald-950/5 whitespace-pre-wrap break-all font-mono text-[11px]">{'value' in item.target ? JSON.stringify(item.target.value) : 'checked' in item.target ? item.target.checked ? 'Checked (true)' : 'Unchecked (false)' : field.options.find(option => option.optionId === ('optionId' in item.target ? item.target.optionId : ''))?.label}</pre><p className="mt-1 text-[10px] text-muted-foreground">Overwrite existing: {item.overwriteExisting ? 'Explicitly allowed' : 'Blocked'}</p></li>
      })}</ul>
      <p className="text-[10px] leading-4 text-muted-foreground">Review expires after 60 seconds. Filling triggers the page’s input and change handlers; their side effects cannot reliably be undone.</p>
      <label className="flex items-start gap-2 cursor-pointer font-medium text-emerald-950"><input type="checkbox" className="mt-0.5 size-4 rounded accent-emerald-800" checked={state.remember} onChange={event => controller.rememberCheckbox(event.target.checked)} /><span>Remember selected answers for this session</span></label>
      <p className="text-[10px] leading-4 text-muted-foreground pl-6">Separate opt-in: only confirmed, successfully verified eligible answers with supported meanings are retained for this origin, for up to 30 minutes. {review.items.filter(item => { const field = fields.find(field => field.fieldId === item.fieldId); return field && factValue(field, item) }).length} selected answers can be remembered. Passwords, codes, credentials, consent and unknown field meanings are never remembered.</p>
      <label className="flex items-start gap-2 cursor-pointer font-semibold text-emerald-950 pt-1 border-t"><input type="checkbox" className="mt-0.5 size-4 rounded accent-emerald-800" checked={state.approved} onChange={event => controller.approveCheckbox(event.target.checked)} /><span>I approve this exact batch and destination.</span></label>
      <Button className="min-h-11 w-full bg-emerald-900 hover:bg-emerald-800 text-white font-medium rounded-xl shadow-xs transition-all disabled:opacity-50" disabled={!state.approved || busy} onClick={() => void controller.fill()}>Approve and fill selected fields</Button>
    </section>}
  </section>
}
