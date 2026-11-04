# dsh-gitbash-tool

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）在 Windows 上增加一个模型可调用的 **Git Bash** 工具，并纠正 Windows 预设里“PowerShell 是默认 shell”的提示词偏见。

这个插件只做两件事：

1. 注册 `gitbash` 工具：用 Git for Windows 的 `bash.exe -c` 执行命令，行为向 DSH 原生 `bash` 工具看齐（前台 job、超时升格、后台任务、`promoted` 输出、输出截断/落盘、沙箱策略、终端卡片）；
2. 通过公开的 `system-prompt/assemble` 瀑布，把官方 `pwsh` 工具的描述和 `tool:pwsh` 提示词段改写成“仅在 Git Bash 做不了的 Windows 原生操作时使用”，避免模型在 Windows 上默认写 PowerShell 语法。`pwsh` 工具本身仍然保留可用。

它不替换 DSH 的 `ctx.shell` 执行器，不修改安装目录，不依赖 MCP，也不接管侧栏终端。

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

本插件选择“增加一个工具 + 纠正提示词”的最小路径：

- 官方 PowerShell 执行器保持原位，`pwsh` 仍然是真的 PowerShell；
- `gitbash` 直接通过 `ctx.subprocess` 启动 Git for Windows 的 `bash.exe`；
- Git Bash 的路径解析、沙箱和后台任务都在工具内部完成；
- 提示词纠正只作用于模型可见的组装结果，不改任何官方源码。

## 先搜索过的现成插件

开发前检查过社区已有实现。它们和本项目的定位不同：

