# Designing Applications for MCP/AI-Driven Testing

This guide provides actionable patterns and conventions to make your application easier to test through MCP (Model Context Protocol) and AI-driven automation.

## Core Principle

**Design for discoverability and semantic clarity.** AI agents excel at understanding meaning and intent, but struggle with ambiguity and anonymous elements.

## The MCP Testing Hierarchy

AI agents can interact with your app through multiple discovery methods, ranked from most reliable to least:

1. **Semantic IDs** (`id="user-email-input"`) - Most reliable
2. **Test Attributes** (`data-testid="submit-button"`) - Highly reliable
3. **ARIA Labels** (`aria-label="Close dialog"`) - Very reliable
4. **Semantic HTML** (`<button>`, `<input type="email">`) - Reliable
5. **CSS Classes** (`className="submit-button"`) - Moderately reliable
6. **Text Content** (button with "Submit") - Less reliable (changes with i18n)
7. **DOM Position** (nth-child, complex selectors) - Unreliable

## Design Patterns for MCP Testing

### 1. Semantic ID Convention

**Pattern:** Use descriptive, hierarchical IDs that convey purpose and context.

```typescript
// ❌ Bad - Generic, meaningless
<input id="input1" />
<button id="btn" />

// ✅ Good - Semantic, discoverable
<input id="user-profile-email-input" />
<button id="user-profile-save-button" />
<div id="error-message-container" />
```

**Naming Convention:**
```
[context]-[component]-[element-type]
```

Examples:
- `auth-login-email-input`
- `dashboard-navigation-menu`
- `project-list-filter-dropdown`
- `settings-theme-toggle-switch`

### 2. Test Attributes for Dynamic Content

Use `data-testid` for elements that might have dynamic IDs or no natural ID:

```typescript
// ✅ List items, cards, repeated elements
<div
  data-testid={`project-card-${project.id}`}
  data-project-name={project.name}
>
  <h3 data-testid="project-card-title">{project.name}</h3>
  <button data-testid="project-card-delete-button">Delete</button>
</div>

// ✅ Modal dialogs
<dialog
  data-testid="confirm-delete-dialog"
  data-dialog-type="confirmation"
  open={isOpen}
>
  <p data-testid="confirm-delete-message">Are you sure?</p>
  <button data-testid="confirm-delete-yes-button">Yes</button>
  <button data-testid="confirm-delete-no-button">No</button>
</dialog>
```

### 3. State Exposure via Data Attributes

Make component state visible to MCP tools:

```typescript
// ✅ Expose loading, error, success states
<button
  id="save-project-button"
  data-testid="save-project-button"
  data-state={isSaving ? 'loading' : 'idle'}
  data-has-changes={hasUnsavedChanges}
  disabled={isSaving}
>
  {isSaving ? 'Saving...' : 'Save'}
</button>

// ✅ Expose validation state
<input
  id="project-name-input"
  data-testid="project-name-input"
  data-validation-state={validationState} // 'valid' | 'invalid' | 'pending'
  data-error-message={errorMessage || ''}
  aria-invalid={validationState === 'invalid'}
/>

// ✅ Expose feature flags
<div
  data-testid="premium-features-section"
  data-feature-enabled={isPremiumUser}
  data-feature-flag="premium-dashboard"
>
  Premium features
</div>
```

### 4. ARIA Labels for Actions and Context

```typescript
// ✅ Buttons with icons need aria-label
<button
  id="close-dialog-button"
  aria-label="Close settings dialog"
  onClick={onClose}
>
  <XIcon />
</button>

// ✅ Complex widgets need aria-description
<div
  role="tabpanel"
  aria-label="Project settings"
  aria-description="Configure project name, visibility, and team access"
  data-testid="project-settings-panel"
>
  {/* settings content */}
</div>

// ✅ Loading states
<div
  role="status"
  aria-live="polite"
  aria-busy={isLoading}
  data-testid="data-loader"
>
  {isLoading ? 'Loading projects...' : `${projects.length} projects loaded`}
</div>
```

