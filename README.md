# dsh-gitbash-tool

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）在 Windows 上增加一个模型可调用的 **Git Bash** 工具，并在不删除 PowerShell 语法参考的前提下，把 Windows 预设里“PowerShell 是默认 shell”的叙述改成 Git Bash 优先的路由。

仓库：<https://github.com/Deng-Xian-Sheng/dsh-gitbash-tool>

这个插件主要做这些事：

1. 注册 `gitbash` 工具：用 Git for Windows 的 `bash.exe -c` 执行命令，行为向 DSH 原生 `bash` 工具看齐（前台 job、超时升格、后台任务、`promoted` 输出、输出截断/落盘、终端卡片）；
2. 没有 Git for Windows 时，自动下载并安装一个私有 PortableGit（SHA-256 校验，普通用户权限即可）；
3. 在默认的 `workspace-write` / `read-only` 下通过 native MSYS token guard 启动 Git Bash，保留 ACL 写入边界；
4. 支持 `sandbox_permissions` + `justification` 的一次性沙箱升级审批；
5. 通过公开的 `system-prompt/assemble` 瀑布，在官方 `pwsh` 工具描述和 `tool:pwsh` 提示词段前加上“PowerShell 不是默认 shell，普通 shell 工作优先 `gitbash`”的路由说明；**原有 PowerShell 语法和示例完整保留**，供 Git Bash 做不了的 Windows 原生操作使用。`pwsh` 工具本身仍然保留可用。

它不替换 DSH 的 `ctx.shell` 执行器，不修改安装目录，不依赖 MCP，也不接管侧栏终端。

## 安装

要求：Windows x64、DSH `0.2.1-rc.1` 及以上（`< 0.3.0`）。Git for Windows 可选；缺失时插件会在首次 `gitbash` 调用时自动安装私有 PortableGit（详见下一节）。

### 从本地目录安装（开发/当前仓库）

```powershell
dsh plugin --profile desktop add C:\path\to\dsh-gitbash-tool
```

### 从 GitHub 安装

```powershell
dsh plugin --profile desktop add github:Deng-Xian-Sheng/dsh-gitbash-tool
```

`dsh plugin add` 会读取 `package.json` 的 `dsh.bundle.patch`，把本插件的 `cordis.patch.yml` 插入 profile bundle 栈。

安装后重启该 profile 的 DSH，或新建会话。插件只作为 profile bundle 层安装，不修改 DSH 安装目录。

## 前置条件

- Windows x64
- DSH `0.2.1-rc.1` 及以上（`< 0.3.0`）
- Git for Windows 可选：**没有安装时插件会自动装一个私有 PortableGit**

插件在**每次调用时**懒解析 Git Bash。找不到 Git 时，默认会自动下载并解压一个固定版本的 Git for Windows PortableGit 到：

```text
%LOCALAPPDATA%\dsh-gitbash-tool\git\PortableGit-2.56.0.4
```

下载地址固定为 Git for Windows 官方 release，SHA-256 校验通过后才解压；不需要管理员权限。首次调用会多等一段时间（约 60 MB 下载）。自动安装由 Host 插件执行，属于“安装依赖”，不是会话里的 `gitbash` 命令在沙箱内执行；因此只接受固定 HTTPS 源和固定 SHA-256，解压只写用户本地安装目录。如果用户显式配置了 `bashPath` 或 `DSH_GIT_BASH_PATH`，插件不会用自动安装覆盖它，而是直接报错。

自动探测顺序：

1. 插件行 `config.bashPath`
2. 环境变量 `DSH_GIT_BASH_PATH`
3. 自动安装目录的 `current.txt` 标记
4. 标准安装位置（`Program Files\Git`、`Program Files (x86)\Git`、`%LOCALAPPDATA%\Programs\Git`、Scoop）
5. `PATH` 上的 `bash.exe`（跳过 `System32` / WindowsApps 的 WSL 启动器）
6. `PATH` 上的 `git.exe --exec-path` 反推 Git 根目录
7. 注册表 `HKLM/HKCU\SOFTWARE\GitForWindows` 的 `InstallPath`

