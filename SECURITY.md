# Security policy

WebGBA processes untrusted files locally. Never load ROM, ZIP, BIOS or save files from untrusted sources. The static GitHub Pages deployment does not upload games, but any optional Rust-server deployment has a different privacy model.

## Supported scope
- Browser JS, local storage, ZIP parsing, WASM glue, UI input.
- Legacy mGBA 0.10.5 is a separately maintained component.
- No ROM/BIOS downloads are supplied.

## Reporting
Please privately contact the repository maintainer using GitHub's private vulnerability reporting feature if enabled; otherwise request a private contact channel without posting exploit data or sample personal saves in public issues.

## Known limitations
- Zip CRC is not authenticity or malware protection. Limit expansion sizes and test hostile input.
- The shipped mGBA WebAssembly binary must be rebuilt for changes to `build/wasm_api.c` to take effect.
- Mobile Safari and iOS PWA behavior require device verification.
- IndexedDB may be lost through browser storage eviction or clearing data; back up saves.
- Browser-side validation cannot sandbox vulnerabilities within the native emulator library. Avoid untrusted ROMs.