### 5. Semantic HTML Elements

Use the right HTML element for the job - it provides free semantics:

```typescript
// ❌ Bad - Div soup
<div onClick={handleSubmit}>Submit</div>
<div onClick={handleCancel}>Cancel</div>

// ✅ Good - Semantic elements
<button type="submit" id="form-submit-button">Submit</button>
<button type="button" id="form-cancel-button">Cancel</button>

// ❌ Bad - Custom select
<div className="select">
  <div onClick={toggle}>Choose option</div>
  {open && <div>{options}</div>}
</div>

// ✅ Good - Native select with enhancements
<select
  id="project-type-select"
  data-testid="project-type-select"
  aria-label="Project type"
>
  <option value="web">Web Application</option>
  <option value="mobile">Mobile App</option>
</select>
```

### 6. Predictable Component Structure

Establish conventions for common patterns:

```typescript
// ✅ Standard form field pattern
interface FormFieldProps {
  id: string;
  label: string;
  error?: string;
  required?: boolean;
}

function FormField({ id, label, error, required, children }: FormFieldProps) {
  return (
    <div
      className="form-field"
      data-testid={`form-field-${id}`}
      data-has-error={!!error}
    >
      <label
        htmlFor={id}
        data-testid={`${id}-label`}
      >
        {label}
        {required && <span aria-label="required">*</span>}
      </label>
      {children}
      {error && (
        <span
          id={`${id}-error`}
          data-testid={`${id}-error`}
          role="alert"
          aria-live="assertive"
        >
          {error}
        </span>
      )}
    </div>
  );
}

// Usage
<FormField id="user-email" label="Email" required error={emailError}>
  <input
    id="user-email"
    type="email"
    data-testid="user-email-input"
    aria-describedby={emailError ? "user-email-error" : undefined}
    aria-invalid={!!emailError}
  />
</FormField>
```

### 7. State Management Exposure

Make global state inspectable by MCP:

```typescript
// ✅ Zustand store with window exposure (dev only)
import create from 'zustand';

interface AppState {
  user: User | null;
  projects: Project[];
  isLoading: boolean;
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  projects: [],
  isLoading: false,
  // ... actions
}));

// Expose store to window in development for MCP inspection
if (import.meta.env.DEV) {
  (window as any).__APP_STORE__ = useAppStore;
  (window as any).__GET_STATE__ = () => useAppStore.getState();
}
```

Now MCP can inspect state:
```javascript
// Via execute_js tool
const state = window.__GET_STATE__();
console.log('Current user:', state.user);
console.log('Projects:', state.projects);
```

### 8. Event Logging for MCP

Create a testing-friendly event system:

```typescript
// ✅ Event logger (dev only)
class TestEventLogger {
  private events: Array<{ type: string; payload: any; timestamp: number }> = [];

  log(type: string, payload?: any) {
    if (import.meta.env.DEV) {
      this.events.push({
        type,
        payload,
        timestamp: Date.now()
      });
      console.log(`[TEST_EVENT] ${type}`, payload);
    }
  }

  getEvents(filter?: string) {
    return filter
      ? this.events.filter(e => e.type.includes(filter))
      : this.events;
  }

  clear() {
    this.events = [];
  }
}

export const testEvents = new TestEventLogger();

// Expose to window for MCP
if (import.meta.env.DEV) {
  (window as any).__TEST_EVENTS__ = testEvents;
}

// Usage in components
function ProjectCard({ project }: Props) {
  const handleDelete = () => {
    testEvents.log('project.delete.clicked', { projectId: project.id });
    deleteProject(project.id);
  };

  return (
    <div data-testid={`project-card-${project.id}`}>
      <button onClick={handleDelete} data-testid="project-delete-button">
        Delete
      </button>
    </div>
  );
}
```

MCP can verify events:
```javascript
// Check if delete was clicked
const deleteEvents = window.__TEST_EVENTS__.getEvents('project.delete');
console.log('Delete events:', deleteEvents);
```

## Practical Example: Refactoring Brainstormer App

Let's improve the current `App.tsx` for MCP testing:

