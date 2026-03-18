use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, RwLock};

// ==================== Question Forwarding Types ====================

#[derive(Debug, Clone)]
pub struct QuestionInfo {
    pub question: String,
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone)]
pub struct QuestionOption {
    pub label: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ForwardedQuestion {
    pub question_id: String,
    pub questions: Vec<QuestionInfo>,
}

pub type QuestionForwarder = Box<
    dyn Fn(ForwardedQuestion) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// Bundles everything needed for question handling in SSE handlers.
pub struct QuestionContext {
    pub forwarder: QuestionForwarder,
    pub store: Arc<PendingQuestionStore>,
}

// ==================== Pending Question Store ====================

#[derive(Debug)]
pub struct PendingQuestionEntry {
    pub question_id: String,
    pub answer_tx: oneshot::Sender<String>,
    pub created_at: Instant,
}

/// Shared store mapping channel message IDs to pending question oneshot channels.
pub struct PendingQuestionStore {
    entries: RwLock<HashMap<String, PendingQuestionEntry>>,
}

const EXPIRY_SECS: u64 = 360; // 6 minutes (> 5 min timeout)

impl PendingQuestionStore {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, channel_msg_id: String, entry: PendingQuestionEntry) {
        let mut entries = self.entries.write().await;
        entries.retain(|_, e| e.created_at.elapsed() < Duration::from_secs(EXPIRY_SECS));
        entries.insert(channel_msg_id, entry);
    }

    pub async fn take(&self, channel_msg_id: &str) -> Option<PendingQuestionEntry> {
        self.entries.write().await.remove(channel_msg_id)
    }

    pub async fn take_by_question_id(&self, question_id: &str) -> Option<PendingQuestionEntry> {
        let mut entries = self.entries.write().await;
        let key = entries
            .iter()
            .find(|(_, e)| e.question_id == question_id)
            .map(|(k, _)| k.clone());
        key.and_then(|k| entries.remove(&k))
    }
}

// ==================== SSE Event Parsing ====================

pub fn parse_question_event(event: &serde_json::Value) -> Vec<QuestionInfo> {
    event.get("properties")
        .and_then(|p| p.get("questions"))
        .and_then(|q| q.as_array())
        .map(|arr| arr.iter().map(|q| {
            let question = q.get("question")
                .and_then(|v| v.as_str())
                .unwrap_or("").to_string();
            let options = q.get("options")
                .and_then(|o| o.as_array())
                .map(|opts| opts.iter().map(|o| QuestionOption {
                    label: o.get("label").and_then(|l| l.as_str())
                        .or_else(|| o.get("value").and_then(|v| v.as_str()))
                        .unwrap_or("").to_string(),
                    value: o.get("value").and_then(|v| v.as_str()).map(|s| s.to_string()),
                }).collect())
                .unwrap_or_default();
            QuestionInfo { question, options }
        }).collect())
        .unwrap_or_default()
}

// ==================== Formatting ====================

pub fn format_question_message(questions: &[QuestionInfo], question_id: &str) -> String {
    let mut out = String::from("AI has a question:\n\n");

    for (i, q) in questions.iter().enumerate() {
        if questions.len() > 1 {
            out.push_str(&format!("**Question {}:** ", i + 1));
        }
        out.push_str(&q.question);
        out.push('\n');

        if !q.options.is_empty() {
            out.push('\n');
            for (j, opt) in q.options.iter().enumerate() {
                out.push_str(&format!("{}. {}\n", j + 1, opt.label));
            }
        }
        out.push('\n');
    }

    out.push_str("(Reply to this message with your answer. Auto-reject in 5 min)\n");
    out.push_str(&format!("[Q:{}]", question_id));
    out
}

pub fn resolve_answer(reply_text: &str, questions: &[QuestionInfo]) -> Vec<Vec<String>> {
    let trimmed = reply_text.trim();
    questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            if i > 0 {
                return vec![];
            }
            if q.options.is_empty() {
                return vec![trimmed.to_string()];
            }
            if let Ok(num) = trimmed.parse::<usize>() {
                if num >= 1 && num <= q.options.len() {
                    let opt = &q.options[num - 1];
                    let value = opt.value.clone().unwrap_or_else(|| opt.label.clone());
                    return vec![value];
                }
            }
            vec![trimmed.to_string()]
        })
        .collect()
}

pub fn extract_question_marker(text: &str) -> Option<&str> {
    let start = text.find("[Q:")?;
    let rest = &text[start + 3..];
    let end = rest.find(']')?;
    Some(&rest[..end])
}
