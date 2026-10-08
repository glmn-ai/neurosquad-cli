# Security Policy

## Supported versions

`nsq` is in early development. Security fixes go into the latest release and `main` only.

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report privately through either channel:

1. **GitHub Security Advisories** (preferred) —
   [report a vulnerability](https://github.com/glmn-ai/neurosquad-cli/security/advisories/new).
2. **Email** — [i@neurosquad.ai](mailto:i@neurosquad.ai).

Please include the affected version or commit, your OS, steps to reproduce, and the impact you
see. We will acknowledge your report within 3 business days, keep you updated, and credit you in
the advisory unless you prefer to stay anonymous.

## Scope

Of particular interest: the local daemon and its socket/loopback endpoints (authentication tokens,
access from other local users), handling of secrets and API keys (they must never reach argv, logs
or files), changes to the user's own harness configuration, and command injection through agent
names, prompts or paths.
