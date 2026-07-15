use anyhow::{bail, Context, Result};
use tree_sitter::{Language, Parser, Query, QueryCursor, StreamingIterator};

/// Code chunk with metadata
#[derive(Debug, Clone)]
pub struct CodeChunk {
    pub content: String,
    pub chunk_type: String, // "function" | "class" | "struct" | "impl" | "module"
    pub name: String,       // Function/class/struct name
    #[allow(dead_code)]
    pub start_line: usize,
    #[allow(dead_code)]
    pub end_line: usize,
}

/// Chunk code by parsing with tree-sitter
pub fn chunk_code(language: &str, source: &str) -> Result<Vec<CodeChunk>> {
    match language.to_lowercase().as_str() {
        "rs" | "rust" => chunk_rust(source),
        "ts" | "tsx" | "typescript" => chunk_typescript(source, language == "tsx"),
        "py" | "python" => chunk_python(source),
        "go" => chunk_go(source),
        other => {
            bail!("Unsupported language for code chunking: {}", other);
        }
    }
}

/// Chunk Rust code
fn chunk_rust(source: &str) -> Result<Vec<CodeChunk>> {
    let mut parser = Parser::new();
    let language = tree_sitter_rust::LANGUAGE;
    parser
        .set_language(&language.into())
        .context("Failed to set Rust language")?;

    let tree = parser
        .parse(source, None)
        .context("Failed to parse Rust code")?;

    let query_source = r#"
        (function_item
            name: (identifier) @name) @function

        (struct_item
            name: (type_identifier) @name) @struct

        (impl_item
            type: (type_identifier) @name) @impl
    "#;

    let query =
        Query::new(&language.into(), query_source).context("Failed to create Rust query")?;

    extract_chunks(source, &tree, &query, &language.into())
}

/// Chunk TypeScript/TSX code
fn chunk_typescript(source: &str, is_tsx: bool) -> Result<Vec<CodeChunk>> {
    let mut parser = Parser::new();
    let language = if is_tsx {
        tree_sitter_typescript::LANGUAGE_TSX
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT
    };

    parser
        .set_language(&language.into())
        .context("Failed to set TypeScript language")?;

    let tree = parser
        .parse(source, None)
        .context("Failed to parse TypeScript code")?;

    let query_source = r#"
        (function_declaration
            name: (identifier) @name) @function

        (class_declaration
            name: (type_identifier) @name) @class

        (interface_declaration
            name: (type_identifier) @name) @interface

        (method_definition
            name: (property_identifier) @name) @method
    "#;

    let query =
        Query::new(&language.into(), query_source).context("Failed to create TypeScript query")?;

    extract_chunks(source, &tree, &query, &language.into())
}

/// Chunk Python code
fn chunk_python(source: &str) -> Result<Vec<CodeChunk>> {
    let mut parser = Parser::new();
    let language = tree_sitter_python::LANGUAGE;
    parser
        .set_language(&language.into())
        .context("Failed to set Python language")?;

    let tree = parser
        .parse(source, None)
        .context("Failed to parse Python code")?;

    let query_source = r#"
        (function_definition
            name: (identifier) @name) @function

        (class_definition
            name: (identifier) @name) @class
    "#;

    let query =
        Query::new(&language.into(), query_source).context("Failed to create Python query")?;

    extract_chunks(source, &tree, &query, &language.into())
}

/// Chunk Go code
fn chunk_go(source: &str) -> Result<Vec<CodeChunk>> {
    let mut parser = Parser::new();
    let language = tree_sitter_go::LANGUAGE;
    parser
        .set_language(&language.into())
        .context("Failed to set Go language")?;

    let tree = parser
        .parse(source, None)
        .context("Failed to parse Go code")?;

    let query_source = r#"
        (function_declaration
            name: (identifier) @name) @function

        (method_declaration
            name: (field_identifier) @name) @method

        (type_declaration
            (type_spec
                name: (type_identifier) @name
                type: (struct_type))) @struct

        (type_declaration
            (type_spec
                name: (type_identifier) @name
                type: (interface_type))) @interface
    "#;

    let query = Query::new(&language.into(), query_source).context("Failed to create Go query")?;

    extract_chunks(source, &tree, &query, &language.into())
}

