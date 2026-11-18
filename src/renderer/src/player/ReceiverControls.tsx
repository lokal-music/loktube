import { useState } from 'react'
import { Cast, Pause, Play, RotateCw, SkipBack, SkipForward, Square, Volume2 } from 'lucide-react'
import { useCastPlayback } from './CastPlayback'

function formatTime(seconds: number): string {
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function ReceiverSlider({ label, value, max, step, disabled, onCommit }: {
  label: string; value: number; max: number; step: number; disabled: boolean; onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const commit = () => {
    if (draft !== null) onCommit(draft)
    setDraft(null)
  }

  return <input type="range" aria-label={label} min={0} max={max} step={step}
    value={draft ?? value} disabled={disabled}
    onChange={(event) => setDraft(Number(event.currentTarget.value))}
    onPointerUp={commit} onPointerCancel={() => setDraft(null)}
    onKeyUp={(event) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit()
    }}
    onBlur={commit}
    className="wt-media-range min-w-0 flex-1 disabled:opacity-40" />
}

const buttonClass = 'grid h-8 w-8 shrink-0 place-items-center rounded text-neutral-200 hover:bg-neutral-700 disabled:opacity-35'

export function ReceiverControls() {
  const { session, busy, control, error } = useCastPlayback()
  if (!session) return null
  const paused = session.state === 'paused' || session.state === 'idle'
  const disabled = busy || !session.connected
  const Power = !session.connected ? RotateCw : paused ? Play : Pause
  const playbackLabel = !session.connected ? 'Reconnect' : paused ? 'Play' : 'Pause'

  return <div role="group" aria-label="Cast playback controls" className="min-w-0 space-y-1.5 text-neutral-100">
    <div className="flex items-center gap-2 text-xs">
      <Cast aria-hidden="true" className="h-4 w-4 shrink-0 wt-accent-text" />
      <span className="flex-1 truncate">{session.deviceName}</span>
      <span className="shrink-0 text-neutral-400">{!session.connected ? 'Disconnected' : session.state === 'buffering' ? 'Loading…' : null}</span>
    </div>
    <div className="flex items-center gap-2 text-xs tabular-nums">
      <span>{formatTime(session.position)}</span>
      <ReceiverSlider label="Seek on cast device" value={session.position} max={session.duration} step={0.1}
        disabled={disabled || !session.duration} onCommit={(value) => control('seek', value)} />
      <span>{formatTime(session.duration)}</span>
    </div>
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" title="Previous" aria-label="Previous on cast device" disabled={disabled || !session.hasPrevious}
        className={buttonClass} onClick={() => control('previous')}><SkipBack aria-hidden="true" size={16} /></button>
      <button type="button" title={playbackLabel} aria-label={playbackLabel} disabled={busy} className={buttonClass}
        onClick={() => control(!session.connected ? 'reconnect' : paused ? 'play' : 'pause')}><Power aria-hidden="true" size={17} /></button>
      <button type="button" title="Next" aria-label="Next on cast device" disabled={disabled || !session.hasNext}
        className={buttonClass} onClick={() => control('next')}><SkipForward aria-hidden="true" size={16} /></button>
      <button type="button" title="Stop playback on cast device" aria-label="Stop casting" disabled={disabled} className={buttonClass}
        onClick={() => control('stop')}><Square aria-hidden="true" size={15} /></button>
      <button type="button" title="Detach and leave playback on the device" disabled={busy}
        className="h-8 shrink-0 rounded px-2 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-35"
        onClick={() => control('detach')}>Detach</button>
      <div className="ml-auto flex min-w-16 max-w-28 flex-1 items-center gap-1.5">
        <Volume2 aria-hidden="true" size={15} />
        <ReceiverSlider label="Cast device volume" value={session.volume ?? 0.5} max={1} step={0.01}
          disabled={disabled} onCommit={(value) => control('volume', value)} />
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </div>
}
