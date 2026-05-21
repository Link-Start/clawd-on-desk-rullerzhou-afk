// Antigravity CLI agent configuration
// Hooks via ~/.gemini/config/hooks.json, stdin JSON + stdout JSON

module.exports = {
  id: "antigravity-cli",
  name: "Antigravity CLI",
  processNames: { win: ["agy.exe"], mac: ["agy"], linux: ["agy"] },
  eventSource: "hook",
  eventMap: {
    PreInvocation: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostInvocation: "idle",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: true,
    interactiveBubble: true,
    notificationHook: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "antigravity-hooks-json",
  },
  stdinFormat: "antigravityHookJson",
  pidField: "agy_pid",
};
