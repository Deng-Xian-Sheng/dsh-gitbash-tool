# Native MSYS token guard

This directory vendors the `msys-token-guard` helper from the MIT-licensed
[`dsh-git-bash`](https://github.com/inmny/dsh-git-bash) project
(`dsh-plugin-git-bash` 0.3.3, `native/`). It lets Git for Windows Bash start
under the DeepSeek Harness Windows ACL restricted token, so `workspace-write`
and `read-only` sessions do not have to fall back to PowerShell.

## Why a native helper is needed

Git for Windows is an MSYS2/Cygwin program. Under the Windows ACL sandbox,
DSH creates a restricted token; the MSYS runtime's signal pipes and token
default DACL do not line up with that token, so a plain `bash.exe` often fails
to start. The guard starts the same `bash.exe` through the restricted token
after preparing the child token/DACL, and exits with code 125 if it cannot.

## Provenance

- Upstream: `dsh-plugin-git-bash` 0.3.3, `native/`
- Upstream license: MIT (see `UPSTREAM_LICENSE` in this directory)
- Detours: Microsoft Detours 4.0.1, MIT (see `vendor/detours/LICENSE.md`)
- Prebuilt artifacts:
  - `bin/win32-x64/msys-token-guard.exe`
    - SHA-256: `3D516D799C13D79F86C769B2B10DC0CEA1C7F4239E70ACCABEED20620E713C9B`
  - `bin/win32-x64/msys-token-guard-hook.dll`
    - SHA-256: `CC2748345E3ECB65DE1D25F999513F7A33EEDBAFA43979D9DC2E5D7198294EDE`

The C++ source and CMake project are included so the binaries can be reviewed
or rebuilt. Rebuilding requires Visual Studio C++ Build Tools and CMake; normal
plugin installation does not build anything.

## Runtime use

For a confined (`read-only` / `workspace-write`) command the plugin runs:

```text
DSH ACL sandbox runner
  -> native/bin/win32-x64/msys-token-guard.exe --
     <Git>\bin\bash.exe -c <command>
```

`danger-full-access` commands run `bash.exe` directly, without the guard.

Before the first guarded command, the plugin runs the guard once with
`--normalize-server-dacl`, matching the upstream plugin. That normalizes the
server process token's default DACL; it does not grant the command itself any
additional file access.

## Security boundary

The guard only bridges the restricted token into the MSYS runtime. It does not
grant filesystem permissions by itself; the ACL runner still owns the write
boundary. A guard failure is reported as `SANDBOX_UNAVAILABLE`, never silently
retried unconfined.
