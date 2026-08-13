# Phase 1 known deviations

## Debug panel intentionally omitted

M1.1 originally listed an empty renderer with a diagnostic panel showing the build channel and resolved paths. Phase 1 deliberately ships an empty renderer instead: installer and runtime isolation are verified by automated packaged-process smoke tests and the E12 installer matrix, without exposing local paths in renderer-visible state. A future diagnostic surface must use typed RPC and redacted values; it must not recreate the original raw-path panel.

## Phase 2 observations

### Windows 8.3 alias rejection may reject legitimate names

The Phase 1 capability gate rejects every path segment matching the conservative Windows 8.3 pattern. This also rejects legitimate user filenames such as `vol1~2.cbz` and `backup~1.txt`. The check is defense in depth: `realpath` already resolves aliases before the normalized result is checked against the authorized root.

When real library scanning is introduced, decide whether to replace the lexical rejection with a semantic alias check, such as comparing each resolved path segment with its corresponding input segment. Any change must preserve the post-`realpath` root-containment check and requires security review because it relaxes an existing capability-gate restriction. User media remains read-only; renaming files is not an acceptable workaround.

### Range result measures the hot-cache protocol path

The Phase 1 Range benchmark repeatedly reads 64 MiB ranges from the approximately 70 MiB `avcodec-62.dll` fixture. Its 825 MB/s throughput and 0.664 ms average request setup validate `mediaResponse` protocol overhead and response setup, not 2 GiB of cold-storage throughput. The overlapping offset window means most reads are served from the operating-system page cache.

After Phase 6 provides large generated video fixtures, rerun the benchmark with a file and access pattern large enough to measure cold or explicitly controlled-cache reads. Do not use the Phase 1 throughput number for storage sizing or media-capacity planning.
