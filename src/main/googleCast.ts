import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { connect, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { CastPlayRequest, CastScreen, CastAction, GoogleCastPlayRequest, CastPlaybackState } from '../shared/ipc'
import { CAST_SERVICE, collectCastDevices, decodeCastMessage, dnsQuery, encodeCastMessage, parseCastDnsPacket, type DnsRecord, type NetworkCastDevice } from './googleCastProtocol'
import { listCastScreens, openPairedYoutubeScreen, openUnpairedYoutubeScreen } from './tvCast'
import type { LoungeSession } from './youtubeLounge'

const RECEIVER = 'urn:x-cast:com.google.cast.receiver'
const CONNECTION = 'urn:x-cast:com.google.cast.tp.connection'
const HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat'
const YOUTUBE = 'urn:x-cast:com.google.youtube.mdx'
const YOUTUBE_APP = '233637DE'
const YOUTUBE_ANDROID = '2C6A6E3D'
const MAX_FRAME = 65536
const DISCOVERY_MS = 3600
const DEVICE_TTL_MS = 120000

const knownDevices = new Map<string, { device: NetworkCastDevice; time: number }>()
type CastTarget = { kind: 'google'; device: NetworkCastDevice } | { kind: 'tv'; device: CastScreen }
type CastSession = CastTarget & { screenId: string; lounge: LoungeSession; connection?: CastConnection }
let activeSession: CastSession | null = null

export async function discoverGoogleCast(): Promise<NetworkCastDevice[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  // Some receivers ignore the unicast-response (QU) bit and reply to the
  // multicast group instead. Listen on 5353 when the OS allows it.
  const multicast = dgram.createSocket({ type: 'udp4', reuseAddr: true })
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
      try { multicast.close() } catch { /* A blocked 5353 bind is optional. */ }
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
    const reply = (packet: Buffer) => {
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
      } catch { /* Ignore unrelated or malformed packets on the LAN. */ }
    }
    socket.on('message', reply)
    multicast.on('message', reply)
    multicast.on('error', () => { /* mDNS port 5353 can be claimed by the OS. */ })
    multicast.bind(5353, '0.0.0.0', () => {
      if (closed) return
      try { multicast.addMembership('224.0.0.251') } catch { /* Unicast discovery can still work. */ }
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
  private lastHeartbeat = Date.now()
  private readonly heartbeat: NodeJS.Timeout
  private constructor(socket: TLSSocket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('The Cast receiver disconnected.')))
    this.events.setMaxListeners(30)
    this.heartbeat = setInterval(() => {
      if (this.closed || !this.socket.encrypted) return
      if (Date.now() - this.lastHeartbeat > 22000) {
        this.fail(new Error('The Cast receiver stopped responding.'))
        return
      }
      this.send(HEARTBEAT, 'receiver-0', { type: 'PING' })
    }, 5000)
    this.heartbeat.unref()
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
      const ready = () => { socket.setTimeout(0); done() }
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
    clearInterval(this.heartbeat)
    this.events.emit('failure', error)
    this.socket.destroy()
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
        this.lastHeartbeat = Date.now()
        if (message.namespace === HEARTBEAT && data.type === 'PING') {
          this.send(HEARTBEAT, message.sourceId, { type: 'PONG' })
          continue
        }
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
    const isYoutube = (app: ReceiverApp) =>
      app.appId === YOUTUBE_APP || app.appId === YOUTUBE_ANDROID || app.universalAppId === YOUTUBE_APP
    let running = status.status?.applications?.find((app) => isYoutube(app) && !!app.transportId)
    if (!running) {
      // Cast Connect Android TV receivers need the supportedAppTypes hint,
      // while classic Chromecast/Nest devices launch the universal ID without
      // one. Retry without the hint only when the first LAUNCH is rejected.
      for (const types of [['ANDROID_TV'], []]) {
        const id = this.requestId++
        const launch = await this.request(RECEIVER, 'receiver-0',
          { type: 'LAUNCH', appId: YOUTUBE_APP, ...(types.length ? { supportedAppTypes: types } : {}), requestId: id },
          (ns, response) => ns === RECEIVER && (
            (response.type === 'RECEIVER_STATUS' && !!response.status?.applications?.some(isYoutube)) ||
            (response.type === 'LAUNCH_ERROR' && response.requestId === id)
          ), 25000)
        if (launch.type === 'LAUNCH_ERROR') {
          if (types.length) continue
          throw new Error('YouTube could not launch on this Cast receiver: ' + (launch.reason ?? 'unsupported'))
        }
        status = launch
        break
      }
      running = status.status?.applications?.find((app) => isYoutube(app) && !!app.transportId)
      if (!running) {
        // Launch events can arrive before the receiver publishes its transport.
        status = await this.getStatus()
        running = status.status?.applications?.find((app) => isYoutube(app) && !!app.transportId)
      }
    }
    const transport = running?.transportId
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
      (ns, value) => ns === RECEIVER && value.type === 'RECEIVER_STATUS' && (value.requestId === id ||
        (typeof value.status?.volume?.level === 'number' && Math.abs(value.status.volume.level - level) < 0.005)), 6000)
    return response.status?.volume?.level ?? level
  }

  get volume(): number | null { return this.receiverVolume }
  get connected(): boolean { return !this.closed }
  close() { this.fail(new Error('Cast session closed')) }
}

