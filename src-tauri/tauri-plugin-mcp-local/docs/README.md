# Tauri MCP Plugin Documentation

Welcome to the comprehensive documentation for the Tauri Model Context Protocol (MCP) plugin! This collection of guides will help you integrate AI-powered debugging and testing into your Tauri applications.

## 📚 Documentation Overview

### [Quick Start Guide](QUICK_START.md)
**Start here!** Get up and running in 5 steps.

Perfect for:
- First-time users
- Quick integration into existing projects
- Verifying the plugin works

What you'll learn:
- Installing and configuring the plugin
- Connecting your AI agent
- Running your first test
- Troubleshooting common issues

Time required: **10-15 minutes**

---

### [Integration Guide](INTEGRATION_GUIDE.md)
**Comprehensive setup** for production use.

Perfect for:
- Understanding all configuration options
- Platform-specific setup (macOS/Linux/Windows)
- Advanced configuration scenarios
- Troubleshooting complex issues

What you'll learn:
- Detailed installation steps
- IPC vs TCP socket configuration
- Platform-specific considerations
- Environment-based configuration
- CI/CD integration
- Best practices

Time required: **30-45 minutes**

---

### [Testing Guide](TESTING_GUIDE.md)
**Master AI-powered testing** of your Tauri app.

Perfect for:
- Creating comprehensive test scenarios
- Learning testing patterns
- Building a test suite
- Debugging complex workflows

What you'll learn:
- 10 complete test scenarios
- Advanced testing patterns
- Best practices for effective prompts
- Common debugging workflows
- How to structure tests

Time required: **45-60 minutes** (includes hands-on practice)

---

## 🚀 Quick Navigation

### I want to...

**...get started immediately**
→ [Quick Start Guide](QUICK_START.md)

**...understand all configuration options**
→ [Integration Guide](INTEGRATION_GUIDE.md)

**...learn how to write effective tests**
→ [Testing Guide](TESTING_GUIDE.md)

