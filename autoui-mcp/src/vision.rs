use anyhow::{Context, Result};
use regex::Regex;
use serde_json::Value;

use crate::config::Config;
use crate::screenshot;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Element {
    pub label: String,
    #[serde(rename = "type")]
    pub elem_type: String,
    pub center: Point,
    pub bbox: BBox,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BBox {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/// Result of a vision verify call.
#[derive(Debug, serde::Serialize)]
pub struct VerifyResult {
    pub assertion: String,
    pub passed: bool,
    pub confidence: f64,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_performed: Option<String>,
}

/// Verify whether the current screen matches the given `assertion`.
pub async fn verify(
    config: &Config,
    assertion: &str,
    action_performed: Option<&str>,
) -> Result<VerifyResult> {
    // 1. Screenshot (resized to 1600px max to save tokens)
    let cap = screenshot::capture_screen().context("Screenshot failed")?;
    tracing::info!(
        w = cap.phys_w,
        h = cap.phys_h,
        assertion,
        "Vision verify"
    );

    let b64 = screenshot::encode_image_base64(&cap.image, Some(1600))?;

    // 2. Build request
    let system_prompt = concat!(
        "你是一个精确的屏幕状态验证专家。你需要根据用户给出的断言（assertion），",
        "判断当前屏幕截图是否满足该断言描述的状态。",
        "只返回纯 JSON，不要有任何多余文字或 markdown 标记。"
    );

    let action_context = action_performed
        .map(|a| format!("刚刚执行的操作：{a}\n"))
        .unwrap_or_default();

    let user_prompt = format!(
        "这是一张当前屏幕截图。\n\n\
         {action_context}\
         请判断当前屏幕状态是否满足以下断言：\n\
         「{assertion}」\n\n\
         严格按以下 JSON 格式返回：\n\
         {{\"passed\": true/false, \"confidence\": 0.0-1.0, \"reason\": \"判断理由（简洁描述你观察到的关键证据）\"}}\n\n\
         要求：\n\
         - passed: 布尔值，断言是否成立\n\
         - confidence: 0.0 到 1.0 的浮点数，表示判断的置信度\n\
         - reason: 简洁的判断理由，描述你在截图中看到的关键证据\n\
         - 只返回 JSON，不要有其他文字"
    );

    let body = build_chat_body(config, system_prompt, &user_prompt, &b64, 1024);

    // 3. Call API
    let raw_content = call_qwen(config, &body).await?;
    tracing::debug!(len = raw_content.len(), "Qwen raw response (verify)");

    // 4. Parse
    let content = clean_vlm_response(&raw_content);
    let parsed: Value =
        serde_json::from_str(&content).context("Failed to parse Qwen3-VL JSON response")?;

    let passed = parsed
        .get("passed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let confidence = parsed
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let reason = parsed
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let status = if passed { "PASS" } else { "FAIL" };
    tracing::info!(status, confidence, reason = reason.as_str(), "Vision verify");

    Ok(VerifyResult {
        assertion: assertion.to_string(),
        passed,
        confidence,
        reason,
        action_performed: action_performed.map(|s| s.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/// Result of a vision plan call.
#[derive(Debug, serde::Serialize)]
pub struct PlanResult {
    pub intent: String,
    pub screen_size: ScreenSize,
    pub action: Action,
    pub reasoning: String,
    pub confidence: f64,
    pub candidates: Vec<Element>,
    pub total_candidates: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize)]
pub struct Action {
    pub action_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    pub params: ActionParams,
}

#[derive(Debug, serde::Serialize)]
pub struct Target {
    pub label: String,
    #[serde(rename = "type")]
    pub element_type: String,
    pub center: Point,
    pub bbox: BBox,
}

#[derive(Debug, serde::Serialize)]
pub struct ActionParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clicks: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_amount: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
}

/// Plan the next action based on the current screen and intent.
pub async fn plan(
    config: &Config,
    intent: &str,
    context: Option<&[String]>,
) -> Result<PlanResult> {
    // 1. Capture full-resolution screenshot (same as locate)
    let cap = screenshot::capture_screen().context("Screenshot failed")?;
    let img_w = cap.phys_w;
    let img_h = cap.phys_h;
    let logical_w = cap.logical_w;
    let logical_h = cap.logical_h;
    let retina_scale = cap.scale;

    tracing::info!(
        img_w,
        img_h,
        logical_w,
        logical_h,
        retina_scale,
        intent,
        context_len = context.map(|c| c.len()).unwrap_or(0),
        "Vision plan"
    );

    // 2. Encode to base64 JPEG (full resolution for accuracy)
    let b64 = screenshot::encode_image_base64(&cap.image, None)?;

    // 3. Build Qwen3-VL request
    let system_prompt = concat!(
        "你是一个智能的 UI 操作规划专家。根据用户的高层意图和当前屏幕状态，",
        "分析并决定下一步应该执行什么操作。你需要识别目标 UI 元素的位置，并返回结构化的操作计划。",
        "坐标使用归一化值，范围 [0, 1000]，(0,0) 为图片左上角，(1000,1000) 为右下角。",
        "只返回纯 JSON，不要有任何多余文字或 markdown 标记。"
    );

    let context_text = context
        .map(|c| {
            if c.is_empty() {
                "无".to_string()
            } else {
                c.iter()
                    .enumerate()
                    .map(|(i, op)| format!("{}. {}", i + 1, op))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        })
        .unwrap_or_else(|| "无".to_string());

    let user_prompt = format!(
        "这是一张屏幕截图。\n\n\
         当前任务意图：{intent}\n\n\
         已执行的操作：\n{context_text}\n\n\
         请分析当前屏幕截图，完成两个任务：\n\
         1. 识别所有与意图相关的 UI 元素\n\
         2. 决定下一步应该执行什么操作\n\n\
         严格按以下 JSON 格式返回：\n\
         {{\n\
           \"recommended_action\": {{\n\
             \"action_type\": \"click|type|press|scroll|drag|wait|done\",\n\
             \"reasoning\": \"推理过程（简洁描述你观察到的关键信息和决策依据）\",\n\
             \"confidence\": 0.0-1.0,\n\
             \"target\": {{\"label\": \"元素描述\", \"type\": \"button|input|link|icon|tab|menu|text|image|other\", \"bbox_2d\": [x1, y1, x2, y2]}},\n\
             \"params\": {{\"text\": \"...\", \"keys\": \"...\", \"button\": \"left|right|middle\", \"clicks\": 1|2, \"scroll_amount\": 正数向上/负数向下, \"wait_reason\": \"...\"}}\n\
           }},\n\
           \"candidates\": [\n\
             {{\"label\": \"元素描述\", \"type\": \"button|input|link|icon|tab|menu|text|image|other\", \"bbox_2d\": [x1, y1, x2, y2]}}\n\
           ]\n\
         }}\n\n\
         操作类型说明：\n\
         - click: 点击元素（需 target + params.button/clicks，默认 left/1）\n\
         - type: 输入文本（需 target + params.text）\n\
         - press: 按键（需 params.keys，如 'enter'、'command+s'）\n\
         - scroll: 滚动（需 target 或屏幕中心 + params.scroll_amount，正数向上/负数向下）\n\
         - drag: 拖拽（暂不支持，建议分解为 click + move）\n\
         - wait: 等待加载（需 params.wait_reason）\n\
         - done: 任务已完成\n\n\
         要求：\n\
         - bbox_2d 使用归一化坐标 [0, 1000]，(x1,y1)=左上角，(x2,y2)=右下角\n\
         - candidates 按相关性从高到低排列，包含所有可能的目标元素\n\
         - recommended_action.target 通常是 candidates 中的第一个元素，但可根据上下文调整\n\
         - target 可选（press/wait/done 操作不需要 target）\n\
         - params 中只填写本次操作需要的参数，其他留空\n\
         - reasoning 简洁明确，描述你看到什么、为什么这样做\n\
         - 只返回 JSON，不要有其他文字",
    );

    let body = build_chat_body(config, system_prompt, &user_prompt, &b64, 2048);

    // 4. Call Qwen3-VL API
    let raw_content = call_qwen(config, &body).await?;
    tracing::debug!(len = raw_content.len(), "Qwen raw response (plan)");

    // 5. Parse response
    let content = clean_vlm_response(&raw_content);
    let parsed: Value =
        serde_json::from_str(&content).context("Failed to parse Qwen3-VL JSON response")?;

    // 6. Parse recommended_action
    let recommended = parsed.get("recommended_action").unwrap_or(&parsed);
    
    let action_type = recommended
        .get("action_type")
        .and_then(|v| v.as_str())
        .unwrap_or("wait")
        .to_string();

    let reasoning = recommended
        .get("reasoning")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let confidence = recommended
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.5);

    // 7. Parse target (if present in recommended_action)
    let target = if let Some(target_val) = recommended.get("target") {
        if let Some(bbox_arr) = target_val.get("bbox_2d").and_then(|v| v.as_array()) {
            if bbox_arr.len() == 4 {
                let nx1 = bbox_arr[0].as_f64().unwrap_or(0.0);
                let ny1 = bbox_arr[1].as_f64().unwrap_or(0.0);
                let nx2 = bbox_arr[2].as_f64().unwrap_or(0.0);
                let ny2 = bbox_arr[3].as_f64().unwrap_or(0.0);

                // Normalised → physical pixels
                let px1 = nx1 / 1000.0 * img_w as f64;
                let py1 = ny1 / 1000.0 * img_h as f64;
                let px2 = nx2 / 1000.0 * img_w as f64;
                let py2 = ny2 / 1000.0 * img_h as f64;

                // Physical → logical
                let x1 = (px1 / retina_scale).round().max(0.0) as i32;
                let y1 = (py1 / retina_scale).round().max(0.0) as i32;
                let x2 = (px2 / retina_scale).round().min(logical_w as f64) as i32;
                let y2 = (py2 / retina_scale).round().min(logical_h as f64) as i32;
                let center_x = (x1 + x2) / 2;
                let center_y = (y1 + y2) / 2;

                Some(Target {
                    label: target_val
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    element_type: target_val
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("other")
                        .to_string(),
                    center: Point {
                        x: center_x,
                        y: center_y,
                    },
                    bbox: BBox {
                        x: x1,
                        y: y1,
                        width: x2 - x1,
                        height: y2 - y1,
                    },
                })
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    // 8. Parse params from recommended_action
    let params_val = recommended.get("params");
    let params = ActionParams {
        text: params_val
            .and_then(|p| p.get("text"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        keys: params_val
            .and_then(|p| p.get("keys"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        button: params_val
            .and_then(|p| p.get("button"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        clicks: params_val
            .and_then(|p| p.get("clicks"))
            .and_then(|v| v.as_u64())
            .map(|n| n as u32),
        scroll_amount: params_val
            .and_then(|p| p.get("scroll_amount"))
            .and_then(|v| v.as_i64())
            .map(|n| n as i32),
        wait_reason: params_val
            .and_then(|p| p.get("wait_reason"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    };

    let action = Action {
        action_type: action_type.clone(),
        target,
        params,
    };

    // 9. Parse candidates
    let candidates_val = parsed
        .get("candidates")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut candidates = Vec::new();
    for elem in &candidates_val {
        let bbox = match elem.get("bbox_2d").and_then(|v| v.as_array()) {
            Some(arr) if arr.len() == 4 => arr,
            _ => continue,
        };

        let nx1 = bbox[0].as_f64().unwrap_or(0.0);
        let ny1 = bbox[1].as_f64().unwrap_or(0.0);
        let nx2 = bbox[2].as_f64().unwrap_or(0.0);
        let ny2 = bbox[3].as_f64().unwrap_or(0.0);

        // Normalised → physical pixels
        let px1 = nx1 / 1000.0 * img_w as f64;
        let py1 = ny1 / 1000.0 * img_h as f64;
        let px2 = nx2 / 1000.0 * img_w as f64;
        let py2 = ny2 / 1000.0 * img_h as f64;

        // Physical → logical
        let x1 = (px1 / retina_scale).round().max(0.0) as i32;
        let y1 = (py1 / retina_scale).round().max(0.0) as i32;
        let x2 = (px2 / retina_scale).round().min(logical_w as f64) as i32;
        let y2 = (py2 / retina_scale).round().min(logical_h as f64) as i32;
        let center_x = (x1 + x2) / 2;
        let center_y = (y1 + y2) / 2;

        candidates.push(Element {
            label: elem
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            elem_type: elem
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("other")
                .to_string(),
            center: Point {
                x: center_x,
                y: center_y,
            },
            bbox: BBox {
                x: x1,
                y: y1,
                width: x2 - x1,
                height: y2 - y1,
            },
        });
    }

    tracing::info!(
        action_type,
        confidence,
        candidates_count = candidates.len(),
        reasoning = reasoning.as_str(),
        "Vision plan complete"
    );

    Ok(PlanResult {
        intent: intent.to_string(),
        screen_size: ScreenSize {
            width: logical_w,
            height: logical_h,
        },
        action,
        reasoning,
        confidence,
        candidates: candidates.clone(),
        total_candidates: candidates.len(),
        context: context.map(|c| c.to_vec()),
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a chat-completions JSON body with one image + text user message.
fn build_chat_body(
    config: &Config,
    system_prompt: &str,
    user_prompt: &str,
    image_b64: &str,
    max_tokens: u32,
) -> Value {
    serde_json::json!({
        "model": config.vision_model,
        "messages": [
            { "role": "system", "content": system_prompt },
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:image/jpeg;base64,{image_b64}")
                        }
                    },
                    { "type": "text", "text": user_prompt }
                ]
            }
        ],
        "max_tokens": max_tokens,
        "temperature": 0.1
    })
}

/// Call the Qwen-compatible chat/completions endpoint and return the raw
/// assistant content string.
async fn call_qwen(config: &Config, body: &Value) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("HTTP client build failed")?;

    let resp = client
        .post(format!("{}/chat/completions", config.vision_base_url))
        .header("Authorization", format!("Bearer {}", config.vision_api_key))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .context("Qwen API request failed")?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("Qwen API HTTP error: {status} - {}", &text[..text.len().min(500)]);
    }

    let result: Value = resp.json().await.context("Qwen API JSON parse failed")?;

    result["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .context("Missing content in Qwen API response")
}

/// Clean a VLM response by stripping `<think>` blocks, markdown fences, and
/// extracting the inner JSON object.
fn clean_vlm_response(raw: &str) -> String {
    // Remove <think>...</think> blocks
    let re_think = Regex::new(r"(?s)<think>.*?</think>").unwrap();
    let cleaned = re_think.replace_all(raw, "").to_string();
    let cleaned = cleaned.trim();

    // Try to extract JSON from markdown code block
    let re_fence = Regex::new(r"(?s)```(?:json)?\s*\n?(.*?)\n?```").unwrap();
    if let Some(caps) = re_fence.captures(cleaned) {
        return caps[1].to_string();
    }

    // Try to extract the first { ... } block
    let re_brace = Regex::new(r"(?s)\{.*\}").unwrap();
    if let Some(m) = re_brace.find(cleaned) {
        return m.as_str().to_string();
    }

    cleaned.to_string()
}
