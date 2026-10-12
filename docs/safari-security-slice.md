# Safari and Security Hardening — Accepted Slice

**Authority:** User approved implementation with “Proceed” on 2026-10-12, following the proposed Safari + security implementation specification.  
**Source:** `erinpanes052204/WebGBA` at `ce9924182d5e5750e70c197b818c1e22e0a7a9ec`.  
**Destination:** `invicta-ctrl/WebGBA`, branch `fix/safari-security-save-integrity`.  
**Exclusions:** No changes to upstream or fork `main`, no production deployment, no accounts/backend/cloud sync, no ROM/BIOS distribution, no PWA packaging in this slice.

## Implemented
1. ZIP imports are parsed locally with central-directory and local-header validation, limits on file/entry count/expanded sizes, path restrictions and CRC-32 verification. ROM and imported save sizes are bounded before WASM.
2. In-game save imports no longer run the outgoing-game save write over the just-imported save. A backup download is attempted before overwriting SRAM.
3. Autosave writes are serialized and `lastSave` changes only after persistence succeeds; switching/reset cancels if a pending save cannot be persisted.
4. Save IDs now use SHA-256 of ROM bytes; legacy saves, states, and cheats remain accessible through existing IDs without silently merging distinct ROM variants.
5. Safari audio has an explicit user-gesture retry, the AudioWorklet Blob URL is revoked after loading, and touch inputs are cleared on backgrounding.
6. Portrait and landscape touch layouts use dynamic viewport units and safe-area spacing, including narrow phones.
7. Native `build/wasm_api.c` allocation and save/state-size checks are reflected in a rebuilt `core/mgba.wasm` binary on the feature branch.
8. Node 22 dependency-free security tests run in GitHub Actions.

## Evidence and verification
- Baseline main commit: `ce9924182d5e5750e70c197b818c1e22e0a7a9ec`.
- Browser logic tests and syntax checks: successful CI at https://github.com/invicta-ctrl/WebGBA/actions/runs/38252081365 (additional later runs also green).
- WASM core rebuild: successful CI at https://github.com/invicta-ctrl/WebGBA/actions/runs/38251979988.
- Artifact archive SHA-256: `a3fb90d0ed5e047153cdb81e23aaad88c3993d4989c58cb101f3832ba9d96d31`.
- Rebuilt `core/mgba.wasm` SHA-256: `e8ce9d7534e54b25138f74343c772add6629f3263fa49424c6efccd33eaf36e7`.
- Rebuilt `core/mgba.js` SHA-256: `513a26f8f0f018d38bb48c68a2ea9fd5e340e62947a909d5626c09944ebae2da` (unchanged).
- Hardened WASM was published only to the feature branch via checksum-gated CI commit `0c344741fca977f09ec5dc15d79816140454c35e`; fork main unchanged.
- Last manual code-review step: inspect the complete branch diff before merge; review pending as of this evidence note.

## Not verified / release blockers
- iPhone Safari playback, touch combinations, phone interruption, audio resume and restore across tab backgrounding.
- iOS installed web-app behavior (PWA not implemented in this slice).
- Android Chrome playback and 360px/375px/393px widths in real browsers.
- Live ROM compatibility: tests use synthetic ZIP and save data; no copyrighted ROMs were run.
- A complete audit of third-party mGBA internals is out of scope.
- Import backup delivery on iOS still depends on Safari download behavior; users should create explicit backups before changing saves.
- Security hardening and automated checks do not guarantee exploit-free code.

## Release gates
1. Run device matrix described in README.
2. Ensure GitHub CI remains green on the final PR commit.
3. Check SHA-256 in README matches shipped WASM.
4. Review complete diff, request collaborator review, then merge only under separate approval.
