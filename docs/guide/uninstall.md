# Uninstall

1. **Stop the daemon and the agents:**

   ```sh
   nsq down
   ```

2. **Remove agents' worktrees you no longer need** (optional — `nsq rm <agent> --worktree` per
   agent), and their branches `nsq/<name>` in your repositories (`git branch -D nsq/<name>`).

3. **Remove the package** the way you installed it:

   ```sh
   npm uninstall -g neurosquad                      # npm and the install scripts
   brew uninstall neurosquad-cli                    # Homebrew
   scoop uninstall neurosquad-cli                   # Scoop
   ```

4. **Delete nsq's data** (settings, agent list, worktrees, dictation models):

   ```sh
   rm -rf ~/.neurosquad-cli                         # macOS / Linux
   ```

   ```powershell
   Remove-Item -Recurse -Force "$HOME\.neurosquad-cli"   # Windows
   ```

   Commit or copy anything you want to keep from `~/.neurosquad-cli/worktrees` first. If you set
   `NSQ_HOME`, delete that folder instead.

5. **Remove secrets from the OS keyring** (optional): before uninstalling, `nsq openrouter clear-key`
   and `nsq logout`; or delete the `neurosquad-cli` entries in Windows Credential Manager, the macOS
   Keychain or your Secret Service app.

Your CLIs' own configuration was never changed, so there is nothing to undo in `~/.claude`,
`~/.codex` or `opencode.json`. Their sessions and transcripts stay where the CLIs keep them.
