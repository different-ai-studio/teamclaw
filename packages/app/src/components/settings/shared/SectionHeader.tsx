import * as React from 'react'

export function SectionHeader({ 
  icon: Icon, 
  title, 
  description,
}: { 
  icon: React.ElementType
  title: string
  description: string
  iconColor?: string 
}) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="rounded-[14px] border border-border-soft bg-panel p-3">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-[15px] font-semibold tracking-normal">{title}</h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
