import { ClipboardCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { valueLabel } from '@/features/assistant/assistant.reducer'
import type { ProposedValue } from '@/features/assistant/assistant.types'
import { sourceLabels } from '@/features/assistant/assistant.labels'

export function ApprovalSummary({ proposals, origin, simulated = false }: { proposals: ProposedValue[]; origin: string; simulated?: boolean }) {
  return <section aria-label={simulated ? 'Simulated approval summary' : 'Approval preview'}>
    <Card className="rounded-2xl border border-emerald-950/15 bg-white/95 shadow-sm overflow-hidden">
      <CardHeader className="gap-2.5 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex size-7 items-center justify-center rounded-lg bg-emerald-950/10 text-emerald-900">
            <ClipboardCheck aria-hidden="true" className="size-4" />
          </div>
          <Badge variant="secondary" className="w-fit text-[10px] font-medium bg-emerald-950/5 text-emerald-900 border border-emerald-950/10">{simulated ? 'Demo approval only' : 'Pending approval'}</Badge>
        </div>
        <CardTitle className="text-base text-emerald-950"><h2>{simulated ? 'Approval simulated' : 'Selected for approval'}</h2></CardTitle>
        <p className="break-all text-xs text-muted-foreground">{origin}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {proposals.length ? <dl className="divide-y divide-emerald-950/5 rounded-xl border border-emerald-950/10 bg-emerald-950/5 px-3">{proposals.map((proposal) => <div key={proposal.fieldId} className="space-y-1 py-2.5 first:pt-2.5 last:pb-2.5">
          <dt className="text-xs font-semibold text-emerald-950">{proposal.label}</dt>
          <dd className="break-words text-sm font-medium text-emerald-900 [overflow-wrap:anywhere]">{valueLabel(proposal)}</dd>
          <dd className="text-[10px] text-muted-foreground">{sourceLabels[proposal.source]}</dd>
        </div>)}</dl> : <p role="status" className="text-sm leading-6 text-muted-foreground bg-emerald-950/5 p-3 rounded-xl border border-emerald-950/10">No values selected. Choose at least one provided answer to simulate approval.</p>}
        <p className="text-xs leading-5 text-muted-foreground">{simulated ? 'No webpage has been modified. Nothing was inserted or submitted.' : 'Only these selected values are included. This prototype does not modify the webpage.'}</p>
      </CardContent>
    </Card>
  </section>
}
