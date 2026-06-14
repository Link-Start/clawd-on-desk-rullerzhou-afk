# 变更日志

## 2026-06-15 Ghostty 跨 Space 切换：probe+stone 合并为单次 AppleScript 调用
- 将探测（probe）和踏板（stone）合并为一个 osascript 调用，减少约 30-50ms IPC 往返
- 移除 `GHOSTTY_STEP_SETTLE_MS`（300ms 固定等待）：Ghostty `focus` Apple Event 同步阻塞直到 Space 动画完成，回调自然触发无需额外 timer
- probe 脚本的返回值改为携带目标 id（`direct:<id>` / `via:<stone>|<target>`），via 路径改用 id-based focus 脚本，避免多终端共享 cwd 时误匹配
- 新增 `test/focus-ghostty-stone.test.js`：覆盖 `runWithSteppingStone` 的 probe+stone 路径、miss/error fallback、target-id 绑定等 6 个用例

## 2026-06-11 Ghostty 会话按窗口自动归类
- 同一 Ghostty 窗口的会话在 Dashboard / HUD / 托盘菜单中自动聚为一组，分组标题用会话所在目录名（稳定、不随会话标签变化）
- 匹配键用会话 `cwd`：Ghostty terminal 对象只暴露 `id`/`name`/`working directory`，无 `tty`/`pid`，cwd 是唯一稳定键；不依赖「提交时前台聚焦」，任何时刻可探测、不漏、不会错关联到别的 tab；同一 cwd 跨多窗口时保守不归类
- 新增 `src/ghostty-window-probe.js`：只读 AppleScript 输出 `windowId→cwd` 映射 + TTL 去抖缓存；`state.js` 在 updateSession 路径按 cwd 回填派生字段 `ghosttyWindowId`（运行时填充、不持久化）
- `state-session-snapshot.js` 在 host 之下按 `windowId` 切子组，单会话窗口平铺；Dashboard / HUD / 托盘菜单消费新 `groups` 结构
- `session-hud.js`：HUD 浮窗高度算上分组标题 18px，避免分组被 `overflow:hidden` 裁切
- 修复探测脚本两处真机失效：① `tab` 常量在 `tell application "Ghostty"` 块内被字典类名遮蔽，裸 `& tab &` 变成字面 `"tab"` → 块外存 `tabChar`；② `as text` 默认空分隔符把多行拼成一行 → 先设 `text item delimiters` 为换行
- 相关单测 264 项通过（probe cwd 映射/歧义/normalize、远程会话不归类、HUD 高度）

## 2026-06-10 修复 Ghostty 跨桌面跳转把窗口拉到当前桌面
- 点击会话列表跳转时，若目标终端位于另一桌面某窗口的「未选中标签页」，原先会把整个窗口拉到当前桌面，而非把用户切换过去
- 根因：Ghostty AppleScript `focus` 用 `makeKeyAndOrderFront`，对屏外（未选中标签）的 NSWindow 上屏会将其吸附到当前 Space；`select tab` 同理
- 修法（踏板法）：先用只读 probe 判断目标标签是否选中——已选中则直接 focus；未选中则先 focus 该窗口当前选中标签的终端（唯一验证可靠切换 Space 的操作），待切换完成再 focus 目标，标签切换发生在已激活的 Space 内，不再拉窗
- `src/focus.js` 新增 `buildGhosttyIdProbeScript` / `buildGhosttyCwdProbeScript` 与 `runWithSteppingStone` 编排；`focus` 脚本还原为原版扁平查询
- 性能：via 路径原先叠加两段固定等待（踏板后 450ms + `runGhosttyScript` 自带 400ms 共 850ms），现改为踏板后直接 focus 目标、仅等单次 `GHOSTTY_STEP_SETTLE_MS`（300ms），跨桌面跳转延迟由 ~1.5s 降至 ~1.1s；direct/miss 路径保持原版行为与 fallback 链不变；并在 debug 日志埋入各段耗时戳
- 新增 `test/focus-ghostty-space.test.js`；Ghostty 1.3.1 / macOS 26 真机验证通过
