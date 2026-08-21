import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import {
  areAnswersComplete,
  buildQuestionAnswers,
  type PendingAcpQuestion,
} from "../pending-questions";

/**
 * The composer replacement shown while an opencode `question` tool request is
 * unanswered. Ported from the iOS `AcpQuestionCard`: one page per question,
 * numbered options (single- or multi-select), a free-text override, Skip, and
 * a Continue/Submit that only fires once every question has an answer.
 */

export type AcpQuestionCardProps = {
  pending: PendingAcpQuestion;
  isSubmitting?: boolean;
  errorMessage?: string | null;
  onSkip: () => void;
  onSubmit: (answers: string[][]) => void;
};

export function AcpQuestionCard({
  errorMessage,
  isSubmitting = false,
  onSkip,
  onSubmit,
  pending,
}: AcpQuestionCardProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  const prompt = pending.questions[Math.min(page, pending.questions.length - 1)];
  const isLastPage = page >= pending.questions.length - 1;
  const typed = (custom[prompt.id] ?? "").trim();
  const currentAnswers = typed ? [typed] : selected[prompt.id] ?? [];
  const canContinue = !isSubmitting && currentAnswers.length > 0;

  const toggle = (label: string) => {
    // Picking an option clears a half-typed custom answer for that question:
    // the two are alternatives, and iOS resolves the conflict the same way.
    setCustom((prev) => ({ ...prev, [prompt.id]: "" }));
    setSelected((prev) => {
      const current = prev[prompt.id] ?? [];
      if (!prompt.allowsMultiple) return { ...prev, [prompt.id]: [label] };
      return {
        ...prev,
        [prompt.id]: current.includes(label)
          ? current.filter((entry) => entry !== label)
          : [...current, label],
      };
    });
  };

  const continueOrSubmit = () => {
    if (!canContinue) return;
    if (!isLastPage) {
      setPage(page + 1);
      return;
    }
    const answers = buildQuestionAnswers(pending.questions, selected, custom);
    if (!areAnswersComplete(answers)) {
      setLocalError(t("Answer each question before submitting."));
      return;
    }
    setLocalError(null);
    onSubmit(answers);
  };

  const shownError = errorMessage ?? localError;

  return (
    <View style={styles.card} testID="session.questionCard">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{prompt.header || t("Question")}</Text>
        {pending.questions.length > 1 ? (
          <View style={styles.pager}>
            <Pressable
              accessibilityLabel={t("Previous question")}
              accessibilityRole="button"
              disabled={page === 0 || isSubmitting}
              hitSlop={6}
              onPress={() => setPage(Math.max(0, page - 1))}
            >
              <Ionicons
                color={page === 0 ? colors.slate : colors.basalt}
                name="chevron-back"
                size={16}
              />
            </Pressable>
            <Text style={styles.pagerLabel}>
              {t("{{current}} of {{total}}", { current: page + 1, total: pending.questions.length })}
            </Text>
            <Pressable
              accessibilityLabel={t("Next question")}
              accessibilityRole="button"
              disabled={isLastPage || isSubmitting}
              hitSlop={6}
              onPress={() => setPage(Math.min(pending.questions.length - 1, page + 1))}
            >
              <Ionicons
                color={isLastPage ? colors.slate : colors.basalt}
                name="chevron-forward"
                size={16}
              />
            </Pressable>
          </View>
        ) : null}
      </View>

      <Text style={styles.question}>{prompt.question}</Text>

      {prompt.options.length > 0 ? (
        <ScrollView style={styles.options}>
          {prompt.options.map((option, index) => {
            const isSelected = (selected[prompt.id] ?? []).includes(option.label);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                disabled={isSubmitting}
                key={option.label}
                onPress={() => toggle(option.label)}
                style={[styles.option, isSelected ? styles.optionSelected : null]}
              >
                <Text style={styles.optionIndex}>{index + 1}.</Text>
                <View style={styles.optionBody}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {option.description ? (
                    <Text style={styles.optionDescription}>{option.description}</Text>
                  ) : null}
                </View>
                {isSelected ? (
                  <Ionicons color={hai.cinnabar} name="checkmark" size={16} />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <View style={styles.footer}>
        <TextInput
          editable={!isSubmitting}
          onChangeText={(value) => setCustom((prev) => ({ ...prev, [prompt.id]: value }))}
          placeholder={
            prompt.options.length === 0 ? t("Type your answer…") : t("Or type a custom answer…")
          }
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.input}
          value={custom[prompt.id] ?? ""}
        />
        <Pressable
          accessibilityRole="button"
          disabled={isSubmitting}
          hitSlop={6}
          onPress={onSkip}
        >
          <Text style={styles.skip}>{t("Skip")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!canContinue}
          onPress={continueOrSubmit}
          style={[styles.submit, canContinue ? null : styles.submitDisabled]}
        >
          <Text style={styles.submitText}>{isLastPage ? t("Submit") : t("Continue")}</Text>
        </Pressable>
      </View>

      {shownError ? <Text style={styles.error}>{shownError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.panel,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    margin: spacing.md,
    padding: spacing.md,
  },
  error: {
    color: hai.cinnabarDeep,
    ...typography.caption,
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  input: {
    color: colors.onyx,
    flex: 1,
    ...typography.secondaryBody,
  },
  option: {
    alignItems: "center",
    borderRadius: radii.input,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  optionBody: {
    flex: 1,
    gap: 2,
  },
  optionDescription: {
    color: colors.slate,
    ...typography.caption,
  },
  optionIndex: {
    color: colors.slate,
    width: 22,
    ...typography.caption,
    fontWeight: "600",
  },
  optionLabel: {
    color: colors.onyx,
    ...typography.secondaryBody,
    fontWeight: "600",
  },
  optionSelected: {
    backgroundColor: hai.pebble,
  },
  options: {
    maxHeight: 220,
  },
  pager: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  pagerLabel: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  question: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  skip: {
    color: colors.slate,
    ...typography.caption,
    fontWeight: "500",
  },
  submit: {
    backgroundColor: hai.onyx,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  submitDisabled: {
    opacity: 0.35,
  },
  submitText: {
    color: hai.paper,
    ...typography.caption,
    fontWeight: "600",
  },
});

export default AcpQuestionCard;
