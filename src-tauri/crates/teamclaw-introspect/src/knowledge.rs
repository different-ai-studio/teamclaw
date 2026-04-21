use serde_json::{json, Value};

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;

    match action {
        "search" => {
            let query = arguments
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: query")?;
            let top_k = arguments.get("top_k").and_then(|v| v.as_u64());

            let mut body = json!({ "query": query });
            if let Some(k) = top_k {
                body["top_k"] = json!(k);
            }

            post_api(api_port, "/knowledge-search", &body).await
        }

        "add" => {
            let content = arguments
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: content")?;
            let title = arguments.get("title").and_then(|v| v.as_str());
            let filename = arguments.get("filename").and_then(|v| v.as_str());

            let mut body = json!({ "content": content });
            if let Some(t) = title {
                body["title"] = json!(t);
            }
            if let Some(f) = filename {
                body["filename"] = json!(f);
            }

            post_api(api_port, "/knowledge-add", &body).await
        }

        "list" => post_api(api_port, "/knowledge-list", &json!({})).await,

        "delete" => {
            let filename = arguments
                .get("filename")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: filename")?;

            post_api(api_port, "/knowledge-delete", &json!({ "filename": filename })).await
        }

        unknown => Err(format!(
            "Unknown action: '{}'. Valid actions: search, add, list, delete",
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

    #[test]
    fn test_add_builds_body() {
        let args = json!({ "action": "add", "content": "hello", "title": "My Note" });
        assert_eq!(args["action"], "add");
        assert_eq!(args["content"], "hello");
    }
}
