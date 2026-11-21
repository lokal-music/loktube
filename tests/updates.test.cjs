const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')

const code = transformSync(readFileSync('src/main/updates.ts', 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node22'
}).code

function setup({ packaged = true, incognito = false, fail = false, flatpak = false, linuxDeb = false, latest = null } = {}) {
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
      app: { isPackaged: packaged, getVersion: () => '2.0.2', relaunch: () => {}, quit: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
    },
    'electron-updater': { autoUpdater: updater },
    '../shared/ipc': { IPC_CHANNELS: channels },
    './localDb': { getAppPreferences: async () => ({ checkForUpdatesOnStartup: false }) }
  }
  runInNewContext(code, { module, exports: module.exports, console, Error,
    process: { platform: linuxDeb ? 'linux' : 'win32', arch: 'x64', env: flatpak ? { FLATPAK_ID: 'com.riberojuanca.worldtube' } : linuxDeb ? {} : { APPIMAGE: '/tmp/LokTube.AppImage' } },
    fetch: async (url) => {
      if (!latest) throw new Error('network unavailable')
      if (url.includes('/releases/latest')) return { ok: true, json: async () => latest }
      return { ok: true, arrayBuffer: async () => new Uint8Array(2048).buffer }
    },
    Buffer: { from: (value) => value },
    AbortSignal: { timeout: () => undefined },
    writeFile: async () => {},
    join: (...parts) => parts.join('/'),
    tmpdir: () => '/tmp',
    spawn: () => { const child = new EventEmitter(); process.nextTick(() => child.emit('close', 1)); return child },
    require: (name) => {
      assert.ok(name in imports, 'Unexpected dependency: ' + name)
      return imports[name]
    }
  })
  module.exports.registerUpdates()
  return { updater, calls, install: handlers.get('UPDATES_INSTALL'),
    check: handlers.get('UPDATES_CHECK'), download: handlers.get('UPDATES_DOWNLOAD'),
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


test('Flatpak delegates updates to the system and never invokes electron-updater', async () => {
  const instance = setup({ flatpak: true })
  assert.equal(instance.state().status, 'current')
  assert.equal(instance.updater.listenerCount('checking-for-update'), 0)
  assert.equal(instance.updater.listenerCount('update-available'), 0)
  assert.equal((await instance.check()).status, 'current')
  assert.equal((await instance.download()).status, 'current')
  instance.install()
  assert.equal(instance.calls.length, 0)
})


test('Debian updates use the matching GitHub .deb asset rather than electron-updater', async () => {
  const latest = { tag_name: 'v2.2.2', draft: false, prerelease: false, assets: [
    { name: 'LokTube-2.2.2-linux-amd64.deb', browser_download_url: 'https://github.com/lokal-music/loktube/releases/download/v2.2.2/LokTube-2.2.2-linux-amd64.deb' }
  ] }
  const instance = setup({ linuxDeb: true, latest })
  assert.equal(instance.updater.listenerCount('checking-for-update'), 0)
  assert.equal((await instance.check()).status, 'available')
  assert.equal((await instance.download()).status, 'downloaded')
})

test('Debian updater reports a missing architecture-specific package', async () => {
  const instance = setup({ linuxDeb: true, latest: { tag_name: 'v2.2.2', draft: false, prerelease: false, assets: [] } })
  const state = await instance.check()
  assert.equal(state.status, 'error')
  assert.match(state.error, /missing LokTube-2.2.2-linux-amd64.deb/)
})
