import { randomUUID } from 'node:crypto'
import type { CastPlayRequest, CastPlaybackState } from '../shared/ipc'
import { extractLoungeSessionIds, readLoungeFrames, validYoutubeVideoIds } from './loungeProtocol'

const LOUNGE_ORIGIN = 'https://www.youtube.com'
const LOUNGE_PATH = '/api/lounge'
const CLIENT_ID = 'loktube-' + randomUUID().slice(0, 18)

async function requestLounge(
  path: string, query: Record<string, string>, fields?: Record<string, string>,
  loungeToken?: string, subscription?: AbortSignal
): Promise<Response> {
  const url = new URL(LOUNGE_PATH + path, LOUNGE_ORIGIN)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  let response: Response
  try {
    response = await fetch(url, {
      method: subscription ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        'Origin': LOUNGE_ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(loungeToken ? { 'X-YouTube-LoungeId-Token': loungeToken } : {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
      },
      body: subscription ? undefined : new URLSearchParams(fields).toString(),
      signal: subscription ?? AbortSignal.timeout(12_000)
    })
  } catch {
    throw new Error('Could not reach the YouTube TV service. Check the network and retry.')
  }
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 400 || response.status === 404) {
      throw new Error('The TV code or TV session was rejected. Open YouTube on the TV and retry.')
    }
    throw new Error('YouTube TV request failed (HTTP ' + response.status + ').')
  }
  return response
}

export async function postLounge(path: string, query: Record<string, string> = {}, fields?: Record<string, string>, token?: string): Promise<string> {
  return (await requestLounge(path, query, fields, token)).text()
}

type LoungeCommand = 'setPlaylist' | 'clearPlaylist' | 'getNowPlaying' | 'play' | 'pause' | 'seekTo' | 'previous' | 'next' | 'setVolume'
type LoungePlayback = Pick<CastPlaybackState,
  'state' | 'videoId' | 'position' | 'duration' | 'hasPrevious' | 'hasNext'>

function playbackNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return
  const number = Number(value)
  if (Number.isFinite(number) && number >= 0) return number
}

export class LoungeSession {
  private readonly lifetime = new AbortController()
  private offset = 1
  private eventId = 0
  private positionTime = performance.now()
  private current: LoungePlayback = {
    state: 'idle', videoId: null, position: 0, duration: 0, hasPrevious: false, hasNext: false
  }
  private volumeLevel: number | null = null
  private commands = Promise.resolve()

  private constructor(
    private readonly token: string, private readonly sid: string, private readonly gsessionid: string
  ) {}

  static async open(token: string): Promise<LoungeSession> {
    const handshake = await postLounge('/bc/bind', {
      RID: '1', VER: '8', CVER: '1', auth_failure_option: 'send_error'
    }, {
      app: 'web', 'mdx-version': '3', name: 'LokTube', id: CLIENT_ID,
      device: 'REMOTE_CONTROL', capabilities: 'que,dsdtr,atp',
      magnaKey: 'cloudPairedDevice', ui: 'false', theme: 'cl', loungeIdToken: token
    }, token)
    const { sid, gsessionid } = extractLoungeSessionIds(handshake)
    const session = new LoungeSession(token, sid, gsessionid)
    session.receive(readLoungeFrames(handshake).events)
    void session.listen()
    return session
  }

  private query(): Record<string, string> {
    return {
      SID: this.sid, gsessionid: this.gsessionid, VER: '8', v: '2', AID: String(this.eventId),
      name: 'LokTube', device: 'REMOTE_CONTROL', app: 'youtube-desktop', loungeIdToken: this.token
    }
  }

