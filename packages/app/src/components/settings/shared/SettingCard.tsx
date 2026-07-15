import * as React from 'react'
import { cn } from '@/lib/utils'

export function SettingCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      "rounded-[14px] border border-border bg-paper p-5 transition-colors",
      className
    )}>
      {children}
    </div>
  )
}