### Before (Current Code)

```typescript
function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        greet();
      }}
    >
      <input
        id="greet-input"
        onChange={(e) => setName(e.currentTarget.value)}
        placeholder="Enter a name..."
      />
      <button type="submit">Greet</button>
      <p>{greetMsg}</p>
    </form>
  );
}
```

### After (MCP-Optimized)

```typescript
function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function greet() {
    testEvents.log('greet.submit', { name });
    setIsLoading(true);
    setError(null);

    try {
      const message = await invoke("greet", { name });
      setGreetMsg(message);
      testEvents.log('greet.success', { message });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      testEvents.log('greet.error', { error: errorMessage });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="container">
      <h1 id="app-title" data-testid="app-title">Welcome to Tauri + React</h1>

      <form
        id="greet-form"
        data-testid="greet-form"
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <div
          className="form-group"
          data-testid="greet-input-group"
          data-has-error={!!error}
        >
          <label
            htmlFor="greet-name-input"
            className="sr-only"
          >
            Enter your name
          </label>
          <input
            id="greet-name-input"
            data-testid="greet-name-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Enter a name..."
            aria-label="Name to greet"
            aria-invalid={!!error}
            aria-describedby={error ? "greet-error-message" : undefined}
            disabled={isLoading}
            data-state={isLoading ? 'loading' : 'idle'}
          />

          <button
            type="submit"
            id="greet-submit-button"
            data-testid="greet-submit-button"
            disabled={isLoading || !name.trim()}
            data-state={isLoading ? 'loading' : 'idle'}
            aria-label="Submit greeting"
          >
            {isLoading ? 'Greeting...' : 'Greet'}
          </button>
        </div>

        {error && (
          <div
            id="greet-error-message"
            data-testid="greet-error-message"
            role="alert"
            aria-live="assertive"
            className="error-message"
          >
            {error}
          </div>
        )}

        {greetMsg && !error && (
          <p
            id="greet-result-message"
            data-testid="greet-result-message"
            role="status"
            aria-live="polite"
            data-result-for={name}
          >
            {greetMsg}
          </p>
        )}
      </form>
    </main>
  );
}
```

### Benefits of Refactored Version

1. **Every interactive element has an ID and data-testid**
2. **State is exposed** via `data-state` attributes
3. **Error states are accessible** via `aria-invalid` and `role="alert"`
4. **Loading states are visible** to both users and MCP
5. **Events are logged** for verification
6. **ARIA labels** provide semantic context
7. **Proper form semantics** with labels and descriptions

## MCP Test Patterns

With proper design, AI agents can write reliable tests:

### Pattern 1: Element Interaction Test

```javascript
// MCP can reliably find and interact with elements
const input = document.querySelector('[data-testid="greet-name-input"]');
input.value = 'John Doe';
input.dispatchEvent(new Event('input', { bubbles: true }));

const button = document.querySelector('[data-testid="greet-submit-button"]');
button.click();

// Wait for result
await new Promise(resolve => setTimeout(resolve, 1000));

const result = document.querySelector('[data-testid="greet-result-message"]');
console.assert(result.textContent.includes('John Doe'), 'Greeting should include name');
```

### Pattern 2: State Verification Test

```javascript
// Verify loading state
const button = document.querySelector('[data-testid="greet-submit-button"]');
button.click();

// Check loading state immediately
console.assert(
  button.getAttribute('data-state') === 'loading',
  'Button should show loading state'
);

// Check disabled state
console.assert(
  button.disabled === true,
  'Button should be disabled while loading'
);
```

### Pattern 3: Error Handling Test

```javascript
// Trigger error by passing invalid input
const input = document.querySelector('[data-testid="greet-name-input"]');
input.value = ''; // Empty name should trigger validation

const button = document.querySelector('[data-testid="greet-submit-button"]');
console.assert(
  button.disabled === true,
  'Button should be disabled for empty input'
);

// Check aria-invalid
console.assert(
  input.getAttribute('aria-invalid') === 'false',
  'Input should not be invalid before submission'
);
```