export function getCastSession(): CastPlaybackState | null {
  if (!activeSession) return null
  const { kind, device, lounge, connection } = activeSession
  return {
    deviceId: device.id, deviceName: device.name, kind, ...lounge.playback,
    connected: lounge.connected,
    volume: connection?.volume ?? lounge.volume
  }
}

async function openTarget(target: CastTarget): Promise<CastSession> {
  if (target.kind === 'tv') {
    const screenId = target.device.id
    return { ...target, screenId, lounge: await openPairedYoutubeScreen(screenId) }
  }
  const connection = await CastConnection.open(target.device)
  try {
    const screenId = await connection.openYoutube()
    const lounge = await openUnpairedYoutubeScreen(screenId)
    return { ...target, screenId, connection, lounge }
  } catch (error) {
    connection.close()
    throw error
  }
}

function closeSession(session: CastSession): void {
  session.lounge.close()
  session.connection?.close()
}

function validateVideo(request: Pick<CastPlayRequest, 'videoId'>): void {
  if (!request || typeof request.videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(request.videoId))
    throw new Error('Choose a Cast device and a playable YouTube video')
}

async function playOnTarget(target: CastTarget, request: CastPlayRequest | GoogleCastPlayRequest): Promise<CastPlaybackState> {
  validateVideo(request)
  const previous = activeSession
  if (previous?.kind === target.kind && previous.device.id === target.device.id && previous.lounge.connected) {
    await previous.lounge.setPlaylist(request)
    return getCastSession()!
  }

  const session = await openTarget(target)
  try { await session.lounge.setPlaylist(request) }
  catch (error) { closeSession(session); throw error }

  activeSession = session
  if (previous) {
    try {
      if (previous.screenId !== session.screenId && previous.lounge.connected)
        await previous.lounge.command('clearPlaylist')
    } catch { /* The new receiver has already accepted playback. */ }
    finally { closeSession(previous) }
  }
  return getCastSession()!
}

let pendingOperation = Promise.resolve()

function runCastOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingOperation.then(operation)
  pendingOperation = result.then(() => undefined, () => undefined)
  return result
}

export function playOnGoogleCast(request: GoogleCastPlayRequest): Promise<CastPlaybackState> {
  return runCastOperation(async () => {
    const known = knownDevices.get(request?.deviceId)
    if (!known || Date.now() - known.time > DEVICE_TTL_MS) throw new Error('Cast device not in a recent scan. Refresh the device list.')
    return playOnTarget({ kind: 'google', device: known.device }, request)
  })
}

export function playOnCastScreen(request: CastPlayRequest): Promise<CastPlaybackState> {
  return runCastOperation(async () => {
    const device = (await listCastScreens()).find((screen) => screen.id === request?.screenId)
    if (!device) throw new Error('TV not paired with LokTube')
    return playOnTarget({ kind: 'tv', device }, request)
  })
}

export function playOnActiveCast(request: Pick<CastPlayRequest, 'videoId' | 'videoIds' | 'position'>): Promise<CastPlaybackState> {
  return runCastOperation(async () => {
    validateVideo(request)
    if (!activeSession) throw new Error('No active Cast receiver')
    await activeSession.lounge.setPlaylist(request)
    return getCastSession()!
  })
}

export function controlCast(action: CastAction, value?: number): Promise<CastPlaybackState | null> {
  return runCastOperation(async () => {
    if (action === 'detach') {
      closeCast()
      return null
    }
    const current = activeSession
    if (!current) throw new Error('No active Cast receiver. Select a device from the list again.')
    switch (action) {
      case 'reconnect': {
        const device = current.kind === 'google' ? knownDevices.get(current.device.id)?.device : undefined
        const restored = await openTarget(device ? { kind: 'google', device } : current)
        try { await restored.lounge.command('getNowPlaying') }
        catch (error) { closeSession(restored); throw error }
        activeSession = restored
        closeSession(current)
        break
      }
      case 'volume':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
          throw new Error('Volume must be between 0 and 100%')
        if (current.connection?.connected) await current.connection.setVolume(value)
        else await current.lounge.command('setVolume', { volume: String(Math.round(value * 100)) })
        break
      case 'seek':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400)
          throw new Error('Invalid seek position')
        await current.lounge.command('seekTo', { newTime: String(value) })
        break
      case 'stop':
        await current.lounge.command('clearPlaylist')
        closeCast()
        return null
      case 'play': case 'pause': case 'previous': case 'next':
        await current.lounge.command(action)
        break
      default:
        throw new Error('Unknown Cast action')
    }
    return getCastSession()
  })
}

export function closeCast(): void {
  if (activeSession) closeSession(activeSession)
  activeSession = null
}
