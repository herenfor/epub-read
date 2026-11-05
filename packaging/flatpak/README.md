# Local Flatpak build

Linux Core uses GNOME Platform/SDK 50, with the matching Freedesktop 25.08
Rust Stable and Node 22 SDK extensions. This runtime was checked to provide
GTK 3 and the WebKitGTK 4.1 API. The application ID remains
`dev.epubreader.app`; the Flatpak uses its own sandbox data directory and a
`.Flatpak` single-instance bus name, separate from a native deb instance.

Install Flatpak, flatpak-builder and desktop-file-utils using the distribution's package manager,
then install the build runtimes in a user installation:

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.gnome.Platform//50 org.gnome.Sdk//50 \
  org.freedesktop.Sdk.Extension.rust-stable//25.08 \
  org.freedesktop.Sdk.Extension.node22//25.08
```

Prepare a committed source snapshot, a private pnpm dependency store and
standard Cargo-vendored sources. The host needs Python 3.12+, pnpm, Cargo,
and the locked Cargo crate sources in its registry cache. Fetch missing
crates with `cargo fetch --locked --manifest-path src-tauri/Cargo.toml` first
if needed. Existing worktree dependencies and targets are not overwritten.

```sh
python3 packaging/flatpak/prepare.py --output /path/to/selis-flatpak-build
cd /path/to/selis-flatpak-build
flatpak-builder --user --force-clean --repo=repo build dev.epubreader.app.json
flatpak build-bundle --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  repo SeLis.flatpak dev.epubreader.app
flatpak install --user ./SeLis.flatpak
flatpak run dev.epubreader.app
```

Both the frontend (including its normal type check) and Rust are compiled
offline inside the SDK. The helper uses an exact Git commit; uncommitted
changes are not included. It creates inputs only in the explicitly supplied
directory. Normal source-integrity checking by pnpm and Cargo is retained.

The local input archives preserve the product source and lock files, but are
not yet a public Flathub source manifest. A Flathub submission must provide
fetchable, pinned source/dependency locations and pass its separate checks;
this local recipe does not claim store acceptance.

## Access and test scope

- Display sockets, shared graphics IPC and render-device access are for the
  native WebKitGTK window. PulseAudio is for existing book media playback.
- No `host`/`home` filesystem grant or unrestricted session/system bus is
  requested. File selection is through GTK's native file chooser and its
  document portal integration; the sandbox cannot simply read the host library.
- This candidate targets local reading. Linux exposes the existing copy-on-import
  choice and defaults to copying selected books into its own library. Turning
  the choice off keeps a document-portal link to the source file. Revoked
  document access, watched folders and persistence across a desktop-session
  restart must be verified separately. Network
  access is not granted yet, so LAN transfer/WebDAV are outside this first
  sandbox package's acceptance scope.
- Native/deb data is not moved into the sandbox automatically. Never run a
  new test against an existing sandbox library without checking ownership.
- A rendering check under WSLg or software graphics is not a native GPU-driver
  compatibility result. Upgrade and revoked-portal permissions need their own
  direct checks; they are not implied by a successful build.
- Install the distribution's CJK font package when reading CJK books without
  embedded fonts. Flatpak can use the host's read-only font installation; a
  Latin-only test system is not a representative font fallback baseline.

The program remains GPL-3.0-only. Its notices and third-party license texts
are installed under `/app/share/licenses/selis`. The newly authored descriptive
AppStream metadata is CC0-1.0; it does not change the program license.

References: [Tauri](https://v2.tauri.app/distribute/flatpak/),
[Flatpak permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html).
