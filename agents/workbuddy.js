// WorkBuddy IDE/CLI agent configuration
// Hook-based integration — Claude Code-compatible hook format
// Settings: ~/.workbuddy/settings.json
// Docs: https://www.codebuddy.cn/docs/workbuddy/Overview

module.exports = {
  id: "workbuddy",
  name: "WorkBuddy",
  processNames: {
    win: ["WorkBuddy.exe", "workbuddy.exe"],
    mac: ["WorkBuddy"],
    linux: ["workbuddy", "WorkBuddy"],
  },
  eventSource: "hook",
  // PascalCase event names — identical to Claude Code hook system
  eventMap: {
    SessionStart:     "idle",
    SessionEnd:       "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse:       "working",
    PostToolUse:      "working",
    Stop:             "attention",
    PermissionRequest:"notification",
    Notification:     "notification",
    PreCompact:       "sweeping",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "claude-code-compatible",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "workbuddy_pid",
};
