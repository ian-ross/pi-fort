# pi-fort

> From [yapp](https://github.com/ian-ross/pi-fort) · yet another pi pack

VM-isolated fort for [pi](https://pi.dev). Runs all tools inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM so secrets never enter the agent's execution environment.

```bash
pi install npm:pi-fort
```

Requires QEMU: `brew install qemu` (macOS) or `sudo apt install qemu-system-x86` / `sudo apt install qemu-system-aarch64` (Linux, matching your host architecture).

## How it works

pi-fort starts a Linux micro-VM using QEMU matching your host architecture, and redirects all tool execution into it. By default it expects `PI_FORT_IMAGE` to point at the built `pi-work` Gondolin asset directory. Your workspace is mounted read-write at the same path inside the VM, so tools see identical paths on host and guest. File changes are bidirectional.

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
    └── github.toml         # GitHub secrets + policies
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

By default pi-fort uses the `pi-work` container image built from this package. Build it, then point `PI_FORT_IMAGE` at the resulting Gondolin asset directory:

```bash
pnpm build:container
export PI_FORT_IMAGE="$PWD/containers/pi-work"
# or: make -C containers pi-work
```

Set `PI_FORT_IMAGE=alpine-default` to explicitly use Gondolin's built-in Alpine image. If `PI_FORT_IMAGE` is unset or points at a missing directory, fort fails closed instead of silently downloading/using Alpine.

You can override the image per project:

```toml
distro = "debian"
image = "../containers/pi-work"
```

Relative image paths are resolved relative to the config file that sets them. `PI_FORT_IMAGE` is path-only, except for the special `alpine-default` value; relative env paths resolve from Pi's startup directory. Supported pi-fort package-manager distros are `alpine` and `debian`. Note that Gondolin's build config may still say `distro = "alpine"` because Gondolin currently builds Alpine kernel/initramfs assets; pi-fort's `distro` controls userspace package-manager behavior inside the rootfs. `packages` are distro-native package names and still accumulate across config layers.

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

### HTTP egress

By default, pi-fort only allows HTTP egress to explicitly configured hosts: secret host scopes, `[hosts]` policy entries, and package repository hosts needed for setup. Set `allow_egress = true` to allow HTTP requests to any public host while still applying method/path/GraphQL restrictions to hosts explicitly listed under `[hosts]`.

```toml
allow_egress = true
```

Internal/private IP ranges remain blocked. DNS inside the VM uses Gondolin synthetic DNS: normal tools can resolve hostnames, but HTTP/TLS policy and upstream resolution are still enforced on the host side.

### Host policies

Access control per configured host. `unmatched` determines what happens to requests that don't match any allow/deny rule.

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

The workspace directory is mounted automatically at the same path inside the VM. Use `mounts` for directories outside it, like a jj/git repo root that is a parent of the workspace. Relative host paths in config files are resolved against the config file that sets them. Missing host paths are silently skipped, so optional mounts are safe to declare unconditionally:

```toml
# In .pi/fort.toml (project config)
mounts = [
  { path = "../.jj", readonly = false },
  { path = "../.git", readonly = false },
]
```

Absolute and `~`-prefixed paths also work:

```toml
mounts = [{ path = "~/shared/data", readonly = true }]
```

Mounts appear at the same absolute path inside the VM unless you choose a different guest path with `target`:

```toml
mounts = [
  { path = "~/shared/configs", target = "/mnt/configs", readonly = true },
]
```

### Config layering

pi-fort loads configuration from the current project only. Merge order is:

1. `.pi/fort.d/*.toml` in alphabetical order
2. `.pi/fort.toml`

Drop-ins provide integration defaults; `.pi/fort.toml` is authoritative. `image`, `distro`, and `allow_egress` use the last configured value. Packages accumulate across all layers; secrets, hosts, mounts, git credentials, and env merge by key/target (later wins). Old global config files under `~/.pi/agent/extensions/` are ignored.

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
| `/fort network allow\|deny` | Persist whether arbitrary public HTTP egress is allowed |
| `/fort container <container-path>` | Use a Debian Gondolin image; relative paths are interpreted from Pi's startup directory and stored relative to `.pi/fort.toml` |
| `/fort container default` | Return to the `PI_FORT_IMAGE` default by removing `distro` and `image` from `.pi/fort.toml` |
| `/fort mount <host-path> [<vm-path>]` | Add/update a read-only mount, keyed by guest path |
| `/fort mount-writable <host-path> [<vm-path>]` | Add/update a read-write mount, keyed by guest path |
| `/fort list-mounts` | Show built-in and configured mounts, including missing/skipped paths |
| `/fort unmount <guest-path>` | Remove a `.pi/fort.toml` mount by guest path; the built-in workspace mount cannot be removed |
