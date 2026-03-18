import { useEffect, useState, useCallback } from 'react'
import { useAppVersion } from '@/lib/version'

interface SplashScreenProps {
  onFinish: () => void
  minDisplayTime?: number
}

// Block letter TEAMCLAW - thick strokes for clarity
const teamclawArt = `
 ######      ##     ##    ##  ######  ##    ##
##          ####    ###   ##    ##     ##  ##
##         ##  ##   ####  ##    ##      ####
## ####   ##    ##  ## ## ##    ##       ##
##   ##   ########  ##  ####    ##      ####
##   ##   ##    ##  ##   ###    ##     ##  ##
 ######   ##    ##  ##    ##  ######  ##    ##
`

interface Particle {
  id: number
  char: string
  startX: number
  startY: number
  targetX: number
  targetY: number
  currentX: number
  currentY: number
  delay: number
  opacity: number
  color: string
  settled: boolean
  isBg: boolean
}

// Characters from around the world
const digitalChars = '01TEAMCLAWαβγδεζηθλπσφψωДЖЗИЛФЦЩЯあいうえおカキクケコ한글자בגדהאابتثج۱۲۳ΣΩΔΘשצקர்தமிழ்'
const fgColors = ['#1e293b', '#334155', '#3b82f6', '#4f46e5', '#6366f1']
const bgColors = ['#cbd5e1', '#d1d8e0', '#b8c4d0']

