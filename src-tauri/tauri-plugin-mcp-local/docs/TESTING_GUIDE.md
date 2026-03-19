# UI Testing with Tauri MCP Plugin

This guide shows how to use the Tauri MCP plugin to automate UI testing of your Tauri application with AI agents (Claude Code, Cursor, Cline, etc.).

## Why MCP for Tauri Testing?

Tauri applications have complex workflows that benefit from AI-assisted testing:

- **Multi-step user workflows**: Sign up → Login → Navigate → Perform actions
- **Visual validation**: Verify UI states, themes, and layouts
- **Form validation**: Test input validation across multiple forms
- **State persistence**: Test localStorage/database data persistence
- **Cross-platform compatibility**: Verify behavior across OS platforms

Traditional testing requires writing and maintaining test scripts. With MCP, you can:
- **Describe tests in plain English** to an AI agent
- **Visually verify** UI changes with screenshots
- **Inspect application state** without DevTools
- **Iterate quickly** on test scenarios without code changes

## Prerequisites

1. MCP plugin installed and configured (see [QUICK_START.md](QUICK_START.md))
2. Your Tauri app running with `cargo tauri dev --features mcp`
3. Claude Code or another MCP-compatible AI agent

## Testing Workflow

### Recommended Debugging Process

When testing a Tauri application, follow this systematic approach:

#### 1. Verify Connectivity

```
Ask AI: "Use the ping tool to verify connection"
```

Ensures the MCP plugin is responding before running tests.

#### 2. Set Up Monitoring

```
Ask AI: "Inject console capture and error tracker"
```

Captures runtime errors and logs during your tests.

#### 3. Understand Current State

```
Ask AI: "Take a screenshot and describe what you see"
```

Establishes baseline understanding of the UI state.

#### 4. Execute Test Scenario

Provide clear, step-by-step instructions (see examples below).

#### 5. Verify Results

```
Ask AI: "Check console logs and exceptions for any errors during the test"
```

Reviews runtime behavior and catches issues.

## Test Scenarios

### Scenario 1: Form Validation Testing

**Goal:** Verify that form validation catches invalid inputs.

**Prompt to AI:**
```
Test form validation for the [form name]:
1. Take a screenshot of the form
2. Try to submit with empty fields - verify error messages appear
3. Try invalid email format - verify error message
4. Try password too short - verify error message
5. Try valid data - verify acceptance
6. Screenshot each validation state
7. Report all validation rules discovered
```

**Expected AI Actions:**
- Tests multiple invalid inputs
- Takes screenshots of error states
- Uses `get_dom` to find error messages
- Verifies both client-side and server-side validation

**What AI Will Report:**
- All validation rules found
- Error message clarity and positioning
- Any edge cases that aren't handled

### Scenario 2: Multi-Step Workflow Testing

**Goal:** Test a complete user workflow from start to finish.

**Prompt to AI:**
```
Test the complete [workflow name]:
1. Start from [initial state]
2. [Step 1 action]
3. Take a screenshot
4. [Step 2 action]
5. Take a screenshot
6. [Final step]
7. Verify [expected outcome]
8. Check localStorage/state for data persistence
```

**Expected AI Actions:**
- Executes multi-step sequence
- Takes screenshots at key points
- Verifies data persistence
- Checks for errors in console

**What AI Will Report:**
- Whether the workflow completes successfully
- If data is stored correctly
- Visual flow and any UX issues

### Scenario 3: State Management Testing

**Goal:** Verify application state is managed correctly.

**Prompt to AI:**
```
Test state management:
1. Inspect current application state using execute_js
2. Perform an action that should update state
3. Verify state changed correctly
4. Refresh the page
5. Verify state persisted correctly
6. Check localStorage for expected data
```

**Expected AI Actions:**
- Uses `execute_js` to inspect state (Redux, Zustand, etc.)
- Uses `local_storage_get_all` to verify persistence
- Compares state before/after actions

**What AI Will Report:**
- Current state structure
- Whether state updates correctly
- If persistence works as expected

### Scenario 4: Visual Regression Testing

**Goal:** Detect unintended visual changes.

**Prompt to AI:**
```
Create visual baseline for [feature]:
1. Navigate to [page/component]
2. Take screenshot and save as "baseline-[name].png"
3. [Perform action or change]
4. Take screenshot and save as "current-[name].png"
5. Compare the two and report any visual differences
```

**Expected AI Actions:**
- Takes before/after screenshots
- Analyzes visual differences
- Reports layout changes, color changes, missing elements

**What AI Will Report:**
- Visual differences detected
- Whether changes were expected
- Potential regressions

### Scenario 5: Theme/Dark Mode Testing

**Goal:** Verify theme switching works across all views.

**Prompt to AI:**
```
Test theme switching:
1. Take a screenshot in current theme
2. Open settings and toggle to dark mode
3. Take a screenshot after toggle
4. Navigate to: [list of views]
5. Take a screenshot of each view in dark mode
6. Toggle back to light mode
7. Verify all views return to light theme
8. Compare screenshots and report any inconsistencies
```

