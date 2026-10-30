import { Check } from 'lucide-react'
import type { AssistantStage } from '@/features/assistant/assistant.types'

const steps = ['Prepare', 'Converse', 'Review', 'Result']
const positions: Record<AssistantStage, number> = { idle: 0, 'inspecting-demo': 0, ready: 0, conversation: 1, review: 2, 'approval-simulated': 3, error: 0 }

export function WorkflowProgress({ stage }: { stage: AssistantStage }) {
  const active = positions[stage]
  return <nav aria-label="Demo workflow" className="p-3 bg-white/90 rounded-2xl border border-emerald-950/10 shadow-2xs">
    <ol className="grid grid-cols-4 gap-2">
      {steps.map((step, index) => <li key={step} aria-current={stage !== 'error' && index === active ? 'step' : undefined} className="space-y-1.5 text-center">
        <span className={`mx-auto flex size-7 items-center justify-center rounded-full text-xs font-semibold transition-all ${index <= active && stage !== 'error' ? 'bg-emerald-900 text-white shadow-2xs' : 'bg-emerald-950/5 text-muted-foreground'}`}>
          {index < active ? <Check aria-hidden="true" className="size-3.5" /> : index + 1}
        </span>
        <span className={`block text-[11px] transition-colors ${index === active ? 'font-semibold text-emerald-950' : 'text-muted-foreground'}`}>{step}</span>
      </li>)}
    </ol>
  </nav>
}
