/** Minimal, bounded parser for YouTube TV's length-prefixed Lounge responses. */
export type LoungeEvent = [string, ...unknown[]]

export function parseLoungeFrames(body: string): LoungeEvent[] {
  if (body.length > 1_000_000) throw new Error('TV response was too large')
  const messages: LoungeEvent[] = []
  let cursor = 0
  while (cursor < body.length) {
    const newline = body.indexOf('\n', cursor)
    if (newline < 0) throw new Error('TV response has no frame delimiter')
    const count = body.slice(cursor, newline).trim()
    if (!/^\d{1,7}$/.test(count)) throw new Error('TV response has an invalid frame length')
    const length = Number(count)
    cursor = newline + 1
    if (length < 1 || cursor + length > body.length) throw new Error('TV response contains a truncated frame')
    let frame: unknown
    try { frame = JSON.parse(body.slice(cursor, cursor + length)) }
    catch { throw new Error('TV response contains invalid JSON') }
    if (!Array.isArray(frame)) throw new Error('TV response contains an invalid frame')
    for (const entry of frame) {
      if (!Array.isArray(entry) || !Array.isArray(entry[1]) || typeof entry[1][0] !== 'string') continue
      messages.push(entry[1] as LoungeEvent)
    }
    cursor += length
    if (body[cursor] === '\n') cursor++
  }
  return messages
}

export function extractLoungeSessionIds(body: string): { sid: string; gsessionid: string } {
  const events = parseLoungeFrames(body)
  const sid = events.find((item) => item[0] === 'c')?.[1]
  const gsessionid = events.find((item) => item[0] === 'S')?.[1]
  if (typeof sid !== 'string' || !sid || typeof gsessionid !== 'string' || !gsessionid) {
    throw new Error('TV did not return an active YouTube session. Open YouTube on the TV and retry.')
  }
  return { sid, gsessionid }
}

export function validYoutubeVideoIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > 100) throw new Error('Invalid TV playback queue')
  const unique = [...new Set(ids)]
  if (unique.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(id))) {
    throw new Error('Invalid YouTube video ID in the TV queue')
  }
  return unique as string[]
}