export function SplashScreen({ onFinish, minDisplayTime = 5000 }: SplashScreenProps) {
  const appVersion = useAppVersion()
  const [isFading, setIsFading] = useState(false)
  const [showSlogan, setShowSlogan] = useState(false)
  const [showGlow, setShowGlow] = useState(false)
  const [particles, setParticles] = useState<Particle[]>([])
  const [animationProgress, setAnimationProgress] = useState(0)
  
  const initParticles = useCallback(() => {
    const lines = teamclawArt.trim().split('\n')
    const newParticles: Particle[] = []
    let id = 0
    
    const centerX = window.innerWidth / 2
    const centerY = window.innerHeight / 2 - 50
    const charWidth = 11
    const charHeight = 16
    const shapeWidth = lines.reduce((max, l) => Math.max(max, l.length), 0)
    const shapeHeight = lines.length
    const offsetX = centerX - (shapeWidth * charWidth) / 2
    const offsetY = centerY - (shapeHeight * charHeight) / 2
    
    // Build a set of occupied positions for background scatter
    const occupied = new Set<string>()
    
    // Foreground: the TEAMCLAW letters
    lines.forEach((line, row) => {
      [...line].forEach((cell, col) => {
        if (cell === '#') {
          occupied.add(`${row},${col}`)
          
          const angle = Math.random() * Math.PI * 2
          const dist = 500 + Math.random() * 400
          const startX = centerX + Math.cos(angle) * dist
          const startY = centerY + Math.sin(angle) * dist
          
          const targetX = offsetX + col * charWidth
          const targetY = offsetY + row * charHeight
          
          const distFromCenter = Math.sqrt(
            Math.pow(col - shapeWidth / 2, 2) + Math.pow(row - shapeHeight / 2, 2)
          )
          const maxDist = Math.sqrt(Math.pow(shapeWidth / 2, 2) + Math.pow(shapeHeight / 2, 2))
          
          newParticles.push({
            id: id++,
            char: digitalChars[Math.floor(Math.random() * digitalChars.length)],
            startX,
            startY,
            targetX,
            targetY,
            currentX: startX,
            currentY: startY,
            delay: (1 - distFromCenter / maxDist) * 200 + Math.random() * 200,
            opacity: 1,
            color: fgColors[Math.floor(Math.random() * fgColors.length)],
            settled: false,
            isBg: false,
          })
        }
      })
    })
    
    // Background: faint scatter chars filling the bounding box gaps
    for (let row = -2; row < shapeHeight + 2; row++) {
      for (let col = -3; col < shapeWidth + 3; col++) {
        if (!occupied.has(`${row},${col}`) && Math.random() < 0.12) {
          const targetX = offsetX + col * charWidth
          const targetY = offsetY + row * charHeight
          
          newParticles.push({
            id: id++,
            char: digitalChars[Math.floor(Math.random() * digitalChars.length)],
            startX: targetX,
            startY: targetY,
            targetX,
            targetY,
            currentX: targetX,
            currentY: targetY,
            delay: 0,
            opacity: 0.18 + Math.random() * 0.12,
            color: bgColors[Math.floor(Math.random() * bgColors.length)],
            settled: true,
            isBg: true,
          })
        }
      }
    }
    
    return newParticles
  }, [])
  
  useEffect(() => {
    setParticles(initParticles())
  }, [initParticles])
  
  // Animation loop
  useEffect(() => {
    if (particles.length === 0) return
    
    const startTime = Date.now()
    const animationDuration = 2200
    let frameId: number
    
    const animate = () => {
      const elapsed = Date.now() - startTime
      const progress = Math.min(elapsed / animationDuration, 1)
      setAnimationProgress(progress)
      
      setParticles(prev => prev.map(p => {
        if (p.isBg) return p
        
        const t = Math.max(0, Math.min(1, (elapsed - p.delay) / (animationDuration * 0.7 - p.delay)))
        const eased = 1 - Math.pow(1 - t, 4)
        
        return {
          ...p,
          currentX: p.startX + (p.targetX - p.startX) * eased,
          currentY: p.startY + (p.targetY - p.startY) * eased,
          settled: t >= 1,
        }
      }))
      
      if (progress < 1) {
        frameId = requestAnimationFrame(animate)
      }
    }
    
    frameId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frameId)
  }, [particles.length])

  useEffect(() => {
    const glowTimer = setTimeout(() => setShowGlow(true), 2400)
    const sloganTimer = setTimeout(() => setShowSlogan(true), 2800)
    const timer = setTimeout(() => {
      setIsFading(true)
      setTimeout(onFinish, 600)
    }, minDisplayTime)

    return () => {
      clearTimeout(timer)
      clearTimeout(sloganTimer)
      clearTimeout(glowTimer)
    }
  }, [minDisplayTime, onFinish])

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center transition-opacity duration-600 ${
        isFading ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ background: 'linear-gradient(160deg, #ffffff 0%, #f1f5f9 50%, #e8eef6 100%)' }}
    >
      {/* Subtle dot pattern */}
      <div 
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, #64748b 1px, transparent 0)`,
          backgroundSize: '28px 28px',
        }}
      />
      
      {/* Top accent line */}
      <div 
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{
          background: 'linear-gradient(90deg, transparent 10%, #3b82f6 35%, #8b5cf6 65%, transparent 90%)',
          opacity: Math.min(1, animationProgress * 3),
        }}
      />

      {/* Particles */}
      <div className="absolute inset-0 overflow-hidden">
        {particles.map(p => (
          <span
            key={p.id}
            className="absolute font-mono select-none"
            style={{
              left: p.currentX,
              top: p.currentY,
              color: p.color,
              opacity: p.isBg
                ? p.opacity * Math.min(1, animationProgress * 2)
                : p.opacity * Math.min(1, animationProgress * 2.5),
              fontSize: p.isBg ? '11px' : '13px',
              fontWeight: p.isBg ? 400 : 700,
              textShadow: !p.isBg && showGlow && p.settled
                ? `0 0 6px ${p.color}50`
                : 'none',
              transition: showGlow ? 'text-shadow 0.8s ease' : 'none',
            }}
          >
            {p.char}
          </span>
        ))}
      </div>
      
      {/* Slogan */}
      {/* Loading bar */}
      <div className="absolute bottom-14 left-1/2 -translate-x-1/2 w-44">
        <div className="h-[2px] bg-slate-200/60 rounded-full overflow-hidden">
          <div 
            className="h-full rounded-full"
            style={{
              width: `${animationProgress * 100}%`,
              background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
              boxShadow: '0 0 8px rgba(99, 102, 241, 0.4)',
            }}
          />
        </div>
      </div>
      
      {/* Version */}
      <div 
        className={`absolute bottom-8 left-1/2 -translate-x-1/2 text-xs tracking-widest transition-opacity duration-500 ${
          showSlogan ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ color: '#cbd5e1' }}
      >
        v{appVersion}
      </div>
    </div>
  )
}
