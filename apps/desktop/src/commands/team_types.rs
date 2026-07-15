use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MemberRole {
    Owner,
    Manager,
    #[default]
    #[serde(alias = "member")]
    Editor,
    Viewer,
    Seed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub node_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: MemberRole,
    #[serde(default)]
    pub shortcuts_role: Vec<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamManifest {
    pub owner_node_id: String,
    pub members: Vec<TeamMember>,
}
