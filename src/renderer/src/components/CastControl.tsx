import { useEffect, useRef, useState } from 'react'
import { Cast, LoaderCircle, MonitorPlay, Plus, Trash2, X } from 'lucide-react'
import { useGlobalPlayer } from '../player/GlobalPlayerContext'
import { PLAYER_COMMAND_EVENT, PLAYER_STATE_EVENT, type PlayerCommandDetail, type PlayerStateDetail } from '../player/events'
import type { CastScreen } from '../../../shared/ipc'

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/

/** The TV uses its own YouTube playback, not a copy of the local video element. */
export function CastControl() {
  const player = useGlobalPlayer()
  const outerRef = useRef<HTMLDivElement>(null)
  const playbackRef = useRef(new Map<string, PlayerStateDetail>())
  const [open, setOpen] = useState(false)
  const [screens, setScreens] = useState<CastScreen[]>([])
  const [activeScreenId, setActiveScreenId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let mounted = true
    void window.api.listCastScreens().then((items) => {
      if (mounted) setScreens(items)
    }).catch((reason: unknown) => {
      if (mounted) setError(describeCastError(reason))
    }).finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const update = (event: Event) => {
      const value = (event as CustomEvent<PlayerStateDetail>).detail
      if (value?.tabId) playbackRef.current.set(value.tabId, value)
    }
    window.addEventListener(PLAYER_STATE_EVENT, update)
    return () => window.removeEventListener(PLAYER_STATE_EVENT, update)
  }, [])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!outerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const clearMessages = () => { setError(''); setNotice('') }
  const active = screens.find((item) => item.id === activeScreenId)
  const isBusy = pairing || busyId !== null

  async function pair() {
    if (isBusy) return
    clearMessages()
    setPairing(true)
    try {
      const screen = await window.api.pairCastScreen(code)
      setScreens((items) => [...items.filter((item) => item.id !== screen.id), screen])
      setCode('')
      setNotice('TV linked. Select it below to play your video.')
    } catch (reason) {
      setError(describeCastError(reason))
    } finally {
      setPairing(false)
    }
  }

  async function playOnTV(screen: CastScreen) {
    if (isBusy) return
    if (!player.videoId || !VIDEO_ID.test(player.videoId)) {
      setError('Start a YouTube video or song in LokTube before casting.')
      return
    }
    clearMessages()
    setBusyId(screen.id)
    const previous = activeScreenId
    try {
      const ownerId = player.ownerTabId
      window.dispatchEvent(new CustomEvent<PlayerCommandDetail>(PLAYER_COMMAND_EVENT, { detail: { tabId: ownerId, action: 'sync' } }))
      const current = playbackRef.current.get(ownerId)
      const sourceQueue = player.playbackMode === 'music' ? player.musicQueue : player.videoQueue
      const ids = sourceQueue.map((item) => item.videoId).filter((id) => VIDEO_ID.test(id))
      const index = ids.indexOf(player.videoId)
      // Keep the current video and nearby queue, without uploading an unbounded playlist.
      const projected = index >= 0 ? ids.slice(Math.max(0, index - 15), index + 85) : [player.videoId]
      await window.api.playOnCastScreen({
        screenId: screen.id,
        videoId: player.videoId,
        videoIds: projected,
        position: current?.videoId === player.videoId ? current.currentTime : 0
      })
      // Only pause local playback after the receiver has accepted the command.
      window.dispatchEvent(new CustomEvent<PlayerCommandDetail>(PLAYER_COMMAND_EVENT, { detail: { tabId: ownerId, action: 'pause' } }))
      setActiveScreenId(screen.id)
      setNotice('Playback sent to ' + screen.name + '.')
      if (previous && previous !== screen.id) {
        try { await window.api.stopCastScreen(previous) }
        catch { setError('The previous TV may still be playing. Stop it on that TV if needed.') }
      }
    } catch (reason) {
      setError(describeCastError(reason))
    } finally {
      setBusyId(null)
    }
  }

  async function stopTV() {
    if (!activeScreenId || isBusy) return
    clearMessages()
    setBusyId(activeScreenId)
    try {
      await window.api.stopCastScreen(activeScreenId)
      setActiveScreenId(null)
      setNotice('TV playback stopped. Use the local player to resume here.')
    } catch (reason) {
      setError(describeCastError(reason))
    } finally {
      setBusyId(null)
    }
  }

  async function forget(screen: CastScreen) {
    if (isBusy) return
    clearMessages()
    setBusyId(screen.id)
    try {
      await window.api.forgetCastScreen(screen.id)
      setScreens((items) => items.filter((item) => item.id !== screen.id))
      if (activeScreenId === screen.id) setActiveScreenId(null)
      setNotice('TV removed from saved devices. This does not stop playback on the TV.')
    } catch (reason) {
      setError(describeCastError(reason))
    } finally {
      setBusyId(null)
    }
  }

  return <div ref={outerRef} className="relative shrink-0">
    <button type="button" aria-label={active ? 'Casting to ' + active.name : 'Cast to TV'}
      aria-haspopup="dialog" aria-expanded={open} title={active ? 'Casting to ' + active.name : 'Cast to TV'}
      onClick={() => setOpen((current) => !current)}
      className={'flex h-10 max-w-44 items-center gap-2 rounded px-2 text-sm hover:bg-neutral-800 hover:text-white ' +
        (active ? 'wt-accent-text' : 'text-neutral-300')}>
      <Cast aria-hidden="true" className="h-5 w-5 shrink-0" strokeWidth={1.8} />
      <span className="hidden max-w-28 truncate min-[900px]:inline">{active ? active.name : 'Cast'}</span>
    </button>
    {open && <div role="dialog" aria-label="Cast to a TV"
      className="absolute right-0 top-[calc(100%+8px)] z-[120] w-[340px] max-w-[calc(100vw-16px)] rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm text-neutral-100 shadow-2xl shadow-black/60">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">Cast to TV</h2>
        <button type="button" aria-label="Close casting menu" onClick={() => setOpen(false)}
          className="grid h-7 w-7 place-items-center rounded text-neutral-400 hover:bg-neutral-700">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <p className="mb-3 text-xs leading-5 text-neutral-400">
        Link the YouTube app on your TV, Chromecast with Google TV, or streaming device using its TV code.
      </p>
      {active && <div className="mb-3 rounded-md border border-neutral-700 bg-neutral-800/70 p-3">
        <div className="mb-2 flex items-center gap-2">
          <MonitorPlay aria-hidden="true" className="h-4 w-4 wt-accent-text" />
          <span className="min-w-0 flex-1 truncate font-medium">{active.name}</span>
          <span className="text-xs text-neutral-400">TV playback</span>
        </div>
        <button type="button" disabled={isBusy} onClick={() => void stopTV()}
          className="rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600 disabled:opacity-40">
          Stop TV playback
        </button>
      </div>}
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Linked TVs</h3>
      {loading ? <p className="mb-3 text-xs text-neutral-400">Loading TVs…</p> : screens.length === 0
        ? <p className="mb-3 text-xs text-neutral-400">No TVs linked yet.</p>
        : <div className="mb-3 max-h-52 space-y-1 overflow-y-auto">
          {screens.map((screen) => <div key={screen.id} className="flex items-center gap-1 rounded bg-neutral-800/60 p-1">
            <button type="button" disabled={isBusy || !player.videoId} onClick={() => void playOnTV(screen)}
              title={player.videoId ? 'Play current video on ' + screen.name : 'Play a video to enable casting'}
              className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40">
              {busyId === screen.id ? <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
                : <MonitorPlay aria-hidden="true" className="h-4 w-4 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{screen.name}</span>
              <span className="text-xs text-neutral-400">{activeScreenId === screen.id ? 'Replay' : 'Play'}</span>
            </button>
            <button type="button" aria-label={'Forget ' + screen.name} title={'Forget ' + screen.name}
              onClick={() => void forget(screen)} disabled={isBusy}
              className="grid h-8 w-8 shrink-0 place-items-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-white disabled:opacity-40">
              <Trash2 aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>)}
        </div>}
      <div className="border-t border-neutral-700 pt-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Plus aria-hidden="true" className="h-4 w-4" /> Link a TV with code
        </div>
        <p className="mb-2 text-xs leading-5 text-neutral-400">
          On your TV: YouTube → Settings → Link with TV code.
        </p>
        <form onSubmit={(event) => { event.preventDefault(); void pair() }} className="flex gap-2">
          <input aria-label="TV pairing code" inputMode="numeric" autoComplete="off"
            value={code} onChange={(event) => setCode(event.target.value)}
            placeholder="TV code" maxLength={24}
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          <button type="submit" disabled={isBusy || code.trim().length < 6}
            className="rounded bg-neutral-100 px-3 py-2 text-xs font-medium text-neutral-950 hover:bg-white disabled:opacity-40">
            {pairing ? 'Linking…' : 'Link'}
          </button>
        </form>
      </div>
      {error && <p role="alert" className="mt-3 text-xs leading-5 text-red-300">{error}</p>}
      {notice && <p role="status" className="mt-3 text-xs leading-5 text-neutral-300">{notice}</p>}
      <p className="mt-3 text-[11px] leading-4 text-neutral-500">
        Uses YouTube TV pairing, not desktop or screen mirroring. The TV plays directly from YouTube.
      </p>
    </div>}
  </div>
}

function describeCastError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': /, '')
}
