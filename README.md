# Interview and Written Test Assistant

Windows 静默全屏截图工具，以及 MeetingCopilot 的截图功能替换补丁。

当前仓库聚焦截图功能，不包含完整 MeetingCopilot、QuizCoze 客户端或 AI 后端。

## 独立使用

下载或克隆仓库，运行 [`bin/QuietCapture.exe`](bin/QuietCapture.exe)：

- **Ctrl+Alt+F9**：截取整个桌面，PNG 保存在 exe 旁的 `Screenshots` 目录。
- 不显示框选、截图预览、通知或命令行窗口。
- 右键系统托盘图标，可打开截图目录或退出；图标可能收纳在任务栏的 `^` 菜单内。
- 多显示器合并为一张图片。程序只在本地保存图片，不联网、不设置开机自启。

面向 Windows 10/11，使用 Windows 自带的 .NET Framework。源码位于 [`src/QuietCapture.cs`](src/QuietCapture.cs)。

## 替换 MeetingCopilot 的截图功能

已验证版本：**MeetingCopilot 0.2.0-beta.1**。安装脚本会校验主进程源码哈希，遇到其他构建会停止，不尝试猜测修改位置。

1. 安装 Python 3.10 或更新版本。
2. 退出 MeetingCopilot（通过托盘退出，不只是隐藏主窗口）。
3. 在仓库目录运行：

```powershell
# 先检查匹配情况，不修改任何文件。
python .\meeting-copilot\install.py --check

# 安装到默认位置：%LOCALAPPDATA%\Programs\meeting-copilot。
python .\meeting-copilot\install.py
```

自定义安装位置可作为参数传入：

```powershell
python .\meeting-copilot\install.py 'D:\Apps\meeting-copilot'
```

安装后重新启动 MeetingCopilot，使用它原有的截图按钮或截图快捷键（默认 **Ctrl+Shift+S**）。现在会直接截取全屏，不再打开框选窗口，图片仍交给原有视觉问答流程。设置中的截图键输入框支持按下键盘组合录入，也支持按下鼠标侧键录入 **Mouse4** / **Mouse5**。程序不会替你更改模型、API、账号、音频或会话设置。

集成模式使用同一个截图程序的 `--capture-once` 入口，返回 PNG data URL 后删除临时图片，不额外注册快捷键或启动托盘。此模式不会将截图保存在独立工具的 `Screenshots` 目录。

### 修改范围与备份

- ASAR 内只修改 `out/main/index.js` 和设置页资源 `out/renderer/assets/index-hyFYaQxP.js`。
- 新增 `resources/tools/QuietCapture.exe`。
- 鼠标侧键监听由辅助程序通过本地命名管道传递给 MeetingCopilot；退出应用时会停止监听。
- 原始 `resources/app.asar` 保存在 `resources/app.asar.quiet-capture.bak`。
- 不重新打包原生依赖；其他文件内容、ASAR 文件条目和 `app.asar.unpacked` 保持原状。
- 软件升级可能覆盖本地补丁；新版本需要重新验证。

恢复时先退出 MeetingCopilot，再把备份复制回 `resources/app.asar`。新增的辅助 exe 可以保留，恢复后的原程序不会调用它。

如果当前安装此前已手动应用过同一补丁，脚本会报告已安装；恢复时应使用当时保留的备份，不能假定存在上述 `.bak` 文件。

可审查的修改：[unified diff](meeting-copilot/changes.patch) · [精确匹配补丁](meeting-copilot/patch.json) · [安装脚本](meeting-copilot/install.py)。

## 编译与检查

```powershell
.\build.cmd
python -m unittest discover -s tests -v
```

编译使用 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，不需要安装 npm 包或 .NET SDK。

可选的真实截图自检（请先退出独立截图工具）：

```powershell
.\bin\QuietCapture.exe --self-test "$env:TEMP\quiet-capture-check.png"
```

自检会实际保存一张截图，以及同路径的 `.json` 检查结果。内部单次截图接口：

```powershell
.\bin\QuietCapture.exe --capture-once "$env:TEMP\quiet-capture-once.png"
```

已在真实安装包中验证 `renderer preload → IPC → 原生截图程序` 链路：返回 2560×1600 PNG，截图前后窗口数和焦点不变，没有创建框选窗口。另验证了临时文件清理、辅助程序失败路径，以及已有图片不重复截屏。该次验证没有向 AI 接口发送截图；结果见 [`tests/verified-runtime.json`](tests/verified-runtime.json)。

## 统一多模态接口与独立提示词

在截图及改键补丁基础上，`meeting-copilot/install_multimodal.py` 在原有“视觉模型”设置区域增加动态自定义接口。退出 MeetingCopilot 后安装或升级：

