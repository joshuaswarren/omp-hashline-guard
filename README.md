# omp-hashline-guard

An [omp](https://github.com/can1357/oh-my-pi) extension for the hashline `edit` tool. It stops edits that apply but damage the file, and it shortens recovery when an edit header is stale or names the wrong path.

## What it does

1. **Refuses damaging edits.** After an edit applies, the guard compares the file before and after. When it finds damage, it writes the old content back and returns an error that names the problem. The header tag stays valid, so the agent fixes its numbers and re-issues in one call. It refuses an edit when:
   - omp reports that the file no longer parses;
   - a body row is an edit op (`+PUT 4.=9:`, `+CUT 12`, `+REM`, a `[path#TAG]` header) and was written as text;
   - a `PUT s.=e:` range is off by 1 to 3 lines, so the lines at the far end are deleted;
   - the body repeats lines that sit just outside the range (a range end that is too wide or too narrow);
   - in Python or YAML, the edit removes a block opener (`def f():`, `key:`) but keeps its body.

   To apply a refused edit as written, send the identical edit again.
2. **Rebinds a header path that does not exist.** When the agent read `/work/fix-7/docs/packet.md` and then edits `[docs/packet.md#TAG]` from another directory, omp reports "File not found". The guard sends the edit to the one file that was read under that tag and whose path ends with the header path.
3. **Stops edits to the wrong copy.** When the header path resolves to a file this session never read, and the tag came from another file with the same path tail (another checkout), the guard refuses once and names the right path.
4. **Explains stale tags.** After omp rejects a stale tag, the guard adds where the anchored lines are now, or says that the edit is already in the file. It also refuses a retry that pairs the new tag with the old line numbers, because those numbers now point at other lines.

## Install

```sh
omp plugin install github:joshuaswarren/omp-hashline-guard
```

The extension needs omp 18.16 or later, which runs extensions on Bun.

## Test

```sh
bun test ./test.js
```

The end-to-end tests run real `omp -p` sessions. A test-only provider (`replay/scripted-provider.js`) plays a fixed script of tool calls, so the real edit tool runs without a language model. The tests skip when `omp` is not on `PATH`. To replay one case by hand:

```sh
bun replay/run.js replay/cases/shifted-range.json          # without the guard
bun replay/run.js replay/cases/shifted-range.json --guard  # with the guard
```

## Limits

- The checks look for known damage shapes. An edit that deletes a line the agent meant to keep, with no echo, parse error, or orphaned body, still applies.
- The guard keeps its records in memory for one omp process. After a restart it knows no earlier reads.
- When a stale-tag conflict moves the target lines more than 2 lines, omp has not displayed the new lines yet, so the corrected retry gets one more "never displayed" reply before it applies.
