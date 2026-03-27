import { cn } from '@/lib/utils'

interface AnimatedClockProps {
  className?: string
  animate?: boolean
}

export function AnimatedClock({ className, animate = false }: AnimatedClockProps) {
  return (
    <div className={cn("relative inline-flex items-center justify-center", className)} style={{ width: '1em', height: '1em' }}>
      <style>{`
        @keyframes clock-hour-hand {
          from { transform: rotate(90deg); }
          to { transform: rotate(450deg); }
        }
        @keyframes clock-minute-hand {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-full h-full"
      >
        {/* Clock circle */}
        <circle cx="12" cy="12" r="10" />
      </svg>
      
      {/* Hour hand - points to 3 o'clock (90deg) when static, rotates slowly when animated */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="absolute w-full h-full"
        style={{ 
          transformOrigin: 'center',
          transform: 'rotate(90deg)',
          animation: animate ? 'clock-hour-hand 72s linear infinite' : 'none'
        }}
      >
        <line x1="12" y1="12" x2="12" y2="8" />
      </svg>
      
      {/* Minute hand - points to 12 o'clock (0deg, vertical up) when static, rotates faster when animated */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="absolute w-full h-full"
        style={{ 
          transformOrigin: 'center',
          transform: 'rotate(0deg)',
          animation: animate ? 'clock-minute-hand 6s linear infinite' : 'none'
        }}
      >
        <line x1="12" y1="12" x2="12" y2="6" />
      </svg>
    </div>
  )
}
