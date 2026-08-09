use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};

#[derive(Debug, Clone)]
pub struct Chunk {
    pub content: String,
    pub chunk_index: i32,
    pub heading: Option<String>,
    pub chunk_type: Option<String>,
    pub name: Option<String>,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
}

/// Chunk a Markdown document by heading structure
pub fn chunk_markdown(text: &str, chunk_size: usize, chunk_overlap: usize) -> Vec<Chunk> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let sections = split_by_headings(text);

    let mut chunks = Vec::new();
    let mut chunk_index = 0i32;

    for section in &sections {
        let section_chunks = split_section_into_chunks(&section.content, chunk_size, chunk_overlap);
        for chunk_content in section_chunks {
            if !chunk_content.trim().is_empty() {
                chunks.push(Chunk {
                    content: chunk_content,
                    chunk_index,
                    heading: section.heading.clone(),
                    chunk_type: None,
                    name: None,
                    start_line: None,
                    end_line: None,
                });
                chunk_index += 1;
            }
        }
    }

    // If no chunks were produced (e.g., all whitespace sections), create one from the whole text
    if chunks.is_empty() && !text.trim().is_empty() {
        chunks.push(Chunk {
            content: text.trim().to_string(),
            chunk_index: 0,
            heading: None,
            chunk_type: None,
            name: None,
            start_line: None,
            end_line: None,
        });
    }

    chunks
}

/// Chunk a plain text document by paragraph boundaries
pub fn chunk_plain_text(text: &str, chunk_size: usize, chunk_overlap: usize) -> Vec<Chunk> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let section_chunks = split_section_into_chunks(text, chunk_size, chunk_overlap);

    let mut chunks = Vec::new();
    for (i, content) in section_chunks.into_iter().enumerate() {
        if !content.trim().is_empty() {
            chunks.push(Chunk {
                content,
                chunk_index: i as i32,
                heading: None,
                chunk_type: None,
                name: None,
                start_line: None,
                end_line: None,
            });
        }
    }

    if chunks.is_empty() && !text.trim().is_empty() {
        chunks.push(Chunk {
            content: text.trim().to_string(),
            chunk_index: 0,
            heading: None,
            chunk_type: None,
            name: None,
            start_line: None,
            end_line: None,
        });
    }

    chunks
}

/// Extract the title (first H1 heading) from a Markdown document
pub fn extract_title(text: &str) -> Option<String> {
    let parser = Parser::new(text);
    let mut in_h1 = false;
    let mut title = String::new();

    for event in parser {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => {
                in_h1 = true;
            }
            Event::Text(text) if in_h1 => {
                title.push_str(&text);
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                if !title.is_empty() {
                    return Some(title.trim().to_string());
                }
                in_h1 = false;
            }
            _ => {}
        }
    }

    None
}

// --- Internal helpers ---

/// Find the nearest valid UTF-8 character boundary at or before the given byte position.
/// This is a stable alternative to the unstable `floor_char_boundary` method.
fn floor_char_boundary(s: &str, pos: usize) -> usize {
    if pos >= s.len() {
        return s.len();
    }

    // A byte is a valid char boundary if:
    // 1. It's at the start of the string (0)
    // 2. It's not a continuation byte (0x80-0xBF)
    // We check backwards from pos to find the nearest valid boundary
    let bytes = s.as_bytes();
    // Ensure we don't go beyond the string length
    let max_pos = pos.min(s.len().saturating_sub(1));
    for i in (0..=max_pos).rev() {
        if i == 0 || !is_continuation_byte(bytes[i]) {
            return i;
        }
    }

    // Fallback (should never reach here)
    0
}

/// Check if a byte is a UTF-8 continuation byte (0x80-0xBF)
fn is_continuation_byte(byte: u8) -> bool {
    (byte & 0xC0) == 0x80
}

struct Section {
    heading: Option<String>,
    content: String,
}

/// Split Markdown text into sections by ## headings
fn split_by_headings(text: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut current_heading: Option<String> = None;
    let mut current_content = String::new();

    let parser = Parser::new(text);
    let mut in_heading = false;
    let mut heading_level = HeadingLevel::H1;
    let mut heading_text = String::new();

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. })
                if level == HeadingLevel::H2 || level == HeadingLevel::H3 =>
            {
                // Save current section before starting new heading
                if !current_content.trim().is_empty() || current_heading.is_some() {
                    sections.push(Section {
                        heading: current_heading.take(),
                        content: current_content.trim().to_string(),
                    });
                    current_content.clear();
                }
                in_heading = true;
                heading_level = level;
                heading_text.clear();
            }
            Event::Text(t) if in_heading => {
                heading_text.push_str(&t);
            }
            Event::End(TagEnd::Heading(level))
                if in_heading && (level == HeadingLevel::H2 || level == HeadingLevel::H3) =>
            {
                current_heading = Some(heading_text.trim().to_string());
                in_heading = false;
                // Add the heading as text for embedding context
                let prefix = if heading_level == HeadingLevel::H2 {
                    "## "
                } else {
                    "### "
                };
                current_content.push_str(prefix);
                current_content.push_str(heading_text.trim());
                current_content.push('\n');
            }
            Event::Text(t) => {
                current_content.push_str(&t);
            }
            Event::SoftBreak | Event::HardBreak => {
                current_content.push('\n');
            }
            Event::Code(code) => {
                current_content.push('`');
                current_content.push_str(&code);
                current_content.push('`');
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                current_content.push_str("\n\n");
            }
            Event::Start(Tag::Item) => {
                current_content.push_str("- ");
            }
            Event::End(TagEnd::Item) => {
                current_content.push('\n');
            }
            Event::Start(Tag::CodeBlock(_)) => {
                current_content.push_str("```\n");
            }
            Event::End(TagEnd::CodeBlock) => {
                current_content.push_str("```\n\n");
            }
            _ => {}
        }
    }

    // Don't forget the last section
    if !current_content.trim().is_empty() || current_heading.is_some() {
        sections.push(Section {
            heading: current_heading,
            content: current_content.trim().to_string(),
        });
    }

    // If no sections found, treat the whole text as one section
    if sections.is_empty() {
        sections.push(Section {
            heading: None,
            content: text.trim().to_string(),
        });
    }

    sections
}

