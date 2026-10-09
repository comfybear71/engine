# Studio

Local Next.js app (App Router) for browsing the asset library and staging
a frame preview. It reads project files **only** through the worker Express
server on the user's machine (`127.0.0.1`, default port 4100).

There is no Vercel Blob, database, or auth in this first slice.

How to run both sides: **[docs/studio.md](../docs/studio.md)**.
