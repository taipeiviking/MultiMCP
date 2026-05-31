# Git setup (read me before touching git in this repo)

This repo is published under the **`taipeiviking`** GitHub account, kept fully
isolated from the machine's other GitHub account and from global git config.

## Key facts
- **Account:** https://github.com/taipeiviking
- **Remote:** `origin = git@github-taipeiviking:taipeiviking/MultiMCP.git`
  (uses the SSH host **alias** `github-taipeiviking`, not `github.com`).
- **SSH key (isolated):** `~/.ssh/id_ed25519_taipeiviking` (+ `.pub`).
- **Identity is repo-LOCAL only** (never `--global`):
  - `user.name  = taipeiviking`
  - `user.email = clas.sivertsen@gmail.com`

## SSH config block (in `~/.ssh/config`)
```
Host github-taipeiviking
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_taipeiviking
    IdentitiesOnly yes
```

## Nesting caveat
This folder lives **inside** `C:\Users\class\git`, which is itself the
`taipeiviking/www.liquacool.com` repo, and sits alongside a sibling `assaya/`
repo. `MultiMCP` is its own independent nested git repo. **Only ever run
git/PR commands against this repo** — never the parent or `assaya`.

## Verify / push
```powershell
ssh -T git@github-taipeiviking          # expect: "Hi taipeiviking! ..."
git branch -M main
git push -u origin main
```

## Don't
- Don't set anything with `--global`.
- Don't use a bare `github.com` remote (it would pick the wrong key/account).
- Don't commit `.claude/settings.local.json` (machine-local; gitignored).
