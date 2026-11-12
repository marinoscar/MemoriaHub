---
"@marinoscar/memoriahub-api": minor
---

Add the optional `MEMORIAHUB_DOCTOR` diagnostics port (`MemoriahubDoctorPort`, `MemoriahubDoctorCheck`; the default registers nothing) and the check helpers in `core` (`doctorCheckId`, `pass`, `warn`, `fail`, `skip`, `readSystemNamespaces`) to `@marinoscar/memoriahub-api` (private), and move ten domain doctor checks into their slices: `android.media-sync` (media), `ai.duplicate-detection` (dedup), `jobs.burst-config` (burst), `ai.social-media` (social-media), `face.detection`, `face.flag-consistency`, `face.pgvector` (face), `geo.reverse-provider` (location), `workflows.state` (workflows) and `ai.flag-consistency` (tagging). The settings port gains the optional read-only `peekSystem` the checks read through (a diagnostics read must not create the settings row). Check ids, statuses and remedies are unchanged.
