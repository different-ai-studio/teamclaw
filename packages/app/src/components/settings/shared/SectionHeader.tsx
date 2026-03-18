import * as React from 'react'
import { cn } from '@/lib/utils'

export function SectionHeader({ 
  icon: Icon, 
  title, 
  description, 
  iconColor 
}: { 
  icon: React.ElementType
  title: string
  description: string
  iconColor: string 
}) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className="rounded-xl p-3 bg-muted/50">
        <Icon className={cn("h-6 w-6", iconColor)} />
      </div>
      <div>
        <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
    </div>
  )
}
