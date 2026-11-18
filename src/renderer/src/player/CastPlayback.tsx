import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CastAction, GoogleCastPlayRequest, CastPlaybackState } from '../../../shared/ipc'

type CastSource = Omit<GoogleCastPlayRequest, 'deviceId'>

interface CastPlayback {
  session: CastPlaybackState | null
  castingTab: string | null
  requestedVideoId: string | null
  busy: boolean
  error: string
  start: (tabId: string, videoId: string, send: () => Promise<CastPlaybackState>, pauseLocal: () => void) => Promise<void>
  load: (source: CastSource) => void
  control: (action: CastAction, value?: number) => void
}

const CastContext = createContext<CastPlayback | null>(null)

export function useCastPlayback(): CastPlayback {
  const context = useContext(CastContext)
  if (!context) throw new Error('CastPlaybackProvider missing')
  return context
}

export function CastPlaybackProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CastPlaybackState | null>(null)
  const [castingTab, setCastingTab] = useState<string | null>(null)
  const [requestedVideoId, setRequestedVideoId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    let mounted = true
    let reading = false
    const refresh = async () => {
      if (reading || running.current) return
      const currentRevision = revision.current
      reading = true
      try {
        const state = await window.api.getCastState()
        if (mounted && revision.current === currentRevision) {
          setSession((previous) => {
            if (!state || !previous) return state
            const fields = Object.keys(state) as Array<keyof CastPlaybackState>
            return fields.every((field) => previous[field] === state[field]) ? previous : state
          })
          if (!state) setCastingTab(null)
        }
      } catch { /* Keep the last known state until the next refresh. */ }
      finally { reading = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [])

  const run = useCallback(async (send: () => Promise<CastPlaybackState | null>, accepted?: () => void) => {
    if (running.current) return
    running.current = true
    revision.current++
    setBusy(true)
    setError('')
    try {
      const state = await send()
      setSession(state)
      if (!state) setCastingTab(null)
      accepted?.()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message.replace(/^Error invoking remote method '[^']+': /, ''))
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])

  return <CastContext.Provider value={{
    session, castingTab, requestedVideoId, busy, error,
    start: (tabId, videoId, send, pauseLocal) => run(send, () => {
      pauseLocal()
      setRequestedVideoId(videoId)
      setCastingTab(tabId)
    }),
    load: (source) => {
      if (running.current) return
      setRequestedVideoId(source.videoId)
      void run(() => window.api.playOnActiveCast(source))
    },
    control: (action, value) => void run(() => window.api.controlCast(action, value))
  }}>{children}</CastContext.Provider>
}
