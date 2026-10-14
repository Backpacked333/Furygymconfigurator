# DBA — Index

## [DISCOVERED]

- No database. Persistence = URL hash (`#c=` LZ-compressed JSON, ≤12 000 chars encoded / 16 000 decoded),
  localStorage `fury-draft-v1` and `fury-builds-v1` (≤12 builds). Schema is the Zod `Config` (v2) with v1 migration.
- Any multi-unit model must add a v3 migration and keep share URLs within the size caps.
