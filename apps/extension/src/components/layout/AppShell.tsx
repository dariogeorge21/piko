import { LockKeyhole } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppHeader } from './AppHeader'
import { Separator } from '@/components/ui/separator'
import pkg from '../../../package.json'

export function AppShell({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-svh w-full max-w-md flex-col gap-5 p-4 sm:p-5">
    <AppHeader />
    {children}
    <footer className="mt-auto space-y-3 pt-2">
      <Separator />
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><LockKeyhole aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />Drafts are temporary. Interpretation uses your local companion; filling requires your approval.</p>
      <p className="text-[11px] text-muted-foreground">Piko v{pkg.version} · Local voice assistance</p>

    </footer>
  </main>
}
