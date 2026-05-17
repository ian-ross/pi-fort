# pi-fort

> From [yapp](https://github.com/ian-ross/pi-fort) · yet another pi pack

VM-isolated fort for [pi](https://pi.dev). Runs all tools inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM so secrets never enter the agent's execution environment.

```bash
pi install npm:pi-fort
```

Requires QEMU: `brew install qemu` (macOS) or `sudo apt install qemu-system-x86` / `sudo apt install qemu-system-aarch64` (Linux, matching your host architecture).

## How it works

pi-fort starts a Linux micro-VM (Alpine by default, Debian with a custom image) using QEMU matching your host architecture, and redirects all tool execution into it. Your workspace is mounted read-write at the same path inside the VM, so tools see identical paths on host and guest. File changes are bidirectional.

The core security property: **secrets never enter the VM**. Secrets configured in your TOML config (like `gh auth token`) are resolved on the host, and their values are replaced with random placeholders inside the VM. Gondolin's HTTP proxy substitutes real values on the wire, only for requests to configured hosts.

```
┌─────────────────────────────────────────────────────┐
│  Gondolin VM (Alpine/Debian Linux)                  │
│                                                     │
│  /home/user/project ← bidirectional mount           │
│  GH_TOKEN = "GONDOLIN_SECRET_a8f3..." (placeholder) │
│  All pi tools execute here                          │
└──────────────────────────┬──────────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────────┐
│  HTTP proxy (host-side)                             │
│  placeholder → real value (only for allowed hosts)  │
└─────────────────────────────────────────────────────┘
```

## Getting started

```
/fort init
```

This creates project-local configuration only:
- `.pi/fort.toml` — project config with `enabled = true`, base packages, and env vars
- `.pi/fort.d/` — drop-in files for git and GitHub

Once enabled, all tools (bash, read, write, edit) execute inside the VM automatically.

## Drop-in files

Service integrations live in `.pi/fort.d/` as self-contained TOML files. Each can contribute packages, setup scripts, secrets, and host policies. Delete a file to disable that integration.

```
.pi/
├── fort.toml               # base config: git, curl, jq, env vars
└── fort.d/
    ├── git.toml            # git + user identity
    └── github.toml         # github-cli + secrets + policies
```

Example drop-in (`git.toml`):

```toml
packages = ["git"]
setup = """
git config --global safe.directory '*'
git config --global user.name "$USER_NAME"
git config --global user.email "$USER_EMAIL"
"""
```

`USER_NAME` and `USER_EMAIL` are defined in the main config as env vars resolved from the host:

```toml
[env]
USER_NAME = { command = "git config --global user.name" }
USER_EMAIL = { command = "git config --global user.email" }
```

## Configuration

### Image and distro

Alpine is the default guest distro. Use a [custom Gondolin image](https://earendil-works.github.io/gondolin/custom-images/) when you need Debian, a different base environment, or a larger root filesystem. Build and tag the image separately, then reference it here:

```toml
distro = "debian"
image = "pi-fort-debian:latest"
```

Supported distros are `alpine` and `debian`. `packages` are distro-native package names and still accumulate across config layers, so edit/remove Alpine-oriented drop-ins when using Debian images. For example, the GitHub CLI package is `github-cli` on Alpine but often `gh` on Debian if your apt sources provide it. Debian images are expected to provide their own apt source configuration; pi-fort runs `apt-get update` and installs with `--no-install-recommends`.

### Env vars

Non-secret values available in the VM and setup scripts. Three source types:

```toml
[env]
EDITOR = "vim"                                     # static
USER_NAME = { command = "git config user.name" }   # host command
GOPATH = { env = "GOPATH" }                        # host env var
```

### Secrets

Like env vars, but values never enter the VM. The HTTP proxy injects them on the wire.

```toml
[secrets.GH_TOKEN]
command = "gh auth token"
hosts = ["api.github.com", "github.com", "*.githubusercontent.com"]
```

### Git credentials

Configures git credential helpers using secret placeholders:

```toml
[[git-credentials]]
host = "github.com"
username = "x-access-token"
secret = "GH_TOKEN"
```

### Host policies

Access control per host. `unmatched` determines what happens to requests that don't match any allow/deny rule.

```toml
[hosts."api.github.com"]
unmatched = "prompt"
allow.GET = ["/**"]

[hosts."api.github.com".graphql]
endpoint = "/graphql"
allow.query = ["*"]
allow.mutation = ["createPullRequest", "createIssue", "addComment"]
```

GraphQL policy parses the request body and checks actual field names (not the spoofable operation name).

### Mounts

The workspace directory is mounted automatically. Use `mounts` for directories outside it, like a jj/git repo root that is a parent of the workspace. Relative paths are resolved against the workspace directory. Missing paths are silently skipped, so optional mounts are safe to declare unconditionally:

```toml
# In .pi/fort.toml (project config)
mounts = ["../.jj", "../.git"]
```

Absolute and `~`-prefixed paths also work:

```toml
mounts = ["~/shared/data"]
```

For read-only mounts, use the object form:

```toml
mounts = [
  "../.jj",
  { path = "~/shared/configs", readonly = true },
]
```

### Config layering

pi-fort loads configuration from the current project only. Merge order is:

1. `.pi/fort.toml`
2. `.pi/fort.d/*.toml` in alphabetical order

`image` uses the last configured value. Packages accumulate across all layers; secrets, hosts, and env merge by key (later wins). Old global config files under `~/.pi/agent/extensions/` are ignored.

```toml
# .pi/fort.toml — allow all GitHub operations in this project
enabled = true

[hosts."api.github.com"]
unmatched = "allow"
```

## Commands

| Command | Description |
|---------|-------------|
| `/fort` or `/fort status` | Show VM state, packages, secrets |
| `/fort init` | Create project config files, enable fort |
| `/fort on` | Enable VM isolation for this session |
| `/fort off` | Disable VM isolation for this session (shuts down VM) |
| `/fort restart` | Restart VM on next tool use |
| `/fort add <package>` | Search for, install, and save a distro-native package to `.pi/fort.toml` |
