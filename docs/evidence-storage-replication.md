# Evidence storage replication

The Evidence Agent keeps the local filesystem as its primary storage. This
release adds a durable, recoverable replication boundary but leaves replication
disabled.

## Fixed configuration

Tracked configuration lives in `server/config/storageConfig.js`. It contains no
credentials and fixes the following production mappings:

| Local source | RustFS object prefix |
| --- | --- |
| `EVIDENCE_RUNTIME_DIR` | `production/evidence/runtime` |
| `EVIDENCE_DATA_DIR` | `production/evidence/static` |

The RustFS endpoint is `http://172.50.0.68:15017`, the private bucket is
`myml-canvas-media`, and credentials are read only from
`/etc/myml-canvas/storage.credentials.json` on Linux. The two local roots must
be distinct before replication can be enabled.

The Evidence replication journal uses
`/opt/1panel/MYML-CANVAS/data/storage-replication/evidence-journal`. Each object
has one atomically replaced, fsynced queue record, so repeated updates collapse
to the latest local version and survive a process restart.

## Write guarantee

Durable Evidence writes follow this order:

1. Write the local file, using the existing atomic rename where applicable.
2. Calculate or retain its SHA-256 digest.
3. Persist the latest replication operation to the local journal.
4. Return to the caller.
5. Replicate asynchronously to RustFS and verify size plus SHA-256 metadata.

Project run state, generated material/final images, imported company references,
category overrides, and uploaded category images all use this boundary.
Proposal package extraction remains a rebuildable cache. Design knowledge is
read-only in this service.

Remote delete mirroring remains disabled. A conflicting remote object is
replaced by a new version in the versioned bucket; older versions are not
removed.

## Activation gate

This release must first be deployed with:

```text
activeDriver=filesystem
replication.mode=disabled
```

Do not change `replication.mode` until all of these are true:

- Canvas and Evidence services are stopped and have no active work.
- The fixed runtime and static roots match the deployed service environment.
- The credential file passes the existing RustFS canary.
- Historical metadata and deep SHA-256 reconciliation remain accepted.
- The Evidence journal directory is owned by the service account and is mode
  `0700`.
- A rollback procedure has been prepared and no local source data is deleted.

Activation is a separate deployment that changes only the tracked replication
mode to `filesystem-to-s3`, validates the queue worker, and then restarts the
Evidence service under observation.
