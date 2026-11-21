# Flatpak / Flathub packaging

This directory holds the AppStream metadata and packaging notes for the planned
Flathub distribution. The application ID intentionally matches the existing
Electron/Linux identity, `com.riberojuanca.worldtube`, to preserve the
application's established desktop integration.

## Status

The metadata is a starting point, **not yet a Flathub-submittable package**.
Do not submit this directory to Flathub until the source-build manifest and
offline dependency sources have been generated and tested.

LokTube uses Electron 43 and pnpm 12. Flathub builds must compile the app from
source in the Flatpak sandbox. Uploading or repackaging the existing AppImage
or DEB is not an acceptable substitute. The pnpm dependency graph (including
native/runtime dependencies and the project's patched youtubei.js dependency)
must be represented as pinned, verifiable sources so the build can run offline.

## Required packaging work

1. Generate a complete source list from `pnpm-lock.yaml` with the current
   `flatpak-node-generator` tooling. Confirm it handles pnpm lockfile v9,
   pnpm 12, optional platform packages, and the project's patched dependency.
2. Add a Flatpak manifest for x86_64 first, building Electron and the renderer
   from the repository source. Keep network access out of the build phase.
3. Install the desktop file, scalable and raster icons, AppStream metadata,
   and complete license/third-party notices into the standard Flatpak paths.
4. Grant only the runtime permissions actually required. YouTube playback,
   account sign-in, downloads, file selection, and media-key integration need
   explicit testing under the Flatpak sandbox. Prefer desktop portals over
   broad filesystem access.
5. Test installation, launch, Google sign-in, video/audio playback, downloads,
   file chooser, external links, incognito mode, media keys, and upgrade
   behavior on COSMIC and at least one other Wayland desktop.
6. Validate the final manifest with Flathub's tooling and submit it through
   Flathub's `new-pr` branch only after the source build passes.

## Updates

Flatpak sets `FLATPAK_ID` in the application environment. LokTube uses that
signal to suppress `electron-updater` and leaves update delivery to the
installed Flatpak remote (Flathub, surfaced by COSMIC Store). AppImage and DEB
installations retain the existing GitHub Releases updater.

## References

- https://docs.flathub.org/docs/for-app-authors/submission
- https://docs.flathub.org/docs/for-app-authors/requirements
- https://github.com/flatpak/flatpak-builder-tools
- https://docs.flatpak.org/en/latest/electron.html
