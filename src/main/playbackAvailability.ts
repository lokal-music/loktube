/**
 * Keep upstream playback denials separate from manifest generation. YouTube can
 * respond to a valid player request without any streaming formats, notably
 * after an anonymous visitor receives LOGIN_REQUIRED partway through a session.
 */
export interface PlaybackResponse {
  playability_status?: { status?: string | null } | null
  streaming_data?: unknown
}

export function playbackStatus(info: PlaybackResponse): string {
  return info.playability_status?.status ?? 'UNKNOWN'
}

export function assertPlayableVideo(info: PlaybackResponse, hasAccount: boolean, incognito = false): void {
  const status = playbackStatus(info)
  if (status === 'LOGIN_REQUIRED') {
    if (incognito) throw new Error('YouTube declined signed-out playback in this incognito session. Retry the video or open it on YouTube to check any verification or availability requirements. Your connected account is not used in incognito.')
    throw new Error(hasAccount
      ? 'YouTube declined playback, including through your connected account. Open YouTube in your browser and complete any account verification, then reconnect your account in LokTube if necessary.'
      : 'YouTube requires a signed-in account for playback. Connect your YouTube account in Account & privacy, or complete any verification requested by YouTube in your browser.')
  }
  if (status !== 'OK') {
    throw new Error(`YouTube cannot play this video (status: ${status}). Open the video on YouTube to see any account or availability requirements.`)
  }
  if (!info.streaming_data) {
    throw new Error('YouTube returned no streaming formats for this video. Retry later or open the video on YouTube.')
  }
}

/** Exactly one account retry; never loop over alternate clients or retry restrictions. */
export async function getPlayableResponse<T extends PlaybackResponse>(
  requestAnonymous: () => Promise<T>,
  requestSignedIn?: () => Promise<T>,
  onFallbackFailure?: (error: unknown) => void,
  incognito = false
): Promise<{ info: T; fromAccount: boolean }> {
  const anonymous = await requestAnonymous()
  if (playbackStatus(anonymous) !== 'LOGIN_REQUIRED' || !requestSignedIn) {
    assertPlayableVideo(anonymous, Boolean(requestSignedIn), incognito)
    return { info: anonymous, fromAccount: false }
  }

  let signedIn: T
  try {
    signedIn = await requestSignedIn()
  } catch (error) {
    onFallbackFailure?.(error)
    assertPlayableVideo(anonymous, true)
    throw new Error('YouTube account playback could not be checked.')
  }

  assertPlayableVideo(signedIn, true)
  return { info: signedIn, fromAccount: true }
}

/** One public watch-page fallback for a rejected guest API request. */
export async function getGuestPlaybackResponse<T extends PlaybackResponse>(
  requestApi: () => Promise<T>,
  requestPublicPage: () => Promise<T>,
  reportFailure: (error: unknown) => void
): Promise<T> {
  const initial = await requestApi()
  if (playbackStatus(initial) !== 'LOGIN_REQUIRED') return initial
  try { return await requestPublicPage() }
  catch (error) { reportFailure(error); return initial }
}