**Expected AI Actions:**
- Takes screenshots in both themes
- Navigates through different views
- Analyzes color schemes
- Verifies consistency

**What AI Will Report:**
- Visual comparison of light vs dark mode
- Any views with theme inconsistencies
- Whether theme preference persists

### Scenario 6: Error Handling Testing

**Goal:** Test how the app handles errors and edge cases.

**Prompt to AI:**
```
Test error handling:
1. Inject error tracker
2. Attempt an action that should fail (e.g., invalid API call)
3. Take a screenshot of the error state
4. Verify error message is user-friendly
5. Check that the UI remains functional after error
6. Get console logs and exceptions
7. Report error handling quality
```

**Expected AI Actions:**
- Triggers error conditions
- Captures error UI
- Checks console for errors
- Verifies graceful degradation

**What AI Will Report:**
- How errors are displayed
- Whether the app recovers
- Console error details
- Suggestions for better error UX

### Scenario 7: Performance Testing

**Goal:** Test UI performance with large datasets.

**Prompt to AI:**
```
Test performance with large dataset:
1. Check current data count
2. Use execute_js to create 100 test items
3. Take a screenshot
4. Measure if all items render correctly
5. Test scrolling performance
6. Test search/filter if available
7. Clean up test data
8. Report any performance issues
```

**Expected AI Actions:**
- Uses `execute_js` to bulk-create data
- Verifies rendering
- Tests interaction responsiveness

**What AI Will Report:**
- Whether the app handles many items well
- Rendering performance
- Scrolling behavior
- Memory usage (if accessible)

### Scenario 8: Accessibility Testing

**Goal:** Verify basic accessibility features.

**Prompt to AI:**
```
Test accessibility:
1. Get the DOM for the main page
2. Check for proper heading hierarchy (h1, h2, h3)
3. Verify all buttons have accessible labels
4. Check for alt text on images
5. Verify form inputs have labels
6. Check for ARIA attributes where needed
7. Test keyboard navigation using execute_js
8. Report accessibility issues found
```

**Expected AI Actions:**
- Uses `get_dom` to analyze HTML
- Checks semantic HTML usage
- Analyzes ARIA attributes
- Tests keyboard navigation

**What AI Will Report:**
- Heading hierarchy structure
- Missing alt text or labels
- ARIA attribute usage
- Keyboard navigation issues
- Accessibility score and recommendations

### Scenario 9: Cross-Window Testing (Multi-Window Apps)

**Goal:** Test interactions between multiple windows.

**Prompt to AI:**
```
Test multi-window functionality:
1. Take screenshot of main window
2. Trigger action that opens second window
3. Use manage_window to list all windows
4. Take screenshot of second window
5. Perform action in second window
6. Verify main window updates correctly
7. Close second window
8. Verify main window state is correct
```

**Expected AI Actions:**
- Manages multiple windows
- Takes screenshots of each
- Verifies data synchronization

**What AI Will Report:**
- Window management behavior
- Data synchronization between windows
- Any issues with focus or state

### Scenario 10: Data Persistence Testing

**Goal:** Verify data is saved and restored correctly.

**Prompt to AI:**
```
Test data persistence:
1. Create new data (e.g., project, todo item)
2. Verify it appears in the UI
3. Check localStorage for the data
4. Take note of the data structure
5. Close the app (if possible with window manager)
6. Restart the app
7. Verify data is still there
8. Report on persistence mechanism
```

**Expected AI Actions:**
- Creates and verifies data
- Inspects localStorage/storage
- Tests persistence across sessions

**What AI Will Report:**
- Data storage mechanism
- Whether persistence works
- Data structure used

## Advanced Testing Patterns

### Pattern 1: State Machine Testing

Test all state transitions in a feature:

```
For the [feature] workflow:
1. Map all possible states (draft, editing, submitted, completed, failed)
2. Map all transitions (create → edit, edit → submit, etc.)
3. Test each valid transition
4. Test that invalid transitions are prevented
5. Create a state diagram of what you found
```

### Pattern 2: Chaos Testing

Intentionally create problematic scenarios:

```
Test edge cases and error handling:
1. Enter extremely long text in all fields (10,000 characters)
2. Enter special characters (emoji, unicode, HTML tags, SQL)
3. Rapidly click buttons multiple times
4. Switch between views while operations are in progress
5. Fill forms and navigate away without saving
6. Report any crashes, freezes, or data loss
```

### Pattern 3: Integration Testing

Test end-to-end scenarios:

```
Test the complete [user journey]:
1. [Start state]
2. [Action 1]
3. [Action 2]
... (complete workflow)
N. Verify [final state]
N+1. Check that no errors occurred in console
N+2. Verify all data was saved correctly
```

### Pattern 4: Regression Testing

Create a test suite that runs regularly:

```
Run the full regression suite:
1. Test [Feature A] - expected behavior: [...]
2. Test [Feature B] - expected behavior: [...]
3. Test [Feature C] - expected behavior: [...]
...
Report any failures or unexpected behavior
```

## Tips for Effective MCP Testing

### 1. Be Specific in Prompts

❌ **Bad**: "Test the app"

✅ **Good**: "Test the login form with valid credentials, invalid email, and empty fields. Screenshot each validation state and report what you find."

### 2. Ask for Screenshots Frequently

Screenshots provide visual proof and help AI understand context:

```
After each major action, take a screenshot and describe what you see
```

### 3. Verify Data Persistence

Always check that data was actually saved:

```
After creating X, check localStorage/database to verify it was persisted correctly
```

### 4. Test Both Happy and Sad Paths

```
Test both successful login AND failed login with wrong password
```

### 5. Use Execute JS for Complex Checks

```
Use execute_js to check:
- window.localStorage state
- React/Vue component state (if exposed)
- Console errors (console.error.length)
- Application global variables
```

### 6. Create Reusable Test Suites

Save common test scenarios and reference them:

```
Run the "Full App Regression Suite" which includes:
- Test scenarios 1-10 from the testing guide
```

## Example AI Conversation

**You:**
> Test the user registration flow. Start with an empty form, try invalid inputs, then complete with valid data. Take screenshots at each step.

**AI Agent:**
> I'll test the registration flow. Let me start by taking a screenshot of the current state...
>
> [Takes screenshot]
>
> I can see a registration form with fields for:
> - Username
> - Email
> - Password
> - Confirm Password
>
> Let me first try submitting with empty fields...
>
> [Clicks submit, takes screenshot]
>
> ✅ Good! The form shows validation errors:
> - "Username is required"
> - "Email is required"
> - "Password is required"
>
> Now let me try an invalid email...
>
> [Enters "notanemail", clicks submit, takes screenshot]
>
> ✅ Email validation works: "Please enter a valid email address"
>
> Let me try a short password...
>
> [Enters "123", takes screenshot]
>
> ✅ Password validation works: "Password must be at least 8 characters"
>
> Now let me complete with valid data...
>
> [Fills all fields correctly, clicks submit, takes screenshot]
>
> ✅ Success! User was registered and redirected to dashboard.
>
> Let me verify the data was persisted...
>
> [Checks localStorage]
>
> ✅ Confirmed: User data is stored in localStorage with key "user" and includes username, email, and auth token.
>
> **Test Summary:**
> - Form validation works correctly for all fields
> - Error messages are clear and helpful
> - Registration completes successfully with valid data
> - Data is properly persisted to localStorage
> - No console errors during the process

## Troubleshooting Common Issues

### Issue: "Can't find element with selector"

**Solution:**
1. Use `get_dom` to inspect the actual DOM structure
2. Verify the selector is correct
3. Wait for dynamic content to load: "Wait 2 seconds before clicking"

### Issue: "Screenshot is empty/black"

**Solution:**
1. Verify window title matches PluginConfig
2. Ensure window is visible (not minimized)
3. On macOS: Grant Screen Recording permission

### Issue: "localStorage is empty"

**Solution:**
1. App might use SQLite or other storage
2. Use `execute_js` to check `window` object for app state
3. Check Tauri commands for storage operations

### Issue: "Actions don't work"

**Solution:**
1. Ensure WebView is fully loaded
2. Add waits between actions: "Wait 1 second between steps"
3. Use `get_element_position` to verify element exists before clicking

## Best Practices

### 1. Start Simple

Begin with basic tests and gradually increase complexity:

1. Connection test (`ping`)
2. Screenshot test
3. DOM inspection
4. Simple clicks
5. Form filling
6. Multi-step workflows

### 2. Document Your Tests

Create a test catalog:

```markdown
## Test Catalog

### Login Tests
- Valid credentials ✅
- Invalid password ✅
- Empty fields ✅
- SQL injection attempts ✅

### Dashboard Tests
- Initial load ✅
- Data refresh ✅
- Search functionality ⏳
```

### 3. Run Tests Regularly

- Before releases
- After major changes
- When bugs are reported
- As part of CI/CD (if automated)

### 4. Share Test Results

Take screenshots and save them:
- `tests/mcp-baseline/` - Baseline screenshots
- `tests/mcp-results/` - Latest test run results

## Next Steps

1. **Run Initial Tests**: Start with Scenarios 1-3 to verify core functionality
2. **Create Baselines**: Capture current UI state for regression testing
3. **Build Test Library**: Save frequently-used test prompts
4. **Automate**: Consider integrating MCP tests into CI/CD
5. **Expand Coverage**: Add more scenarios as features develop

## Resources

- [Quick Start Guide](QUICK_START.md) - Get set up quickly
- [Integration Guide](INTEGRATION_GUIDE.md) - Advanced configuration
- [Main README](../README.md) - Complete tool reference
- [AI Agent Usage Guide](../README.md#ai-agent-usage-guide) - Best practices for AI debugging

Happy testing! 🚀
