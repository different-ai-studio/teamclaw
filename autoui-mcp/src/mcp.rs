use std::borrow::Cow;
use std::future::Future;
use std::sync::Arc;

use rmcp::{
    handler::server::{router::tool::ToolRouter, tool::Parameters},
    model::{ErrorData as McpError, *},
    schemars, tool, tool_handler, tool_router, ServerHandler,
};
use serde::Deserialize;

use crate::config::Config;
use crate::{keyboard, mouse, vision};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AutoUiService {
    config: Arc<Config>,
    tool_router: ToolRouter<AutoUiService>,
}

impl std::fmt::Debug for AutoUiService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutoUiService")
            .field("config", &self.config)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct VisionVerifyRequest {
    #[schemars(description = "要验证的断言，描述期望的屏幕状态，如 '文件已成功打开'")]
    pub assertion: String,

    #[schemars(description = "（可选）刚刚执行的操作描述，为模型提供上下文")]
    pub action_performed: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MouseClickRequest {
    #[schemars(description = "X 坐标（逻辑像素）")]
    pub x: i32,
    #[schemars(description = "Y 坐标（逻辑像素）")]
    pub y: i32,
    #[schemars(description = "鼠标按键: left / right / middle（默认 left）")]
    pub button: Option<String>,
    #[schemars(description = "点击次数（1=单击, 2=双击打开）（默认 1）")]
    pub clicks: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MouseMoveRequest {
    #[schemars(description = "X 坐标（逻辑像素）")]
    pub x: i32,
    #[schemars(description = "Y 坐标（逻辑像素）")]
    pub y: i32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MouseScrollRequest {
    #[schemars(description = "滚动量（正=上, 负=下）")]
    pub clicks: i32,
    #[schemars(description = "X 坐标（可选，先聚焦再滚动）")]
    pub x: Option<i32>,
    #[schemars(description = "Y 坐标（可选，先聚焦再滚动）")]
    pub y: Option<i32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MouseDragRequest {
    #[schemars(description = "起始 X（逻辑像素）")]
    pub start_x: i32,
    #[schemars(description = "起始 Y（逻辑像素）")]
    pub start_y: i32,
    #[schemars(description = "终点 X（逻辑像素）")]
    pub end_x: i32,
    #[schemars(description = "终点 Y（逻辑像素）")]
    pub end_y: i32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct KeyboardTypeRequest {
    #[schemars(description = "要输入的文本")]
    pub text: String,
    #[schemars(description = "字符间隔（秒），仅 ASCII 文本有效（默认 0）")]
    pub interval: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct KeyboardPressRequest {
    #[schemars(description = "按键，组合键用 + 连接，如 'enter'、'ctrl+c'、'command+v'")]
    pub keys: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct VisionPlanRequest {
    #[schemars(description = "当前任务意图描述，如 '登录系统'、'打开设置并关闭通知'")]
    pub intent: String,
    #[schemars(description = "（可选）任务上下文：之前执行的操作列表，帮助 VL 模型理解任务进度")]
    pub context: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

#[tool_router]
impl AutoUiService {
    pub fn new(config: Config) -> Self {
        Self {
            config: Arc::new(config),
            tool_router: Self::tool_router(),
        }
    }

    // ---- Vision ----

    #[tool(
        description = "视觉验证：截图后调用视觉模型判断当前屏幕状态是否符合预期断言。用于操作后验证结果是否正确。"
    )]
    async fn auto_vision_verify(
        &self,
        Parameters(req): Parameters<VisionVerifyRequest>,
    ) -> Result<CallToolResult, McpError> {
        if !self.config.has_vision() {
            return Ok(CallToolResult::error(vec![Content::text(
                "Error: QWEN_API_KEY not configured. Set it in environment.",
            )]));
        }
        let assertion = req.assertion.trim().to_string();
        if assertion.is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "Error: 'assertion' parameter is required.",
            )]));
        }

        match vision::verify(
            &self.config,
            &assertion,
            req.action_performed.as_deref(),
        )
        .await
        {
            Ok(result) => {
                let json = serde_json::to_string_pretty(&result).map_err(|e| McpError {
                    code: ErrorCode::INTERNAL_ERROR,
                    message: Cow::from(format!("Serialization error: {e}")),
                    data: None,
                })?;
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Vision verify error: {e:#}"
            ))])),
        }
    }

    #[tool(
        description = "智能规划：分析屏幕状态和意图，返回推荐操作和候选元素。\
                       推荐操作包含 action_type、target、params、reasoning、confidence。\
                       候选元素列表包含所有相关 UI 元素坐标（逻辑像素），agent 可自行选择。"
    )]
    async fn auto_vision_plan(
        &self,
        Parameters(req): Parameters<VisionPlanRequest>,
    ) -> Result<CallToolResult, McpError> {
        if !self.config.has_vision() {
            return Ok(CallToolResult::error(vec![Content::text(
                "Error: QWEN_API_KEY not configured. Set it in environment.",
            )]));
        }
        let intent = req.intent.trim().to_string();
        if intent.is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "Error: 'intent' parameter is required.",
            )]));
        }

        let context = req.context.as_ref().map(|v| v.as_slice());

        match vision::plan(&self.config, &intent, context).await {
            Ok(result) => {
                let json = serde_json::to_string_pretty(&result).map_err(|e| McpError {
                    code: ErrorCode::INTERNAL_ERROR,
                    message: Cow::from(format!("Serialization error: {e}")),
                    data: None,
                })?;
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Vision plan error: {e:#}"
            ))])),
        }
    }

    // ---- Mouse ----

    #[tool(description = "鼠标点击。打开文件/应用需 clicks=2（双击）。")]
    async fn auto_mouse_click(
        &self,
        Parameters(req): Parameters<MouseClickRequest>,
    ) -> Result<CallToolResult, McpError> {
        let button = req.button.as_deref().unwrap_or("left");
        let clicks = req.clicks.unwrap_or(1);

        // Run blocking enigo calls on a dedicated thread
        let x = req.x;
        let y = req.y;
        let btn = button.to_string();
        let result =
            tokio::task::spawn_blocking(move || mouse::click(x, y, &btn, clicks)).await;

        match result {
            Ok(Ok(msg)) => {
                // Wait for UI to respond after click
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Ok(Err(e)) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Mouse click error: {e:#}"
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Task join error: {e}"
            ))])),
        }
    }

    #[tool(description = "移动鼠标到指定坐标（悬停）。")]
    async fn auto_mouse_move(
        &self,
        Parameters(req): Parameters<MouseMoveRequest>,
    ) -> Result<CallToolResult, McpError> {
        let x = req.x;
        let y = req.y;
        let result = tokio::task::spawn_blocking(move || mouse::move_to(x, y)).await;

        match result {
            Ok(Ok(msg)) => Ok(CallToolResult::success(vec![Content::text(msg)])),
            Ok(Err(e)) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Mouse move error: {e:#}"
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Task join error: {e}"
            ))])),
        }
    }

    #[tool(
        description = "滚动鼠标滚轮。正数向上，负数向下。滚动前先点击目标区域聚焦。"
    )]
    async fn auto_mouse_scroll(
        &self,
        Parameters(req): Parameters<MouseScrollRequest>,
    ) -> Result<CallToolResult, McpError> {
        let amount = req.clicks;
        let focus = match (req.x, req.y) {
            (Some(x), Some(y)) => Some((x, y)),
            _ => None,
        };
        let result =
            tokio::task::spawn_blocking(move || mouse::scroll(amount, focus)).await;

        match result {
            Ok(Ok(msg)) => Ok(CallToolResult::success(vec![Content::text(msg)])),
            Ok(Err(e)) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Mouse scroll error: {e:#}"
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Task join error: {e}"
            ))])),
        }
    }

    #[tool(
        description = "从起点拖拽到终点。用于拖放文件、调整滑块、调整窗口大小等。"
    )]
    async fn auto_mouse_drag(
        &self,
        Parameters(req): Parameters<MouseDragRequest>,
    ) -> Result<CallToolResult, McpError> {
        let sx = req.start_x;
        let sy = req.start_y;
        let ex = req.end_x;
        let ey = req.end_y;
        let result =
            tokio::task::spawn_blocking(move || mouse::drag(sx, sy, ex, ey)).await;

        match result {
            Ok(Ok(msg)) => Ok(CallToolResult::success(vec![Content::text(msg)])),
            Ok(Err(e)) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Mouse drag error: {e:#}"
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Task join error: {e}"
            ))])),
        }
    }

    // ---- Keyboard ----

    #[tool(
        description = "输入文本，支持中文等 Unicode 字符（通过剪贴板粘贴）。"
    )]
    async fn auto_keyboard_type(
        &self,
        Parameters(req): Parameters<KeyboardTypeRequest>,
    ) -> Result<CallToolResult, McpError> {
        let text = req.text;
        let interval = req.interval.unwrap_or(0.0);
        let result =
            tokio::task::spawn_blocking(move || keyboard::type_text(&text, interval)).await;

        match result {
            Ok(Ok(msg)) => Ok(CallToolResult::success(vec![Content::text(msg)])),
            Ok(Err(e)) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Keyboard type error: {e:#}"
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Task join error: {e}"
            ))])),
        }
    }

    #[tool(
        description = "按键或组合键，如 'enter'、'ctrl+c'、'command+v'。"
    )]
    async fn auto_keyboard_press(
        &self,
        Parameters(req): Parameters<KeyboardPressRequest>,
    ) -> Result<CallToolResult, McpError> {
        let keys = req.keys;
        let result =
            tokio::task::spawn_blocking(move || keyboard::press_keys(&keys)).await;

        match result {
            Ok(Ok(msg)) => Ok(CallToolResult::success(vec![Content::text(msg)])),
            Ok(Err(e)) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Keyboard press error: {e:#}"
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Task join error: {e}"
            ))])),
        }
    }
}