### Pattern 4: Event Log Verification

```javascript
// Clear previous events
window.__TEST_EVENTS__.clear();

// Perform action
document.querySelector('[data-testid="greet-submit-button"]').click();

// Verify events were logged
const events = window.__TEST_EVENTS__.getEvents('greet');
console.assert(events.length > 0, 'Greet events should be logged');
console.assert(
  events.some(e => e.type === 'greet.submit'),
  'Submit event should be logged'
);
```

## Code Conventions Summary

### ID Naming Convention

```
[context]-[component]-[element-type]

Examples:
- auth-login-email-input
- dashboard-project-card-title
- settings-theme-toggle-button
- modal-confirm-delete-yes-button
```

### Data Attribute Conventions

```typescript
data-testid          // Primary test selector
data-state           // Component state: 'idle' | 'loading' | 'success' | 'error'
data-has-error       // Boolean: true if error present
data-validation-state // 'valid' | 'invalid' | 'pending'
data-feature-flag    // Feature flag name
data-feature-enabled // Boolean: feature availability
data-[custom]        // Any domain-specific attribute
```

### ARIA Attribute Conventions

```typescript
aria-label           // Always for icon buttons, complex widgets
aria-describedby     // Link to error/help text
aria-invalid         // Validation state
aria-live            // "polite" for status, "assertive" for errors
aria-busy            // Loading state
role                 // Semantic role (alert, status, dialog, etc.)
```

## Implementation Checklist

- [ ] **IDs**: Every interactive element has a semantic ID
- [ ] **Test IDs**: All dynamic/repeated elements have data-testid
- [ ] **State exposure**: Component states visible via data attributes
- [ ] **ARIA labels**: All icon buttons and widgets have aria-label
- [ ] **Semantic HTML**: Using correct HTML elements (button, input, select)
- [ ] **Error states**: Errors use role="alert" and aria-invalid
- [ ] **Loading states**: Loading indicators use aria-busy and data-state
- [ ] **Form labels**: All inputs have associated labels (visible or sr-only)
- [ ] **Event logging**: Key actions logged to window.__TEST_EVENTS__
- [ ] **State exposure**: Global state accessible via window.__GET_STATE__

## Component Template

Use this as a starting template for new components:

```typescript
interface Props {
  id: string;  // Required base ID
  // ... other props
}

function MyComponent({ id, ...props }: Props) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState<string | null>(null);

  const handleAction = () => {
    testEvents.log(`${id}.action`, { /* context */ });
    // ... action logic
  };

  return (
    <div
      id={id}
      data-testid={id}
      data-state={state}
      data-has-error={!!error}
      aria-busy={state === 'loading'}
    >
      {/* Component content */}

      <button
        id={`${id}-action-button`}
        data-testid={`${id}-action-button`}
        onClick={handleAction}
        disabled={state === 'loading'}
        aria-label="Perform action"
      >
        {state === 'loading' ? 'Processing...' : 'Action'}
      </button>

      {error && (
        <div
          id={`${id}-error`}
          data-testid={`${id}-error`}
          role="alert"
          aria-live="assertive"
        >
          {error}
        </div>
      )}
    </div>
  );
}
```

## Benefits

Following these patterns provides:

1. **Reliable MCP testing** - AI can consistently find and interact with elements
2. **Better accessibility** - ARIA attributes help all users
3. **Easier debugging** - State exposure and event logging
4. **Self-documenting code** - Semantic IDs and attributes explain intent
5. **Regression prevention** - Stable selectors prevent test brittleness
6. **AI-friendly** - Clear semantics help AI understand your app

## Next Steps

1. **Audit existing components** - Add IDs and test attributes
2. **Create component library** - Build testable primitives (Button, Input, etc.)
3. **Write MCP test suite** - Use patterns above to test critical paths
4. **Document conventions** - Add to CLAUDE.md for team consistency
5. **Automate verification** - Use MCP to verify conventions in CI

---

**Remember:** Design for machines *and* humans. Good MCP design is good accessible design.
