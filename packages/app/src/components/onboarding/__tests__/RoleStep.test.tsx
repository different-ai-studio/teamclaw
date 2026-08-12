import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/lib/version', () => ({ useAppVersion: () => '0.0.0-test' }))

const { changeLanguage, localeState } = vi.hoisted(() => ({
  changeLanguage: vi.fn(),
  localeState: { locked: false, languages: ['en', 'zh-CN'] },
}))
vi.mock('@/lib/i18n', () => ({
  changeLanguage,
  getCurrentLanguage: () => 'zh-CN',
  get isLocaleLocked() {
    return localeState.locked
  },
  get availableLanguages() {
    return localeState.languages
  },
}))

import { RoleStep } from '../RoleStep'
import { useOnboardingStore } from '@/stores/onboarding'

describe('RoleStep', () => {
  beforeEach(() => {
    localeState.locked = false
    localeState.languages = ['en', 'zh-CN']
    changeLanguage.mockClear()
    useOnboardingStore.getState().reset()
  })

  // The unit env runs zh-CN per project convention, so assert on that copy.
  it('offers both setup paths', () => {
    render(<RoleStep onDone={() => {}} />)
    expect(screen.getByText('我自己来')).toBeInTheDocument()
    expect(screen.getByText('直接开始用')).toBeInTheDocument()
  })

  it.each([
    ['我自己来', 'developer'],
    ['直接开始用', 'guided'],
  ])('records %s as role %s', (label, role) => {
    const onDone = vi.fn()
    render(<RoleStep onDone={onDone} />)
    fireEvent.click(screen.getByText(label))
    expect(useOnboardingStore.getState().role).toBe(role)
    expect(onDone).toHaveBeenCalledWith(role)
  })

  it('offers a language switch when the build ships more than one locale', () => {
    render(<RoleStep onDone={() => {}} />)
    fireEvent.click(screen.getByText('EN'))
    expect(changeLanguage).toHaveBeenCalledWith('en')
  })

  // A one-option "choice" is noise, and switching would silently no-op because
  // changeLanguage only applies locales present in the bundle.
  it('hides the language switch on a single-locale build', () => {
    localeState.locked = true
    localeState.languages = ['zh-CN']
    render(<RoleStep onDone={() => {}} />)
    expect(screen.queryByText('EN')).not.toBeInTheDocument()
    expect(screen.queryByText('中文')).not.toBeInTheDocument()
  })
})