```powershell
python meeting-copilot/install_multimodal.py --check
python meeting-copilot/install_multimodal.py
node --test tests/multimodal.test.cjs
```

在设置 → 高级设置 → 视觉模型中，点击标题右侧的“＋”每次添加一个备用 API 接口，填写各接口的 Base URL、模型名、密钥、代理和超时，勾选启用多模态回答后保存。默认显示一个主接口，可继续新增或移除接口。支持 OpenAI 兼容的 Chat Completions 多模态模型。按从上到下的顺序处理超时、HTTP/网络错误、空回答和明确拒答；点击停止会中止后续尝试。拒答文本检测是启发式规则，可在设置中关闭。回答完整返回后再展示。

截图、文字问答、翻译与会话备忘共享此配置。普通文字请求不会自动截图；图片仍由截图按钮或快捷键明确提交。ASR 配置保持独立。原视觉接口为空时初始不启用统一接口，保留原文本模式供用户先配置。

提示词初始模板在 `meeting-copilot/prompts`，实际可编辑文件位于应用用户数据目录的 `multimodal/prompts`。设置中的“打开提示词文件夹”可定位；每次提问重新读取。提供通用、笔试、面试及自动场景规则，另保留原始视觉提示词备份。密钥用 Electron safeStorage 加密，界面只返回是否已保存。

安装前备份为 `resources/app.asar.before-multimodal.bak`，退出应用后复制覆盖 `app.asar` 可恢复到本次安装前的状态。软件更新可能覆盖程序补丁；用户数据目录中的接口配置和提示词保留。

从旧的固定四接口补丁升级时，另外保留 `resources/app.asar.before-dynamic-vision.bak`、运行模块备份及 `multimodal/interfaces.json.before-dynamic.bak`。已填写的接口及提示词保留，仅收起旧版未使用的空白占位项。每个接口使用独立 ID，新增或移除后不会把已保存密钥分配给另一个接口。

## 可选区域截图（无全屏蒙层）

保留现有静默全屏截图，另外增加原生框选。安装当前视觉模型补丁后，退出 MeetingCopilot 再运行：

```powershell
.\build.cmd
python meeting-copilot/install_region_capture.py --check
python meeting-copilot/install_region_capture.py
node --test tests/quiet-capture.test.cjs tests/multimodal.test.cjs
```

常用设置里分别配置“静默全屏截图键”和“框选截图键”。原全屏快捷键保持不变，框选默认 `Control+Shift+A`；支持录入组合键或鼠标侧键 `Mouse4` / `Mouse5`，不同动作不能绑定同一键。点击“清除框选快捷键”可以取消区域快捷键绑定。配置好视觉接口、启用多模态后，右栏的相机按钮仍然截全屏，旁边新增“框选”按钮。

框选只显示四条 2 像素细边和一个小提示窗口，不创建全屏窗口、不铺蒙层、不重绘截图作背景；选择窗口不激活、不抢前台焦点。左键拖动选取，Esc 或右键取消，等待 60 秒自动取消；连续触发不会叠加选择器。窗口初始化时先取一帧，选好后裁剪该帧，避免将选框或提示截入图片。动态内容以开始框选时的画面为准。不同显示器环境中的物理像素坐标会按虚拟桌面处理。

原生测试入口（输出路径须尚不存在）：

```powershell
.\bin\QuietCapture.exe --self-test-region <output.png>
```

本机已验证实际快捷键触发、Esc 取消、真实鼠标拖选、临时文件清理及原全屏截图回归。自检检查无全屏窗口、前台焦点不变、裁剪像素与初始帧相同、钩子释放和负坐标裁剪；测试记录见 `tests/verified-region-capture.json`。这些结果描述本机测试范围，不等于对所有显卡驱动、HDR 或远程桌面环境作零闪烁保证。

安装前程序包备份为 `resources/app.asar.before-region-capture.bak`，辅助程序备份为 `resources/tools/QuietCapture.exe.before-region.bak`。退出应用后分别恢复可回退本次截图改动。区域快捷键保存在用户数据目录的 `capture.json`，视觉模型配置及独立提示词继续使用现有文件。

实现依据：[LowLevelMouseProc](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc)、[窗口扩展样式](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)、[SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)。

## 快捷键录制修复与多模型同时回答

在上述补丁基础上，`meeting-copilot/install_shortcuts_parallel.py` 增加专用快捷键录制器，并修复侧键带来的网页前进/后退。退出应用后运行：

```powershell
.\build.cmd
python meeting-copilot/install_shortcuts_parallel.py --check
python meeting-copilot/install_shortcuts_parallel.py
node --test tests/shortcut-runtime.test.cjs tests/quiet-capture.test.cjs tests/multimodal.test.cjs
```

