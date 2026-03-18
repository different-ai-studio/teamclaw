import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const INSTALL_SCRIPT = path.resolve(__dirname, '../..', 'install.sh')

describe('Install Script', () => {
  it('script is executable', () => {
    const result = execSync(`test -x "${INSTALL_SCRIPT}" && echo "executable" || echo "not executable"`, {
      encoding: 'utf-8',
    }).trim()
    expect(result).toBe('executable')
  })

  it('detects macOS aarch64 platform', () => {
    const os = execSync('uname -s', { encoding: 'utf-8' }).trim()
    const arch = execSync('uname -m', { encoding: 'utf-8' }).trim()

    if (os === 'Darwin' && arch === 'arm64') {
      const result = execSync(`bash -n "${INSTALL_SCRIPT}" 2>&1 || true`, {
        encoding: 'utf-8',
      })
      expect(result.trim()).toBe('')
    }
  })

  it('script has correct shebang and set flags', () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
    const firstTwoLines = content.split('\n').slice(0, 2).join('\n')
    expect(firstTwoLines).toContain('#!/bin/bash')
    expect(firstTwoLines).toContain('set -euo pipefail')
  })

  it('script references correct GitHub repo', () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
    expect(content).toContain('diffrent-ai-studio/teamclaw')
    expect(content).toContain('TeamClaw')
  })

  it('script checks for unsupported OS', () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
    expect(content).toContain('uname -s')
    expect(content).toContain('Darwin')
    expect(content).toContain('Unsupported operating system')
  })

  it('script checks for unsupported architecture', () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
    expect(content).toContain('uname -m')
    expect(content).toContain('arm64')
    expect(content).toContain('Unsupported architecture')
  })

  it('script handles existing installation', () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, 'utf-8')
    expect(content).toContain('Existing installation found')
    expect(content).toContain('/Applications')
  })
})