候选路径会实际运行 `bash.exe -c "uname -s"`，只接受 `MINGW*` / `MSYS*`。WSL、WindowsApps 别名、Cygwin/MSYS2 的非 Git Bash 都会被拒绝。

## 与官方 bash 工具的对齐

exe 版 DSH 的工具源码打包在 `resources/app.asar` 里，开发时直接读取了：

```text
app.asar/dsh/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js
```

`gitbash` 的执行层与官方 bash 工具对齐：

- 前台命令在 job registry 可用时先注册为 job，再等待结果；
- `promoteOnTimeout` 默认开启：等待超时不会杀进程，而是返回 `kind: "promoted"` 和 job id，进程继续在后台运行；
- 输出联合类型包含 `background` / `promoted` / `foreground`，`presentResult` 对 promoted 使用 generic 卡片；
- 后台 job 的 output ring、`job_output` 续读、`job_kill`、`stopped` 标记按官方 bash 的语义处理；
- 终端卡片、退出码标记、stderr 段、超时/信号标记保持一致；
- 系统提示词段的位置使用 `TOOL_BASH` 的顺序，而不是 pwsh 的顺序。

差异只在执行器：官方 bash 通过 `ctx.shell`，本工具直接消费 `ctx.subprocess` + `ctx.sandbox`，因为 Windows 上的 `ctx.shell` 被官方 PowerShell 执行器占用，而本插件不替换它。工具描述、路径方言和提示词是 Git Bash 专用，不是 PowerShell 专用。

## 为什么不是一个“切换默认 shell”的插件

DSH 在 Windows 上的标准预设把 `tool-bash` 禁用、把 `tool-pwsh` 启用。单纯换掉 `ctx.shell` 执行器会影响所有 shell 消费方，也容易和沙箱、持久终端、其他插件互相覆盖。

本插件选择“增加一个工具 + 路由提示词”的最小路径：

- 官方 PowerShell 执行器保持原位，`pwsh` 仍然是真的 PowerShell；
- `gitbash` 直接通过 `ctx.subprocess` 启动 Git for Windows 的 `bash.exe`；
- Git Bash 的路径解析、沙箱和后台任务都在工具内部完成；
- 提示词路由只作用于模型可见的组装结果，不改任何官方源码。

## 先搜索过的现成插件

开发前检查过社区已有实现。它们和本项目的定位不同：