/// Split a section's text into chunks respecting paragraph boundaries
fn split_section_into_chunks(text: &str, chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }

    // If text fits in one chunk, return as-is
    if text.len() <= chunk_size {
        return vec![text.to_string()];
    }

    // Split into paragraphs
    let paragraphs: Vec<&str> = text.split("\n\n").collect();
    let mut chunks = Vec::new();
    let mut current_chunk = String::new();

    for para in &paragraphs {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }

        // If adding this paragraph exceeds chunk_size and we have content, start new chunk
        if !current_chunk.is_empty() && current_chunk.len() + para.len() + 2 > chunk_size {
            chunks.push(current_chunk.trim().to_string());

            // Start new chunk with overlap from end of previous
            let prev = chunks.last().unwrap().as_str();
            if prev.len() > chunk_overlap {
                // Find valid UTF-8 character boundary
                let start_pos = prev.len().saturating_sub(chunk_overlap);
                let safe_start = floor_char_boundary(prev, start_pos);
                current_chunk = prev[safe_start..].to_string();
                current_chunk.push_str("\n\n");
            } else {
                current_chunk = String::new();
            }
        }

        if !current_chunk.is_empty() {
            current_chunk.push_str("\n\n");
        }
        current_chunk.push_str(para);
    }

    // Don't forget the last chunk
    if !current_chunk.trim().is_empty() {
        chunks.push(current_chunk.trim().to_string());
    }

    // Handle very long paragraphs (longer than chunk_size) by splitting at word boundaries
    let mut final_chunks = Vec::new();
    for chunk in chunks {
        if chunk.len() <= chunk_size {
            final_chunks.push(chunk);
        } else {
            // Split long chunk at word boundaries
            let words: Vec<&str> = chunk.split_whitespace().collect();
            let mut sub_chunk = String::new();
            for word in words {
                if !sub_chunk.is_empty() && sub_chunk.len() + word.len() + 1 > chunk_size {
                    final_chunks.push(sub_chunk.trim().to_string());
                    // Overlap
                    let prev = final_chunks.last().unwrap().as_str();
                    if prev.len() > chunk_overlap {
                        // Find valid UTF-8 character boundary
                        let start_pos = prev.len().saturating_sub(chunk_overlap);
                        let safe_start = floor_char_boundary(prev, start_pos);
                        sub_chunk = prev[safe_start..].to_string();
                        sub_chunk.push(' ');
                    } else {
                        sub_chunk = String::new();
                    }
                }
                if !sub_chunk.is_empty() {
                    sub_chunk.push(' ');
                }
                sub_chunk.push_str(word);
            }
            if !sub_chunk.trim().is_empty() {
                final_chunks.push(sub_chunk.trim().to_string());
            }
        }
    }

    final_chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_markdown_simple() {
        let md = "# Title\n\nSome intro text.\n\n## Section 1\n\nContent of section 1.\n\n## Section 2\n\nContent of section 2.";
        let chunks = chunk_markdown(md, 800, 100);
        assert!(!chunks.is_empty());
        // Should have at least intro + 2 sections
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn test_chunk_markdown_empty() {
        let chunks = chunk_markdown("", 800, 100);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_chunk_markdown_no_headings() {
        let md = "Just a plain paragraph with no headings at all.";
        let chunks = chunk_markdown(md, 800, 100);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].heading.is_none());
    }

    #[test]
    fn test_chunk_plain_text() {
        let text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
        let chunks = chunk_plain_text(text, 800, 100);
        assert_eq!(chunks.len(), 1); // Small enough for one chunk
    }

    #[test]
    fn test_chunk_plain_text_empty() {
        let chunks = chunk_plain_text("", 800, 100);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_extract_title() {
        let md = "# My Document Title\n\nSome content.";
        assert_eq!(extract_title(md), Some("My Document Title".to_string()));
    }

    #[test]
    fn test_extract_title_none() {
        let md = "## Not an H1\n\nSome content.";
        assert_eq!(extract_title(md), None);
    }
}
