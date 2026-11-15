import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CastPlayRequest, CastScreen } from '../shared/ipc'
import { extractLoungeSessionIds, validYoutubeVideoIds } from './loungeProtocol'

/**
 * YouTube TV's "Link with TV code" protocol. The television streams its own
 * YouTube media; do not send the renderer's private SABR/Googlevideo URLs to it.
 * This is TV-code pairing, not general-purpose Chromecast screen mirroring.
 */
type StoredScreen = CastScreen & { loungeToken: string; expiration: number }
const LOUNGE_ORIGIN = 'https://www.youtube.com'
const LOUNGE_PATH = '/api/lounge'
const CLIENT_ID = 'loktube-' + randomUUID()
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

async function postLounge(path: string, query: Record<string, string> = {}, fields?: Record<string, string>, loungeToken?: string): Promise<string> {
  const url = new URL(LOUNGE_PATH + path, LOUNGE_ORIGIN)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Origin': LOUNGE_ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(loungeToken ? { 'X-YouTube-LoungeId-Token': loungeToken } : {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
      },
      body: fields ? new URLSearchParams(fields).toString() : '',
      signal: AbortSignal.timeout(12_000)
    })
  } catch {
    throw new Error('Could not reach the YouTube TV service. Check the network and retry.')
  }
  if (!response.ok) {
    if (response.status === 400 || response.status === 404) {
      throw new Error('The TV code or TV session was rejected. Open YouTube on the TV and retry.')
    }
    throw new Error('YouTube TV request failed (HTTP ' + response.status + ').')
  }
  return response.text()
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

async function tvSession(screenId: string): Promise<{ token: string; sid: string; gsessionid: string }> {
  const screens = await readScreens()
  const paired = screens.find((screen) => screen.id === screenId)
  if (!paired) throw new Error('TV not paired with LokTube')
  const screen = await freshToken(paired)
  const response = await postLounge('/bc/bind', {
    CVER: '1', RID: '1', VER: '8', app: 'youtube-desktop', device: 'REMOTE_CONTROL',
    id: CLIENT_ID, loungeIdToken: screen.loungeToken, name: 'LokTube'
  })
  const { sid, gsessionid } = extractLoungeSessionIds(response)
  return { sid, gsessionid, token: screen.loungeToken }
}

async function tvCommand(screenId: string, command: string, fields: Record<string, string>): Promise<void> {
  const { sid, gsessionid, token } = await tvSession(screenId)
  const payload: Record<string, string> = { count: '1', req0__sc: command }
  for (const [key, value] of Object.entries(fields)) payload['req0_' + key] = value
  await postLounge('/bc/bind', {
    CVER: '1', RID: '2', SID: sid, VER: '8', gsessionid, loungeIdToken: token
  }, payload)
}

export async function playOnCastScreen(request: CastPlayRequest): Promise<void> {
  if (!request || typeof request.screenId !== 'string' || !request.screenId ||
      typeof request.videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(request.videoId)) {
    throw new Error('Choose a paired TV and a YouTube video')
  }
  const queued = validYoutubeVideoIds(request.videoIds ?? [request.videoId])
  const videoIds = queued.includes(request.videoId) ? queued : [request.videoId, ...queued]
  const currentIndex = videoIds.indexOf(request.videoId)
  const currentTime = Number.isFinite(request.position) ? Math.max(0, Math.floor(request.position ?? 0)) : 0
  await tvCommand(request.screenId, 'setPlaylist', {
    currentIndex: String(currentIndex),
    currentTime: String(currentTime),
    videoId: request.videoId,
    videoIds: videoIds.join(',')
  })
}

export async function stopCastScreen(screenId: string): Promise<void> {
  if (typeof screenId !== 'string' || !screenId) throw new Error('Choose a paired TV')
  await tvCommand(screenId, 'clearPlaylist', {})
}

/**
 * Network-discovered Google Cast devices expose a transient YouTube screen ID
 * over the Cast V2 MDX channel. Resolve its Lounge token without saving a TV
 * code pairing, then send the command through YouTube's remote protocol.
 */
export async function commandUnpairedYoutubeScreen(
  screenId: string, command: 'setPlaylist' | 'clearPlaylist' | 'play' | 'pause' | 'seekTo',
  fields: Record<string, string>
): Promise<void> {
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
  const cid = CLIENT_ID.slice(0, 26)
  const details = {
    app: 'web', 'mdx-version': '3', name: 'LokTube', id: cid,
    device: 'REMOTE_CONTROL', capabilities: 'que,dsdtr,atp', method: 'setPlaylist',
    magnaKey: 'cloudPairedDevice', ui: 'false', theme: 'cl', loungeIdToken: token
  }
  const handshake = await postLounge('/bc/bind', {
    RID: '0', VER: '8', CVER: '1', TYPE: 'bind', auth_failure_option: 'send_error'
  }, details, token)
  const { sid, gsessionid } = extractLoungeSessionIds(handshake)
  const body: Record<string, string> = {
    count: '1', ofs: '0', req0__sc: command, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => ['req0_' + key, value]))
  }
  if (command === 'setPlaylist') {
    body.req0_listId = ''
    body.req0_audioOnly = 'false'
    body.req0_prioritizeMobileSenderPlaybackStateOnConnection = 'true'
    body.req0_params = ''
    body.req0_playerParams = ''
  }
  await postLounge('/bc/bind', {
    SID: sid, gsessionid, RID: '1', VER: '8', CVER: '1', TYPE: 'bind',
    v: '2', t: '1', AID: '0', CI: '0', name: 'LokTube', id: cid,
    device: 'REMOTE_CONTROL', loungeIdToken: token
  }, body, token)
}
