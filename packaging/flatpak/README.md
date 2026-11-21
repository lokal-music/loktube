# Flatpak / Flathub packaging

The Flatpak uses the established Linux application ID
`com.riberojuanca.worldtube` to preserve desktop identity. Its AppStream
display name is **LokTube**, and its developer attribution is **Lokal Music**.

## Current status

The source set, x86_64 manifest, and offline build are now present. On
2026-11-21, GitHub Actions passed AppStream validation, built the Flatpak, and
created an installable CI bundle on commit `af53ed8`, which was merged into
the v2.2.3 release:
[Flatpak build](https://github.com/lokal-music/loktube/actions/runs/44936175046),
[source generation](https://github.com/lokal-music/loktube/actions/runs/44936175175).
This verifies the build, not a real install or runtime on COSMIC. There is no
Flathub listing yet.

LokTube uses Electron 43 and pnpm 12.4.1 with a pnpm v9 lockfile and a patched
`youtubei.js` dependency. Flathub builds must compile from repository source
inside the Flatpak sandbox; repackaging the AppImage or DEB is not acceptable.

## COSMIC Store branding

The published v2.2.3 DEB has `Package: worldtube`; its vendor and maintainer
fields are `riberojuanca`. The configured product name and desktop entry are
already **LokTube**. When COSMIC Store opens a standalone DEB, it uses the
package name for the fallback title and, without AppStream developer metadata,
shows the fallback “WorldTube Developer”. This is package-manager fallback
metadata, not the app's display name or the DEB's vendor value.

Keep the Debian package name `worldtube`: changing it to `loktube` would make
the new DEB a different package instead of an upgrade and could conflict with
files from the existing package. For a COSMIC Store listing with curated
branding, submit the Flatpak and its AppStream metadata to Flathub. This
AppStream developer name does not change the existing Debian vendor or
maintainer fields.

## Remaining work before Flathub submission

1. Install and run the CI-built Flatpak on COSMIC and another Wayland desktop.
   Check YouTube playback, browser sign-in, downloads, file chooser, external
   links, incognito mode, media keys, and upgrade behavior.
2. Run Flathub's manifest and repository linters and address their findings.
3. Review Flathub's current AI-content policy. Flathub requires AI-assisted
   material to be disclosed and does not accept AI-generated or AI-assisted
   manifest content.
4. Submit the app through a pull request against Flathub's `new-pr` branch.
   Flathub review and approval are required before it appears in COSMIC Store.

## Updates

Flatpak sets `FLATPAK_ID` in the application environment. LokTube uses this
signal to suppress `electron-updater` and leaves update delivery to the
configured Flatpak remote. AppImage and DEB installations retain the existing
GitHub Releases updater.

## References

- https://docs.flathub.org/docs/for-app-authors/submission
- https://docs.flathub.org/docs/for-app-authors/requirements
- https://docs.flathub.org/docs/for-app-authors/linter
- https://github.com/flatpak/flatpak-builder-tools
- https://docs.flatpak.org/en/latest/electron.html
