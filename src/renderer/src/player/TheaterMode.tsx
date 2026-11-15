import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppTabs } from '../tabs/AppTabs'
import { THEATER_STATE_EVENT, THEATER_TOGGLE_EVENT } from './events'

const TheaterContext = createContext({ active: false })
export const useTheaterMode = () => useContext(TheaterContext)
const preferenceKey = 'loktube:theater-mode'

export function TheaterModeProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const { activeId } = useAppTabs()
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(preferenceKey) === 'true' } catch { return false }
  })
  const isWatch = pathname.startsWith('/watch/')
  const active = enabled && isWatch

  useEffect(() => {
    try { localStorage.setItem(preferenceKey, String(enabled)) } catch { /* Still works for this session. */ }
  }, [enabled])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(THEATER_STATE_EVENT, { detail: { active } }))
  }, [active, activeId])
  useEffect(() => {
    const toggle = (event: Event) => {
      if (isWatch && (event as CustomEvent<{ tabId: string }>).detail?.tabId === activeId) {
        setEnabled((value) => !value)
        window.scrollTo({ top: 0, behavior: 'instant' })
      }
    }
    const keyboard = (event: KeyboardEvent) => {
      if (!isWatch || document.fullscreenElement || event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], dialog, [role="dialog"]')) return
      if (event.key.toLowerCase() !== 't') return
      event.preventDefault()
      setEnabled((value) => !value)
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    window.addEventListener(THEATER_TOGGLE_EVENT, toggle)
    window.addEventListener('keydown', keyboard)
    return () => {
      window.removeEventListener(THEATER_TOGGLE_EVENT, toggle)
      window.removeEventListener('keydown', keyboard)
    }
  }, [isWatch, activeId])
  return <TheaterContext.Provider value={{ active }}>{children}</TheaterContext.Provider>
}

// An immediate CSS :hover retracts mid-animation when the pointer moves off the
// edge trigger. Keep the reveal while crossing the toolbar, but do not let an
// inactive pointer or a mouse-focused tab button pin the header open forever.
// Keyboard navigation, text entry and open menus must remain usable.
export function useTheaterHeaderReveal(active: boolean): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    setVisible(false)
    if (!active) return
    let shown = false
    let lastX = Number.POSITIVE_INFINITY
    let lastY = Number.POSITIVE_INFINITY
    let pointerFocused = false
    let pointerHeld = false
    let autoHiding = false
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const toolbar = '.wt-topbar, .wt-tabbar, .wt-theater-top-edge'
    const idleDelay = 2500
    const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined } }
    const cancelIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined } }
    const focusedElement = () => document.activeElement instanceof HTMLElement &&
      document.activeElement.closest(toolbar) ? document.activeElement : null
    const focused = () => !!focusedElement()
    const hovered = () => Number.isFinite(lastX) && Number.isFinite(lastY) &&
      !!document.elementFromPoint(lastX, lastY)?.closest(toolbar)
    const protectedInteraction = () => {
      const element = focusedElement()
      return !!document.querySelector('.wt-topbar [role="dialog"], [role="menu"]') ||
        !!element && (
          !pointerFocused ||
          !!element.closest('[role="dialog"], [role="menu"]') ||
          element.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')
        )
    }
    const retract = () => { shown = false; setVisible(false) }
    const armIdle = () => {
      cancelIdle()
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        if (!shown) return
        if (pointerHeld || protectedInteraction()) {
          // Recheck after an open menu closes; its dismissal may not move
          // focus or generate another pointer event.
          armIdle()
          return
        }
        // The tab that was clicked remains focused after navigation. CSS
        // :focus-within would otherwise keep the header visible even if the
        // hook marks it hidden. Only release *mouse-origin* button focus.
        const element = focusedElement()
        if (element && pointerFocused) {
          autoHiding = true
          element.blur()
          autoHiding = false
        }
        if (!focused()) retract()
      }, idleDelay)
    }
    const show = () => { cancelHide(); shown = true; setVisible(true); armIdle() }
    const hideLater = () => {
      if (hideTimer || focused()) return
      hideTimer = setTimeout(() => {
        hideTimer = undefined
        if (focused() || hovered()) return
        cancelIdle()
        retract()
      }, 180)
    }
    const move = (event: PointerEvent) => {
      lastX = event.clientX
      lastY = event.clientY
      if (document.fullscreenElement) return
      const target = event.target instanceof Element ? event.target : null
      if ((!shown && lastY <= 36) || target?.closest(toolbar)) show()
      else hideLater()
    }
    const down = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(toolbar)) {
        pointerFocused = true
        pointerHeld = true
        show()
      }
    }
    const up = () => { pointerHeld = false }
    const keyboard = (event: KeyboardEvent) => {
      if (!focused()) return
      pointerFocused = false
      if (!event.repeat) show()
    }
    const focus = () => {
      if (autoHiding) return
      if (focused() || hovered()) show()
      else hideLater()
    }
    const leave = () => { lastY = Number.POSITIVE_INFINITY; hideLater() }
    const fullscreen = () => {
      if (document.fullscreenElement) { cancelHide(); cancelIdle(); retract() }
    }
    // Activation often follows a tab click made *before* this hook was active.
    // Mouse-focused tab buttons are not :focus-visible; keyboard-focused ones
    // retain the usual focus-within accessibility behavior.
    const initialFocus = focusedElement()
    pointerFocused = !!initialFocus?.closest('.wt-tabbar') && !initialFocus.matches(':focus-visible')
    if (initialFocus) show()
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('pointerleave', leave)
    document.addEventListener('keydown', keyboard, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', focus)
    document.addEventListener('fullscreenchange', fullscreen)
    return () => {
      cancelHide()
      cancelIdle()
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('pointerleave', leave)
      document.removeEventListener('keydown', keyboard, true)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', focus)
      document.removeEventListener('fullscreenchange', fullscreen)
    }
  }, [active])
  return active && visible
}
