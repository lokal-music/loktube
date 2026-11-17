import { isIncognito } from './incognito'
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_CHANNELS, type UpdateState } from '../shared/ipc'
import { getAppPreferences } from './localDb'

let state: UpdateState = { status: app.isPackaged ? 'idle' : 'development', currentVersion: app.getVersion() }
let checking: Promise<UpdateState> | null = null
let downloading: Promise<UpdateState> | null = null
let installing = false

function publish(change: Partial<UpdateState>) {
  state = { ...state, ...change }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.UPDATES_STATE, state)
  }
}

async function check(): Promise<UpdateState> {
  if (isIncognito || !app.isPackaged || ['downloading', 'downloaded'].includes(state.status)) return state
  if (checking) return checking
  checking = (async () => {
    try { await autoUpdater.checkForUpdates() }
    catch (failure) { publish({ status: 'error', error: failure instanceof Error ? failure.message : String(failure) }) }
    return state
  })().finally(() => { checking = null })
  return checking
}

export function registerUpdates(): void {
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
  ipcMain.handle(IPC_CHANNELS.UPDATES_STATE, () => state)
  ipcMain.handle(IPC_CHANNELS.UPDATES_CHECK, () => check())
  ipcMain.handle(IPC_CHANNELS.UPDATES_DOWNLOAD, () => {
    if (isIncognito || !app.isPackaged || state.status !== 'available') return downloading ?? state
    publish({ status: 'downloading', percent: 0, error: undefined })
    downloading = autoUpdater.downloadUpdate().then(() => state).catch((failure) => {
      publish({ status: 'error', error: failure instanceof Error ? failure.message : String(failure) })
      return state
    }).finally(() => { downloading = null })
    return downloading
  })
  ipcMain.handle(IPC_CHANNELS.UPDATES_INSTALL, () => {
    if (isIncognito || !app.isPackaged || state.status !== 'downloaded' || installing) return
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
  if (!app.isPackaged) return
  try {
    if ((await getAppPreferences()).checkForUpdatesOnStartup) await check()
  } catch (failure) { console.warn('[updates] Startup check failed', failure) }
}
