# mc-agent-eval

An LLM-driven agent for Minecraft, built together with an **offline evaluation harness** for measuring how well language models can compose low-level game actions into working skills.

Minecraft serves as the testbed. The project is mostly about two questions: how to build an agent whose language model never claims to have done something it did not do, and how to evaluate that agent on tasks it has not seen before.

> Status: work in progress (about 80% of the planned scope). Interfaces may still change.

## What is in this repository

| Area | Path | Description |
| --- | --- | --- |
| Agent runtime | `src/` | Mineflayer-based body, rule-based decision layer, skills, teaching, survival and stance logic |
| LLM layer | `src/brain/` | Dialogue, teaching extraction and conflict arbitration, with OpenAI-compatible and Gemini providers and ordered model fallback |
| Skill system | `src/skills/` | A small skill grammar, validator and automatic repair of model-written skill drafts |
| Evaluation harness | `scripts/probe/` | Deterministic simulator, task sets, seeded task generator and runner |
| Tests | `test/` | Unit and integration tests (`node --test`) |
| Launcher | `launcher/` | Local helper that starts a test server and the agent (Windows) |

## Agent design

- **Two layers.** A rule-based decision layer reacts to the game state, and the LLM layer handles open-ended dialogue, learning from the player and choosing between conflicting goals. The game keeps working without a model; without one, the agent only reports plain facts.
- **Grounded speech.** The model may only describe actions that actually happened. A skill counts as "learned" only after a successful trial, and the origin of every skill (built in, self-learned, taught by the player) is tracked and checked before it is mentioned.
- **Constrained arbitration.** When goals conflict, the model may only choose from an allowed list of policies within fixed parameter ranges, and it falls back to the most conservative choice when unsure.
- **Robust model access.** Per-call deadlines, ordered fallback models on 429/5xx/network errors, and logging that records timing and model metadata but never credentials, prompts or generated text.

## Evaluation harness

`scripts/probe/` tests whether a model can build skills out of small action primitives, without a game client or network access to the game.

- **Simulator** (`sim.js`): a deterministic 64×10×64 grid world with blocks, entities and an inventory. It is close to Minecraft semantics but much simpler.
- **Two paradigms.**
  - **A: write a program.** The model receives the task, the primitive catalogue and the skill grammar, and writes the whole skill body at once. The draft is validated, automatically repaired where possible, and executed in the simulator.
  - **B: step-by-step choice.** At each step the simulator offers 4–8 candidate actions, and the model picks one until the task succeeds or the step budget runs out.
- **Task sets** at three difficulty levels: a base set (tasks 1–16), a held-out set (21–50), a reuse set (51–80) and a generated set (81–110). Every task ships a reference solution that must pass the simulator's self-test before any model is run.
- **Seeded task generator** (`gen.mjs`). To stop the task design from drifting toward what models already solve, the generator code is committed and frozen before a set is drawn, and each acceptance round uses a fresh seed. All parameters are baked into the emitted file, so a drawn set is auditable data rather than code that re-samples.
- **Failure accounting.** API failures (quota, 5xx, open circuit breaker) are recorded per cell and kept separate from task failures, because they can dominate the raw success rates.

### Results on the held-out set (tasks 21–50)

540 trials were run across 5 model configurations. 306 of them ended in API failures, mostly quota limits. On the remaining **234 valid trials, 231 succeeded (98.7%)**.

| Model | Valid / total trials | Success on valid trials |
| --- | --- | --- |
| deepseek-flash | 88 / 90 | 100% |
| deepseek-v4-pro | 60 / 180 | 100% |
| deepseek | 62 / 90 | 97% |
| gemini-3.5-flash-lite | 21 / 90 | 95% |
| gemini-3.8-flash | 3 / 90 | — (too few valid trials) |

Several cells have only a handful of valid trials, so these numbers are a sanity check of the harness rather than a ranking of the models. The main lesson so far is about the data: without separating infrastructure failures from model failures, the raw rates suggested a large drop on held-out tasks that was not real. Runs on the reuse and generated sets are still in progress.

## Running

Requires Node.js 24.

```bash
npm install
npm test                                   # unit and integration tests
node scripts/probe/run.mjs --selftest      # check every reference solution in the simulator
node scripts/probe/run.mjs --selftest --holdout
```

`node scripts/probe/gen.mjs --seed=<n>` draws a new generated set and **overwrites** `scripts/probe/tasks-p0r3.js`. The committed file is the frozen set used for the reported runs, so draw new sets on a separate branch.

Live probe runs and the in-game agent need model credentials. Put them in environment variables or a local, uncommitted `.env` file (see `.env.example`). Never commit keys.

## License

MIT
