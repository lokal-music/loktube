# Casting from LokTube

LokTube supports two ways to play YouTube videos on external displays:

1. **Google Cast on your local network** (new): automatic discovery of Cast receivers, including Google Nest Hub, a docked Pixel Tablet, Chromecast, and supported Android/Google TV devices.
2. **Link with TV code** (fallback): manually pair a supported YouTube TV app using its numeric code, even if local Cast discovery does not find it.

Both approaches send the YouTube video and a bounded queue to the receiver. They **do not** mirror the computer's desktop, send cookies, expose LokTube's SABR manifests, or transmit temporary Googlevideo URLs.

## Google Cast setup

1. Connect the LokTube computer and the receiver to the **same local network**. Ensure the router does not isolate wireless clients and local firewall permits outbound UDP multicast to `224.0.0.251:5353`, inbound mDNS replies, and TCP to Cast receiver port 8009.
2. Nest Hub: ensure it is on, connected to Wi-Fi, and able to run YouTube video playback.
3. **Pixel Tablet:** attach it to its Charging Speaker Dock and enable Hub Mode / Cast reception. An undocked Pixel Tablet is not a general-purpose Cast receiver.
4. Start a YouTube video in LokTube. Open **Cast** in the header. A 3.6-second LAN scan populates the **Devices on this network** section; press **Refresh** to scan again.
5. Select a device. LokTube opens the YouTube receiver through Cast V2, queries its YouTube screen ID via MDX, then sends the video/queue through YouTube Lounge. Local playback pauses **only after a successful remote command**.
6. When connected, use **Pause/Resume**, **Stop casting**, **Volume**, or **Seek (s)**. To switch devices, select another discovered receiver; LokTube transfers the playlist and attempts to stop the previous receiver only after the new one accepts the request.\n7. If the LAN connection drops, the menu shows **Disconnected**. **Reconnect** attempts to attach to the same YouTube receiver session without restarting its video. If the device's IP changed or YouTube restarted, refresh the list and select the device to start a fresh handoff.

The source and destination negotiate a YouTube session using the receiver's own app. Google Cast control works only with receivers that support this YouTube receiver and the MDX/Lounge handoff. A device showing in discovery does not guarantee that its YouTube receiver will accept playback.

## Link a TV with code

1. Open the YouTube app on the target TV, Chromecast with Google TV, or streaming device.
2. On that device select **YouTube → Settings → Link with TV code**.
3. Open LokTube **Cast → TV-code pairing**, enter the code, and choose **Link**.
4. Select the saved TV under the code-pairing section. **Stop TV playback** clears its remote playlist. **Forget** removes the saved token, but does not stop playback.

Saved TV-code tokens are stored inside the existing user-data directory with owner-only file permissions where supported, and refreshed when possible. LAN Cast discovery does not store device pairing tokens; only the current app process caches recent device addresses to prevent arbitrary network targets from being supplied by the renderer.

## Limitations

- Google Cast uses mDNS service `_googlecast._tcp.local` and the Cast V2 TLS protocol. Hosts must be found through a recent scan; multicast filtering, VPNs, guest-network isolation, firewalls, and some network adapters may hide receivers.
- Cast V2 receivers usually use self-signed TLS certificates. As with other open-source Cast V2 senders, LokTube does not verify a public PKI chain. Do not expose this feature to untrusted LANs.
- The receiver's YouTube screen protocol and YouTube Lounge playback commands are not public APIs. Device compatibility, playback handoff, and seeking can change without notice. The playback controls reflect **commands sent**, not synchronized video position or status from the receiver. Adjustments made physically or from another sender are not continually tracked.
- This version has no general tab/window mirroring, arbitrary media URL casting, AirPlay, speaker-group control, Cast Connect remote authentication, or synchronized cross-device media session notifications.
- Some receivers report different volume capabilities; Google Cast volume messages target the receiver device and may not control every HDMI/TV speaker setup.
- The local player remains independently controllable; manual playback in LokTube does not automatically mirror each action to the remote device.

## Verification

Automated tests cover mDNS record validation, Cast V2 protobuf message framing, Lounge session parsing, malformed input, and existing desktop behavior. **Physical-device testing is required** for a real Nest Hub, docked Pixel Tablet, and a Chromecast/Google TV receiver, including app launch, receiver permission states, network disconnection, switching devices, volume, seek, and persistent playback.

The tab bar still shows a speaker icon when a tab's media element is actively audible, independent of Cast state.
