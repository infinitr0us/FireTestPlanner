# Flame analysis validation corpus

Both `python/tests/test_flame_analysis_validation.py` and
`web/src/core/flame-analysis-validation.test.ts` read these files.

`baseline/` is a small synthetic event from the data review. Each entry in
`cases.json` overlays the listed files under `cases/<name>/` on that baseline.
The 52 original folder cases preserve the reviewers' input bytes, including BOMs,
invalid UTF-8, CSV line endings and non-JSON numbers. Expected verdicts implement
the accepted fixes in CONVENTIONS section 13, rather than the former behavior.
Eight later cases come from a differential test of the two readers: an id and a
date followed by a line break (`id_newline_series`, `id_newline_event`,
`date_newline`), whole numbers too large for a float (`number_huge_onset`,
`number_huge_instant`, `number_huge_voxel`, `number_huge_moment`), all refused,
and a time base label of 21 characters outside the Basic Multilingual Plane
(`label_astral`), accepted because the limit of 40 counts characters.

`meshes.json` covers the 17 original PLY variants, three outputs from the old
writer probes, two header boundary cases, and five strict-header cases (BOM,
Unicode, element order and numeric syntax). The old writer's fractional-index
output is a valid integer-index PLY because that writer already truncated the
indices. Its reader verdict is therefore acceptance; separate tests ensure the
writer now rejects the original fractional input. Headers exactly 65,536 bytes
long use leading zeros in the vertex count and are accepted; 65,537 bytes is
refused. `paths.json` covers runtime and schema path policy, including every
forbidden control character.

The original evidence came from `review/codex-data/`. Tests need only this tracked
corpus, and do not depend on that ignored directory. All geometry and imagery are
synthetic public fixtures.
