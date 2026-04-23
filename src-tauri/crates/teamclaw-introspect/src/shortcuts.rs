use serde_json::{json, Value};

pub async fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: action".to_string())?;

    match action {
        "create" => action_create(workspace, arguments),
        "update" => action_update(workspace, arguments),
        "delete" => action_delete(workspace, arguments),
        other => Err(format!("Unknown action: {other}")),
    }
}

// ─── Create ───────────────────────────────────────────────────────────────────

fn action_create(workspace: &str, args: &Value) -> Result<Value, String> {
    let label = args
        .get("label")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "create requires 'label'".to_string())?;

    let shortcut_type = args
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "create requires 'type' (native/link/folder)".to_string())?;

    let target = args
        .get("target")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "create requires 'target'".to_string())?;

    let icon = args.get("icon");
    let parent_id = args.get("parent_id").or_else(|| args.get("parentId"));

    let parent_id_str = parent_id.and_then(|v| v.as_str()).filter(|s| !s.is_empty());

    // Generate ID: shortcut-{timestamp_ms}-{uuid_prefix}
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let uuid_prefix = uuid::Uuid::new_v4()
        .to_string()
        .chars()
        .take(7)
        .collect::<String>();
    let id = format!("shortcut-{ts}-{uuid_prefix}");

    // Read config and get/mutate shortcuts array
    let mut config = crate::config::read_teamclaw_config(workspace)?;
    let mut shortcuts = get_shortcuts_mut(&mut config);

    // Compute order from existing siblings
    let sibling_max_order = shortcuts
        .iter()
        .filter(|s| {
            let s_parent = s
                .get("parentId")
                .or_else(|| s.get("parent_id"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            s_parent == parent_id_str
        })
        .filter_map(|s| s.get("order").and_then(|v| v.as_f64()))
        .fold(f64::NEG_INFINITY, f64::max);

    let order = if sibling_max_order.is_infinite() {
        0i64
    } else {
        sibling_max_order as i64 + 1
    };

    // Build the new shortcut node
    let mut node = serde_json::Map::new();
    node.insert("id".to_string(), Value::String(id.clone()));
    node.insert("label".to_string(), Value::String(label.to_string()));
    node.insert("type".to_string(), Value::String(shortcut_type.to_string()));
    node.insert("target".to_string(), Value::String(target.to_string()));
    node.insert("order".to_string(), Value::Number(order.into()));
    node.insert(
        "parentId".to_string(),
        match parent_id_str {
            Some(p) => Value::String(p.to_string()),
            None => Value::Null,
        },
    );
    if let Some(ic) = icon {
        if !ic.is_null() {
            node.insert("icon".to_string(), ic.clone());
        }
    }

    shortcuts.push(Value::Object(node.clone()));

    // Write back
    write_shortcuts(workspace, &mut config, shortcuts)?;

    Ok(json!({
        "action": "created",
        "id": id,
        "shortcut": Value::Object(node)
    }))
}

// ─── Update ───────────────────────────────────────────────────────────────────

fn action_update(workspace: &str, args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "update requires 'id'".to_string())?;

    let mut config = crate::config::read_teamclaw_config(workspace)?;
    let mut shortcuts = get_shortcuts_mut(&mut config);

    let idx = shortcuts
        .iter()
        .position(|s| s.get("id").and_then(|v| v.as_str()) == Some(id))
        .ok_or_else(|| format!("Shortcut not found: {id}"))?;

    if let Value::Object(ref mut map) = shortcuts[idx] {
        // Update any provided fields
        for (key, dest_key) in &[
            ("label", "label"),
            ("type", "type"),
            ("target", "target"),
            ("icon", "icon"),
        ] {
            if let Some(v) = args.get(*key) {
                map.insert(dest_key.to_string(), v.clone());
            }
        }

        // parent_id / parentId
        if let Some(v) = args.get("parent_id").or_else(|| args.get("parentId")) {
            map.insert("parentId".to_string(), v.clone());
        }
    }

    write_shortcuts(workspace, &mut config, shortcuts)?;

    Ok(json!({
        "action": "updated",
        "id": id
    }))
}

// ─── Delete ───────────────────────────────────────────────────────────────────

fn action_delete(workspace: &str, args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "delete requires 'id'".to_string())?;

    let mut config = crate::config::read_teamclaw_config(workspace)?;
    let shortcuts = get_shortcuts_mut(&mut config);

    let original_len = shortcuts.len();

    // Collect all IDs to delete (the target + all descendants)
    let ids_to_delete = collect_descendants(&shortcuts, id);

    if !ids_to_delete.contains(&id.to_string()) {
        return Err(format!("Shortcut not found: {id}"));
    }

    let deleted_count = ids_to_delete.len();
    let updated: Vec<Value> = shortcuts
        .into_iter()
        .filter(|s| {
            let s_id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
            !ids_to_delete.contains(&s_id.to_string())
        })
        .collect();

    let _ = original_len; // used indirectly via deleted_count

    write_shortcuts(workspace, &mut config, updated)?;

    Ok(json!({
        "action": "deleted",
        "id": id,
        "deleted_count": deleted_count
    }))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Get the shortcuts array from config (as a cloned Vec for mutation).
fn get_shortcuts_mut(config: &mut Value) -> Vec<Value> {
    config
        .get("shortcuts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Write shortcuts back into config and persist.
fn write_shortcuts(
    workspace: &str,
    config: &mut Value,
    shortcuts: Vec<Value>,
) -> Result<(), String> {
    if let Value::Object(ref mut map) = config {
        map.insert("shortcuts".to_string(), Value::Array(shortcuts));
    }
    crate::config::write_teamclaw_config(workspace, config)
}

/// Recursively collect IDs of the node and all its descendants.
fn collect_descendants(nodes: &[Value], root_id: &str) -> Vec<String> {
    let mut result = vec![root_id.to_string()];
    // BFS/DFS: find children of each collected id
    let mut queue = vec![root_id.to_string()];

    while let Some(parent_id) = queue.pop() {
        for node in nodes.iter() {
            let node_id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let node_parent = node
                .get("parentId")
                .or_else(|| node.get("parent_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if node_parent == parent_id && !node_id.is_empty() {
                result.push(node_id.to_string());
                queue.push(node_id.to_string());
            }
        }
    }

    result
}
