# GitNexus Adapter

This package isolates the migration seam between multiverse and the upstream GitNexus engine.

Current responsibilities:

- Start the legacy multiverse server while the extraction is in progress.
- Call the GitNexus per-repo analysis pipeline from one controlled location.

Rule:

- Multiverse packages should not import `gitnexus/src/**` directly outside this adapter.
