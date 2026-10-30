import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { hasValue } from '@/features/assistant/assistant.reducer'
import type { ProposedValue } from '@/features/assistant/assistant.types'
import { sourceLabels } from '@/features/assistant/assistant.labels'

interface ProposedValueCardProps {
  proposal: ProposedValue
  error?: string
  onUpdate: (value: ProposedValue['value']) => void
  onToggle: () => void
}

export function ProposedValueCard({ proposal, error, onUpdate, onToggle }: ProposedValueCardProps) {
  const id = proposal.fieldId
  const missing = !hasValue(proposal)
  const descriptionId = `${id}-note`
  const errorId = `${id}-error`
  const selectClass = 'min-h-11 w-full min-w-0 rounded-xl border border-emerald-950/20 bg-emerald-50/10 px-3 text-sm focus-visible:outline-2 focus-visible:outline-emerald-800'
  return <article aria-label={proposal.label} className={`space-y-2.5 rounded-2xl border bg-white p-3.5 shadow-2xs transition-all ${error ? 'border-destructive/60' : 'border-emerald-950/15 hover:border-emerald-950/25'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label htmlFor={`${id}-include`} className="flex min-h-6 cursor-pointer items-center gap-2 text-sm font-semibold text-emerald-950">
        <Checkbox id={`${id}-include`} checked={proposal.selected && !missing} disabled={missing} onCheckedChange={onToggle} aria-label={`Include ${proposal.label.toLowerCase()}`} />{proposal.label}
      </label>
      <Badge variant="outline" className="text-[10px] font-medium border-emerald-950/15 text-emerald-900 bg-emerald-950/5">{missing ? proposal.required ? 'Required · missing' : 'Missing' : 'Pending approval'}</Badge>
    </div>
    <label htmlFor={`${id}-value`} className="sr-only">{proposal.label}</label>
    {proposal.type === 'select' ? <select id={`${id}-value`} value={String(proposal.value ?? '')} onChange={(event) => onUpdate(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId} className={selectClass}>
      <option value="">Not provided</option>{proposal.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select> : proposal.type === 'checkbox' ? <select id={`${id}-value`} value={proposal.value === null ? '' : String(proposal.value)} onChange={(event) => onUpdate(event.target.value === '' ? null : event.target.value === 'true')} className={selectClass} aria-describedby={descriptionId}>
      <option value="">Not provided</option><option value="true">Yes</option><option value="false">No</option>
    </select> : <Input id={`${id}-value`} type={proposal.type} value={typeof proposal.value === 'string' ? proposal.value : ''} placeholder="Not provided" onChange={(event) => onUpdate(event.target.value)} maxLength={1024} autoComplete="off" spellCheck={false} className="min-h-11 rounded-xl bg-white border-emerald-950/20 text-sm" aria-invalid={Boolean(error)} aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId} />}
    <p id={descriptionId} className="text-[11px] leading-5 text-muted-foreground">{missing ? 'Not provided · excluded until you supply and select a value' : `Source: ${sourceLabels[proposal.source]} · ${proposal.selected ? 'Included' : 'Excluded'}`}</p>
    {error && <p id={errorId} className="text-xs text-destructive font-medium">{error}</p>}
  </article>
}
