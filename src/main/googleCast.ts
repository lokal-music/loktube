import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { connect, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { CastPlayRequest } from '../shared/ipc'
import { CAST_SERVICE, collectCastDevices, decodeCastMessage, dnsQuery, encodeCastMessage, parseCastDnsPacket, type DnsRecord, type NetworkCastDevice } from './googleCastProtocol'
import { commandUnpairedYoutubeScreen } from './tvCast'
import { validYoutubeVideoIds } from './loungeProtocol'

const RECEIVER = 'urn:x-cast:com.google.cast.receiver'
const CONNECTION = 'urn:x-cast:com.google.cast.tp.connection'
const YOUTUBE = 'urn:x-cast:com.google.youtube.mdx'
const YOUTUBE_APP = '233637DE'
const YOUTUBE_ANDROID = '2C6A6E3D'
const MAX_FRAME = 65536
const DISCOVERY_MS = 3600
const DEVICE_TTL_MS = 120000

const knownDevices = new Map<string, { device: NetworkCastDevice; time: number }>()
let activeSession: { device: NetworkCastDevice; screenId: string; connection: CastConnection; state: 'playing' | 'paused' } | null = null

export interface CastSessionState {
  deviceId: string
  deviceName: string
  state: 'playing' | 'paused'
  volume: number | null
}

export async function discoverGoogleCast(): Promise<NetworkCastDevice[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const records: DnsRecord[] = []
  const seenQueries = new Set<string>()
  let closed = false
  const queries = new Map<string, Buffer>()
  const addQuery = (name: string, type: number) => {
    const key = name.toLowerCase() + ':' + type
    if (!seenQueries.has(key) && name.length < 256) {
      seenQueries.add(key)
      queries.set(key, dnsQuery(name, type))
    }
  }
  addQuery(CAST_SERVICE, 12)
  return await new Promise<NetworkCastDevice[]>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    let tick: NodeJS.Timeout | undefined
    const finish = (error?: Error) => {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      if (tick) clearInterval(tick)
      socket.close()
      if (error) { reject(error); return }
      const devices = collectCastDevices(records)
      for (const device of devices) knownDevices.set(device.id, { device, time: Date.now() })
      resolve(devices)
    }
    const sendQueries = () => {
      const interfaces = Object.values(networkInterfaces()).flatMap((group) => group ?? [])
        .filter((entry) => entry.family === 'IPv4' && !entry.internal)
        .map((entry) => entry.address)
      const targets = interfaces.length ? interfaces : [null]
      for (const address of targets) {
        if (address) {
          try { socket.setMulticastInterface(address) } catch { continue }
        }
        for (const query of queries.values()) socket.send(query, 5353, '224.0.0.251', () => undefined)
      }
    }
    socket.on('message', (packet) => {
      try {
        const parsed = parseCastDnsPacket(packet)
        records.push(...parsed)
        if (records.length > 1800) records.splice(0, records.length - 1800)
        for (const record of parsed) {
          if (record.type === 'PTR' && record.name.toLowerCase() === CAST_SERVICE) {
            addQuery(record.value, 33)
            addQuery(record.value, 16)
          } else if (record.type === 'SRV') addQuery(record.host, 1)
        }
        sendQueries()
      } catch { /* Ignore unrelated or malformed packets on the LAN. */ }
    })
    socket.on('error', (err) => finish(new Error('Google Cast discovery failed: ' + err.message)))
    socket.bind(0, '0.0.0.0', () => {
      if (closed) return
      try { socket.setMulticastTTL(2); sendQueries() }
      catch (err) { finish(err instanceof Error ? err : new Error('Cannot start Google Cast discovery')) }
      tick = setInterval(sendQueries, 900)
      timer = setTimeout(() => finish(), DISCOVERY_MS)
    })
  })
}

type ReceiverApp = { appId?: string; universalAppId?: string; transportId?: string }
type CastResponse = {
  type?: string
  requestId?: number
  status?: { applications?: ReceiverApp[]; volume?: { level?: number } }
  data?: { screenId?: string }
  reason?: string
}

