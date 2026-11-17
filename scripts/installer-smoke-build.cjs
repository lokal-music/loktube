const fs = require('node:fs/promises')
const path = require('node:path')
const { build, Platform, Arch } = require('electron-builder')
async function main() {
  const root = path.resolve(__dirname, '..')
  const fixture = path.join(process.env.RUNNER_TEMP, 'loktube-custom-setup-fixture')
  await fs.mkdir(path.join(fixture, 'resources'), { recursive: true })
  await fs.writeFile(path.join(fixture, 'LokalInstallerSmoke.exe'), 'Isolated installation fixture; not an application.')
  require('./build-setup-ui.cjs')()
  await build({
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), prepackaged: fixture, publish: 'never',
    config: {
      appId: 'com.lokal.installer-smoke', productName: 'LokalInstallerSmoke',
      directories: { output: path.join(root, 'installer-test-output'), buildResources: 'resources' },
      win: { target: ['nsis'], icon: 'resources/icon.ico', signAndEditExecutable: false },
      nsis: { oneClick: false, allowElevation: true, include: 'resources/setup/installer.nsh', runAfterFinish: false },
    },
  })
}
main().catch(error => { console.error(error); process.exitCode = 1 })
