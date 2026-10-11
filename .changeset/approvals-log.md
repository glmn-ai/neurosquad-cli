---
'neurosquad': minor
'@neurosquad/remote': minor
---

An approvals log: every "needs you" question, across all agents, and how it ended goes into `~/.neurosquad-cli/logs/approvals.jsonl` — the agent, its CLI and folder, the question as the CLI put it (tool, command / path / url, its text), the answer (yes / always / no) and who gave it from where: the dashboard, `nsq answer`, the phone (this machine, the Wi-Fi or the internet tunnel, and the device), the agent's own terminal, or that the CLI went on by itself, the turn ended, it was interrupted or the agent exited. No environment, tokens or prompts; secret-looking parts of commands are masked, long text cut; rotated at 10 MB. `nsq log approvals [--agent x] [--since 2h] [--json]` prints it; `nsq config set approvalsLog false` turns it off. The phone server tells its host who answered or interrupted (`PhoneCaller`: origin and device label).