两组截图快捷键都支持“录制”“手动填写”“清除”。录制期间临时注销软件自身的全局键，让已有组合键可以重新录入；接受 Ctrl/Alt/Shift/Win 组合、F1–F24 和 Mouse4 / Mouse5，松开主键后恢复原有注册，保存后启用新值。录制失去焦点、关闭设置或超时会恢复全局键。手动填写适用于直接输入 `Control+Shift+S` 等格式。

侧键使用原生低级鼠标钩子：被绑定的侧键按下和松开均拦截，松开后仅触发一次截图，未绑定的按钮正常放行。录制时两枚侧键都进入录制器，不触发截图。原先轮询 GetAsyncKeyState 的实现已替换。辅助进程会在父应用退出后释放钩子。

视觉模型设置中的“同时回答”默认不勾选。勾选并保存后，截图与普通提问同时调用所有已启用且 URL、模型名完整的接口，按接口分别显示结果；先返回的先出现，每个接口保留自己的超时和错误。停止按钮取消全部仍在进行的请求，已完成答案保留。未勾选时继续按原来的顺序切换备用接口。每个启用接口各自发起请求，后台翻译、会话备忘仍使用单接口。

测试包含录制暂停与恢复、侧键改回组合键、按键转换、并发启动、部分失败、先返回先显示及全部取消。原生鼠标钩子自检：`bin/QuietCapture.exe --self-test-mouse <report.json>`。本次程序包备份为 `resources/app.asar.before-shortcuts-parallel.bak`；被替换的模块和辅助程序保留同名 `.before-shortcuts-parallel.bak` 备份。

## 设置保存与笔试 Prompt

`meeting-copilot/install_persistence_prompts.py` 为设置添加常驻顶部“保存设置”栏、视觉模型区独立“保存视觉设置”按钮及未保存关闭提示。空白备用接口、未填写密钥的接口允许先保存。保存后显示成功状态，页面保持打开；齿轮、关闭按钮、帮助/诊断跳转和标题栏退出都会在存在修改时提供“保存并关闭 / 放弃修改 / 继续编辑”。视觉设置单独保存不会提交其他还在编辑的设置。

```powershell
python meeting-copilot/install_persistence_prompts.py --check
python meeting-copilot/install_persistence_prompts.py
node --test tests/settings-save.test.cjs tests/multimodal.test.cjs tests/quiet-capture.test.cjs tests/shortcut-runtime.test.cjs
```

笔试模式单独读取用户数据目录下的 `multimodal/prompts/written.md`，所有接口共享同一份系统提示词，包括同时回答和顺序切换。选择题只给选项字母（如 B / AC），不要题号，简单题只给答案，简答题只列必要要点；用户明确要求解析时才解释。设置里的“定位笔试 Prompt”可定位实际生效文件，保存文件后下一次提问读取新内容。

面试模式保留原版消息构造、简历、JD、历史和语言指令。普通面试使用从原代码 PERSONA 提取的 `interview.md`（第一人称口语回答、技术题先思路后关键点）；截图面试使用原 `buildVisionMessages` 身份文本对应的 `original-vision.md`（回答要点或解题思路）。这两个场景不读取笔试简答规则。自动场景仍按题型使用各自规则，确定笔试任务时建议直接选择“笔试”。

本次备份为 `resources/app.asar.before-save-prompts.bak`，路由模块和更新的场景文件也保留 `.before-save-prompts.bak` 副本。验证包含空接口跨实例加载、全部模型共享笔试 Prompt、原版面试/截图消息一致性、独立保存和未保存关闭选项，并已在真实界面完成空备用接口的“新增 → 保存并关闭 → 重开”。

## 笔试专用小窗

安装 `meeting-copilot/install_written_window.py` 后，笔试模式标题栏新增“小窗”，常用设置里也有“打开笔试专用小窗”。它将当前窗口切换为只显示最新一轮模型答案的紧凑布局，每个模型一行，隐藏转录、简历/JD 和历史面试工具。进入时停止系统声音/麦克风采集和持续回答；全屏及框选截图快捷键、并发模型回答保持可用。

```powershell
python meeting-copilot/install_written_window.py --check
python meeting-copilot/install_written_window.py
node --test tests/written-window.test.cjs tests/multimodal.test.cjs tests/settings-save.test.cjs tests/quiet-capture.test.cjs tests/shortcut-runtime.test.cjs
```

拖动标题移动，拖动窗口边缘调整大小；小窗最小 190×96（Electron 逻辑像素）。A−/A+ 调整答案字号，“⋯”中可选择 12–72 字号、微软雅黑/宋体/黑体/等线/Consolas/Arial、隐藏模型名、放大/缩小窗口或按答案适配。点击选项可复制。↗ 返回完整界面，并恢复之前的窗口大小。

