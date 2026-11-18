import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CastScreen } from '../shared/ipc'
import { LoungeSession, postLounge } from './youtubeLounge'

/**
 * YouTube TV's "Link with TV code" protocol. The television streams its own
 * YouTube media; do not send the renderer's private SABR/Googlevideo URLs to it.
 * This is TV-code pairing, not general-purpose Chromecast screen mirroring.
 */
type StoredScreen = CastScreen & { loungeToken: string; expiration: number }
let screenCache: StoredScreen[] | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'youtube-tv-screens.json')
}

function asScreen(value: unknown): StoredScreen | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 200 ||
      typeof item.name !== 'string' || item.name.length > 150 ||
      typeof item.loungeToken !== 'string' || item.loungeToken.length > 2048 ||
      typeof item.expiration !== 'number' || !Number.isFinite(item.expiration)) return null
  return { id: item.id, name: item.name, loungeToken: item.loungeToken, expiration: item.expiration }
}

async function readScreens(): Promise<StoredScreen[]> {
  if (screenCache) return screenCache
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(), 'utf8'))
    if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('Invalid paired TV data')
    const saved = parsed.map(asScreen)
    if (saved.some((item) => !item)) throw new Error('Invalid paired TV data')
    screenCache = saved as StoredScreen[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    screenCache = []
  }
  return screenCache ?? []
}

async function saveScreens(screens: StoredScreen[]): Promise<void> {
  await writeFile(storePath(), JSON.stringify(screens, null, 2), { encoding: 'utf8', mode: 0o600 })
  screenCache = screens
}

function screenFromYoutube(value: unknown, fallbackName = 'YouTube TV'): StoredScreen {
  if (!value || typeof value !== 'object') throw new Error('YouTube returned an invalid TV response')
  const item = value as Record<string, unknown>
  const id = item.screenId
  const token = item.loungeToken
  const expiration = Number(item.expiration)
  if (typeof id !== 'string' || !id || id.length > 200 ||
      typeof token !== 'string' || !token || token.length > 2048 ||
      !Number.isFinite(expiration) || expiration <= 0) {
    throw new Error('YouTube did not return a usable TV pairing token')
  }
  const name = typeof item.name === 'string' && item.name.trim()
    ? item.name.trim().slice(0, 150) : fallbackName
  return { id, name, loungeToken: token, expiration }
}

export async function listCastScreens(): Promise<CastScreen[]> {
  return (await readScreens()).map(({ id, name }) => ({ id, name }))
}

export async function pairCastScreen(code: string): Promise<CastScreen> {
  if (typeof code !== 'string') throw new Error('Enter a TV pairing code')
  const digits = code.replace(/[\s-]/g, '')
  if (!/^\d{6,16}$/.test(digits)) throw new Error('Enter the numeric code shown in YouTube on your TV')
  let payload: unknown
  try { payload = JSON.parse(await postLounge('/pairing/get_screen', {}, { pairing_code: digits })) }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('YouTube returned an unreadable TV pairing response')
    throw error
  }
  const item = payload as { screen?: unknown }
  const screen = screenFromYoutube(item?.screen)
  const existing = await readScreens()
  const next = [...existing.filter((other) => other.id !== screen.id), screen]
  await saveScreens(next)
  return { id: screen.id, name: screen.name }
}

export async function forgetCastScreen(id: string): Promise<void> {
  const screens = await readScreens()
  if (screens.every((screen) => screen.id !== id)) return
  await saveScreens(screens.filter((screen) => screen.id !== id))
}

async function freshToken(screen: StoredScreen): Promise<StoredScreen> {
  if (screen.loungeToken && screen.expiration > Date.now() + 60_000) return screen
  let result: { screens?: unknown }
  try { result = JSON.parse(await postLounge('/pairing/get_lounge_token_batch', {}, { screen_ids: screen.id })) }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('YouTube returned an unreadable TV token response')
    throw error
  }
  const values = Array.isArray(result?.screens) ? result.screens : []
  const match = values.find((value) => value && typeof value === 'object' && (value as Record<string, unknown>).screenId === screen.id)
  if (!match) throw new Error('TV pairing has expired. Use YouTube on your TV to link it again.')
  const refreshed = screenFromYoutube(match, screen.name)
  const screens = await readScreens()
  await saveScreens(screens.map((entry) => entry.id === screen.id ? refreshed : entry))
  return refreshed
}

export async function openPairedYoutubeScreen(screenId: string): Promise<LoungeSession> {
  const screens = await readScreens()
  const paired = screens.find((screen) => screen.id === screenId)
  if (!paired) throw new Error('TV not paired with LokTube')
  const screen = await freshToken(paired)
  return LoungeSession.open(screen.loungeToken)
}

export async function openUnpairedYoutubeScreen(screenId: string): Promise<LoungeSession> {
  if (!/^[a-zA-Z0-9_-]{8,200}$/.test(screenId)) throw new Error('Invalid YouTube receiver screen ID')
  let payload: { screens?: Array<{ screenId?: string; loungeToken?: string }> }
  try {
    payload = JSON.parse(await postLounge('/pairing/get_lounge_token_batch', {}, { screen_ids: screenId }))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('YouTube returned an unreadable receiver token')
    throw error
  }
  const matches = Array.isArray(payload.screens) ? payload.screens : []
  const selected = matches.find((entry) => entry.screenId === screenId) ??
    (matches.length === 1 && !matches[0].screenId ? matches[0] : undefined)
  const token = selected?.loungeToken
  if (!token || token.length > 2048) throw new Error('YouTube receiver did not provide a usable Lounge token')
  return LoungeSession.open(token)
}
