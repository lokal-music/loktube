import { isIP } from 'node:net'

/** Bounded mDNS and Cast V2 wire codecs. No extra native dependencies. */
export type DnsRecord =
  | { type: 'PTR'; name: string; value: string }
  | { type: 'SRV'; name: string; host: string; port: number }
  | { type: 'TXT'; name: string; properties: Record<string, string> }
  | { type: 'A'; name: string; address: string }

export interface NetworkCastDevice { id: string; name: string; model: string; host: string; port: number }
export const CAST_SERVICE = '_googlecast._tcp.local'

function readName(packet: Buffer, start: number): { value: string; next: number } {
  let offset = start
  let next = -1
  const labels: string[] = []
  const visited = new Set<number>()
  for (let count = 0; count < 32; count++) {
    if (offset >= packet.length || visited.has(offset)) throw new Error('Invalid DNS name')
    visited.add(offset)
    const length = packet[offset]
    if (length === 0) return { value: labels.join('.'), next: next >= 0 ? next : offset + 1 }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error('Truncated DNS pointer')
      const pointer = ((length & 0x3f) << 8) | packet[offset + 1]
      if (pointer >= packet.length) throw new Error('Invalid DNS pointer')
      if (next < 0) next = offset + 2
      offset = pointer
      continue
    }
    if (length > 63 || offset + 1 + length > packet.length) throw new Error('Invalid DNS label')
    labels.push(packet.toString('utf8', offset + 1, offset + 1 + length))
    offset += length + 1
  }
  throw new Error('DNS name exceeds recursion limit')
}

export function dnsQuery(name: string, type: number): Buffer {
  const labels = name.split('.')
  if (![1, 12, 16, 33].includes(type) || labels.some((label) => !label || Buffer.byteLength(label) > 63)) throw new Error('Invalid mDNS question')
  const parts: Buffer[] = []
  for (const label of labels) { const bytes = Buffer.from(label); parts.push(Buffer.from([bytes.length]), bytes) }
  parts.push(Buffer.from([0]))
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 4)
  const suffix = Buffer.alloc(4)
  suffix.writeUInt16BE(type, 0)
  suffix.writeUInt16BE(0x8001, 2) // unicast response requested (QU)
  return Buffer.concat([header, ...parts, suffix])
}

export function parseCastDnsPacket(packet: Buffer): DnsRecord[] {
  if (packet.length < 12 || packet.length > 65535) throw new Error('Invalid DNS packet size')
  const questions = packet.readUInt16BE(4)
  const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10)
  if (questions > 32 || count > 256) throw new Error('Excessive DNS records')
  let offset = 12
  for (let i = 0; i < questions; i++) {
    offset = readName(packet, offset).next
    if (offset + 4 > packet.length) throw new Error('Truncated DNS question')
    offset += 4
  }
  const records: DnsRecord[] = []
  for (let i = 0; i < count; i++) {
    const name = readName(packet, offset)
    offset = name.next
    if (offset + 10 > packet.length) throw new Error('Truncated DNS record')
    const type = packet.readUInt16BE(offset)
    const length = packet.readUInt16BE(offset + 8)
    const start = offset + 10
    const end = start + length
    if (end > packet.length) throw new Error('Truncated DNS record payload')
    offset = end
    if (type === 12) {
      const ptr = readName(packet, start)
      if (ptr.next <= end) records.push({ type: 'PTR', name: name.value, value: ptr.value })
    } else if (type === 33 && length >= 6) {
      const target = readName(packet, start + 6)
      if (target.next <= end) records.push({ type: 'SRV', name: name.value, host: target.value, port: packet.readUInt16BE(start + 4) })
    } else if (type === 1 && length === 4) {
      records.push({ type: 'A', name: name.value, address: [...packet.subarray(start, end)].join('.') })
    } else if (type === 16) {
      const properties: Record<string, string> = {}
      for (let cursor = start; cursor < end;) {
        const size = packet[cursor++]
        if (cursor + size > end) throw new Error('Invalid TXT record')
        const item = packet.toString('utf8', cursor, cursor + size)
        cursor += size
        const equal = item.indexOf('=')
        if (equal > 0 && equal < 40) properties[item.slice(0, equal).toLowerCase()] = item.slice(equal + 1, equal + 201)
      }
      records.push({ type: 'TXT', name: name.value, properties })
    }
  }
  return records
}

