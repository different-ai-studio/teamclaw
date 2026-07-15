//! Permission-option translation + resolution routing, extracted from
//! `adapter.rs`.
//!
//! Maps ACP permission options to/from the daemon wire proto, picks the option
//! id that satisfies a grant/deny resolution, and routes a resolution back to
//! the waiting request in the session registry.
//!
//! Child module of `runtime::adapter`, so it reaches the parent's private
//! `SessionRegistry` / `SessionRoute` / `PermissionResolution` types directly.

use std::cell::RefCell;

use agent_client_protocol as acp;
use tracing::warn;

use crate::proto::amux;

use super::{PermissionResolution, SessionRegistry};

pub(super) fn permission_kind_wire(kind: acp::PermissionOptionKind) -> String {
    match kind {
        acp::PermissionOptionKind::AllowOnce => "allow_once".to_string(),
        acp::PermissionOptionKind::AllowAlways => "allow_always".to_string(),
        acp::PermissionOptionKind::RejectOnce => "reject_once".to_string(),
        acp::PermissionOptionKind::RejectAlways => "reject_always".to_string(),
        _ => "allow_once".to_string(),
    }
}

pub(super) fn amux_permission_options(
    options: &[acp::PermissionOption],
) -> Vec<amux::AcpPermissionOption> {
    options
        .iter()
        .map(|o| amux::AcpPermissionOption {
            option_id: o.option_id.to_string(),
            kind: permission_kind_wire(o.kind),
            name: o.name.clone(),
        })
        .collect()
}

pub(super) fn acp_option_for_resolution(
    options: &[acp::PermissionOption],
    resolution: &PermissionResolution,
) -> acp::PermissionOptionId {
    match resolution {
        PermissionResolution::Denied => options
            .iter()
            .find(|o| {
                matches!(
                    o.kind,
                    acp::PermissionOptionKind::RejectOnce | acp::PermissionOptionKind::RejectAlways
                )
            })
            .or_else(|| options.last())
            .map(|o| o.option_id.clone())
            .unwrap_or_else(|| acp::PermissionOptionId::new("deny")),
        PermissionResolution::Granted { option_id } => {
            if let Some(id) = option_id.as_deref().filter(|s| !s.is_empty()) {
                if let Some(opt) = options.iter().find(|o| o.option_id.to_string() == id) {
                    return opt.option_id.clone();
                }
                if id == "always" {
                    if let Some(opt) = options
                        .iter()
                        .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowAlways))
                    {
                        return opt.option_id.clone();
                    }
                }
                if id == "once" {
                    if let Some(opt) = options
                        .iter()
                        .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowOnce))
                    {
                        return opt.option_id.clone();
                    }
                }
                return acp::PermissionOptionId::new(id);
            }
            options
                .iter()
                .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowOnce))
                .or_else(|| {
                    options
                        .iter()
                        .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowAlways))
                })
                .or_else(|| options.first())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("allow"))
        }
    }
}

pub(super) fn resolve_permission_in_registry(
    registry: &RefCell<SessionRegistry>,
    request_id: &str,
    granted: bool,
    option_id: Option<String>,
) {
    let resolution = if granted {
        PermissionResolution::Granted { option_id }
    } else {
        PermissionResolution::Denied
    };
    let mut guard = registry.borrow_mut();
    for route in guard.sessions.values_mut() {
        if let Some(tx) = route.pending_permissions.remove(request_id) {
            let _ = tx.send(resolution);
            return;
        }
    }
    warn!(request_id, "no pending permission request found");
}
