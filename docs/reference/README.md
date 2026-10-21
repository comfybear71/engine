# Reference notes

Living notes for developing the Engine and the craft of making cartoons with
it. Nothing here is a spec unless a file says so.

| File | What it is |
|---|---|
| [lessons-learned.md](lessons-learned.md) | Running log of lessons, open questions and experiments. Add to it whenever we learn something. |
| [higgsfield-passport-rush.md](higgsfield-passport-rush.md) | Study of another team's hybrid Blender + AI pipeline. |
| [shot-recipe-drone-house.md](shot-recipe-drone-house.md) | How a drone fly-through of a house could work in a 2D cartoon. |
| [blender-plan.md](blender-plan.md) | Notes and experiments for bringing Blender into the pipeline. |
| [shot-library.md](shot-library.md) | Camera moves and mood shifts we want (dolly zoom, push-in, Dutch angle, normal to ominous): what the Engine can do now and what needs Blender. |
| [showcase.md](showcase.md) | Picture gallery of what Blender can make from scripts: storm, rainforest, ocean, clouds, planet, sci-fi base, city, psychedelic, cloth physics, caravan park draft. First drafts, with honest notes. |
| [blender-capabilities.md](blender-capabilities.md) | Checklist of what Blender can do for us and what we have proved, with a capability lab that tests one facet per picture. |
| [pc-control-options.md](pc-control-options.md) | How an AI agent could work on the user's own PC (local Cursor, self-hosted worker, MCP, computer use). Tried and working on the user's PC (tool paths and timings inside; test videos in `pc-test/`). |
| [sunny-banks-ep06-plan.md](sunny-banks-ep06-plan.md) | Plan to use Sunny Banks EP06 as the real project: caravan park in Blender, depth options, characters, stages and questions. |
| [sunny-banks-bible.md](sunny-banks-bible.md) | What we know about Sunny Banks (cast, locations, EP list, pipeline), what can be pulled from the deck app, and conflicts between sources. |
| [setup-my-machine-worker.md](setup-my-machine-worker.md) | Step-by-step: make the user's PC a My Machine so the cloud assistant can run Blender there. Tried and working on the user's PC (tool paths and timings inside; test videos in `pc-test/`). |
| [dialogue-scene.md](dialogue-scene.md) | Dazza and Nan talking in one shot: Nan's mouth set, the two-speaker scene script, how to run it. Not yet rendered. |

## Rules for keeping these useful

- Mark how sure we are: **Confirmed** (we ran it and saw it), **Diagnosed**
  (explained from code or docs, not run), **Suspected**, or **From others**
  (a claim from a video or article).
- Never write a guess as a fact. "Unknown" is a fine entry.
- Add new lessons at the top of their section with a date.
- When an unknown gets answered, move it from Open questions into a lesson
  and link the evidence (script, clip, PR).
- Cite sources for anything from outside (URL, video time).
