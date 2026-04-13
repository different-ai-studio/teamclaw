use serde_json::Value;

pub async fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let _ = (workspace, arguments);
    todo!("capabilities::handle not yet implemented")
}
