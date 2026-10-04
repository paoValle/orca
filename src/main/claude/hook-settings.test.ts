import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { ClaudeHookService } from './hook-service'
import { CLAUDE_HOOK_SETTINGS, OPENCLAUDE_HOOK_SETTINGS, getConfigPath } from './hook-settings'

// Why: the CLI reads settings.json from this variable when it names a dir, which is also how an
// account with a non-default home is launched, so hooks have to follow it (#25242).
const RELOCATED_DIR = join('tmp', 'orca-relocated-claude')

describe('getConfigPath config dir resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the CLI default dir when no variable names one', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    expect(getConfigPath(CLAUDE_HOOK_SETTINGS)).toBe(join(homedir(), '.claude', 'settings.json'))
  })

  it('follows a relocated config dir', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', RELOCATED_DIR)
    expect(getConfigPath(CLAUDE_HOOK_SETTINGS)).toBe(join(RELOCATED_DIR, 'settings.json'))
  })

  it('ignores surrounding whitespace in the variable', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', `  ${RELOCATED_DIR}  `)
    expect(getConfigPath(CLAUDE_HOOK_SETTINGS)).toBe(join(RELOCATED_DIR, 'settings.json'))
  })

  it('leaves a fork descriptor on its own dir while the variable is set', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', RELOCATED_DIR)
    expect(getConfigPath(OPENCLAUDE_HOOK_SETTINGS)).toBe(
      join(homedir(), '.openclaude', 'settings.json')
    )
  })
})

// Why end-to-end: the reported symptom is a hook-driven feature reading inactive because the hooks
// land in a settings file the CLI never opens, so the install has to be checked, not just the path.
describe('Claude hook install with a relocated config dir', () => {
  let tmpHome: string
  let relocatedDir: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-hook-home-'))
    relocatedDir = mkdtempSync(join(tmpdir(), 'orca-claude-hook-relocated-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    vi.stubEnv('CLAUDE_CONFIG_DIR', relocatedDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(relocatedDir, { recursive: true, force: true })
  })

  it('writes the managed hooks where the CLI reads settings', () => {
    const status = new ClaudeHookService().install({ claudeVersion: '2.1.261' })

    expect(status.configPath).toBe(join(relocatedDir, 'settings.json'))
    expect(status.state).toBe('installed')
    const written = JSON.parse(readFileSync(status.configPath, 'utf-8'))
    expect(Object.keys(written.hooks ?? {}).length).toBeGreaterThan(0)
    // The default dir must not keep a settings file the CLI will never read.
    expect(existsSync(join(tmpHome, '.claude', 'settings.json'))).toBe(false)
  })
})