/// Extract chunks from tree-sitter query matches
fn extract_chunks(
    source: &str,
    tree: &tree_sitter::Tree,
    query: &Query,
    _language: &Language,
) -> Result<Vec<CodeChunk>> {
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, tree.root_node(), source.as_bytes());

    let mut chunks = Vec::new();
    let capture_names = query.capture_names();

    while let Some(match_) = matches.next() {
        let mut chunk_type = String::new();
        let mut name = String::new();
        let mut start_byte = 0;
        let mut end_byte = 0;

        for capture in match_.captures {
            let capture_name = &capture_names[capture.index as usize];
            let node = capture.node;

            match *capture_name {
                "function" | "class" | "struct" | "impl" | "interface" | "method" => {
                    chunk_type = capture_name.to_string();
                    start_byte = node.start_byte();
                    end_byte = node.end_byte();
                }
                "name" => {
                    name = node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                }
                _ => {}
            }
        }

        if !chunk_type.is_empty() && start_byte < end_byte {
            let content = &source[start_byte..end_byte];
            // Calculate 1-indexed line numbers (lines().count() returns 0 for first line)
            let start_line = source[..start_byte].lines().count() + 1;
            let end_line = source[..end_byte].lines().count() + 1;

            chunks.push(CodeChunk {
                content: content.to_string(),
                chunk_type,
                name: if name.is_empty() {
                    format!("anonymous_{}", start_line)
                } else {
                    name
                },
                start_line,
                end_line,
            });
        }
    }

    // If no chunks found, treat the whole file as one chunk
    if chunks.is_empty() {
        chunks.push(CodeChunk {
            content: source.to_string(),
            chunk_type: "module".to_string(),
            name: "module".to_string(),
            start_line: 1,
            end_line: source.lines().count(),
        });
    }

    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_rust() {
        let source = r#"
fn hello() {
    println!("Hello, world!");
}

struct Point {
    x: i32,
    y: i32,
}

impl Point {
    fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }
}
"#;
        let chunks = chunk_rust(source).unwrap();
        assert!(!chunks.is_empty());

        // Should find function, struct, and impl
        let types: Vec<&str> = chunks.iter().map(|c| c.chunk_type.as_str()).collect();
        assert!(types.contains(&"function"));
        assert!(types.contains(&"struct"));
        assert!(types.contains(&"impl"));
    }

    #[test]
    fn test_chunk_typescript() {
        let source = r#"
function greet(name: string) {
    console.log(`Hello, ${name}!`);
}

class Person {
    constructor(public name: string) {}
    
    sayHello() {
        console.log(`Hello, I'm ${this.name}`);
    }
}

interface User {
    id: number;
    name: string;
}
"#;
        let chunks = chunk_typescript(source, false).unwrap();
        assert!(!chunks.is_empty());

        let types: Vec<&str> = chunks.iter().map(|c| c.chunk_type.as_str()).collect();
        assert!(types.contains(&"function"));
        assert!(types.contains(&"class"));
    }

    #[test]
    fn test_chunk_python() {
        let source = r#"
def greet(name):
    print(f"Hello, {name}!")

class Person:
    def __init__(self, name):
        self.name = name
    
    def say_hello(self):
        print(f"Hello, I'm {self.name}")
"#;
        let chunks = chunk_python(source).unwrap();
        assert!(!chunks.is_empty());

        let types: Vec<&str> = chunks.iter().map(|c| c.chunk_type.as_str()).collect();
        assert!(types.contains(&"function"));
        assert!(types.contains(&"class"));
    }

    #[test]
    fn test_chunk_go() {
        let source = r#"
package main

import "fmt"

func greet(name string) {
    fmt.Printf("Hello, %s!\n", name)
}

type Point struct {
    X int
    Y int
}

func (p *Point) Distance() float64 {
    return math.Sqrt(float64(p.X*p.X + p.Y*p.Y))
}

type Reader interface {
    Read(p []byte) (n int, err error)
}
"#;
        let chunks = chunk_go(source).unwrap();
        assert!(!chunks.is_empty());

        let types: Vec<&str> = chunks.iter().map(|c| c.chunk_type.as_str()).collect();
        assert!(types.contains(&"function"));
        assert!(types.contains(&"struct"));
        assert!(types.contains(&"method"));
        assert!(types.contains(&"interface"));
    }

    #[test]
    fn test_empty_file() {
        let source = "";
        let chunks = chunk_rust(source).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chunk_type, "module");
    }
}