  private receive(events: ReturnType<typeof readLoungeFrames>['events']): void {
    for (const { id, event: [type, payload] } of events) {
      this.eventId = Math.max(this.eventId, id)
      if (type === 'loungeScreenDisconnected' || type === 'stop') { this.close(); return }
      if (!payload || typeof payload !== 'object') continue
      const data = payload as Record<string, unknown>
      if (type === 'onVolumeChanged') {
        const volume = playbackNumber(data.volume)
        if (volume !== undefined && volume <= 100)
          this.volumeLevel = data.muted === true || data.muted === 'true' ? 0 : volume / 100
      }
      if (type === 'onHasPreviousNextChanged') {
        this.current.hasPrevious = data.hasPrevious === true || data.hasPrevious === 'true'
        this.current.hasNext = data.hasNext === true || data.hasNext === 'true'
      }
      if (type !== 'onStateChange' && type !== 'nowPlaying') continue
      const state = String(data.state)
      this.current = {
        ...this.current,
        state: state === '1' ? 'playing' : state === '2' ? 'paused' : state === '3' ? 'buffering'
          : type === 'nowPlaying' || state === '0' || state === '-1' ? 'idle' : this.current.state,
        videoId: typeof data.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(data.videoId)
          ? data.videoId : type === 'nowPlaying' ? null : this.current.videoId,
        position: playbackNumber(data.currentTime) ?? (type === 'nowPlaying' ? 0 : this.playback.position),
        duration: playbackNumber(data.duration) ?? (type === 'nowPlaying' ? 0 : this.current.duration)
      }
      this.positionTime = performance.now()
    }
  }

  private async listen(): Promise<void> {
    const lifetime = this.lifetime.signal
    while (!lifetime.aborted) {
      const timeout = AbortSignal.timeout(90_000)
      const signal = AbortSignal.any([lifetime, timeout])
      try {
        const response = await requestLounge('/bc/bind', {
          ...this.query(), RID: 'rpc', CI: '0', TYPE: 'xmlhttp'
        }, undefined, this.token, signal)
        if (!response.body) throw new Error('YouTube TV returned no event stream')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        let receivedData = false
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read()
            if (done) {
              this.receive(readLoungeFrames(pending + decoder.decode()).events)
              if (!receivedData) throw new Error('YouTube TV closed the event stream')
              break
            }
            receivedData = true
            const { events, remainder } = readLoungeFrames(pending + decoder.decode(value, { stream: true }), true)
            pending = remainder
            this.receive(events)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
      } catch {
        if (!timeout.aborted) this.close()
      }
    }
  }

  command(command: LoungeCommand, fields: Record<string, string> = {}): Promise<void> {
    const pending = this.commands.then(async () => {
      if (!this.connected) throw new Error('YouTube TV disconnected. Reconnect to resume control.')
      const body: Record<string, string> = { count: '1', ofs: String(this.offset), req0__sc: command }
      for (const [key, value] of Object.entries(fields)) body['req0_' + key] = value
      await postLounge('/bc/bind', { ...this.query(), RID: String(++this.offset) }, body, this.token)
    })
    this.commands = pending.catch(() => this.close())
    return pending
  }

  async setPlaylist(request: Pick<CastPlayRequest, 'videoId' | 'videoIds' | 'position'>): Promise<void> {
    const queued = validYoutubeVideoIds(request.videoIds ?? [request.videoId])
    const ids = queued.includes(request.videoId) ? queued : [request.videoId, ...queued].slice(0, 100)
    const index = ids.indexOf(request.videoId)
    const position = Number.isFinite(request.position) ? Math.max(0, Math.floor(request.position ?? 0)) : 0
    const previousUpdate = this.positionTime
    await this.command('setPlaylist', {
      videoId: request.videoId, videoIds: ids.join(','), currentIndex: String(index),
      currentTime: String(position), listId: '', audioOnly: 'false',
      prioritizeMobileSenderPlaybackStateOnConnection: 'true', params: '', playerParams: ''
    })
    if (!this.connected) throw new Error('YouTube TV disconnected during playback handoff.')
    if (this.positionTime === previousUpdate || this.current.videoId !== request.videoId) {
      this.current = {
        videoId: request.videoId, position, duration: 0, state: 'buffering',
        hasPrevious: index > 0, hasNext: index < ids.length - 1
      }
      this.positionTime = performance.now()
    }
  }

  get connected(): boolean { return !this.lifetime.signal.aborted }
  get volume(): number | null { return this.volumeLevel }
  get playback(): LoungePlayback {
    const elapsed = this.connected && this.current.state === 'playing' ? (performance.now() - this.positionTime) / 1000 : 0
    return { ...this.current, position: Math.min(this.current.position + elapsed, this.current.duration || Infinity) }
  }
  close(): void {
    if (!this.connected) return
    this.current = this.playback
    this.lifetime.abort()
  }
}
