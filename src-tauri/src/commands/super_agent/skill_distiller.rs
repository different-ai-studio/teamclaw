use super::types::{DistilledSkill, Strategy, now_millis};

// ─── SkillDistiller ───────────────────────────────────────────────────────────

/// Pure string-formatting unit that converts a validated `Strategy` into a
/// `DistilledSkill` containing a SKILL.md document ready for publication.
pub struct SkillDistiller;

impl SkillDistiller {
    /// Generate a `DistilledSkill` from a validated `Strategy`.
    ///
    /// * `name` — `"{domain}-{first_tag}"` or `"{domain}-general"` when the
    ///   strategy has no tags.
    /// * `skill_content` — a SKILL.md with YAML front-matter followed by
    ///   Markdown sections (Trigger Condition, Recommendation, Reasoning,
    ///   Evidence).
    /// * `source_strategy_id` — copied from `strategy.id`.
    /// * `adoption_count` — initialised to `0`.
    /// * `avg_effectiveness` — taken from `strategy.confidence_interval`.
    pub fn distill(strategy: &Strategy) -> DistilledSkill {
        let tag_suffix = strategy
            .tags
            .first()
            .cloned()
            .unwrap_or_else(|| "general".to_string());
        let name = format!("{}-{}", strategy.domain, tag_suffix);

        let contributors = strategy.contributing_agents.join(", ");
        let skill_content = format!(
            r#"---
name: {name}
description: "{condition}"
source: collective-learning
confidence: {confidence:.4}
sample_size: {sample_size}
contributors: [{contributors}]
---

## Trigger Condition

{condition}

## Recommendation

{recommendation}

## Reasoning

{reasoning}

## Evidence

- **Sample size**: {sample_size} experiences
- **Contributing agents**: {contributing_agents_count}
- **Source strategy**: `{strategy_id}`
"#,
            name = name,
            condition = strategy.condition,
            confidence = strategy.confidence_interval,
            sample_size = strategy.sample_size,
            contributors = contributors,
            recommendation = strategy.recommendation,
            reasoning = strategy.reasoning,
            contributing_agents_count = strategy.contributing_agents.len(),
            strategy_id = strategy.id,
        );

        DistilledSkill {
            id: nanoid::nanoid!(),
            name,
            source_strategy_id: strategy.id.clone(),
            skill_content,
            adoption_count: 0,
            avg_effectiveness: strategy.confidence_interval,
            created_at: now_millis(),
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::super_agent::types::{
        StrategyType, StrategyValidation, ValidationStatus,
    };

    fn make_strategy(domain: &str, tags: Vec<String>) -> Strategy {
        let now = now_millis();
        Strategy {
            id: nanoid::nanoid!(),
            domain: domain.to_string(),
            tags,
            strategy_type: StrategyType::Recommend,
            condition: "When working in a complex async environment".to_string(),
            recommendation: "Prefer structured concurrency patterns".to_string(),
            reasoning: "Avoids race conditions and simplifies error propagation".to_string(),
            source_experiences: vec!["exp-1".to_string(), "exp-2".to_string()],
            success_rate: 0.85,
            sample_size: 10,
            contributing_agents: vec!["agent-a".to_string(), "agent-b".to_string()],
            confidence_interval: 0.82,
            validation: StrategyValidation {
                status: ValidationStatus::Validated,
                validated_by: vec!["node-x".to_string(), "node-y".to_string()],
                validation_score: 0.91,
            },
            created_at: now,
            updated_at: now,
        }
    }

    // 1. Generated SKILL.md has `---` frontmatter delimiters, `name:`, and
    //    `source: collective-learning`.
    #[test]
    fn generates_valid_skill_md() {
        let strategy = make_strategy("backend", vec!["rust".to_string()]);
        let skill = SkillDistiller::distill(&strategy);

        assert!(
            skill.skill_content.starts_with("---"),
            "skill_content should start with '---' (YAML front-matter)"
        );
        assert!(
            skill.skill_content.contains("name:"),
            "skill_content should contain 'name:'"
        );
        assert!(
            skill.skill_content.contains("source: collective-learning"),
            "skill_content should contain 'source: collective-learning'"
        );
    }

    // 2. Skill name is composed of domain + first tag.
    #[test]
    fn skill_name_from_domain_and_tags() {
        let strategy = make_strategy("frontend", vec!["react".to_string(), "typescript".to_string()]);
        let skill = SkillDistiller::distill(&strategy);

        assert!(
            skill.name.contains("frontend"),
            "skill name should contain the domain 'frontend', got: {}",
            skill.name
        );
        assert_eq!(
            skill.name, "frontend-react",
            "skill name should be 'domain-first_tag'"
        );
    }

    // 3. Skill content has YAML front-matter block and all required Markdown
    //    section headers.
    #[test]
    fn skill_has_frontmatter_and_sections() {
        let strategy = make_strategy("devops", vec!["kubernetes".to_string()]);
        let skill = SkillDistiller::distill(&strategy);

        // Front-matter: opening and closing `---`
        let dashes_count = skill.skill_content.matches("---").count();
        assert!(
            dashes_count >= 2,
            "Expected at least two '---' delimiters for front-matter, found {}",
            dashes_count
        );

        assert!(
            skill.skill_content.contains("## Trigger Condition"),
            "skill_content must have a '## Trigger Condition' section"
        );
        assert!(
            skill.skill_content.contains("## Recommendation"),
            "skill_content must have a '## Recommendation' section"
        );
        assert!(
            skill.skill_content.contains("## Reasoning"),
            "skill_content must have a '## Reasoning' section"
        );
    }

    // 4. source_strategy_id on the distilled skill matches the originating
    //    strategy's id.
    #[test]
    fn distilled_skill_references_strategy() {
        let strategy = make_strategy("ml", vec!["pytorch".to_string()]);
        let strategy_id = strategy.id.clone();
        let skill = SkillDistiller::distill(&strategy);

        assert_eq!(
            skill.source_strategy_id, strategy_id,
            "source_strategy_id must equal the originating strategy id"
        );
    }
}
