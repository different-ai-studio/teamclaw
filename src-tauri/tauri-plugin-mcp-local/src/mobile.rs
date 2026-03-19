use serde::de::DeserializeOwned;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::commands::SocketInfoResponse;
use crate::models::*;
use crate::socket_server::SocketServer;
use crate::{Error, PluginConfig};

#[derive(Debug, Clone)]
struct MobilePluginHandle<R: Runtime> {
    app: AppHandle<R>,
    plugin: PluginHandle<R>,
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
    config: &PluginConfig,
) -> crate::Result<TauriMcp<R>> {
    // Mobile platforms might use a different approach for the socket server
    // For now, we'll initialize it the same way as desktop, but in a real implementation
    // you might want to use a different approach or disable it on mobile
    let socket_server = if config.start_socket_server {
        let mut server = SocketServer::new(app.clone(), config.socket_type.clone());
        server.start()?;
        Some(Arc::new(Mutex::new(server)))
    } else {
        None
    };

    Ok(TauriMcp {
        app: app.clone(),
        socket_server,
    })
}

/// Access to the tauri-mcp APIs.
pub struct TauriMcp<R: Runtime> {
    app: AppHandle<R>,
    socket_server: Option<Arc<Mutex<SocketServer<R>>>>,
}

impl<R: Runtime> TauriMcp<R> {
    pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
        Ok(PingResponse {
            value: payload.value,
        })
    }

    pub fn control_window(
        &self,
        _payload: WindowControlRequest,
    ) -> crate::Result<WindowControlResponse> {
        // On mobile, window control is more limited
        Err(Error::Anyhow(
            "Window control is not supported on mobile".to_string(),
        ))
    }

    // For the MCP DOM manipulation commands, we'll implement stubs that return errors
    // In a real implementation, you'd want to implement these using platform-specific APIs

    pub async fn eval_js(&self, _payload: EvalJsRequest) -> crate::Result<EvalJsResponse> {
        Err(Error::Anyhow(
            "JavaScript evaluation is not implemented on mobile".to_string(),
        ))
    }

    pub async fn get_element_text(
        &self,
        _payload: ElementRequest,
    ) -> crate::Result<ElementResponse> {
        Err(Error::Anyhow(
            "DOM manipulation is not implemented on mobile".to_string(),
        ))
    }

    pub async fn set_element_value(
        &self,
        _payload: SetElementValueRequest,
    ) -> crate::Result<ElementResponse> {
        Err(Error::Anyhow(
            "DOM manipulation is not implemented on mobile".to_string(),
        ))
    }

    pub async fn click_element(&self, _payload: ElementRequest) -> crate::Result<ElementResponse> {
        Err(Error::Anyhow(
            "DOM manipulation is not implemented on mobile".to_string(),
        ))
    }

    pub async fn get_url(&self, _payload: WebviewInfoRequest) -> crate::Result<UrlResponse> {
        Err(Error::Anyhow(
            "URL retrieval is not implemented on mobile".to_string(),
        ))
    }

    pub async fn get_title(&self, _payload: WebviewInfoRequest) -> crate::Result<TitleResponse> {
        Err(Error::Anyhow(
            "Title retrieval is not implemented on mobile".to_string(),
        ))
    }

    pub async fn get_html(&self, _payload: WebviewInfoRequest) -> crate::Result<HtmlResponse> {
        Err(Error::Anyhow(
            "HTML retrieval is not implemented on mobile".to_string(),
        ))
    }

    // Take screenshot - not fully supported on mobile
    pub async fn take_screenshot_async(
        &self,
        _payload: ScreenshotRequest,
    ) -> crate::Result<ScreenshotResponse> {
        Err(Error::WindowOperationFailed(
            "Screenshots are not supported on mobile platforms".to_string(),
        ))
    }

    pub async fn type_text(&self, _payload: TypeTextRequest) -> crate::Result<ElementResponse> {
        Err(Error::Anyhow(
            "Text input is not implemented on mobile".to_string(),
        ))
    }
}

impl<R: Runtime> Drop for TauriMcp<R> {
    fn drop(&mut self) {
        if let Some(server) = &self.socket_server {
            if let Ok(mut server) = server.lock() {
                let _ = server.stop();
            }
        }
    }
}
