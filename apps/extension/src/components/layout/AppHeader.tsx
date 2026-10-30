import { AudioLines, FlaskConical } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function AppHeader() {
  return <header className="flex items-center justify-between gap-3 pb-1 border-b border-emerald-950/5">
    <div className="flex items-center gap-2.5">
      <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-800 to-teal-950 text-white shadow-sm ring-1 ring-emerald-900/20"><AudioLines aria-hidden="true" className="size-5" /></div>
      <div>
        <p className="text-lg font-semibold leading-5 tracking-tight text-emerald-950">piko</p>
        <p className="text-[10px] font-medium text-muted-foreground flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-emerald-600 animate-pulse" />
          Local Voice Assistant
        </p>
      </div>
    </div>
    <Badge variant="outline" className="gap-1 bg-white/80 border-emerald-950/15 text-emerald-900 text-[11px] font-medium shadow-2xs"><FlaskConical aria-hidden="true" className="size-3 text-emerald-700" />Prototype</Badge>
  </header>
}
