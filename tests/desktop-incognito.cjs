const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const { mkdtemp, mkdir, writeFile, readFile, rm, readdir } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loktube-private-test-'))
  const normal = join(directory, 'worldtube')
  await mkdir(normal)
  const marker = '{"normalProfile":"untouched"}'
  await writeFile(join(normal, 'worldtube-data.json'), marker)
  await writeFile(join(normal, 'youtube-session.enc'), 'normal-account-only')
  const executablePath = process.env.WORLDTUBE_SMOKE_APP
  const app = await electron.launch({
    executablePath, args: ['--no-sandbox', '--disable-gpu', ...(!executablePath ? ['.'] : []), '--incognito'],
    cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: directory,
      LOKTUBE_INCOGNITO_DIRECTORY: '', LOKTUBE_INCOGNITO_ROUTE: '/' }, timeout: 30000
  })
  let privateDirectory
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'You’re browsing incognito' }).waitFor({ timeout: 20000 })
    assert.equal(await page.evaluate(() => window.api.isIncognito), true)
    assert.equal(await page.getByRole('button', { name: 'Close incognito', exact: true }).count(), 2)
    assert.equal((await page.evaluate(() => window.api.getYoutubeAccount())).signedIn, false)
    assert.deepEqual(await page.evaluate(() => window.api.getHomeFeed()), {
      ok: true, data: [], home: { shorts: [], hasMore: false }
    })
    assert.deepEqual(await page.evaluate(() => window.api.recordSearchQuery('private search')), [])
    assert.deepEqual(await page.evaluate(() => window.api.listSearchHistory()), [])
    assert.deepEqual(await page.evaluate(() => window.api.getHistory()), [])
    for (const action of ['signInYoutube', 'importData']) {
      assert.equal(await page.evaluate(async (action) => {
        try { await window.api[action](); return false }
        catch (error) { return String(error).includes('unavailable in incognito') }
      }, action), true)
    }
    const state = await app.evaluate(({ app, BrowserWindow }) => ({
      directory: app.getPath('userData'), sessionDirectory: app.getPath('sessionData'),
      persistent: BrowserWindow.getAllWindows()[0].webContents.session.isPersistent()
    }))
    privateDirectory = state.directory
    assert.notEqual(state.directory, normal)
    assert.equal(state.directory, state.sessionDirectory)
    assert.equal(state.persistent, false)
    const files = await readdir(state.directory)
    assert.equal(files.includes('worldtube-data.json'), false)
    assert.equal(files.includes('logs'), false)
    assert.equal(await readFile(join(normal, 'worldtube-data.json'), 'utf8'), marker)
    assert.equal(await readFile(join(normal, 'youtube-session.enc'), 'utf8'), 'normal-account-only')
    console.log('PASS: incognito has no home recommendations, account, history, persistent session or database')
  } finally {
    await app.close()
    if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
