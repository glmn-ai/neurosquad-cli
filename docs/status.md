# Agent status

While its process runs, an agent is in one of four states (`AgentStatusKind`):

| State                       | Meaning                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `working`                   | a turn is running                                                                                                      |
| `needs-input` ("needs you") | the harness is blocked on the person: a permission prompt, a question, a plan to approve — with the harness's own text |
| `finished`                  | the turn ended and the answer is on screen                                                                             |
| `idle`                      | at its prompt with nothing new to say (the person dismissed a question, interrupted, or the process restarted)         |

When the process is gone the machine publishes nothing more and `agentStatusSnapshot` returns
`null`; hosts show that as "exited" (nsq does).

## Where facts come from

1. **Hooks** — each harness's own lifecycle reports ([harnesses.md](harnesses.md)). A hook is a
   fact, not a guess: no screen scraping decides "needs you".
2. **The person's keys** — an answer key (Enter, a digit, `y`/`n`/`a`) typed into a waiting agent
   moves it to `working` at once; Escape / Ctrl+C moves it to `idle`. Both are confirmed by the
   next hook, or by `QUIET_MS` (3 s) of silent output.
3. **The pty** — a spawn clears whatever the previous process said; facts between an exit and the
   next spawn are dropped; a hook sent by a previous process is dropped.
4. **The Claude Code transcript** — interrupts, API errors, lost hooks and queued prompts are read
   from the session transcript's tail (only entries newer than the current state count).
5. **Subagents** — while a subagent runs inside an agent, the parent's own turn end is held.

The rules live in `packages/core/src/status/machine.ts` (pure, fully unit-tested) and the wiring in
`packages/core/src/status/hub.ts`.