**...see available tools and parameters**
→ [Main README - Tool Reference](../README.md#tool-parameters-reference)

**...understand how AI agents should use this**
→ [Main README - AI Agent Usage Guide](../README.md#ai-agent-usage-guide)

**...add new tools to the plugin**
→ [Main README - Adding New Tools](../README.md#adding-new-tools)

**...troubleshoot connection issues**
→ [Integration Guide - Troubleshooting](INTEGRATION_GUIDE.md#troubleshooting)

**...see example test scenarios**
→ [Testing Guide - Test Scenarios](TESTING_GUIDE.md#test-scenarios)

---

## 📖 Recommended Learning Path

### For Developers New to MCP

1. **Read**: [Quick Start Guide](QUICK_START.md) - Get set up (15 min)
2. **Try**: Run the first test scenario from the guide
3. **Read**: [Testing Guide - Scenarios 1-3](TESTING_GUIDE.md#test-scenarios) (30 min)
4. **Practice**: Run 2-3 test scenarios on your app
5. **Read**: [Integration Guide](INTEGRATION_GUIDE.md) for deeper understanding (30 min)
6. **Build**: Create your own test suite

Total time: **2-3 hours** spread across a few sessions

### For Experienced Testers

1. **Skim**: [Quick Start Guide](QUICK_START.md) - Installation only (5 min)
2. **Deep dive**: [Testing Guide](TESTING_GUIDE.md) - All scenarios (45 min)
3. **Reference**: [Main README](../README.md) - Tool parameters
4. **Build**: Custom test automation

Total time: **1-2 hours**

### For AI Agents

If you're an AI agent reading this:

1. **Start**: [Main README - AI Agent Usage Guide](../README.md#ai-agent-usage-guide)
2. **Learn**: Recommended debugging workflow
3. **Practice**: Common debugging patterns
4. **Reference**: [Tool Parameters Reference](../README.md#tool-parameters-reference)
5. **Apply**: Use the best practices when debugging

---

## 🎯 Common Use Cases

### Visual Regression Testing

**Guides**: [Testing Guide - Scenario 4](TESTING_GUIDE.md#scenario-4-visual-regression-testing)

Take screenshots before/after changes to detect unintended visual changes.

### Form Validation Testing

**Guides**: [Testing Guide - Scenario 1](TESTING_GUIDE.md#scenario-1-form-validation-testing)

Test all validation rules, error messages, and edge cases automatically.

### Multi-Step Workflow Testing

**Guides**: [Testing Guide - Scenario 2](TESTING_GUIDE.md#scenario-2-multi-step-workflow-testing)

Test complete user journeys from start to finish with automatic verification.

### State Management Debugging

**Guides**: [Testing Guide - Scenario 3](TESTING_GUIDE.md#scenario-3-state-management-testing)

Inspect and verify application state (Redux, Zustand, localStorage, etc.).

### Error Handling Testing

**Guides**: [Testing Guide - Scenario 6](TESTING_GUIDE.md#scenario-6-error-handling-testing)

Verify your app handles errors gracefully with good UX.

---

## 🔧 Available MCP Tools

Quick reference of what AI agents can do:

| Category | Tools |
|----------|-------|
| **Visual** | `take_screenshot`, `get_dom`, `get_element_position` |
| **Debugging** | `inject_console_capture`, `get_console_logs`, `inject_error_tracker`, `get_exceptions` |
| **Interaction** | `execute_js` (run JavaScript in app context) |
| **Storage** | `local_storage_get/set/remove/clear/get_all` |
| **Window** | `manage_window` (resize, move, focus, etc.) |
| **Diagnostics** | `ping`, `health_check` |

Full details: [Tool Parameters Reference](../README.md#tool-parameters-reference)

---

## 💡 Tips for Success

### 1. Start Simple

Begin with basic tests before complex scenarios:
```
"Take a screenshot and describe what you see"
```

### 2. Be Specific

Detailed prompts get better results:
```
❌ "Test the form"
✅ "Test the login form with valid email, invalid email, and empty fields. Screenshot each state."
```

### 3. Verify Everything

Always check that data was saved:
```
"After creating the item, check localStorage to verify it was persisted"
```

### 4. Use Screenshots Liberally

Visual proof helps debugging:
```
"Take a screenshot before clicking, after clicking, and after the modal opens"
```

### 5. Check Console Logs

Catch runtime errors:
```
"After the test, get console logs and exceptions to check for errors"
```

---

## 🐛 Troubleshooting

### Quick Fixes

| Problem | Solution |
|---------|----------|
| Connection refused | Verify app is running with `--features mcp` |
| Black screenshots | Check window title matches config |
| Can't find tool | Rebuild MCP server: `cd mcp-server-ts && pnpm build` |
| Socket already in use | `rm -f /tmp/yourapp-mcp.sock` |

Full troubleshooting: [Integration Guide - Troubleshooting](INTEGRATION_GUIDE.md#troubleshooting)

---

## 📦 What's in This Plugin?

### Core Capabilities

- **Screenshot Capture**: High-quality window screenshots for visual testing
- **DOM Inspection**: Full HTML structure retrieval for state verification
- **Console Monitoring**: Capture and retrieve console.log, error, warn messages
- **Exception Tracking**: Track unhandled errors and promise rejections
- **JavaScript Execution**: Run arbitrary JS in app context for advanced testing
- **Storage Access**: Full localStorage CRUD operations
- **Window Management**: Control window position, size, focus, state

### Platform Support

- ✅ **macOS**: Full support (IPC sockets)
- ✅ **Linux**: Full support (IPC sockets)
- ✅ **Windows**: Full support (Named pipes)
- ⏳ **Mobile**: Planned (marked as unimplemented)

### Security

- **Development-only**: Automatically excluded from production builds
- **Feature-gated**: Only active with `--features mcp` flag
- **Debug-only**: Protected by `#[cfg(debug_assertions)]`
- **Zero overhead**: No impact on release builds

---

## 🤝 Contributing

Want to improve the plugin or documentation?

1. **Report issues**: Found a bug? Open an issue!
2. **Suggest improvements**: Have ideas? We'd love to hear them!
3. **Contribute code**: See [Main README - Contributing](../README.md#contributing)
4. **Improve docs**: Documentation PRs are always welcome!

---

## 📄 License

This plugin is open source under the [MIT License](../LICENSE).

Based on the original [tauri-plugin-mcp](https://github.com/P3GLEG/tauri-plugin-mcp) by P3GLEG, with extensive improvements and documentation.

---

## 🔗 Additional Resources

- **Main README**: [../README.md](../README.md) - Complete reference
- **Tauri Documentation**: [v2.tauri.app](https://v2.tauri.app/)
- **MCP Specification**: [modelcontextprotocol.io](https://modelcontextprotocol.io/)
- **Claude Code**: [claude.com/code](https://claude.com/claude-code)

---

## 🎉 Ready to Start?

Jump into the [Quick Start Guide](QUICK_START.md) and get testing in 15 minutes!

Have questions? Check the troubleshooting sections in each guide, or review the [Main README](../README.md) for comprehensive information.

Happy testing! 🚀
