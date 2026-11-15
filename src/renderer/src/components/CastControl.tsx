import { useCallback, useEffect, useRef, useState } from 'react'
import { Cast, LoaderCircle, MonitorPlay, Plus, RefreshCw, Trash2, X, Volume2 } from 'lucide-react'
import { useGlobalPlayer } from '../player/GlobalPlayerContext'
import { PLAYER_COMMAND_EVENT, PLAYER_STATE_EVENT, type PlayerCommandDetail, type PlayerStateDetail } from '../player/events'
import type { CastScreen, GoogleCastAction, GoogleCastDevice, GoogleCastPlayRequest, GoogleCastState } from '../../../shared/ipc'

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/

function describeError(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason)
  return text.replace(/^Error invoking remote method '[^']+': /, '')
}

export function CastControl() {
  const player = useGlobalPlayer()
  const outerRef = useRef<HTMLDivElement>(null)
  const playbackRef = useRef(new Map<string, PlayerStateDetail>())
  const scanId = useRef(0)
  const [open, setOpen] = useState(false)
  const [screens, setScreens] = useState<CastScreen[]>([])
  const [devices, setDevices] = useState<GoogleCastDevice[]>([])
  const [activeTV, setActiveTV] = useState<string | null>(null)
  const [activeCast, setActiveCast] = useState<GoogleCastState | null>(null)
  const [code, setCode] = useState('')
  const [seekSeconds, setSeekSeconds] = useState('0')
  const [scanBusy, setScanBusy] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    const id = ++scanId.current
    setScanBusy(true)
    try {
      const result = await window.api.discoverGoogleCast()
      if (id === scanId.current) setDevices(result)
    } catch (reason) {
      if (id === scanId.current) setError(describeError(reason))
    } finally {
      if (id === scanId.current) setScanBusy(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void Promise.all([window.api.listCastScreens(), window.api.getGoogleCastState()])
      .then(([paired, session]) => {
        if (!mounted) return
        setScreens(paired)
        setActiveCast(session)
      }).catch((reason) => { if (mounted) setError(describeError(reason)) })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false; scanId.current++ }
  }, [])
  useEffect(() => {
    if (!open) return
    void refresh()
    void window.api.getGoogleCastState().then(setActiveCast).catch((reason) => setError(describeError(reason)))
  }, [open, refresh])
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<PlayerStateDetail>).detail
      if (detail?.tabId) playbackRef.current.set(detail.tabId, detail)
    }
    window.addEventListener(PLAYER_STATE_EVENT, update)
    return () => window.removeEventListener(PLAYER_STATE_EVENT, update)
  }, [])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!outerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const clear = () => { setError(''); setNotice('') }
  const isBusy = busy !== null
  const activeTVName = screens.find((item) => item.id === activeTV)?.name
  const activeName = activeCast?.deviceName ?? activeTVName
  const canSend = Boolean(player.videoId && VIDEO_ID.test(player.videoId))

  function playback(): Omit<GoogleCastPlayRequest, 'deviceId'> | null {
    if (!player.videoId || !VIDEO_ID.test(player.videoId)) { setError('Start a YouTube video or song before casting.'); return null }
    const ownerId = player.ownerTabId
    window.dispatchEvent(new CustomEvent<PlayerCommandDetail>(PLAYER_COMMAND_EVENT, { detail: { tabId: ownerId, action: 'sync' } }))
    const current = playbackRef.current.get(ownerId)
    const source = player.playbackMode === 'music' ? player.musicQueue : player.videoQueue
    const ids = source.map((item) => item.videoId).filter((id) => VIDEO_ID.test(id))
    const index = ids.indexOf(player.videoId)
    const videoIds = index >= 0 ? ids.slice(Math.max(0, index - 15), index + 85) : [player.videoId]
    return { videoId: player.videoId, videoIds, position: current?.videoId === player.videoId ? current.currentTime : 0 }
  }

  function pauseLocal() {
    window.dispatchEvent(new CustomEvent<PlayerCommandDetail>(PLAYER_COMMAND_EVENT, {
      detail: { tabId: player.ownerTabId, action: 'pause' }
    }))
  }

  async function sendToGoogle(device: GoogleCastDevice) {
    if (isBusy) return
    clear()
    const source = playback()
    if (!source) return
    setBusy('google:' + device.id)
    try {
      const state = await window.api.playOnGoogleCast({ ...source, deviceId: device.id })
      setActiveCast(state)
      setSeekSeconds(String(Math.floor(source.position ?? 0)))
      pauseLocal()
      if (activeTV) {
        try { await window.api.stopCastScreen(activeTV) }
        catch { setError('Playback transferred, but the previous TV may still be playing.') }
        setActiveTV(null)
      }
      setNotice('Playing on ' + state.deviceName + '. Control it below.')
    } catch (reason) { setError(describeError(reason)) }
    finally { setBusy(null) }
  }

  async function control(action: GoogleCastAction, value?: number) {
    if (isBusy || !activeCast) return
    clear()
    setBusy('control:' + action)
    try {
      const result = await window.api.controlGoogleCast(action, value)
      setActiveCast(result)
      if (action === 'stop') setNotice('Cast stopped. Resume playback locally when ready.')
      if (action === 'reconnect') setNotice('Reconnected to ' + result?.deviceName + '.')
      if (action === 'seek') setNotice('Seek requested at ' + Math.floor(value ?? 0) + 's.')
    } catch (reason) {
      setError(describeError(reason))
      // If a receiver went away, let the next scan/session refresh recover.
      void window.api.getGoogleCastState().then(setActiveCast).catch(() => undefined)
    } finally { setBusy(null) }
  }

  async function sendToTV(screen: CastScreen) {
    if (isBusy) return
    clear()
    const source = playback()
    if (!source) return
    setBusy('tv:' + screen.id)
    try {
      await window.api.playOnCastScreen({ ...source, screenId: screen.id })
      pauseLocal()
      if (activeCast) {
        try { await window.api.controlGoogleCast('stop') }
        catch { setError('The previous Cast device may still be playing.') }
        setActiveCast(null)
      }
      if (activeTV && activeTV !== screen.id) {
        try { await window.api.stopCastScreen(activeTV) }
        catch { setError('The previous TV may still be playing.') }
      }
      setActiveTV(screen.id)
      setNotice('Playback sent to ' + screen.name + '.')
    } catch (reason) { setError(describeError(reason)) }
    finally { setBusy(null) }
  }

  async function pair() {
    if (isBusy) return
    clear()
    setBusy('pair')
    try {
      const screen = await window.api.pairCastScreen(code)
      setScreens((items) => [...items.filter((item) => item.id !== screen.id), screen])
      setCode('')
      setNotice('TV linked. Select it below to start playback.')
    } catch (reason) { setError(describeError(reason)) }
    finally { setBusy(null) }
  }

  async function forget(screen: CastScreen) {
    if (isBusy) return
    clear()
    setBusy('forget:' + screen.id)
    try {
      await window.api.forgetCastScreen(screen.id)
      setScreens((items) => items.filter((item) => item.id !== screen.id))
      if (activeTV === screen.id) setActiveTV(null)
      setNotice('Removed the pairing. Existing playback may continue on the TV.')
    } catch (reason) { setError(describeError(reason)) }
    finally { setBusy(null) }
  }

  async function stopTV() {
    if (!activeTV || isBusy) return
    clear()
    setBusy('stop-tv')
    try {
      await window.api.stopCastScreen(activeTV)
      setActiveTV(null)
      setNotice('TV playback stopped.')
    } catch (reason) { setError(describeError(reason)) }
    finally { setBusy(null) }
  }

  return <div ref={outerRef} className="relative shrink-0">
    <button type="button" aria-label={activeName ? 'Casting to ' + activeName : 'Cast to a device'}
      aria-haspopup="dialog" aria-expanded={open} title={activeName ? 'Casting to ' + activeName : 'Cast to a device'}
      onClick={() => setOpen((value) => !value)}
      className={'flex h-10 max-w-44 items-center gap-2 rounded px-2 text-sm hover:bg-neutral-800 hover:text-white ' +
        (activeName ? 'wt-accent-text' : 'text-neutral-300')}>
      <Cast aria-hidden="true" className="h-5 w-5 shrink-0" strokeWidth={1.8} />
      <span className="hidden max-w-28 truncate min-[900px]:inline">{activeName ?? 'Cast'}</span>
    </button>
    {open && <div role="dialog" aria-label="Cast to a device"
      className="absolute right-0 top-[calc(100%+8px)] z-[120] max-h-[min(85vh,690px)] w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm text-neutral-100 shadow-2xl shadow-black/60">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">Cast to a device</h2>
        <button type="button" aria-label="Close casting menu" onClick={() => setOpen(false)}
          className="grid h-7 w-7 place-items-center rounded text-neutral-400 hover:bg-neutral-700"><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <p className="mb-3 text-xs leading-5 text-neutral-400">Choose a Google Cast display on your Wi-Fi. Pixel Tablet must be docked; Nest Hub and supported Google TV devices should appear automatically.</p>

      {activeCast && <div className="mb-3 space-y-2 rounded-md border border-neutral-600 bg-neutral-800/70 p-3">
        <div className="flex items-center gap-2">
          <Cast aria-hidden="true" className="h-4 w-4 wt-accent-text" />
          <span className="min-w-0 flex-1 truncate font-semibold">{activeCast.deviceName}</span>
          <span className="text-xs text-neutral-400">{!activeCast.connected ? 'Disconnected' : activeCast.state === 'paused' ? 'Paused' : 'Casting'}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={isBusy} onClick={() => void control(!activeCast.connected ? 'reconnect' : activeCast.state === 'paused' ? 'play' : 'pause')}
            className="rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600 disabled:opacity-40">
            {!activeCast.connected ? 'Reconnect' : activeCast.state === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button type="button" disabled={isBusy} onClick={() => void control('stop')}
            className="rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600 disabled:opacity-40">Stop casting</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <Volume2 className="h-4 w-4" aria-hidden="true" />
          <span className="shrink-0">Volume</span>
          <input aria-label="Cast device volume" type="range" min="0" max="100" step="5"
            value={Math.round((activeCast.volume ?? 0.5) * 100)}
            disabled={isBusy || !activeCast.connected} onChange={(event) => {
              const volume = Number(event.target.value) / 100
              setActiveCast((prev) => prev ? { ...prev, volume } : null)
            }}
            onPointerUp={(event) => {
              const value = Number((event.currentTarget as HTMLInputElement).value) / 100
              void control('volume', value)
            }}
            onKeyUp={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
                void control('volume', Number(event.currentTarget.value) / 100)
            }}
            className="min-w-0 flex-1" />
          <span className="w-9 text-right">{Math.round((activeCast.volume ?? 0.5) * 100)}%</span>
        </label>
        <form className="flex items-center gap-2" onSubmit={(event) => {
          event.preventDefault()
          void control('seek', Number(seekSeconds))
        }}>
          <label className="shrink-0 text-xs text-neutral-300" htmlFor="google-cast-seek">Seek (s)</label>
          <input id="google-cast-seek" type="number" min="0" max="86400" step="1" inputMode="numeric"
            value={seekSeconds} onChange={(event) => setSeekSeconds(event.target.value)}
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs" />
          <button type="submit" disabled={isBusy || !activeCast.connected || !seekSeconds || !Number.isFinite(Number(seekSeconds))}
            className="rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600 disabled:opacity-40">Seek</button>
        </form>
      </div>}

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Devices on this network</h3>
        <button type="button" onClick={() => void refresh()} disabled={scanBusy || isBusy}
          aria-label="Refresh Cast devices" title="Refresh Cast devices"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40">
          <RefreshCw aria-hidden="true" className={'h-3.5 w-3.5 ' + (scanBusy ? 'animate-spin' : '')} /> Refresh
        </button>
      </div>
      {scanBusy && devices.length === 0 && <p className="mb-3 text-xs text-neutral-400">Searching for Cast receivers…</p>}
      {!scanBusy && devices.length === 0 && <p className="mb-3 text-xs leading-5 text-neutral-400">No devices found. Check that they’re powered on, on the same Wi-Fi network, and that local discovery is allowed by your firewall.</p>}
      {devices.length > 0 && <div className="mb-3 max-h-40 space-y-1 overflow-y-auto">
        {devices.map((device) => <button key={device.id} type="button" disabled={isBusy || !canSend}
          onClick={() => void sendToGoogle(device)}
          title={canSend ? 'Play current YouTube video on ' + device.name : 'Start a YouTube video to cast'}
          className="flex w-full min-w-0 items-center gap-2 rounded bg-neutral-800/60 px-3 py-2 text-left hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40">
          {busy === 'google:' + device.id ? <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" /> : <Cast aria-hidden="true" className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">
            <span className="block truncate">{device.name}</span>
            {device.model && <span className="block truncate text-[11px] text-neutral-400">{device.model}</span>}
          </span>
          <span className="text-xs text-neutral-400">{activeCast?.deviceId === device.id ? 'Replay' : 'Play'}</span>
        </button>)}
      </div>}

      {activeTVName && !activeCast && <div className="mb-3 rounded border border-neutral-700 bg-neutral-800/70 p-2">
        <div className="mb-2 flex gap-2 text-xs"><MonitorPlay className="h-4 w-4" aria-hidden="true" /><span className="flex-1 truncate">{activeTVName}</span><span className="text-neutral-400">TV code</span></div>
        <button type="button" onClick={() => void stopTV()} disabled={isBusy}
          className="rounded bg-neutral-700 px-2 py-1.5 text-xs disabled:opacity-40">Stop TV playback</button>
      </div>}
      <div className="border-t border-neutral-700 pt-3">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          <Plus aria-hidden="true" className="h-4 w-4" /> TV-code pairing (fallback)
        </h3>
        {loading ? <p className="mb-2 text-xs text-neutral-400">Loading linked TVs…</p> :
          screens.length > 0 && <div className="mb-3 max-h-28 space-y-1 overflow-y-auto">
            {screens.map((screen) => <div key={screen.id} className="flex items-center gap-1 rounded bg-neutral-800/60 p-1">
              <button type="button" disabled={isBusy || !canSend} onClick={() => void sendToTV(screen)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-neutral-700 disabled:opacity-40">
                {busy === 'tv:' + screen.id ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <MonitorPlay aria-hidden="true" className="h-4 w-4" />}
                <span className="min-w-0 flex-1 truncate">{screen.name}</span>
                <span className="text-xs text-neutral-400">Play</span>
              </button>
              <button type="button" disabled={isBusy} aria-label={'Forget ' + screen.name} title={'Forget ' + screen.name}
                onClick={() => void forget(screen)}
                className="grid h-8 w-8 place-items-center rounded text-neutral-400 hover:bg-neutral-700 disabled:opacity-40"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
            </div>)}
          </div>}
        <p className="mb-2 text-xs leading-5 text-neutral-400">If your receiver isn’t discoverable, open YouTube on the TV → Settings → Link with TV code.</p>
        <form onSubmit={(event) => { event.preventDefault(); void pair() }} className="flex gap-2">
          <input aria-label="TV pairing code" inputMode="numeric" autoComplete="off" value={code}
            onChange={(event) => setCode(event.target.value)} placeholder="TV code" maxLength={24}
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs outline-none focus:border-neutral-400" />
          <button type="submit" disabled={isBusy || code.trim().length < 6}
            className="rounded bg-neutral-100 px-3 py-2 text-xs font-medium text-neutral-950 hover:bg-white disabled:opacity-40">
            {busy === 'pair' ? 'Linking…' : 'Link'}
          </button>
        </form>
      </div>
      {error && <p role="alert" className="mt-3 text-xs leading-5 text-red-300">{error}</p>}
      {notice && <p role="status" className="mt-3 text-xs leading-5 text-neutral-300">{notice}</p>}
      <p className="mt-3 text-[11px] leading-4 text-neutral-500">Cast devices play using their YouTube receiver. Does not mirror the window. Device controls require an active session; state may lag changes made directly on the receiver.</p>
    </div>}
  </div>
}
