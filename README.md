# WebGBA

A Game Boy Advance emulator that runs entirely in your browser. The emulation is
[mGBA](https://mgba.io) 0.10.5 compiled to WebAssembly; the interface is React.

**Upstream demo (does not include this fork's pending patches):** https://erinpanes052204.github.io/WebGBA/

- **Bring your own games.** No ROMs, BIOS files or cover art are included or ever will be.
  Use only games you own.
- **Local-first on GitHub Pages.** ROMs, saves and settings stay in your browser (IndexedDB and localStorage); the GitHub Pages deployment does not upload them. The optional separately hosted Rust server mode uses server-side storage and is **not** local-only. Use *Settings > Backup* to keep a copy.
- **Controller friendly.** Select + Start opens the game list; D-pad navigates; hold a button for turbo.
- **Mobile:** Touch controls, responsive portrait/landscape layouts, and a **Tap to enable sound** recovery control are implemented. iOS Safari and Android Chrome still require real-device acceptance testing; do not treat these browsers as verified yet.

## Where the code comes from
- `core/mgba.wasm` is built from **unmodified upstream mGBA 0.10.5 sources** ([source](https://github.com/mgba-emu/mgba/tree/0.10.5),
  MPL-2.0, see `LICENSE-mGBA.txt`) plus a small glue file, `build/wasm_api.c`.
  Rebuild it yourself with `build/build-core.sh` (needs Emscripten).
- `vendor/` holds React and htm (MIT), bundled so the page loads nothing from third parties.

### Verify the binary
`core/mgba.wasm` SHA-256:
`e8ce9d7534e54b25138f74343c772add6629f3263fa49424c6efccd33eaf36e7`

## Importing ROMs and ZIP files safely

Click **Open ROM** to choose a local `.gba` file (or a ZIP containing one).
The archive is inspected **in the browser, without a database or upload**. The importer checks central-directory boundaries, entry counts, encryption/compression flags, paths, declared size limits, actual extracted length and CRC-32 before loading files. A backup is validated in full before any restore writes begin. CRC-32 is a corruption check, not malware detection. ZIP uploads have a 64 MiB per-entry and 512 MiB total expanded-size limit; game ROMs are limited to 32 MiB. Older Safari browsers that lack `DecompressionStream('deflate-raw')` can import uncompressed `.gba` files directly instead. Unsupported or malformed archives should fail safely.

Game identity now uses a SHA-256 content fingerprint to keep patched variants' saves separate. Existing saves and save states retain a read-only legacy-ID fallback; export a backup before modifying your library. When importing a `.sav` during play, the app attempts to download a backup of current in-memory save data first.

## Safari and mobile notes

WebGBA requires JavaScript, WebAssembly, IndexedDB and a modern Web Audio implementation. For ZIP compression/decompression, Safari 16.4+ is recommended. Tap **Open ROM** or **Tap to enable sound** to provide the user gesture required by mobile audio restrictions. If Safari suspends audio during a call or when changing tabs, return to the app and tap to enable sound again. On iPhone, fullscreen may not be available through the browser Fullscreen API. Mobile layout is designed for portrait and landscape, but device coverage is pending manual checks.

Save data is held in local browser storage and may be evicted. Export a backup periodically, especially before iOS updates, clearing browsing data or switching browsers. The app does not provide a cloud sync service.

## Security and rebuild status

The JavaScript guards and ZIP/save validations ship directly from this repository's source. `build/wasm_api.c` also adds native allocation checks; **the included `core/mgba.wasm` is rebuilt with these allocation checks, as recorded in the checksum above**. See the separate `Rebuild mGBA for verification` workflow and `build/build-core.sh`. Do not treat this change as a complete WASM memory-safety audit.

Regression tests: `node --test tests/*.test.cjs` (Node.js 22+). Browser checks: `node --check engine.js && node --check ui.js`. Verify real Safari / Android device playback, ROM import, audio, save/load and orientation before production release.
