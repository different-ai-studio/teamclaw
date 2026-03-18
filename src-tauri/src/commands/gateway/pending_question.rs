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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_insert_and_take() {
        let store = PendingQuestionStore::new();
        let (tx, _rx) = oneshot::channel();
        store.insert("msg_123".to_string(), PendingQuestionEntry {
            question_id: "q_abc".to_string(),
            answer_tx: tx,
            created_at: Instant::now(),
        }).await;
        let entry = store.take("msg_123").await;
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().question_id, "q_abc");
        assert!(store.take("msg_123").await.is_none());
    }

    #[tokio::test]
    async fn test_take_nonexistent() {
        let store = PendingQuestionStore::new();
        assert!(store.take("nope").await.is_none());
    }

    #[tokio::test]
    async fn test_take_by_question_id() {
        let store = PendingQuestionStore::new();
        let (tx, _rx) = oneshot::channel();
        store.insert("msg_456".to_string(), PendingQuestionEntry {
            question_id: "q_xyz".to_string(),
            answer_tx: tx,
            created_at: Instant::now(),
        }).await;
        let entry = store.take_by_question_id("q_xyz").await;
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().question_id, "q_xyz");
        assert!(store.take("msg_456").await.is_none());
    }

    #[tokio::test]
    async fn test_expired_cleanup_on_insert() {
        let store = PendingQuestionStore::new();
        let (tx, _rx) = oneshot::channel();
        let expired_time = Instant::now().checked_sub(Duration::from_secs(400))
            .unwrap_or_else(Instant::now);
        store.insert("old".to_string(), PendingQuestionEntry {
            question_id: "q_old".to_string(),
            answer_tx: tx,
            created_at: expired_time,
        }).await;
        let (tx2, _rx2) = oneshot::channel();
        store.insert("new".to_string(), PendingQuestionEntry {
            question_id: "q_new".to_string(),
            answer_tx: tx2,
            created_at: Instant::now(),
        }).await;
        assert!(store.take("old").await.is_none());
        assert!(store.take("new").await.is_some());
    }

    #[tokio::test]
    async fn test_concurrent_insert_take() {
        let store = Arc::new(PendingQuestionStore::new());
        let store2 = Arc::clone(&store);
        let (tx, rx) = oneshot::channel();
        store.insert("msg_concurrent".to_string(), PendingQuestionEntry {
            question_id: "q_concurrent".to_string(),
            answer_tx: tx,
            created_at: Instant::now(),
        }).await;
        let handle = tokio::spawn(async move {
            store2.take("msg_concurrent").await
        });
        let entry = handle.await.unwrap();
        assert!(entry.is_some());
        let entry = entry.unwrap();
        let _ = entry.answer_tx.send("answer".to_string());
        assert_eq!(rx.await.unwrap(), "answer");
    }

    #[test]
    fn test_format_question_with_options() {
        let questions = vec![QuestionInfo {
            question: "Continue with the refactor?".to_string(),
            options: vec![
                QuestionOption { label: "Yes".to_string(), value: Some("yes".to_string()) },
                QuestionOption { label: "No".to_string(), value: Some("no".to_string()) },
            ],
        }];
        let msg = format_question_message(&questions, "q_123");
        assert!(msg.contains("Continue with the refactor?"));
        assert!(msg.contains("1. Yes"));
        assert!(msg.contains("2. No"));
        assert!(msg.contains("[Q:q_123]"));
        assert!(msg.contains("Auto-reject in 5 min"));
    }

    #[test]
    fn test_format_question_open_ended() {
        let questions = vec![QuestionInfo {
            question: "What should I name this variable?".to_string(),
            options: vec![],
        }];
        let msg = format_question_message(&questions, "q_456");
        assert!(msg.contains("What should I name this variable?"));
        assert!(!msg.contains("1."));
        assert!(msg.contains("[Q:q_456]"));
    }

    #[test]
    fn test_format_question_multiple() {
        let questions = vec![
            QuestionInfo { question: "First?".to_string(), options: vec![] },
            QuestionInfo { question: "Second?".to_string(), options: vec![] },
        ];
        let msg = format_question_message(&questions, "q_multi");
        assert!(msg.contains("**Question 1:**"));
        assert!(msg.contains("**Question 2:**"));
    }

    #[test]
    fn test_resolve_answer_with_options() {
        let questions = vec![QuestionInfo {
            question: "Pick one".to_string(),
            options: vec![
                QuestionOption { label: "A".to_string(), value: Some("a_val".to_string()) },
                QuestionOption { label: "B".to_string(), value: None },
            ],
        }];
        assert_eq!(resolve_answer("1", &questions), vec![vec!["a_val".to_string()]]);
        assert_eq!(resolve_answer("2", &questions), vec![vec!["B".to_string()]]);
        assert_eq!(resolve_answer("3", &questions), vec![vec!["3".to_string()]]);
        assert_eq!(resolve_answer("hello", &questions), vec![vec!["hello".to_string()]]);
    }

    #[test]
    fn test_resolve_answer_open_ended() {
        let questions = vec![QuestionInfo {
            question: "What?".to_string(),
            options: vec![],
        }];
        assert_eq!(resolve_answer("my answer", &questions), vec![vec!["my answer".to_string()]]);
    }

    #[test]
    fn test_resolve_answer_multiple_questions() {
        let questions = vec![
            QuestionInfo { question: "First?".to_string(), options: vec![] },
            QuestionInfo { question: "Second?".to_string(), options: vec![] },
        ];
        let result = resolve_answer("my answer", &questions);
        assert_eq!(result, vec![vec!["my answer".to_string()], vec![]]);
    }

    #[test]
    fn test_extract_question_marker() {
        assert_eq!(extract_question_marker("blah [Q:abc123] end"), Some("abc123"));
        assert_eq!(extract_question_marker("no marker here"), None);
        assert_eq!(extract_question_marker("[Q:]"), Some(""));
    }

    #[test]
    fn test_parse_question_event() {
        let event = serde_json::json!({
            "properties": {
                "questions": [{
                    "question": "Continue?",
                    "options": [
                        { "label": "Yes", "value": "yes" },
                        { "label": "No", "value": "no" }
                    ]
                }]
            }
        });
        let questions = parse_question_event(&event);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Continue?");
        assert_eq!(questions[0].options.len(), 2);
        assert_eq!(questions[0].options[0].label, "Yes");
        assert_eq!(questions[0].options[0].value, Some("yes".to_string()));
    }

    #[test]
    fn test_parse_question_event_empty() {
        let event = serde_json::json!({ "properties": {} });
        assert!(parse_question_event(&event).is_empty());
    }
}
