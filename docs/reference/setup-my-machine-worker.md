# Setting up your PC as a "My Machine" (step by step)

Goal: let the cloud assistant run commands and Blender on **your PC**, so it
can render with your real Blender, see your real files and use your GPU.

Source: Cursor docs page "My Machines" (cursor.com/docs/cloud-agent/my-machines),
checked 2026-10-21. **Not yet tried by us.** If a step fails, run
`agent worker debug` and send me the output.

## Before you start

- Windows 10 or 11, signed in to Cursor in your browser (same account as here).
- The engine repo already on the PC (yours is `C:\Users\Stuie\engine`) with
  git working and a `master` that is up to date (`git pull`).
- Blender 5.2 installed (you have this).
- Optional: `ffmpeg` (to make .mp4 files) and Rhubarb (for new lip sync).

## Steps (PowerShell)

1. Install the Cursor command-line tool:

   ```
   irm 'https://cursor.com/install?win32=true' | iex
   ```

   Close PowerShell and open a new window, then check:

   ```
   agent --version
   ```

2. Sign in (opens your browser, click approve):

   ```
   agent login
   ```

3. Go to the engine folder and start the worker:

   ```
   cd C:\Users\Stuie\engine
   agent worker start --name "stuie-pc"
   ```

   Leave this window open. The assistant can only reach your PC while it is
   running and the PC is awake. Stop it any time with Ctrl+C.

4. Check it can be seen:

   ```
   agent worker debug
   ```

5. On cursor.com/agents, start a new agent on this repo. In the menu that
   chooses where the agent runs, pick **stuie-pc** under My Machines. Ask for
   something small first, for example: "Run `blender --version` and tell me
   what you see."

## If `agent` is the wrong program

Found 2026-10-21 on the user's PC: typing `agent` started **Grok's** command-line
tool (its help says "Usage: grok"), not Cursor's, so `agent login` signed in to
the wrong thing and `agent worker start` failed with "unrecognized subcommand".
Two programs share the name `agent`. Fix:

1. See which programs answer to the name:
   `Get-Command agent -All | Format-List Source`
2. Try Cursor's other name for the same tool: `cursor-agent --version`
3. If that works, use `cursor-agent` in place of `agent` in steps 2 to 4 (the
   sign-in must be repeated with `cursor-agent login`).
4. If `cursor-agent` is not found, open a new PowerShell window (the install
   changes the PATH), then look for the program with
   `dir $env:LOCALAPPDATA\cursor-agent` and run it by its full path.

## Good to know

- **No approval prompts.** The assistant can run any command on the PC without
  asking. Use a folder and Windows account you are comfortable with, keep
  important files backed up, and do not put anything private in the engine
  folder.
- **Privacy.** File contents, command output and screenshots are sent to
  Cursor so the assistant can work with them.
- **No mouse.** It runs commands and edits files. It cannot click inside
  Blender. Everything we have done so far is commands, so that is fine.
- **Your PC key is safe.** The assistant on your PC would use the PC's own
  `.env` (including the working Grok key). It does not receive the dashboard
  secrets from the cloud. Do not ask it to print the `.env` file.
- **Which checkout.** The worker matches the repo from the git remote of the
  folder you start it in. Start it inside the engine folder.
- **If the machine does not show in the list:** the worker window must still
  be running, Cursor in the browser and the CLI must use the same account, and
  the folder must have a git remote.
- **Firewall.** Only outbound internet is needed (api2.cursor.sh and
  downloads.cursor.com). No ports to open.

## First tasks once it works

1. "Run `tools/blender/dazza.py` and `tools/blender/talk_scene.py` with your
   Blender and show me the pictures." (Checks Blender and paths.)
2. Re-run `capability_lab.py`, `showcase.py` and `dolly_zoom.py` on the PC
   and look at the real results (still to do).
3. Then try a free lip-sync add-on, or the Blender MCP helper, with the
   assistant able to see the real output.

## Verified on Stuie's PC (2026-10-21)

The worker is tried and working. Tool locations (none are on PATH, so always
use the full path):

| Tool | Path | Version |
| --- | --- | --- |
| Blender | `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` | 5.2.2 LTS |
| Rhubarb | `C:\Users\Stuie\tools\Rhubarb-Lip-Sync-1.14.0-Windows\rhubarb.exe` | 1.14.0 |
| ffmpeg | on PATH | 8.1.2 |

Results (Blender runs on the CPU; the "CUEW initialization failed" line in
the log is harmless):

- `talk_scene.py` at 640x360, 8 samples: 69 frames in about 50 s, mp4 with
  audio joined by the script's own ffmpeg step.
- Rhubarb on `dazza_pants.wav` (2.6 s): about 2 s, 16 cues using A, B, C, E,
  F, G, X. Fed back into `talk_scene.py` with `--cues`, about 50 s again.
- Output of both runs is in `pc-test/`.

The PC's own checkout has the user's local changes in it. Worker tasks
should make a new branch, stage only the files they mean to, and never
discard anything.
