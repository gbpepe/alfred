import { describe, it, expect } from 'vitest'
import {
  appServiceLabel,
  launchdStatusPattern,
  systemdStatusUnits,
} from '../config.js'

describe('appServiceLabel derives the standalone-installer service label from SERVICE_ID', () => {
  it('default install keeps the alfred-derived app label', () => {
    expect(appServiceLabel('alfred')).toBe('com.alfred.app')
  })

  it('a branded install names the app service after the brand slug', () => {
    expect(appServiceLabel('acme')).toBe('com.acme.app')
  })
})

describe('launchdStatusPattern matches every install shape', () => {
  const re = new RegExp(launchdStatusPattern('alfred'))

  it('matches the standalone-installer app unit', () => {
    expect(re.test('com.alfred.app')).toBe(true)
  })

  it('matches the install-macos.sh dashboard unit', () => {
    expect(re.test('com.alfred.dashboard')).toBe(true)
  })

  it('does NOT count an ancillary com.<id>.* helper as the dashboard running', () => {
    expect(re.test('com.alfred.telegram-progress-watchdog')).toBe(false)
    expect(re.test('com.alfred.channels')).toBe(false)
    expect(re.test('com.alfred.channel-coordinator')).toBe(false)
  })

  it('is right-anchored: a longer segment that merely starts with app/dashboard does not match', () => {
    expect(re.test('com.alfred.dashboard-helper')).toBe(false)
    expect(re.test('com.alfred.appliance')).toBe(false)
    expect(re.test('com.alfred.app.helper')).toBe(false)
    expect(re.test('com.alfred.dashboardx')).toBe(false)
  })

  it('does not match an unrelated service or a prefix without the specific suffix', () => {
    expect(re.test('com.apple.somethingd')).toBe(false)
    expect(re.test('com.othertool.dashboard')).toBe(false)
    expect(re.test('com.alfredistnoise')).toBe(false)
  })

  it('a branded install matches only its own dashboard/app, not an unrelated brand', () => {
    const reAcme = new RegExp(launchdStatusPattern('acme'))
    expect(reAcme.test('com.acme.dashboard')).toBe(true)
    expect(reAcme.test('com.acme.app')).toBe(true)
    expect(reAcme.test('com.alfred.app')).toBe(false)
    expect(reAcme.test('com.alfred.dashboard')).toBe(false)
  })
})

describe('systemdStatusUnits probes dashboard unit first then bare id', () => {
  it('lists dashboard and bare id for a default install', () => {
    expect(systemdStatusUnits('alfred')).toEqual(['alfred-dashboard', 'alfred'])
  })

  it('lists dashboard and bare id for a branded install', () => {
    expect(systemdStatusUnits('acme')).toEqual(['acme-dashboard', 'acme'])
  })
})