// ---------------------------------------------------------------------------
// Server handler
// ---------------------------------------------------------------------------

const SERVER_INSTRUCTIONS: &str = "\
You control the local computer via desktop automation.

WORKFLOW: plan → act → verify

1. auto_vision_plan(intent, context) - Get AI-suggested action + all candidate elements
   Returns:
   - action: Recommended operation with action_type, target, params, reasoning, confidence
   - candidates: All relevant UI elements with coordinates (sorted by relevance)
   
2. Choose execution strategy:
   Option A: Follow AI recommendation - use action.action_type, action.target, action.params
   Option B: Custom choice - select from candidates and decide your own action_type
   
3. Perform the action (click/type/press/scroll/drag)

4. auto_vision_verify(assertion) - Verify the result is correct. Retry if failed.

RULES:
- NEVER guess or reuse old coordinates, always call auto_vision_plan first.
- Use action.target from the recommendation OR pick from candidates.
- For complex multi-step tasks, follow AI recommendations (action.action_type).
- For simple single-step tasks, you can choose from candidates yourself.
- Scroll: plan → click to focus → scroll.
- Open files/apps: use clicks=2 (double-click).";

#[tool_handler]
impl ServerHandler for AutoUiService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "autoui-mcp".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            instructions: Some(SERVER_INSTRUCTIONS.to_string()),
        }
    }
}
