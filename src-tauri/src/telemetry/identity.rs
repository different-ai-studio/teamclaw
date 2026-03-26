use super::db::TelemetryDb;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalUser {
    pub uid: String,
    pub display_name: String,
    pub role: Option<String>,
    pub created_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedIdentity {
    pub uid: String,
    pub display_name: String,
    pub role: Option<String>,
    pub is_new: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub session_key: String,
    pub uid: Option<String>,
    pub platform: String,
    pub external_id: String,
    pub display_name: Option<String>,
    pub message_preview: Option<String>,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub cost: f64,
    pub tools_called: Option<String>,
    pub created_at: String,
}

#[derive(Clone)]
pub struct IdentityRegistry {
    db: TelemetryDb,
}

#[allow(dead_code)]
impl IdentityRegistry {
    pub fn new(db: TelemetryDb) -> Self {
        Self { db }
    }

    /// Resolve an external identity to an internal user.
    /// If not found, auto-register a new user.
    pub async fn resolve_or_register(
        &self,
        platform: &str,
        external_id: &str,
        display_name: &str,
    ) -> Result<ResolvedIdentity, String> {
        if let Some(user) = self.resolve(platform, external_id).await? {
            return Ok(ResolvedIdentity {
                uid: user.uid,
                display_name: user.display_name,
                role: user.role,
                is_new: false,
            });
        }

        let uid = format!("u_{}", uuid::Uuid::new_v4().simple());
        let conn = self.db.conn().await;

        conn.execute(
            "INSERT INTO users (uid, display_name) VALUES (?1, ?2)",
            libsql::params![uid.clone(), display_name.to_string()],
        )
        .await
        .map_err(|e| format!("Failed to create user: {}", e))?;

        conn.execute(
            "INSERT INTO identity_mappings (platform, external_id, uid, display_name) VALUES (?1, ?2, ?3, ?4)",
            libsql::params![
                platform.to_string(),
                external_id.to_string(),
                uid.clone(),
                display_name.to_string()
            ],
        )
        .await
        .map_err(|e| format!("Failed to create identity mapping: {}", e))?;

        Ok(ResolvedIdentity {
            uid,
            display_name: display_name.to_string(),
            role: None,
            is_new: true,
        })
    }

    /// Look up an external identity without auto-registering.
    pub async fn resolve(
        &self,
        platform: &str,
        external_id: &str,
    ) -> Result<Option<InternalUser>, String> {
        let conn = self.db.conn().await;
        let mut rows = conn
            .query(
                "SELECT u.uid, u.display_name, u.role, u.created_at
                 FROM identity_mappings m
                 JOIN users u ON m.uid = u.uid
                 WHERE m.platform = ?1 AND m.external_id = ?2",
                libsql::params![platform.to_string(), external_id.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query identity: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read row: {}", e))?
        {
            Ok(Some(InternalUser {
                uid: row.get::<String>(0).unwrap_or_default(),
                display_name: row.get::<String>(1).unwrap_or_default(),
                role: row.get::<String>(2).ok(),
                created_at: row.get::<String>(3).unwrap_or_default(),
            }))
        } else {
            Ok(None)
        }
    }

    /// Bind an additional external identity to an existing internal user.
    pub async fn bind(
        &self,
        platform: &str,
        external_id: &str,
        uid: &str,
        display_name: &str,
    ) -> Result<(), String> {
        let conn = self.db.conn().await;
        conn.execute(
            "INSERT OR REPLACE INTO identity_mappings (platform, external_id, uid, display_name) VALUES (?1, ?2, ?3, ?4)",
            libsql::params![
                platform.to_string(),
                external_id.to_string(),
                uid.to_string(),
                display_name.to_string()
            ],
        )
        .await
        .map_err(|e| format!("Failed to bind identity: {}", e))?;
        Ok(())
    }

    /// List all registered internal users.
    pub async fn list_users(&self) -> Result<Vec<InternalUser>, String> {
        let conn = self.db.conn().await;
        let mut rows = conn
            .query(
                "SELECT uid, display_name, role, created_at FROM users ORDER BY created_at DESC",
                (),
            )
            .await
            .map_err(|e| format!("Failed to list users: {}", e))?;

        let mut users = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read row: {}", e))?
        {
            users.push(InternalUser {
                uid: row.get::<String>(0).unwrap_or_default(),
                display_name: row.get::<String>(1).unwrap_or_default(),
                role: row.get::<String>(2).ok(),
                created_at: row.get::<String>(3).unwrap_or_default(),
            });
        }
        Ok(users)
    }

    /// Get all identity mappings for a given internal user.
    pub async fn get_mappings_for_user(
        &self,
        uid: &str,
    ) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.db.conn().await;
        let mut rows = conn
            .query(
                "SELECT platform, external_id, display_name FROM identity_mappings WHERE uid = ?1",
                libsql::params![uid.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query mappings: {}", e))?;

        let mut mappings = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read row: {}", e))?
        {
            mappings.push((
                row.get::<String>(0).unwrap_or_default(),
                row.get::<String>(1).unwrap_or_default(),
                row.get::<String>(2).unwrap_or_default(),
            ));
        }
        Ok(mappings)
    }

    /// Record an audit entry for a message sent through a gateway.
    pub async fn record_audit(
        &self,
        session_key: &str,
        uid: Option<&str>,
        platform: &str,
        external_id: &str,
        display_name: Option<&str>,
        message_preview: Option<&str>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let conn = self.db.conn().await;
        conn.execute(
            "INSERT INTO audit_entries (id, session_key, uid, platform, external_id, display_name, message_preview)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            libsql::params![
                id.clone(),
                session_key.to_string(),
                uid.unwrap_or("").to_string(),
                platform.to_string(),
                external_id.to_string(),
                display_name.unwrap_or("").to_string(),
                message_preview.unwrap_or("").to_string()
            ],
        )
        .await
        .map_err(|e| format!("Failed to record audit entry: {}", e))?;
        Ok(id)
    }

    /// Update token usage on an existing audit entry (called after LLM response).
    pub async fn update_audit_usage(
        &self,
        audit_id: &str,
        tokens_input: i64,
        tokens_output: i64,
        cost: f64,
        tools_called: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.db.conn().await;
        conn.execute(
            "UPDATE audit_entries SET tokens_input = ?1, tokens_output = ?2, cost = ?3, tools_called = ?4
             WHERE id = ?5",
            libsql::params![
                tokens_input,
                tokens_output,
                cost,
                tools_called.unwrap_or("").to_string(),
                audit_id.to_string()
            ],
        )
        .await
        .map_err(|e| format!("Failed to update audit usage: {}", e))?;
        Ok(())
    }

    /// Get aggregated usage stats per user.
    pub async fn get_usage_by_user(&self) -> Result<Vec<(String, String, i64, i64, f64, i64)>, String> {
        let conn = self.db.conn().await;
        let mut rows = conn
            .query(
                "SELECT a.uid, COALESCE(u.display_name, a.display_name, 'unknown'),
                        SUM(a.tokens_input), SUM(a.tokens_output), SUM(a.cost), COUNT(*)
                 FROM audit_entries a
                 LEFT JOIN users u ON a.uid = u.uid
                 WHERE a.uid IS NOT NULL AND a.uid != ''
                 GROUP BY a.uid
                 ORDER BY SUM(a.cost) DESC",
                (),
            )
            .await
            .map_err(|e| format!("Failed to query usage: {}", e))?;

        let mut results = Vec::new();
        while let Some(row) = rows.next().await.map_err(|e| format!("Row error: {}", e))? {
            results.push((
                row.get::<String>(0).unwrap_or_default(),
                row.get::<String>(1).unwrap_or_default(),
                row.get::<i64>(2).unwrap_or(0),
                row.get::<i64>(3).unwrap_or(0),
                row.get::<f64>(4).unwrap_or(0.0),
                row.get::<i64>(5).unwrap_or(0),
            ));
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::db::TelemetryDb;
    use tempfile::TempDir;

    async fn setup() -> (IdentityRegistry, TempDir) {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("test.db");
        let db = TelemetryDb::new(&db_path).await.unwrap();
        (IdentityRegistry::new(db), tmp)
    }

    #[tokio::test]
    async fn test_resolve_or_register_creates_new_user() {
        let (registry, _tmp) = setup().await;
        let result = registry
            .resolve_or_register("discord", "123", "Alice")
            .await
            .unwrap();
        assert!(result.is_new);
        assert_eq!(result.display_name, "Alice");
        assert!(result.uid.starts_with("u_"));
    }

    #[tokio::test]
    async fn test_resolve_returns_existing_user() {
        let (registry, _tmp) = setup().await;
        let first = registry
            .resolve_or_register("discord", "123", "Alice")
            .await
            .unwrap();
        let second = registry
            .resolve_or_register("discord", "123", "Alice")
            .await
            .unwrap();
        assert!(!second.is_new);
        assert_eq!(first.uid, second.uid);
    }

    #[tokio::test]
    async fn test_bind_multiple_platforms_to_same_user() {
        let (registry, _tmp) = setup().await;
        let user = registry
            .resolve_or_register("discord", "123", "Alice")
            .await
            .unwrap();

        registry
            .bind("feishu", "ou_abc", &user.uid, "Alice")
            .await
            .unwrap();

        let from_feishu = registry.resolve("feishu", "ou_abc").await.unwrap().unwrap();
        assert_eq!(from_feishu.uid, user.uid);
    }

    #[tokio::test]
    async fn test_list_users() {
        let (registry, _tmp) = setup().await;
        registry
            .resolve_or_register("discord", "1", "Alice")
            .await
            .unwrap();
        registry
            .resolve_or_register("feishu", "2", "Bob")
            .await
            .unwrap();

        let users = registry.list_users().await.unwrap();
        assert_eq!(users.len(), 2);
    }

    #[tokio::test]
    async fn test_audit_recording() {
        let (registry, _tmp) = setup().await;
        let user = registry
            .resolve_or_register("discord", "123", "Alice")
            .await
            .unwrap();

        let audit_id = registry
            .record_audit(
                "discord:channel:guild:chan",
                Some(&user.uid),
                "discord",
                "123",
                Some("Alice"),
                Some("Hello world"),
            )
            .await
            .unwrap();

        registry
            .update_audit_usage(&audit_id, 100, 50, 0.01, Some("[\"bash\"]"))
            .await
            .unwrap();

        let usage = registry.get_usage_by_user().await.unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].0, user.uid); // uid
        assert_eq!(usage[0].2, 100);      // tokens_input
    }

    #[tokio::test]
    async fn test_get_mappings_for_user() {
        let (registry, _tmp) = setup().await;
        let user = registry
            .resolve_or_register("discord", "123", "Alice")
            .await
            .unwrap();
        registry
            .bind("feishu", "ou_abc", &user.uid, "Alice-feishu")
            .await
            .unwrap();

        let mappings = registry.get_mappings_for_user(&user.uid).await.unwrap();
        assert_eq!(mappings.len(), 2);
    }
}
