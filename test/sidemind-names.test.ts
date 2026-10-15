import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { adoptLegacyConnections, configDirectory, legacyConfigDirectory, setting } from '../server/sidemind'

let home: string
let env: NodeJS.ProcessEnv
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidemind-names-')); env = { XDG_CONFIG_HOME: home } })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

it('prefers SIDEMIND_* settings and still honours the old CANVAS_* names', () => {
  expect(setting('DATA_DIR', { CANVAS_DATA_DIR: '/old' })).toBe('/old')
  expect(setting('DATA_DIR', { CANVAS_DATA_DIR: '/old', SIDEMIND_DATA_DIR: '/new' })).toBe('/new')
  expect(setting('DATA_DIR', {})).toBeUndefined()
})

it('keeps private connections in a Sidemind folder, apart from the old one', () => {
  if (process.platform !== 'linux') return
  expect(configDirectory(env)).toBe(path.join(home, 'sidemind', 'connections'))
  expect(legacyConfigDirectory(env)).toBe(path.join(home, 'canvas-note', 'connections'))
})

it('copies Canvas Note connections once, never touching the originals, and not when a location is set explicitly', () => {
  if (process.platform !== 'linux') return
  const legacy = legacyConfigDirectory(env)
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'one.json'), '{"k":1}')
  expect(adoptLegacyConnections({ ...env, SIDEMIND_CONFIG_DIR: path.join(home, 'elsewhere') })).toBe(0)
  expect(adoptLegacyConnections(env)).toBe(1)
  expect(fs.readFileSync(path.join(configDirectory(env), 'one.json'), 'utf8')).toBe('{"k":1}')
  expect(fs.readFileSync(path.join(legacy, 'one.json'), 'utf8')).toBe('{"k":1}')
  fs.writeFileSync(path.join(legacy, 'two.json'), '{}')
  expect(adoptLegacyConnections(env)).toBe(0)
})
