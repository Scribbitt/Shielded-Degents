# Changes to the vendored code

`vendor/shielded-ordinals` is Ord Dropz's MIT-licensed Shielded Ordinals repository, copied at the
commit in `vendor/shielded-ordinals/UPSTREAM_COMMIT`. The protocol code under `src/v1/` and the circuits
are **unmodified**: that is what lets anyone check Shielded Degents with the same indexer anyone runs
for Shielded Nakas.

| File | Change | Why |
|---|---|---|
| `indexer/indexer.mjs`, `relayer/relayer.mjs`, `cosigner/cosigner.mjs` | read the spend verification key from `SPEND_VKEY` when set (default unchanged: `zk/spend_vkey.json`) | our collection has its own trusted setup; the indexer still refuses any key that does not match the `spendVkeyHash` pinned in our parent inscription |

Not committed: `build/` (compiled circuits, made by `npx circom2`), `node_modules/`.

To update from upstream: copy the new commit over this folder, re-apply the table above, run
`npm run test:all`, and compare `src/v1/` and `circuits/` with a diff before trusting anything new.
