import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const isIncognito = process.argv.includes('--incognito') || process.env.LOKTUBE_INCOGNITO === '1'

import { incognitoRoute } from '../shared/incognito'
export { incognitoRoute } from '../shared/incognito'

export function configureIncognito(): void {
  if (!isIncognito) return
  const supplied = process.env.LOKTUBE_INCOGNITO_DIRECTORY
  const directory = supplied && dirname(resolve(supplied)) === resolve(tmpdir()) &&
    /^loktube-incognito-[a-zA-Z0-9]+$/.test(basename(supplied))
    ? supplied : mkdtempSync(join(tmpdir(), 'loktube-incognito-'))
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
  app.on('quit', () => {
    // The parent also retries cleanup after the child has fully exited (Windows
    // may still have Chromium files open while this event is being delivered).
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* parent retries */ }
  })
}

export async function openIncognito(route: unknown = '/'): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'loktube-incognito-'))
  const executable = app.isPackaged ? process.env.APPIMAGE || process.execPath : process.execPath
  const args = [
    ...(!app.isPackaged ? [app.getAppPath()] : []),
    ...process.argv.filter((arg) => arg === '--no-sandbox' || arg === '--disable-gpu'),
    '--incognito'
  ]
  const child = spawn(executable, args, {
    detached: true, stdio: 'ignore',
    env: { ...process.env, LOKTUBE_INCOGNITO: '1',
      LOKTUBE_INCOGNITO_DIRECTORY: directory, LOKTUBE_INCOGNITO_ROUTE: incognitoRoute(route) }
  })
  const cleanup = () => { void rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined) }
  child.once('exit', cleanup)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (error) => { cleanup(); reject(error) })
  })
  child.unref()
}
