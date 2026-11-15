# Casting from LokTube

The Cast button in the header supports YouTube's **Link with TV code** feature. It sends a YouTube video ID and a bounded playback queue to the YouTube app on the television. The TV fetches and decodes its own streams; LokTube does not expose its SABR manifests, user cookies or temporary stream URLs.

## Pair and play

1. Open the YouTube app on a supported TV, Chromecast with Google TV, or streaming device.
2. Open YouTube **Settings → Link with TV code** on that device.
3. In LokTube's header, open **Cast**, enter the numeric code and select **Link**.
4. Start a video/song in LokTube and choose the paired TV from **Linked TVs**. The device is sent the current video and up to 100 queue entries, starting at the local playback position where available.
5. Local playback pauses only if the remote request succeeds. **Stop TV playback** clears the TV's YouTube playlist. Removing a saved TV only unpairs it from LokTube.

Paired devices and their lounge tokens are stored inside the existing LokTube user-data directory with user-only file permissions where supported. Expired tokens are refreshed automatically when possible. No Google password or YouTube session cookie is sent to the TV.

## Scope and limitations

This is **YouTube TV code-based remote playback**, not generic Google Cast or AirPlay. Automatic local-network discovery, arbitrary Chromecast receivers, tab mirroring, device-volume control, and TV playback-state synchronization are not implemented. Remote queuing uses YouTube's Lounge service and requires a working YouTube app on the receiver; compatibility may change if YouTube changes the private protocol. TV-code pairing, the TV's account/content permissions and a working Internet connection are prerequisites.

Changing videos in LokTube does not silently hijack TV playback; select the device again to send a new video. Once a queue has been handed off, the TV advances it independently.

The tab bar shows a speaker icon when that tab's video element is playing with nonzero output volume, independent of which tab is selected. Muted, paused, unloaded and closed players do not show the indicator. This derives from media-element state, not waveform analysis.

## Verification

Unit coverage includes Lounge frame/session parsing, malformed replies and YouTube video-ID validation. Validate real-device playback on a supported YouTube TV with a fresh TV code, switching to another linked TV, expired-token recovery, and TV disconnection before advertising general receiver compatibility.
