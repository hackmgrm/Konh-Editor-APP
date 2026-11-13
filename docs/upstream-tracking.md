# Upstream tracking

This is the review ledger and procedure, not a claim that either upstream is fully synchronized. Pins below are observed remote default-branch HEADs, **not** a tested synchronization baseline. Remote HEAD can move; verify it again before each review.

| Upstream | Remote HEAD verified 2026-11-12 (UTC), via `git ls-remote --symref ... HEAD` | Integration status |
| --- | --- | --- |
| [TongYun Planner](https://github.com/dangzhuotong/tongyun-planner) | `refs/heads/master` at `bf4c85df39898987bbab911143a5b14760aa9479` | Historical imported baseline is **unknown**. No tested sync baseline established; do not use this observed HEAD as the old side of a historical change range. |
| [Mars Editor](https://github.com/whyubel1eve/Mars-Editor-APP) | `refs/heads/main` at `919bc2d8eac204ed485176972cac09fa7b20c455` | [Prior integration record](upstream-integration.md) reports selective integration and tests at abbreviated `919bc2d`; it also records limitations. This is not proof of complete parity or a fresh test of the current working tree. |

## Reproducible review

Use separate disposable clones outside KonhEditor; do not overwrite the working tree, which may contain local work. The following POSIX shell commands fetch both histories and compare their recorded pins with a freshly observed HEAD. A network connection and Git are required. `WORK` is retained for inspection; remove it when finished.

```sh
WORK=$(mktemp -d)
git clone https://github.com/dangzhuotong/tongyun-planner.git "$WORK/tongyun"
git clone https://github.com/whyubel1eve/Mars-Editor-APP.git "$WORK/mars"

for spec in \
  'tongyun bf4c85df39898987bbab911143a5b14760aa9479' \
  'mars 919bc2d8eac204ed485176972cac09fa7b20c455'
do
  set -- $spec
  repo=$WORK/$1 pin=$2
  git -C "$repo" fetch origin
  git -C "$repo" ls-remote --symref origin HEAD
  git -C "$repo" rev-parse --verify "$pin^{commit}"
  # Resolve the default branch afresh, rather than assuming origin/HEAD is current.
  branch=$(git -C "$repo" ls-remote --symref origin HEAD | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2}')
  test -n "$branch" || { echo 'Cannot resolve remote HEAD' >&2; break; }
  git -C "$repo" fetch origin "refs/heads/$branch"
  head=$(git -C "$repo" rev-parse FETCH_HEAD)
  printf '\n%s: recorded=%s fetched=%s\n' "$1" "$pin" "$head"
  if git -C "$repo" merge-base --is-ancestor "$pin" "$head"; then
    git -C "$repo" log --oneline "$pin..$head"
    git -C "$repo" diff --stat "$pin" "$head"
    git -C "$repo" diff "$pin" "$head"
  else
    echo 'Pin is not an ancestor: investigate rewritten or divergent history before choosing a range.'
    git -C "$repo" log --oneline --left-right "$pin...$head"
  fi
done
printf 'Review clones: %s\n' "$WORK"
```

The fetched commit is authoritative for that comparison; if the separately printed remote HEAD differs, it moved during the review—repeat and record the actual commit compared. For TongYun this range shows changes **since the observed pin only**, not all changes missing locally. To establish a baseline, investigate provenance and compare relevant upstream files/behavior with the current local implementation (`src/tongyun/`, `src/productivity/`, `src-tauri/src/tongyun.rs` and related integration points); map renamed or adapted files manually. For Mars, inspect editor and native integration similarly. For individual mapped files, for example, run `git diff --no-index -- "$WORK/tongyun/<upstream-file>" "<local-file>"` from the KonhEditor root; exit 1 means differences, not a tool failure. This compares working-tree content, including uncommitted changes. Record local commit and dirty state, file mappings and any exclusions; do not treat a textual difference as necessarily missing functionality. Avoid generated files, dependencies and macOS `._*` sidecars in comparisons.

## Selective port and validation

1. Save/coordinate existing work before editing; never reset, clean, merge wholesale or blindly overwrite it. Review upstream commits and changed files plus their dependencies; decide per change to port, adapt, defer or reject, with a reason. If history is unrelated or unknown, use file/behavior comparison instead of inventing a commit range.
2. Preserve Konh branding, icons, identifiers, version/update endpoints and existing product behavior. Review configuration and dependency changes rather than copying them wholesale. Protect vaults, drafts, user settings, credentials, databases and sync data: back up before migration tests, use disposable data/accounts, and explicitly review compatibility, migrations and rollback. Never put secrets or real user content in review notes.
3. Check upstream and third-party licenses and retain required copyright/license notices and attribution for each copied or adapted portion. Record upstream commit and paths as provenance; do not assume the two projects have identical licensing.
4. Test the selected changes and regressions relevant to their impact. Available starting points include `npm run build`, `npm run test:upstream`, `npm run test:productivity`, `npm run test:publishing`, and `cargo test --manifest-path src-tauri/Cargo.toml --lib`; add focused integration/manual tests for affected flows. Record commands, results, environment, skipped tests and limitations. Real external service behavior is not established by mocks.
5. Add a dated entry below only after review, identifying exact upstream and local commits, dirty state, range or file mapping, decisions, attribution and test evidence. A reviewed pin, an observed HEAD and a tested sync baseline are distinct. Advance a tested baseline only when its scope and validation are actually established; unresolved items remain open.

## Review ledger

- 2026-11-12 UTC: remote HEADs observed as in the table using `git ls-remote --symref`. No comparison, port, or synchronization validation is implied by this observation. TongYun historical baseline remains unknown. The earlier Mars integration is documented separately and has not been revalidated by this observation.
