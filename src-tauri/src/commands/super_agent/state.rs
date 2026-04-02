use std::sync::Arc;
use tokio::sync::Mutex;

use super::registry::AgentRegistry;
use super::nerve::NerveChannel;
use super::blackboard::Blackboard;

pub struct SuperAgentNode {
    pub registry: AgentRegistry,
    pub nerve: NerveChannel,
    pub blackboard: Blackboard,
    pub local_node_id: String,
}

pub type SuperAgentState = Arc<Mutex<Option<SuperAgentNode>>>;
