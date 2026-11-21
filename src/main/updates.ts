import { isIncognito } from './incognito'
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_CHANNELS, type UpdateState } from '../shared/ipc'
import { getAppPreferences } from './localDb'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Flatpak applications are updated by the system repository (Flathub/COSMIC Store),
// not by downloading and replacing files through electron-updater.
const isFlatpak = Boolean(process.env.FLATPAK_ID)
// AppImage supports electron-updater; .deb files must be installed by dpkg/apt with elevation.
const isDebPackage = process.platform === 'linux' && app.isPackaged && !isFlatpak && !process.env.APPIMAGE
const RELEASE_API = 'https://api.github.com/repos/lokal-music/loktube/releases/latest'
let debUpdatePath: string | null = null
let state: UpdateState = { status: app.isPackaged ? (isFlatpak ? 'current' : 'idle') : 'development', currentVersion: app.getVersion() }
let checking: Promise<UpdateState> | null = null
let downloading: Promise<UpdateState> | null = null
let installing = false


type GithubRelease = { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }

function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/, '').split('.').map(Number)
  const b = right.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

async function latestRelease(): Promise<GithubRelease> {
  const response = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LokTube-Updater' }, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`GitHub update check failed (HTTP ${response.status})`)
  const release = await response.json() as GithubRelease
  if (release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('GitHub returned an invalid stable release')
  return release
}

async function checkDebUpdate(): Promise<UpdateState> {
  try {
    publish({ status: 'checking', error: undefined, version: undefined })
    const release = await latestRelease()
    const version = release.tag_name.replace(/^v/, '')
    if (compareVersions(version, app.getVersion()) <= 0) publish({ status: 'current', version: undefined, error: undefined })
    else {
      const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null
      if (!arch) throw new Error(`Debian updates are unavailable for architecture ${process.arch}`)
      const asset = `LokTube-${version}-linux-${arch}.deb`
      if (!release.assets.some((item) => item.name === asset)) throw new Error(`Latest release is missing ${asset}`)
      publish({ status: 'available', version, error: undefined })
    }
  } catch (failure) { publish({ status: 'error', error: failure instanceof Error ? failure.message : String(failure) }) }
  return state
}

async function downloadDebUpdate(): Promise<UpdateState> {
  if (downloading) return downloading
  downloading = (async () => {
    try {
      publish({ status: 'downloading', percent: 0, error: undefined })
      const release = await latestRelease()
      const version = release.tag_name.replace(/^v/, '')
      if (compareVersions(version, app.getVersion()) <= 0) throw new Error('LokTube is already up to date')
      const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null
      if (!arch) throw new Error(`Debian updates are unavailable for architecture ${process.arch}`)
      const name = `LokTube-${version}-linux-${arch}.deb`
      const asset = release.assets.find((item) => item.name === name)
      if (!asset || !asset.browser_download_url.startsWith('https://github.com/lokal-music/loktube/releases/download/')) throw new Error(`Latest release is missing a trusted ${name} download`)
      const response = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'LokTube-Updater' }, signal: AbortSignal.timeout(180000) })
      if (!response.ok) throw new Error(`Update download failed (HTTP ${response.status})`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length < 1024) throw new Error('Downloaded Debian package is incomplete')
      debUpdatePath = join(tmpdir(), name)
      await writeFile(debUpdatePath, bytes, { mode: 0o600 })
      publish({ status: 'downloaded', version, percent: 100, error: undefined })
    } catch (failure) { publish({ status: 'error', error: failure instanceof Error ? failure.message : String(failure) }) }
    return state
  })().finally(() => { downloading = null })
  return downloading
}

function installDebUpdate(): void {
  if (!debUpdatePath || installing) return
  installing = true
  const child = spawn('pkexec', ['apt-get', 'install', '-y', debUpdatePath], { stdio: 'ignore' })
  child.once('error', (failure) => { installing = false; publish({ status: 'error', error: failure.message }) })
  child.once('close', (code) => {
    if (code !== 0) {
      installing = false
      publish({ status: 'error', error: code === null ? 'Package installation was cancelled' : `Package installation failed (exit code ${code})` })
      return
    }
    app.relaunch()
    app.quit()
  })
}

function publish(change: Partial<UpdateState>) {
  state = { ...state, ...change }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.UPDATES_STATE, state)
  }
}

async function check(): Promise<UpdateState> {
  if (isIncognito || isFlatpak || !app.isPackaged || ['downloading', 'downloaded'].includes(state.status)) return state
  if (isDebPackage) { if (checking) return checking; checking = checkDebUpdate().finally(() => { checking = null }); return checking }
  if (checking) return checking
  checking = (async () => {
    try { await autoUpdater.checkForUpdates() }
    catch (failure) { publish({ status: 'error', error: failure instanceof Error ? failure.message : String(failure) }) }
    return state
  })().finally(() => { checking = null })
  return checking
}

export function registerUpdates(): void {
  if (!isFlatpak && !isDebPackage) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = app.getVersion().includes('-')
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = console
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: undefined }))
    autoUpdater.on('update-available', (info) => publish({ status: 'available', version: info.version, percent: undefined }))
    autoUpdater.on('update-not-available', () => publish({ status: 'current', version: undefined }))
    autoUpdater.on('download-progress', (progress) => publish({ status: 'downloading', percent: progress.percent }))
    autoUpdater.on('update-downloaded', (info) => publish({ status: 'downloaded', version: info.version, percent: 100 }))
    autoUpdater.on('error', (failure) => {
      installing = false
      publish({ status: 'error', error: failure.message })
    })
  }
  ipcMain.handle(IPC_CHANNELS.UPDATES_STATE, () => state)
  ipcMain.handle(IPC_CHANNELS.UPDATES_CHECK, () => check())
  ipcMain.handle(IPC_CHANNELS.UPDATES_DOWNLOAD, () => {
    if (isIncognito || isFlatpak || !app.isPackaged || state.status !== 'available') return downloading ?? state
    if (isDebPackage) return downloadDebUpdate()
    publish({ status: 'downloading', percent: 0, error: undefined })
    downloading = autoUpdater.downloadUpdate().then(() => state).catch((failure) => {
      publish({ status: 'error', error: failure instanceof Error ? failure.message : String(failure) })
      return state
    }).finally(() => { downloading = null })
    return downloading
  })
  ipcMain.handle(IPC_CHANNELS.UPDATES_INSTALL, () => {
    if (isIncognito || isFlatpak || !app.isPackaged || state.status !== 'downloaded' || installing) return
    if (isDebPackage) return installDebUpdate()
    installing = true
    try {
      // The explicitly labelled restart button is the confirmation. On Windows,
      // silent NSIS mode skips setup pages; forceRunAfter reopens LokTube.
      autoUpdater.quitAndInstall(true, true)
    } catch (failure) {
      installing = false
      publish({ status: 'error', error: failure instanceof Error ? failure.message : String(failure) })
    }
  })
}

export async function checkForUpdatesOnStartup(): Promise<void> {
  if (!app.isPackaged || isFlatpak) return
  try {
    if ((await getAppPreferences()).checkForUpdatesOnStartup) await check()
  } catch (failure) { console.warn('[updates] Startup check failed', failure) }
}
