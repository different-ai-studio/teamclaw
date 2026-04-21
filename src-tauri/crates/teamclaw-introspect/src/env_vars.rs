use crate::config;
use serde_json::{json, Value};

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;

    match action {
        "list" => {
            let cfg = config::read_teamclaw_config(workspace)?;
            let entries = cfg
                .get("envVars")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            Ok(json!({ "env_vars": entries }))
        }

        "set" => {
            let key = arguments
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: key")?;
            let value = arguments
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: value")?;
            let description = arguments.get("description").and_then(|v| v.as_str());

            let mut body = json!({ "key": key, "value": value });
            if let Some(d) = description {
                body["description"] = json!(d);
            }

            post_api(api_port, "/env-var-set", &body).await
        }

        "delete" => {
            let key = arguments
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: key")?;

            post_api(api_port, "/env-var-delete", &json!({ "key": key })).await
        }

        unknown => Err(format!(
            "Unknown action: '{}'. Valid actions: list, set, delete",
            unknown
        )),
    }
}

async fn post_api(api_port: u16, path: &str, body: &Value) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{api_port}{path}");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}. Is the TeamClaw app running?"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API error: {text}"));
    }

    resp.json::<Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_unknown_action() {
        let args = json!({ "action": "nope" });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown action"));
    }

    #[tokio::test]
    async fn test_set_missing_key() {
        let args = json!({ "action": "set", "value": "abc" });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing field: key"));
    }

    #[tokio::test]
    async fn test_set_missing_value() {
        let args = json!({ "action": "set", "key": "MY_KEY" });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing field: value"));
    }
}