class CastConnection {
  private socket: TLSSocket
  private readonly events = new EventEmitter()
  private readonly senderId = 'sender-0'
  private pendingData = Buffer.alloc(0)
  private requestId = 1
  private closed = false
  private receiverVolume: number | null = null
  private constructor(socket: TLSSocket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('The Cast receiver disconnected.')))
    this.events.setMaxListeners(30)
  }

  static async open(device: NetworkCastDevice): Promise<CastConnection> {
    const socket = connect({ host: device.host, port: device.port, rejectUnauthorized: false, timeout: 8000 })
    const connection = new CastConnection(socket)
    await new Promise<void>((resolve, reject) => {
      let completed = false
      const done = (error?: Error) => {
        if (completed) return
        completed = true
        socket.off('secureConnect', ready)
        socket.off('error', failed)
        socket.off('timeout', timeout)
        if (error) { socket.destroy(); reject(error) } else resolve()
      }
      const ready = () => done()
      const failed = (error: Error) => done(error)
      const timeout = () => done(new Error('Cast device did not respond to the connection.'))
      socket.once('secureConnect', ready)
      socket.once('error', failed)
      socket.once('timeout', timeout)
    })
    connection.send(CONNECTION, 'receiver-0', { type: 'CONNECT' })
    return connection
  }

  private fail(error: Error) {
    if (this.closed) return
    this.closed = true
    this.events.emit('failure', error)
    this.socket.destroy()
    if (activeSession?.connection === this) activeSession = null
  }

  private onData(chunk: Buffer) {
    this.pendingData = Buffer.concat([this.pendingData, chunk])
    if (this.pendingData.length > 2 * MAX_FRAME + 4) { this.fail(new Error('Oversized Cast response')); return }
    while (this.pendingData.length >= 4) {
      const length = this.pendingData.readUInt32BE()
      if (length > MAX_FRAME || length < 1) { this.fail(new Error('Invalid Cast response length')); return }
      if (this.pendingData.length < 4 + length) break
      const payload = this.pendingData.subarray(4, 4 + length)
      this.pendingData = this.pendingData.subarray(4 + length)
      try {
        const message = decodeCastMessage(payload)
        const data = JSON.parse(message.payload) as CastResponse
        if (data.type === 'RECEIVER_STATUS' && typeof data.status?.volume?.level === 'number') {
          this.receiverVolume = data.status.volume.level
        }
        this.events.emit('message', { namespace: message.namespace, data })
      } catch { /* Ignore non-JSON messages and unrelated Cast namespaces. */ }
    }
  }

  send(namespace: string, destinationId: string, payload: Record<string, unknown>): void {
    if (this.closed) throw new Error('Cast connection is closed')
    this.socket.write(encodeCastMessage({
      sourceId: this.senderId, destinationId, namespace, payload: JSON.stringify(payload)
    }))
  }

  private async request(namespace: string, destination: string, data: Record<string, unknown>, expect: (namespace: string, response: CastResponse) => boolean, timeout = 9000): Promise<CastResponse> {
    if (this.closed) throw new Error('Cast connection is closed')
    return await new Promise<CastResponse>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.events.off('message', receive)
        this.events.off('failure', fail)
      }
      const receive = ({ namespace: ns, data: response }: { namespace: string; data: CastResponse }) => {
        if (!expect(ns, response)) return
        cleanup()
        resolve(response)
      }
      const fail = (error: Error) => { cleanup(); reject(error) }
      const timer = setTimeout(() => fail(new Error('Cast receiver timed out waiting for ' + String(data.type))), timeout)
      this.events.on('message', receive)
      this.events.on('failure', fail)
      try { this.send(namespace, destination, data) }
      catch (err) { fail(err instanceof Error ? err : new Error('Cannot send Cast request')) }
    })
  }

  async getStatus(): Promise<CastResponse> {
    const id = this.requestId++
    return this.request(RECEIVER, 'receiver-0', { type: 'GET_STATUS', requestId: id }, (ns, response) => ns === RECEIVER && response.type === 'RECEIVER_STATUS' && (response.requestId === id || response.requestId === 0))
  }

  async openYoutube(): Promise<string> {
    let status = await this.getStatus()
    const running = () => status.status?.applications?.find((app) =>
      (app.appId === YOUTUBE_APP || app.appId === YOUTUBE_ANDROID || app.universalAppId === YOUTUBE_APP) && !!app.transportId)
    if (!running()) {
      const id = this.requestId++
      status = await this.request(RECEIVER, 'receiver-0',
        { type: 'LAUNCH', appId: YOUTUBE_APP, supportedAppTypes: ['ANDROID_TV'], requestId: id },
        (ns, response) => ns === RECEIVER && (
          (response.type === 'RECEIVER_STATUS' && !!response.status?.applications?.some((app) =>
            app.appId === YOUTUBE_APP || app.appId === YOUTUBE_ANDROID || app.universalAppId === YOUTUBE_APP)) ||
          (response.type === 'LAUNCH_ERROR' && response.requestId === id)
        ), 25000)
      if (status.type === 'LAUNCH_ERROR') throw new Error('YouTube cannot be launched on this Cast device: ' + (status.reason ?? 'unsupported receiver'))
    }
    const transport = running()?.transportId
    if (!transport) throw new Error('YouTube receiver did not provide a Cast session')
    this.send(CONNECTION, transport, { type: 'CONNECT' })
    const response = await this.request(YOUTUBE, transport, { type: 'getMdxSessionStatus' },
      (ns, value) => ns === YOUTUBE && value.type === 'mdxSessionStatus' && typeof value.data?.screenId === 'string', 12000)
    const screenId = response.data?.screenId
    if (!screenId || screenId.length > 200) throw new Error('YouTube receiver did not return a valid screen ID')
    return screenId
  }

  async setVolume(level: number): Promise<number> {
    const id = this.requestId++
    const response = await this.request(RECEIVER, 'receiver-0', { type: 'SET_VOLUME', volume: { level }, requestId: id },
      (ns, value) => ns === RECEIVER && value.type === 'RECEIVER_STATUS' && typeof value.status?.volume?.level === 'number', 6000)
    return response.status?.volume?.level ?? level
  }

  get volume(): number | null { return this.receiverVolume }
  close() { this.fail(new Error('Cast session closed')) }
}