字体、字号、模型名显示、窗口位置尺寸和上次布局保存在用户数据目录 `written-window.json`，独立于原来的面试界面字号。截图继续沿用原有静默截屏与原生框选；原有隐身设置保持不变。

笔试显示会将旧答案 `2. B` 简化为 `B`，多选为 `AC`，多道选择题每行只保留对应字母，不改写历史原始回答。不能明确识别为选项的内容保留原文，不凭空推断字母。新的共享笔试 Prompt 也明确只返回字母、不要题号。面试模式显示不做上述简化。

新增验证覆盖小窗尺寸、缩放、字体、重启恢复、返回正常窗口、离线显示器位置校正、选项格式与控件；本次程序包备份为 `resources/app.asar.before-written-window.bak`，原笔试 Prompt 备份为同目录下 `written.md.before-written-window.bak`。

## 简短文字／代码与面试文本 Prompt

在小窗补丁后安装 `meeting-copilot/install_rich_answers_prompt.py`。笔试继续只缩略明确选项，必要文字、字段和代码会保留；代码块按等宽字体显示并保留缩进，长内容默认滚动，可展开与复制，不截断完整代码。共享笔试 Prompt 对简答建议 1–3 句／120 字以内，代码力求最短完整函数、25 行以内，复杂题以完整正确为先。

Ctrl+B 等呼出快捷键改用 `showInactive()`，不再主动聚焦。小窗“⋯ → 只读穿透”会忽略鼠标、禁止激活；托盘“设置”退出小窗并解除穿透，双击托盘也可恢复操作。穿透不跨重启保留。正常窗口的点击仍会转移焦点；这些改动不保证任何外部测评系统不报告切屏。

设置中新增“面试文本模型 Prompt”编辑区，修改／恢复原版后点击顶部“保存设置”；单独保存视觉设置不会丢弃这里的草稿。实际文件为用户目录的 `multimodal/prompts/interview.md`，文本模型（含自由提问）和普通面试多模态共用，翻译、笔试与截图面试各自独立。下一次提问热读取，保留原简历／JD／历史及备忘。无效外部编辑时文本模型回退原版并在设置中提示。

```powershell
python meeting-copilot/install_rich_answers_prompt.py --check
python meeting-copilot/install_rich_answers_prompt.py
node --test tests/interview-prompt.test.cjs tests/written-window.test.cjs tests/settings-save.test.cjs tests/multimodal.test.cjs tests/quiet-capture.test.cjs tests/shortcut-runtime.test.cjs
```

`--check` 会生成真实安装包的编译检查文件，也供面试 Prompt 消息构造集成测试读取。没有该文件时仅跳过该项集成测试，独立测试继续执行。安装备份为 `resources/app.asar.before-rich-answers-prompt.bak`；自定义的笔试 Prompt 不覆盖，只自动升级旧默认文本。

## 文本回答与截图接口分工

最后安装 `python meeting-copilot/install_model_routing.py`（可先 `--check`）。标题栏原“多模态／纯文本”改名为“截图开／截图关”，仅控制截图问答。语音转录问答、持续答、自由提问、翻译和备忘固定使用设置中的文本模型；不再因开启截图而调用视觉接口。缺少文本密钥时明确报错，不回退到视觉接口。

面试截图及自动场景截图顺序请求主接口，失败后尝试备用接口，只返回一份答案。只有明确选择“笔试”时，“笔试截图同时回答”才生效；原并行偏好仍保留。关闭截图时不截屏、不调用旧视觉接口。面试截图继续读取 `original-vision.md` 分析要点／思路，文本面试使用可编辑的 `interview.md`，笔试截图使用 `written.md`。

验证：`node --test tests/model-routing.test.cjs tests/multimodal.test.cjs tests/interview-prompt.test.cjs tests/written-window.test.cjs tests/settings-save.test.cjs tests/quiet-capture.test.cjs tests/shortcut-runtime.test.cjs`。路由测试使用 `--check` 从真实安装包生成的代码；不触发真实模型调用。备份：`resources/app.asar.before-model-routing.bak`。

## 来源

- MeetingCopilot 截图接入补丁针对 [JWM0203/MeetingCopilot](https://github.com/JWM0203/MeetingCopilot) 发布的 0.2.0-beta.1 安装包；其包元数据声明 Apache-2.0 许可证。
- 补丁中涉及的上游代码保留其许可证，副本见 [`licenses/MeetingCopilot-LICENSE.txt`](licenses/MeetingCopilot-LICENSE.txt)。
- 截图程序是独立的 Windows 原生 API 实现，不依赖 QuizCoze 的代码、登录或运行时。
- API 文档：[RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)、[Graphics.CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen)。
