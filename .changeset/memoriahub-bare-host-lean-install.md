---
---

Add `examples/bare-host` (a host that installs the packed compute, contract and api tarballs outside the repository with in-memory ports), extend `check:memoriahub-lean-install` to install each package alone and load every `exports` entry, add the `lean-install` and `bare-host` CI jobs and the manual, dry-run-by-default `memoriahub-release.yml`. No package source changes and no release; nothing is published.
