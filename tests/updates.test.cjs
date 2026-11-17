const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')

const code = transformSync(readFileSync('src/main/updates.ts', 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node22'
}).code

function setup({ packaged = true, incognito = false, fail = false } = {}) {
  const handlers = new Map()
  const calls = []
  const updater = new EventEmitter()
  updater.quitAndInstall = (...args) => {
    calls.push(args)
    if (fail) throw new Error('Installer could not start')
  }
  const channels = new Proxy({}, { get: (_, key) => key })
  const module = { exports: {} }
  const imports = {
    './incognito': { isIncognito: incognito },
    electron: {
      app: { isPackaged: packaged, getVersion: () => '2.0.2' },
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
    },
    'electron-updater': { autoUpdater: updater },
    '../shared/ipc': { IPC_CHANNELS: channels },
    './localDb': { getAppPreferences: async () => ({ checkForUpdatesOnStartup: false }) }
  }
  runInNewContext(code, { module, exports: module.exports, console, Error,
    require: (name) => {
      assert.ok(name in imports, 'Unexpected dependency: ' + name)
      return imports[name]
    }
  })
  module.exports.registerUpdates()
  return { updater, calls, install: handlers.get('UPDATES_INSTALL'),
    state: handlers.get('UPDATES_STATE') }
}

test('restart action silently installs and reopens exactly once, with no dialog dependency', () => {
  const { updater, calls, install } = setup()
  updater.emit('update-downloaded', { version: '2.0.3' })
  install()
  install()
  assert.deepEqual(calls, [[true, true]])
})

test('idle, development and incognito instances cannot install', () => {
  const idle = setup()
  idle.install()
  assert.equal(idle.calls.length, 0)
  for (const options of [{ packaged: false }, { incognito: true }]) {
    const instance = setup(options)
    instance.updater.emit('update-downloaded', { version: '2.0.3' })
    instance.install()
    assert.equal(instance.calls.length, 0)
  }
})

test('a failed installer launch is reported and can be retried after another download', () => {
  const instance = setup({ fail: true })
  instance.updater.emit('update-downloaded', { version: '2.0.3' })
  instance.install()
  assert.equal(instance.state().status, 'error')
  assert.equal(instance.state().error, 'Installer could not start')
  instance.updater.emit('update-downloaded', { version: '2.0.3' })
  instance.install()
  assert.equal(instance.calls.length, 2)
})

test('asynchronous updater errors release the install guard', () => {
  const instance = setup()
  instance.updater.emit('update-downloaded', { version: '2.0.3' })
  instance.install()
  instance.updater.emit('error', new Error('Could not spawn installer'))
  assert.equal(instance.state().status, 'error')
  instance.updater.emit('update-downloaded', { version: '2.0.3' })
  instance.install()
  assert.equal(instance.calls.length, 2)
})
