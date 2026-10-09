# Studio

Local Next.js app (App Router). `/` is a project home grid; `/p/<name>`
opens Assets, Stage, Script, and Render for that folder. It reads and
writes project files **only** through the worker Express server on
the user's machine (`127.0.0.1`, default port 4100).

There is no Vercel Blob, database, or auth in this first slice.

How to run both sides: **[docs/studio.md](../docs/studio.md)**.