export function getGoogleCastSession(): CastSessionState | null {
  if (!activeSession) return null
  return { deviceId: activeSession.device.id, deviceName: activeSession.device.name, state: activeSession.state, volume: activeSession.connection.volume }
}

export async function playOnGoogleCast(request: CastPlayRequest & { deviceId: string }): Promise<CastSessionState> {
  if (!request || typeof request.deviceId !== 'string' || typeof request.videoId !== 'string' ||
      !/^[a-zA-Z0-9_-]{11}$/.test(request.videoId)) throw new Error('Choose a Cast device and a playable YouTube video')
  const known = knownDevices.get(request.deviceId)
  if (!known || Date.now() - known.time > DEVICE_TTL_MS) throw new Error('Cast device not in a recent scan. Refresh the device list.')
  const device = known.device
  const list = validYoutubeVideoIds(request.videoIds ?? [request.videoId])
  const ids = list.includes(request.videoId) ? list : [request.videoId, ...list]
  const connection = await CastConnection.open(device)
  try {
    const screenId = await connection.openYoutube()
    await commandUnpairedYoutubeScreen(screenId, 'setPlaylist', {
      videoId: request.videoId, videoIds: ids.join(','), currentIndex: String(ids.indexOf(request.videoId)),
      currentTime: String(Number.isFinite(request.position) ? Math.max(0, Math.floor(request.position ?? 0)) : 0)
    })
    const previous = activeSession
    activeSession = { device, screenId, connection, state: 'playing' }
    if (previous && previous.connection !== connection) {
      try { await commandUnpairedYoutubeScreen(previous.screenId, 'clearPlaylist', {}) }
      catch { /* Do not roll back a successful handoff on a stale device. */ }
      previous.connection.close()
    }
    return getGoogleCastSession()!
  } catch (error) {
    connection.close()
    throw error
  }
}

export async function controlGoogleCast(action: 'play' | 'pause' | 'seek' | 'stop' | 'volume', value?: number): Promise<CastSessionState | null> {
  const current = activeSession
  if (!current) throw new Error('No active Google Cast session. Select a device again.')
  if (action === 'volume') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Volume must be between 0 and 100%')
    await current.connection.setVolume(value)
  } else if (action === 'seek') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400) throw new Error('Invalid seek position')
    await commandUnpairedYoutubeScreen(current.screenId, 'seekTo', { newTime: String(value) })
  } else {
    await commandUnpairedYoutubeScreen(current.screenId, action === 'stop' ? 'clearPlaylist' : action, {})
    if (action === 'stop') { activeSession = null; current.connection.close(); return null }
    current.state = action === 'pause' ? 'paused' : 'playing'
  }
  return getGoogleCastSession()
}

export function closeGoogleCast(): void {
  const session = activeSession
  activeSession = null
  session?.connection.close()
}
