//! Short-lived Cloud API credentials for the introspect loopback API.
//!
//! Design-2 keeps the user JWT in the renderer. Background MCP tools (e.g.
//! `archive_session`) still need a bearer to call `PATCH /v1/sessions/:id`, so
//! the frontend pushes a fresh token into this in-memory bridge on auth
//! changes. Nothing is written to disk.

use std::sync::Mutex;

use tauri::State;

#[derive(Default)]
pub struct IntrospectAuthState {
    inner: Mutex<IntrospectAuthSnapshot>,
}

#[derive(Default, Clone)]
struct IntrospectAuthSnapshot {
    access_token: Option<String>,
    cloud_api_url: Option<String>,
}

impl IntrospectAuthState {
    pub fn set(&self, access_token: Option<String>, cloud_api_url: Option<String>) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.access_token = access_token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        guard.cloud_api_url = cloud_api_url
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty());
    }

    pub fn clear(&self) {
        self.set(None, None);
    }

    pub fn get(&self) -> Option<(String, String)> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match (&guard.access_token, &guard.cloud_api_url) {
            (Some(token), Some(url)) => Some((token.clone(), url.clone())),
            _ => None,
        }
    }
}

/// Push the signed-in user's Cloud API credentials for introspect MCP tools.
#[tauri::command]
pub fn set_introspect_auth(
    state: State<'_, IntrospectAuthState>,
    access_token: Option<String>,
    cloud_api_url: Option<String>,
) -> Result<(), String> {
    if access_token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .is_none()
    {
        state.clear();
        return Ok(());
    }
    state.set(access_token, cloud_api_url);
    Ok(())
}

/// Drop credentials (sign-out).
#[tauri::command]
pub fn clear_introspect_auth(state: State<'_, IntrospectAuthState>) -> Result<(), String> {
    state.clear();
    Ok(())
}
