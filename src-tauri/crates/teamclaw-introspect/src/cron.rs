use serde_json::Value;

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let _ = (workspace, api_port, arguments);
    todo!("cron::handle not yet implemented")
}