| 项目 | 做法 | 与本项目的差异 |
| --- | --- | --- |
| [`dsh-gitbash-shell`](https://github.com/KannaKuron/dsh-gitbash-shell) | 私有 Git Bash 执行器 + 自有 bash 工具，默认隐藏 pwsh，另带 MSYS 路径方言、四个 preset 变体、侧栏终端接管 | 核心思路最接近，但范围大得多；本项目只保留工具、自动安装、native guard 和提示词路由，并让 `pwsh` 继续可用 |
| [`dsh-win-gitbash`](https://github.com/buhuikongpan/dsh-win-gitbash)（仓库内 package 名 `dsh-tool-gitbash`，未发布 npm） | 注册 `gitbash` 工具，直接消费 `ctx.subprocess`，支持后台和沙箱升级 | 单工具形态很接近，但没有给 PowerShell 提示词加路由；它的启动期解析也要求 Git 已安装 |
| [`dsh-plugin-git-bash`](https://github.com/inmny/dsh-git-bash)（仓库名 `dsh-git-bash`） | 替换默认 shell 执行器，让官方 bash 工具跑 Git Bash，带 native guard | 不是“新增一个 git bash 工具”，而是替换执行器 |
| [`dsh-git-bash`](https://www.npmjs.com/package/dsh-git-bash)（GitHub 仓库已 404，npm 包仍在） | 让 `bash` 在 Host 进程里解析到 Git Bash，复用官方 bash 栈 | 同样是复用官方 bash 工具，不是独立的 Git Bash 工具 |

表中链接优先指向项目主页；GitHub 仓库名和 npm package 名可能不同，括号里已经注明。`dsh-git-bash` 的原 GitHub 仓库已经 404，但 npm 包 `dsh-git-bash@0.1.3` 仍可安装。

如果你需要路径方言、preset 变体或侧栏终端，直接使用 `dsh-gitbash-shell` 更合适；如果你只需要一个 Git Bash 工具、自动安装和 PowerShell 路由，本项目就是为此准备的。

## 配置

插件行 id 是 `gitbash-tool`。可以在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: gitbash-tool
  name: dsh-gitbash-tool
  config:
    bashPath: 'D:\Tools\Git\bin\bash.exe'
    autoInstallGit: true
    gitInstallDir: 'C:\Users\me\AppData\Local\dsh-gitbash-tool\git'
    enableRunInBackground: true
    promoteOnTimeout: true
    demotePwsh: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `bashPath` | 空 | 显式指定 `bash.exe`；非空时优先且不会回退到自动探测/自动安装 |
| `autoInstallGit` | `true` | 找不到 Git 时自动下载并安装私有 PortableGit |
| `gitInstallDir` | `%LOCALAPPDATA%\dsh-gitbash-tool\git` | 自动安装目录；必须是绝对路径 |
| `gitDownloadUrl` | 固定 Git for Windows release | 镜像/离线源可覆盖；必须 HTTPS |
| `gitSha256` | 固定 SHA-256 | 覆盖下载源时必须同时覆盖校验值 |
| `enableRunInBackground` | `true` | 是否暴露/允许 `run_in_background` |
| `promoteOnTimeout` | `true` | 前台命令超时后升格为后台 job，而不是直接杀进程；与官方 bash 工具一致 |
| `demotePwsh` | `true` | 历史字段名，保留兼容；实际行为是给 `pwsh` 工具描述和 `tool:pwsh` 段加 Git Bash 路由说明，原有 PowerShell 语法和示例保留 |

环境变量：

- `DSH_GIT_BASH_PATH`：无 GUI 配置时指定 Git Bash 路径；显式路径失败不会触发自动安装；
- `DSH_GITBASH_AUTO_INSTALL=0`：关闭自动安装 Git；
- `DSH_GITBASH_DEMOTE_PWSH=0`：历史变量名，保留兼容；强制保留官方 PowerShell 提示词（等价于 `demotePwsh: false`）。

## 工具行为

工具名：`gitbash`

| 参数 | 说明 |
| --- | --- |
| `command` | Git Bash 命令（`bash.exe -c`） |
| `description` | 一句话用途，显示在 UI |
| `timeoutMs` | 超时，默认 120s，上限 600s；到期默认升格为后台 job（与官方 bash 一致），`promoteOnTimeout: false` 时杀进程 |
| `workdir` | 工作目录；支持 `C:\...` 和 `/c/...`，相对路径按会话工作区解析 |
| `run_in_background` | 立即返回 job id，用 `job_output` / `job_kill` 管理 |
| `sandbox_permissions` | 沙箱拒绝后，请求更宽的一次性权限；与 `justification` 成对使用 |
| `justification` | 一句话说明为什么这次命令需要更宽权限；会显示在审批弹窗里 |

输出与官方 bash 工具一致：

- `stdout` / `stderr`，超长时截断到尾部并给出完整输出文件路径；
- `[exit code: N]`、`[killed by signal: X]`、`[timed out after Nms]` 标记；
- 沙箱拒绝时给出 `[sandbox: file access denied under <mode> mode]`；
- Web UI 使用终端卡片显示命令、cwd、输出和退出码。

### 沙箱说明（重要）

DSH 在 Windows 上的默认权限不是“无沙箱”：

```yaml
# dsh-base
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
```

也就是说，新会话默认是 **`workspace-write` + Windows ACL 沙箱 + approval=ask**。普通 Git for Windows 的 MSYS/Cygwin 运行时在受限 token 下经常无法启动（历史错误包括 Win32 error 5 / `0xC0000142`）；如果插件不做处理，模型就会退回 `pwsh`，工具等于没起作用。

本插件内置了 **native MSYS token guard**：

- `danger-full-access`：直接运行 `bash.exe`；
- `read-only` / `workspace-write`：由 ACL runner 启动 `msys-token-guard.exe`，guard 准备 restricted child token 后再启动 `bash.exe`；
- guard 失败时返回 `SANDBOX_UNAVAILABLE`，**不静默改走 pwsh，也不静默取消沙箱**；
- guard 的源码和预编译二进制在 `native/`，来源是 MIT 的 `dsh-plugin-git-bash`；上游许可证见 `native/UPSTREAM_LICENSE`。

如果 guard 在你的机器上仍然失败，请把 `SANDBOX_UNAVAILABLE` 的完整错误发回来；不要把它当成普通命令失败重试。

已验证：用临时 headless profile 设置 `DSH_PERMISSION_MODE=workspace-write` 启动，guard 路径下 Git Bash 正常启动，工作区外写入被拒绝（`Permission denied`，`write_exit=1`），没有回退到 `pwsh`。全权限会话的直接调用不会走 guard，因此上述验证使用独立的 workspace-write profile。

#### 重要坑：不要把 PortableGit 从工作区移到 Program Files

如果 PortableGit 是在 DSH 工作区内解压的，它会继承工作区的 ACL：

```text
S-1-4-...(OI)(CI)(W,D,DC)
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

把它整个目录移到 `%LOCALAPPDATA%\Programs\Git` 时，文件上的 `Low` 完整性标签也会一起带过去。**Low 标签会限制 `bash.exe` 进程本身**，所以即使会话批准了 `danger-full-access`，甚至直接启动这个 `bash.exe`，它仍然是 Low integrity，写不了 Medium 的 Desktop/Documents，典型表现就是：

```text
审批 allowed-once
命令仍然 Permission denied
没有 [sandbox: ...] 标记
```

检查：

```powershell
icacls "C:\path\to\Git\bin\bash.exe"
```

如果看到 `Mandatory Label\Low Mandatory Level`，就是这个原因。

修复：

1. 删除这个继承 Low 标签的 Git 安装；
2. 让本插件自动安装到私有目录：
   ```text
   %LOCALAPPDATA%\dsh-gitbash-tool\git
   ```
   或使用 Git for Windows 官方安装器装到 `C:\Program Files\Git`；
3. 不要把工作区里解压的 PortableGit 直接移动到 `Program Files` 或 `%LOCALAPPDATA%\Programs`。

插件现在会检查 `bash.exe` 的完整性标签，**拒绝 Low-labeled Git** 并优先使用自己的私有安装；如果检测到 Low 标签且没有其他可用 Git，会自动安装一份干净副本。

### 沙箱审批升级（与官方 bash 一致）

`gitbash` 现在支持官方 bash 同款的：

```jsonc
{
  "sandbox_permissions": "danger-full-access",
  "justification": "需要把结果写到工作区外"
}
```

触发方式：

1. 在默认 `workspace-write` 或 `read-only` 会话里，让 `gitbash` 执行一个会被沙箱拒绝的操作，例如写工作区外文件；
2. 工具返回拒绝后，模型可以对**同一条命令**重试一次，并带上 `sandbox_permissions`（取比当前模式更宽的 `workspace-write` 或 `danger-full-access`）和 `justification`；
3. 如果当前 approval policy 是 `ask`（默认非 full-access 模式），DSH 会弹出审批；用户批准后，这一条命令以批准的模式执行一次；拒绝则保持拒绝；
4. 如果 approval policy 是 `never`（例如 full-access 模式），不会弹窗；请求相同模式会直接执行，请求更宽/更窄会按规则失败。

注意：

- 升级只作用于**当前这一次调用**，不会把整个会话切到 full access；
- 不是“沙箱失败自动重试”；必须显式带 `sandbox_permissions` 才会走审批；
- 不能 speculative 升级；没有先发生拒绝就请求更宽权限，工具仍会要求审批，但这不符合官方 bash 的使用约定；
- 如果 native guard 返回 `SANDBOX_UNAVAILABLE`，那是 guard/运行器问题，不是普通的文件拒绝；不要把它当作可重试的沙箱拒绝。

可以在“仅可查看”会话里这样测：先让模型写一个工作区外文件（应被拒绝），然后对它说“用 `sandbox_permissions: danger-full-access` 和 justification 重试一次”，审批框应该出现。

## 提示词路由

Windows 预设里，模型看到的主要 PowerShell 文本来自两处：

1. `pwsh` 工具的 schema description（包含 `$env:NAME`、PowerShell sandbox 细节和 `Get-Process` 等语法示例）；
2. `dsh-tool-pwsh` 注册的 `tool:pwsh` 系统提示词段。

本插件只做“路由”，不删除语法参考。在 `system-prompt/assemble` 瀑布的 `next()` 之后：

- 在 `pwsh` 工具 description 前面加上“PowerShell 不是默认 shell；普通 shell 工作用 `gitbash`，只有 Git Bash 做不了的 Windows 原生操作才用 PowerShell”；
- 在 `tool:pwsh` 段前面加上同样的路由说明；
- **完整保留**原有的 PowerShell 语法、`$env:NAME`、`Get-Process` 示例和 Windows 结果说明；
- 新增 `tool:gitbash` 段，说明 Git for Windows Bash（不是 Linux bash）的路由规则；
- 不删除、不隐藏 `pwsh` 工具，`pwsh` 仍可正常工作。

这样在 Git Bash 做不了、必须用 PowerShell 时，模型仍然有语法参考；同时不会被“Windows 默认用 PowerShell”这种叙述带偏。

如果其他插件也修改 `system-prompt/assemble`，本插件只影响 `pwsh` 工具/段，不会改动其他工具或用户 AGENTS.md。

## 开发

```powershell
node --test
```

测试覆盖：

- Git Bash 解析、显式路径优先级、失败关闭、WSL 拒绝、标准候选路径；
- PortableGit 解压、SHA-256 校验、`bash.exe` 实测；
- 自动下载链路已实测：57.3 MiB、SHA-256 校验通过、解压后 `uname -s` 为 `MINGW64_NT-*`；
- native guard 文件存在性与 DACL 归一化；`workspace-write` 下 guard + ACL 的越界写入拒绝已实测；
- `sandbox_permissions` 严格加宽阶梯、参数配对、审批通过/拒绝/取消/不可用；
- `gitbash` 描述明确区分 Git Bash 与 Linux bash；
- `pwsh` 描述/段的路由前缀是纯函数，保留原语法且不修改原对象。

`native/` 下是 Windows ACL 沙箱需要的 MSYS token guard，源码和二进制来自 MIT 项目 [`dsh-plugin-git-bash`](https://github.com/inmny/dsh-git-bash)；相关版权声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 许可证与来源

本项目以 MIT 发布。

工具结构参考了 DSH 官方 `@deepseek-ai/dsh-tool-bash` / `dsh-tool-pwsh` 的公开契约，以及社区 MIT 项目 [`dsh-win-gitbash`](https://github.com/buhuikongpan/dsh-win-gitbash) 的 `gitbash` 工具实现思路。Windows ACL 下的 MSYS token guard 来自 MIT 项目 [`dsh-plugin-git-bash`](https://github.com/inmny/dsh-git-bash)。相关版权声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
