# MeetingCopilot 补丁项目

此仓库保存静默截图工具与 MeetingCopilot 0.2.0-beta.1 的增量补丁，不包含完整 MeetingCopilot 安装包、用户密钥、问答历史或截图。

## 项目与累计补丁

根目录提供修改后的完整补丁项目源码、原生辅助程序、安装脚本及测试。

`patches/meeting-copilot-enhancements.patch` 包含此前工作累计修改（含新增文件及原生程序的 Git binary patch），基于原补丁项目提交 `e27d39fc509775f3b8a2ba51fd5f83abfa9cc97e`。在该提交的干净工作树中执行：

```powershell
git apply --check path/to/meeting-copilot-enhancements.patch
git apply path/to/meeting-copilot-enhancements.patch
```

这个 `.patch` 修改的是补丁项目；给已安装 MeetingCopilot 打补丁，应使用下面的安装脚本。

## 安装顺序

退出 MeetingCopilot 后，按顺序执行；各脚本支持 `--check` 先验证兼容性，默认查找当前用户的安装目录。不要对其他版本强行应用。

```powershell
python meeting-copilot/install.py
python meeting-copilot/install_multimodal.py
python meeting-copilot/install_region_capture.py
python meeting-copilot/install_shortcuts_parallel.py
python meeting-copilot/install_persistence_prompts.py
python meeting-copilot/install_written_window.py
python meeting-copilot/install_rich_answers_prompt.py
python meeting-copilot/install_model_routing.py
```

每个阶段生成对应备份；已安装标记表示该阶段已存在，不代表之后编辑源码会自动重新部署。详细功能和各阶段验证方式见 README。

## 功能

- 全屏静默截图、无全屏蒙层的区域框选。
- 键盘组合键与鼠标侧键录制，绑定侧键的前进／后退事件拦截。
- 动态增加多模态接口，主备切换、超时与拒答处理。
- 显式保存、空白接口持久化及未保存提示。
- 笔试答案小窗、字体字号与窗口尺寸调整、短文本和代码显示。
- 面试文本 Prompt 设置，笔试和面试截图使用独立提示词。
- 面试普通问答固定走文本模型；截图才走视觉模型。面试截图顺序主备返回一份，笔试截图可选多模型同时回答。
- 窗口不主动聚焦的呼出行为与可选鼠标穿透；不保证第三方软件不报告切屏。

## 测试

```powershell
python -m unittest discover -s tests
node --test tests/*.test.cjs
```

涉及实际安装包消息构造的集成测试，需要先运行相应安装脚本 `--check` 生成本地 `work/` 检查文件；缺少时跳过。测试使用本地模拟服务，不需要真实 API Key。

## 来源与许可

源补丁项目来自 https://github.com/qiao94/Interview-and-Written-Test-Assistant 。保留 README 的来源说明及 `licenses/MeetingCopilot-LICENSE.txt`。本仓库不是 MeetingCopilot 官方发行版。