| 插件 | 做法 | 与本项目的差异 |
| --- | --- | --- |
| [`dsh-gitbash-shell`](https://github.com/KannaKuron/dsh-gitbash-shell) | 私有 Git Bash 执行器 + 自有 bash 工具，默认隐藏 pwsh，另带 MSYS 路径方言、四个 preset 变体、侧栏终端接管 | 核心思路最接近，但范围大得多；本项目只保留工具和提示词纠正，并让 `pwsh` 继续可用 |
| [`dsh-win-gitbash` / `dsh-tool-gitbash`](https://github.com/buhuikongpan/dsh-win-gitbash) | 注册 `gitbash` 工具，直接消费 `ctx.subprocess`，支持后台和沙箱升级 | 单工具形态很接近，但没有改写 PowerShell 提示词；它的启动期解析也要求 Git 已安装 |
| [`dsh-plugin-git-bash`](https://github.com/inmny/dsh-git-bash) | 替换默认 shell 执行器，让官方 bash 工具跑 Git Bash，带 native guard | 不是“新增一个 git bash 工具”，而是替换执行器 |
| [`dsh-git-bash`](https://github.com/VviLliAm-qwq/dsh-git-bash) | 让 `bash` 在 Host 进程里解析到 Git Bash，复用官方 bash 栈 | 同样是复用官方 bash 工具，不是独立的 Git Bash 工具 |

如果你需要路径方言、preset 变体或侧栏终端，直接使用 `dsh-gitbash-shell` 更合适；如果你只需要一个 Git Bash 工具并纠正 PowerShell 提示词，本项目就是为此准备的。

## 前置条件

- Windows x64
- DSH `0.2.1-rc.1` 及以上（`< 0.3.0`）
- [Git for Windows](https://git-scm.com/download/win)（提供 `bash.exe`）

插件在**每次调用时**懒解析 Git Bash，所以先装插件、后装 Git 也不会让 DSH 启动失败；调用时会返回带安装指引的错误。

自动探测顺序：

1. 插件行 `config.bashPath`
2. 环境变量 `DSH_GIT_BASH_PATH`
3. 标准安装位置（`Program Files\Git`、`Program Files (x86)\Git`、`%LOCALAPPDATA%\Programs\Git`、Scoop）
4. `PATH` 上的 `bash.exe`（跳过 `System32` / WindowsApps 的 WSL 启动器）
5. `PATH` 上的 `git.exe --exec-path` 反推 Git 根目录
6. 注册表 `HKLM/HKCU\SOFTWARE\GitForWindows` 的 `InstallPath`

候选路径会实际运行 `bash.exe -c "uname -s"`，只接受 `MINGW*` / `MSYS*`。WSL、WindowsApps 别名、Cygwin/MSYS2 的非 Git Bash 都会被拒绝。

## 安装

### 从本地目录安装（开发/当前仓库）

```powershell
dsh plugin --profile desktop add C:\path\to\dsh-gitbash-tool
```

安装后重启该 profile 的 DSH，或新建会话。插件只作为 profile bundle 层安装，不修改 DSH 安装目录。

### 从 GitHub 安装（发布后）

```powershell
dsh plugin --profile desktop add github:<owner>/dsh-gitbash-tool
```

`dsh plugin add` 会读取 `package.json` 的 `dsh.bundle.patch`，把本插件的 `cordis.patch.yml` 插入 profile bundle 栈。

## 配置

插件行 id 是 `gitbash-tool`。可以在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: gitbash-tool
  name: dsh-gitbash-tool
  config:
    bashPath: 'D:\Tools\Git\bin\bash.exe'
    enableRunInBackground: true
    promoteOnTimeout: true
    demotePwsh: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `bashPath` | 空 | 显式指定 `bash.exe`；非空时优先且不会回退到自动探测 |
| `enableRunInBackground` | `true` | 是否暴露/允许 `run_in_background` |
| `promoteOnTimeout` | `true` | 前台命令超时后升格为后台 job，而不是直接杀进程；与官方 bash 工具一致 |
| `demotePwsh` | `true` | 是否改写 `pwsh` 工具描述和 `tool:pwsh` 提示词段 |

环境变量：

- `DSH_GIT_BASH_PATH`：无 GUI 配置时指定 Git Bash 路径；
- `DSH_GITBASH_DEMOTE_PWSH=0`：强制保留官方 PowerShell 提示词（等价于 `demotePwsh: false`）。

## 工具行为

工具名：`gitbash`

| 参数 | 说明 |
| --- | --- |
| `command` | Git Bash 命令（`bash.exe -c`） |
| `description` | 一句话用途，显示在 UI |
| `timeoutMs` | 超时，默认 120s，上限 600s；到期默认升格为后台 job（与官方 bash 一致），`promoteOnTimeout: false` 时杀进程 |
| `workdir` | 工作目录；支持 `C:\...` 和 `/c/...`，相对路径按会话工作区解析 |
| `run_in_background` | 立即返回 job id，用 `job_output` / `job_kill` 管理 |

输出与官方 bash 工具一致：

- `stdout` / `stderr`，超长时截断到尾部并给出完整输出文件路径；
- `[exit code: N]`、`[killed by signal: X]`、`[timed out after Nms]` 标记；
- 沙箱拒绝时给出 `[sandbox: file access denied under <mode> mode]`；
- Web UI 使用终端卡片显示命令、cwd、输出和退出码。

### 沙箱说明（重要）

DSH 在 Windows 上使用 ACL restricted-token runner 做文件沙箱。Git for Windows 的 MSYS/Cygwin 运行时在受限 token 下经常无法启动（历史错误包括 Win32 error 5 / `0xC0000142`）。

本插件的策略是**不静默绕过**：

- `danger-full-access`：直接运行 Git Bash，正常工作；
- `read-only` / `workspace-write`：仍然交给 `ctx.sandbox.confine` 包装；如果 ACL runner 无法启动 Git Bash，工具返回 `SANDBOX_UNAVAILABLE` 并明确说明“不要用其他方式绕过”；
- 需要受限模式时，请用 `pwsh` 执行该命令，或把当前会话切到 `danger-full-access` 后再用 `gitbash`。

这不是本插件能单独解决的平台限制。`dsh-gitbash-shell` / `dsh-plugin-git-bash` 通过 native guard、或直接声明“受限模式不可用”来处理同一问题。

## 提示词纠正

Windows 预设里，模型看到的主要 PowerShell 文本来自两处：

1. `pwsh` 工具的 schema description（其中包含 `$env:NAME`、PowerShell sandbox 细节和 `Get-Process` 示例）；
2. `dsh-tool-pwsh` 注册的 `tool:pwsh` 系统提示词段。

插件在 `system-prompt/assemble` 瀑布的 `next()` 之后：

- 把 `pwsh` 工具的 description 改成“仅用于 Git Bash 做不了的 Windows 原生操作”，并移除 `Get-Process` 等默认示例；
- 把 `tool:pwsh` 段改成“PowerShell 仅用于 Windows 原生操作，shell 工作优先 `gitbash`”；
- 新增 `tool:gitbash` 段，说明 Git for Windows Bash（不是 Linux bash）的路由规则；
- 不删除、不隐藏 `pwsh` 工具，`pwsh` 仍可正常工作。

如果其他插件也修改 `system-prompt/assemble`，本插件的改写只影响 `pwsh` 工具/段，不会改动其他工具或用户 AGENTS.md。

## 开发

```powershell
node --test
```

测试覆盖：

- Git Bash 解析、显式路径优先级、失败关闭、WSL 拒绝、标准候选路径；
- `gitbash` 描述明确区分 Git Bash 与 Linux bash；
- `pwsh` 描述/段的改写是纯函数，不修改原对象。

## 许可证与来源

本项目以 MIT 发布。

工具结构参考了 DSH 官方 `@deepseek-ai/dsh-tool-bash` / `dsh-tool-pwsh` 的公开契约，以及社区 MIT 项目 [`dsh-win-gitbash`](https://github.com/buhuikongpan/dsh-win-gitbash) 的 `gitbash` 工具实现思路。相关版权声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
