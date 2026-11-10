# Runbook: the Google geocoding key and worker nodes

Applies when reverse geocoding uses Google (`/admin/settings/geo`) and you want worker nodes to run `geocode` jobs
(RETRO-C6, issue #600). The design is [geocoding.md, node path](../specs/geocoding.md#node-path-retro-c6).

## What is and is not delivered to a node

- The Google key is the platform credential `geo_provider/google`, stored encrypted. A node never reads it from the
  database, an environment variable, a file or the command line.
- A node that holds a `geocode` job asks `POST /api/nodes/:id/jobs/:jobId/secret` and receives
  `{ kind: 'geo.google', expiresAt, material: { apiKey } }`, valid until the job's lease ends (plus a one-minute
  clock-skew allowance). It keeps the key in memory for that job only. The server stores a handle in `job_node_secrets`, never the key.
- AI provider keys are never delivered to a node (AI rule 3). The offline and Nominatim providers need no key.

## Turn it on

1. `/admin/settings/geo`: select **Google** as the reverse provider, store the key, leave the provider switched on.
2. `/admin/settings/workers` (the `nodes` settings): switch on **per-job secret brokering** (`nodes.jobSecretBrokerEnabled`, off by default).
3. Check the Doctor: the geo check reports the active provider; the node fleet page shows `geocode` among the offered types.

## When it is off (the default) or unusable

The platform does not offer `geocode` to nodes and the API's own worker runs it (`JOBS_WORKER_MODE` `all` or `system`; not `off`).
No job fails for lack of a secret. The cases: the broker switch is off, the active provider is not Google, the Google
provider is switched off, or no key is stored. `POST .../secret` answers 403 (`job_secret_broker_disabled`) or 503
(`broker_unusable`, with the remedy) if a node asks anyway.

## Residual risk and rotation

A Google API key cannot be revoked for one job: a compromised node holds a usable key until you rotate it.

- In Google Cloud, restrict the key to the **Geocoding API** and to the egress IPs of the API and the fleet.
- After a node compromise (or when you retire a node): rotate the key in Google Cloud, store the new one at
  `/admin/settings/geo`, then revoke the node's `nod_` credential (`/admin/settings/workers`). Grants for settled jobs are revoked
  by the platform sweep; for this broker revocation is a no-op because the key is shared, which is why rotation is the remedy.
- To get zero key egress, leave the broker switch off.