export function collectCastDevices(records: DnsRecord[]): NetworkCastDevice[] {
  const key = (value: string) => value.toLowerCase().replace(/\.$/, '')
  const instances = new Set(records.filter((item): item is Extract<DnsRecord, { type: 'PTR' }> => item.type === 'PTR' && key(item.name) === CAST_SERVICE).map((item) => key(item.value)))
  const hosts = new Map(records.filter((item): item is Extract<DnsRecord, { type: 'A' }> => item.type === 'A').map((item) => [key(item.name), item.address]))
  const services = new Map(records.filter((item): item is Extract<DnsRecord, { type: 'SRV' }> => item.type === 'SRV').map((item) => [key(item.name), item]))
  const metadata = new Map(records.filter((item): item is Extract<DnsRecord, { type: 'TXT' }> => item.type === 'TXT').map((item) => [key(item.name), item.properties]))
  const devices = new Map<string, NetworkCastDevice>()
  for (const instance of instances) {
    const srv = services.get(instance)
    if (!srv || srv.port < 1 || srv.port > 65535) continue
    const host = hosts.get(key(srv.host))
    if (!host || isIP(host) !== 4) continue
    const txt = metadata.get(instance) ?? {}
    const id = txt.id?.match(/^[a-fA-F0-9-]{8,80}$/) ? txt.id : instance
    const name = txt.fn?.trim() || instance.split('._googlecast.')[0]
    if (name.length > 150 || id.length > 200) continue
    devices.set(id, { id, name, model: txt.md ?? '', host, port: srv.port })
  }
  return [...devices.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Cast V2 CastMessage (cast_channel.proto) uses protobuf over a 4-byte BE
// frame length. Encode only text payload messages, the fields this sender uses.
function varint(value: number): Buffer {
  const bytes: number[] = []
  do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; bytes.push(byte) } while (value)
  return Buffer.from(bytes)
}
function writeString(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes])
}
export interface CastWireMessage { sourceId: string; destinationId: string; namespace: string; payload: string }
export function encodeCastMessage(message: CastWireMessage): Buffer {
  const payload = Buffer.concat([
    Buffer.from([8, 0]), // protocol_version=CASTV2_1_0
    writeString(2, message.sourceId), writeString(3, message.destinationId),
    writeString(4, message.namespace), Buffer.from([40, 0]), writeString(6, message.payload)
  ])
  if (payload.length > 65536) throw new Error('Cast message too large')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  return Buffer.concat([length, payload])
}
function readVarint(packet: Buffer, from: number): { value: number; end: number } {
  let value = 0
  for (let i = 0; i < 7; i++) {
    if (from + i >= packet.length) throw new Error('Truncated protobuf integer')
    const byte = packet[from + i]
    value += (byte & 0x7f) * 2 ** (7 * i)
    if (!(byte & 0x80)) return { value, end: from + i + 1 }
  }
  throw new Error('Protobuf integer too large')
}
export function decodeCastMessage(packet: Buffer): CastWireMessage {
  const strings = new Map<number, string>()
  let cursor = 0
  for (let fields = 0; cursor < packet.length && fields < 20; fields++) {
    const tag = readVarint(packet, cursor)
    cursor = tag.end
    const field = tag.value >> 3
    const wire = tag.value & 7
    if (wire === 0) cursor = readVarint(packet, cursor).end
    else if (wire === 2) {
      const length = readVarint(packet, cursor)
      cursor = length.end
      if (length.value > 65536 || cursor + length.value > packet.length) throw new Error('Malformed Cast payload')
      if ([2, 3, 4, 6].includes(field)) strings.set(field, packet.toString('utf8', cursor, cursor + length.value))
      cursor += length.value
    } else throw new Error('Unsupported Cast protobuf wire type')
  }
  if (!strings.has(2) || !strings.has(3) || !strings.has(4) || !strings.has(6)) throw new Error('Cast message missing required fields')
  return { sourceId: strings.get(2)!, destinationId: strings.get(3)!, namespace: strings.get(4)!, payload: strings.get(6)! }
}
