# Letting the AI work on your PC

Question from the user: some bots can take over a PC. How do we give Cursor the
same abilities, so it can run Blender and other tools on the user's own machine?

Everything on this page is **From others**: it comes from a read of Cursor's
documentation on 2026-10-20 (pages named below) plus two Cursor forum replies.
None of it has been set up or run by us yet. Check the docs pages before
relying on any step, the product changes quickly.

## Where the AI runs today

| Where | What it is | Can it touch the user's PC? |
|---|---|---|
| **Cloud agent (managed)** | Runs in Cursor's own virtual machine, with its own desktop. This is the assistant that has been working on the repo so far. | No. It cannot see Blender, files or the GPU on the user's PC. |
| **Cursor on the PC (local agent)** | The agent inside the Cursor desktop app. | Yes: runs commands in the user's own terminal, edits files, uses the built-in browser, and runs local MCP servers. |
| **Cloud agent on "My Machines" (self-hosted worker)** | A small program (`agent worker`) on the user's PC. The thinking stays in Cursor's cloud, the work (commands, file edits, local MCP servers) runs on the PC. | Yes, for commands, files and local MCP servers. |

Docs pages: Agent overview, Terminal, Browser, MCP, Self-Hosted Machines, My
Machines, Capabilities, Computer use (all under cursor.com/docs).

## Option A: Cursor on the PC plus a Blender MCP server

The documented route to drive a live Blender. The MCP server is started by Cursor
on the PC and talks to an add-on inside Blender. Details and cautions in
[blender-plan.md](blender-plan.md). The user is happy to try it (no projects to
lose, telemetry not a concern, but we still switch usage statistics off).

## Option B: Cloud agent on My Machines (self-hosted worker)

Lets this same style of cloud agent run on the user's PC, so it can run Blender
headless, render, see the real files and use the GPU, with the user starting
tasks from cursor.com/agents. From the docs, for Windows:

1. In PowerShell: `irm 'https://cursor.com/install?win32=true' | iex`, then check
   with `agent --version`.
2. `agent login`.
3. From the repo folder: `agent worker start --name "my-pc"` and leave it running.
4. At cursor.com/agents, pick the machine under My Machines and send a task.

Needs: the Cursor CLI, outbound internet only (no ports to open), the PC kept on
with the worker running, and on a Teams plan an admin must allow it.

Cautions from the docs:

- Cloud agents do not ask for approval before running commands, so on a
  self-hosted worker the agent can run anything on the PC without asking. Use a
  folder and an account you are comfortable with.
- File contents, terminal output, diffs and screenshots go to Cursor so the agent
  can work with them (privacy mode applies).
- This gives commands, files and local MCP servers. It does **not** give a mouse
  and keyboard.

Status of the assistant's check: when asked, no self-hosted worker was connected
to this run, so nothing has been tried.

## Option C: full desktop control (mouse, keyboard, screenshots)

This is the "take over my PC" ability.

- Cursor documents computer use for managed cloud agents (their own VM) and for
  self-hosted workers on **macOS and Linux**. It lists **no Windows** support.
- Two Cursor staff forum replies (Sept 29 and Oct 18, 2026) say native local
  computer use is in a limited staged rollout or an open request with no date, and
  that today the way to give an agent full desktop access is a third-party
  computer-use MCP server.
- We have not looked at any such server. It would have the same risks as Option B
  or worse (it can click anything), so check the source and use a spare account or
  machine.

## What we actually need

For Blender work we mostly do not need a mouse. Almost everything we have done
needs only commands and files, which Options A and B provide. A mouse matters only
for things that cannot be scripted. So the sensible order is:

1. Try Option B (self-hosted worker) so the assistant can run Blender and the
   Engine render on the user's PC and look at the real output.
2. Add Option A (Blender MCP) if we want to watch and adjust Blender live.
3. Look at Option C only if we hit something that truly needs clicking.

## Open questions

- Does a Windows self-hosted worker work as the docs describe, with Blender and
  the Engine's Python worker? (Untried.)
- Does the Blender MCP server work with Blender 5.2.2 LTS and Cursor on Windows?
  The README says Blender 3.0 or newer. (Untried.)
- Is there a trustworthy computer-use MCP server for Windows? (Not researched.)
