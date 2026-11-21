# Flatpak / Flathub packaging

The AppStream metadata uses the established Linux application ID
`com.riberojuanca.worldtube` so a future Flatpak can coexist with the
existing LokTube desktop identity. The visible application name is **LokTube**
and the developer attribution is **Cheyckit**.

## Current status

This directory is not yet a publishable Flatpak. In particular, there is no
verified Flatpak manifest or committed offline dependency source set. Do not
submit it to Flathub or advertise it as installable until the complete build
and runtime checks pass.

LokTube uses Electron 43 and pnpm 12.4.1 with a pnpm v9 lockfile and a patched
`youtubei.js` dependency. Flathub builds must compile from repository source
inside the Flatpak sandbox; repackaging the AppImage or DEB is not acceptable.

## Reproducible dependency-source generation

The workflow `.github/workflows/flatpak-sources.yml` runs
`flatpak-node-generator` against the committed lockfile using the pnpm v11
store compatibility mode required for pnpm 12. It also requests the matching
Electron FFmpeg archive and validates the AppStream metadata. The generated
JSON is uploaded as the
`loktube-flatpak-generated-sources` Actions artifact.

This is an initial compatibility gate, not proof that the application can
already be built offline. Review the generated output for the patched
`youtubei.js` source and all platform-specific packages before committing it
as `generated-sources.json`.

## Remaining work before Flathub submission

1. Confirm source generation succeeds and includes every dependency, including
   the patched `youtubei.js` source and Electron runtime assets.
2. Add a Flatpak manifest for x86_64 using the generated source set and a
   supported Electron BaseApp / Node SDK extension combination.
3. Build LokTube from source with network access disabled during the build.
   The build must not rely on electron-builder downloading Electron, FFmpeg,
   or other artifacts at build time.
4. Install the correct desktop entry, scalable and raster icons, AppStream
   metadata, and complete license / third-party notices.
5. Grant only required sandbox permissions. Test YouTube playback, browser
   sign-in, downloads, file chooser, external links, incognito mode, media
   keys, and upgrade behavior on COSMIC and another Wayland desktop.
6. Validate with Flathub tooling, then submit through Flathub's `new-pr`
   branch only after the build and runtime tests pass.

## Updates

Flatpak sets `FLATPAK_ID` in the application environment. LokTube uses this
signal to suppress `electron-updater` and leaves update delivery to the
configured Flatpak remote. AppImage and DEB installations retain the existing
GitHub Releases updater.

## References

- https://docs.flathub.org/docs/for-app-authors/submission
- https://docs.flathub.org/docs/for-app-authors/requirements
- https://github.com/flatpak/flatpak-builder-tools
- https://docs.flatpak.org/en/latest/electron.html
