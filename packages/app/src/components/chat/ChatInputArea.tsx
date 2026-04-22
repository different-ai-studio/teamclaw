import * as React from "react";
import { useTranslation } from 'react-i18next';
import { FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProviderStore, getSelectedModelOption } from "@/stores/provider";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  useInsertFileMention,
  useInsertSkillMention,
  type PromptInputMessage,
} from "@/packages/ai/prompt-input";
import { FileMentionPopover } from "./FileMentionPopover";
import { CommandPopover } from "./CommandPopover";
import type { Command as OpenCodeCommand } from "@/lib/opencode/sdk-client";
import { useTeamModeStore } from "@/stores/team-mode";
import {
  ModelSelector,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorLogo,
  ModelSelectorName,
} from "@/packages/ai/model-selector";
import { Button } from "@/components/ui/button";
import { FileInputButton } from "./FileInputButton";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { type QueuedMessage, useSessionStore } from "@/stores/session";
import { useVoiceInputStore } from "@/stores/voice-input";
import { useWorkspaceStore } from "@/stores/workspace";
import { useUIStore } from "@/stores/ui";
import { getFileName, getFileDisplayPath } from "./utils/fileUtils";
import { LocalImage } from "@/packages/ai/message";

// ─── Popover wrappers (need PromptInput context for useInsertFileMention) ───

function FileMentionPopoverWrapper({
  open,
  onOpenChange,
  searchQuery,
  onSearchChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}) {
  const insertFileMention = useInsertFileMention();

  return (
    <FileMentionPopover
      open={open}
      onOpenChange={onOpenChange}
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
      onSelect={insertFileMention}
    />
  );
}

function CommandPopoverWrapper({
  open,
  onOpenChange,
  searchQuery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchQuery: string;
}) {
  const insertSkillMention = useInsertSkillMention();

  const handleSelect = React.useCallback((command: OpenCodeCommand & { _type?: 'role' | 'skill' | 'command' }) => {
    console.log('[CommandPopoverWrapper] 🎯 handleSelect called, command:', command.name, 'type:', command._type);
    const type = command._type || 'skill'; // Default to skill for backward compatibility
    insertSkillMention(command.name, type);
    console.log('[CommandPopoverWrapper] ✅ insertSkillMention called');
    onOpenChange(false);
  }, [insertSkillMention, onOpenChange]);

  return (
    <CommandPopover
      open={open}
      onOpenChange={onOpenChange}
      searchQuery={searchQuery}
      onSelect={handleSelect}
    />
  );
}

// ─── Main input area ────────────────────────────────────────────────────────

interface ChatInputAreaProps {
  compact: boolean;
  inputValue: string;
  onInputChange: (v: string) => void;
  attachedFiles: string[];
  onFilesChange: (paths: string[]) => void;
  onRemoveFile: (index: number) => void;
  imageFiles: File[];
  onImageFilesChange: (files: File[]) => void;
  onRemoveImageFile: (index: number) => void;
  onSubmit: (message: PromptInputMessage) => void;
  isStreaming: boolean;
  onAbort: () => void;
  messageQueue: QueuedMessage[];
  onRemoveFromQueue: (id: string) => void;
  onHeightChange?: (height: number) => void;
  headerContent?: React.ReactNode;
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(path);
}

export function ChatInputArea({
  compact,
  inputValue,
  onInputChange,
  attachedFiles,
  onFilesChange,
  onRemoveFile,
  imageFiles,
  onImageFilesChange,
  onRemoveImageFile,
  onSubmit,
  isStreaming,
  onAbort,
  messageQueue: _messageQueue,
  onRemoveFromQueue: _onRemoveFromQueue,
  onHeightChange,
  headerContent,
}: ChatInputAreaProps) {
  const { t } = useTranslation();

  // @ mention states
  const [mentionPopoverOpen, setMentionPopoverOpen] = React.useState(false);
  const [mentionSearchQuery, setMentionSearchQuery] = React.useState("");

  // / command states
  const [commandPopoverOpen, setCommandPopoverOpen] = React.useState(false);
  const [commandSearchQuery, setCommandSearchQuery] = React.useState("");

  // Plan mode
  const [isPlanMode, setIsPlanMode] = React.useState(false);

  // Team mode
  const teamMode = useTeamModeStore(s => s.teamMode);
  const teamModelConfig = useTeamModeStore(s => s.teamModelConfig);
  const teamModelOptions = useTeamModeStore(s => s.teamModelOptions);
  const switchTeamModel = useTeamModeStore(s => s.switchTeamModel);
  const devUnlocked = useTeamModeStore(s => s.devUnlocked);
  const advancedMode = useUIStore((s) => s.advancedMode);
  const canShowPlanToggle = advancedMode && devUnlocked;

  // Model selector
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const models = useProviderStore(s => s.models);
  const configuredProvidersLoading = useProviderStore(s => s.configuredProvidersLoading);
  const storeSelectModel = useProviderStore(s => s.selectModel);
  const selectedModelOption = useProviderStore((s) => getSelectedModelOption(s));

  // Handle file paths dropped from file tree - insert as @{filepath} mention (same as "Add to Agent")
  const handleFilePathsDrop = React.useCallback((paths: string[]) => {
    const wsPath = useWorkspaceStore.getState().workspacePath;
    for (const path of paths) {
      let displayPath = path;
      if (wsPath && path.startsWith(wsPath)) {
        displayPath = path.slice(wsPath.length + 1);
      }
      // Read current text inside loop — draftInput updates after each insertToChat
      const currentText = useSessionStore.getState().draftInput;
      if (currentText.includes(`@{${displayPath}}`)) continue;
      const mention = `@{${displayPath}} `;
      useVoiceInputStore.getState().insertToChat(mention);
    }
  }, []);

  // Handle pasted/dropped files from PromptInput - filter images from non-images
  const handlePastedFiles = React.useCallback((files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const nonImages = files.filter((f) => !f.type.startsWith("image/"));

    if (images.length > 0) {
      onImageFilesChange(images);
    }
    if (nonImages.length > 0) {
      // For non-image files, create pseudo file-path entries (name only since they're from paste)
      onFilesChange(nonImages.map((f) => f.name));
    }
  }, [onImageFilesChange, onFilesChange]);

  // Generate preview URLs for image files
  const imagePreviewUrls = React.useMemo(() => {
    return imageFiles.map((file) => URL.createObjectURL(file));
  }, [imageFiles]);

  // Revoke preview URLs on cleanup
  React.useEffect(() => {
    return () => {
      imagePreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [imagePreviewUrls]);

  // Wrap onSubmit to inject plan mode agent
  const handleSubmit = React.useCallback((message: PromptInputMessage) => {
    (message as PromptInputMessage & { _planMode?: boolean })._planMode = isPlanMode;
    onSubmit(message);
  }, [onSubmit, isPlanMode]);

  // Measure height and report to parent via ResizeObserver
  // Round to nearest integer to prevent sub-pixel oscillation feedback loops
  const rootRef = React.useRef<HTMLDivElement>(null);
  const lastReportedHeight = React.useRef(0);
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeightChange) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const raw = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        const rounded = Math.round(raw);
        if (rounded !== lastReportedHeight.current) {
          lastReportedHeight.current = rounded;
          onHeightChange(rounded);
        }
      }
    });
    ro.observe(el);
    const initial = Math.round(el.getBoundingClientRect().height);
    lastReportedHeight.current = initial;
    onHeightChange(initial);
    return () => ro.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={rootRef}
      data-testid="chat-input-area"
      className={cn(
        "z-10",
        compact
          ? "absolute bottom-0 left-0 right-0 px-2 pb-2 pt-2 bg-background"
          : "absolute bottom-0 left-0 right-0 px-4 pb-6 pt-8 bg-gradient-to-t from-background from-70% to-transparent",
      )}
    >
      <div className={cn("relative w-full", compact ? "" : "mx-auto max-w-3xl")}>
        {/* Permission & Error UI (rendered above input so it's visible) */}
        {headerContent}

        <PromptInput
          data-onboarding-id="chat-input-root"
          value={inputValue}
          onValueChange={onInputChange}
          onSubmit={handleSubmit}
          onFilesChange={handlePastedFiles}
          onFilePathsDrop={handleFilePathsDrop}
          onMentionTrigger={(query) => {
            setMentionSearchQuery(query);
            setMentionPopoverOpen(true);
          }}
          onMentionClose={() => {
            setMentionPopoverOpen(false);
            setMentionSearchQuery("");
          }}
          onCommandTrigger={(query) => {
            setCommandSearchQuery(query);
            setCommandPopoverOpen(true);
          }}
          onCommandClose={() => {
            setCommandPopoverOpen(false);
            setCommandSearchQuery("");
          }}
          multiple
          className="relative z-10 bg-card shadow-lg"
        >
          {/* Image previews */}
          {imageFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3 pb-2">
              {imageFiles.map((file, index) => (
                <div
                  key={`img-${file.name}-${index}`}
                  className="relative group"
                >
                  <div className="relative h-20 w-20 rounded-lg border bg-muted/50 overflow-hidden">
                    <img
                      src={imagePreviewUrls[index]}
                      alt={file.name}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => onRemoveImageFile(index)}
                      className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <span className="block text-[10px] text-muted-foreground truncate max-w-[80px] mt-0.5 text-center">
                    {file.name}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Attached files preview */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3 pb-2">
              {attachedFiles.map((filePath, index) => {
                const fileName = getFileName(filePath);
                const displayPath = getFileDisplayPath(filePath);
                const isImageAttachment = isImagePath(filePath);

                if (isImageAttachment) {
                  return (
                    <div
                      key={`${filePath}-${index}`}
                      className="relative group"
                    >
                      <div className="relative h-20 w-20 rounded-lg border bg-muted/50 overflow-hidden">
                        <LocalImage
                          src={filePath}
                          alt={fileName}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => onRemoveFile(index)}
                          className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <span className="block text-[10px] text-muted-foreground truncate max-w-[80px] mt-0.5 text-center">
                        {fileName}
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    key={`${filePath}-${index}`}
                    title={filePath}
                    className="relative group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border bg-muted/50 min-w-0 max-w-[280px]"
                  >
                    <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-medium truncate leading-tight">{fileName}</span>
                      {displayPath !== fileName && (
                        <span className="text-[10px] text-muted-foreground truncate leading-tight opacity-70">
                          {displayPath.split("/").slice(0, -1).join("/")}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveFile(index)}
                      className="ml-0.5 p-0.5 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <PromptInputBody>
            <PromptInputTextarea
              placeholder={
                isStreaming
                  ? t('chat.inputPlaceholderQueue', 'Type to queue message...')
                  : attachedFiles.length > 0
                    ? t('chat.inputPlaceholderDescription', 'Add a description...')
                    : t('chat.inputPlaceholderMention', 'Type @ to reference files...')
              }
            />
          </PromptInputBody>

          {/* Popovers (inside PromptInput for context) */}
          <FileMentionPopoverWrapper
            open={mentionPopoverOpen}
            onOpenChange={setMentionPopoverOpen}
            searchQuery={mentionSearchQuery}
            onSearchChange={setMentionSearchQuery}
          />
          <CommandPopoverWrapper
            open={commandPopoverOpen}
            onOpenChange={setCommandPopoverOpen}
            searchQuery={commandSearchQuery}
          />

          <PromptInputFooter>
            <PromptInputTools>
              <div data-onboarding-id="chat-input-files">
                <FileInputButton onFilesSelected={onFilesChange} />
              </div>

              {/* Plan mode toggle (Advanced Mode + Dev Mode only) */}
              {canShowPlanToggle && (
                <Button
                  type="button"
                  variant={isPlanMode ? "default" : "ghost"}
                  size="sm"
                  className={cn(
                    "h-8 px-2 text-xs",
                    isPlanMode
                      ? "bg-[#F5A623] text-black hover:bg-[#E09500]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setIsPlanMode(!isPlanMode)}
                >
                  Plan
                </Button>
              )}

              {teamMode && teamModelConfig && !devUnlocked && teamModelOptions.length > 1 ? (
                <ModelSelector
                  open={modelSelectorOpen}
                  onOpenChange={setModelSelectorOpen}
                >
                  <ModelSelectorTrigger asChild>
                    <PromptInputButton>
                      <ModelSelectorLogo provider="team" />
                      {teamModelConfig.modelName}
                    </PromptInputButton>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent align="start">
                    <ModelSelectorList>
                      <ModelSelectorGroup heading="Team">
                        {teamModelOptions.map((option) => (
                          <ModelSelectorItem
                            key={option.id}
                            onSelect={() => {
                              setModelSelectorOpen(false);
                              const wsPath = useWorkspaceStore.getState().workspacePath;
                              if (wsPath) switchTeamModel(option.id, wsPath);
                            }}
                          >
                            <ModelSelectorLogo provider="team" />
                            <ModelSelectorName>{option.name}</ModelSelectorName>
                          </ModelSelectorItem>
                        ))}
                      </ModelSelectorGroup>
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
              ) : teamMode && teamModelConfig && !devUnlocked ? (
                <PromptInputButton>
                  <ModelSelectorLogo provider="team" />
                  {teamModelConfig.modelName}
                </PromptInputButton>
              ) : (
                <ModelSelector
                  open={modelSelectorOpen}
                  onOpenChange={setModelSelectorOpen}
                >
                  <ModelSelectorTrigger asChild>
                    <PromptInputButton>
                      {selectedModelOption ? (
                        <>
                          <ModelSelectorLogo
                            provider={selectedModelOption.provider}
                          />
                          {selectedModelOption.name}
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          {configuredProvidersLoading
                            ? "Loading..."
                            : "Select model"}
                        </span>
                      )}
                    </PromptInputButton>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent align="start">
                    <ModelSelectorInput placeholder="Search models..." />
                    <ModelSelectorList>
                      <ModelSelectorEmpty>
                        {models.length === 0
                          ? "No models configured. Connect a provider in Settings."
                          : "No models found"}
                      </ModelSelectorEmpty>
                      {Array.from(new Set(models.map((m) => m.provider))).map(
                        (provider) => (
                          <ModelSelectorGroup
                            key={provider}
                            heading={
                              provider.charAt(0).toUpperCase() +
                              provider.slice(1)
                            }
                          >
                            {models
                              .filter((m) => m.provider === provider)
                              .map((model) => (
                                <ModelSelectorItem
                                  key={`${model.provider}-${model.id}`}
                                  onSelect={() => {
                                    setModelSelectorOpen(false);
                                    storeSelectModel(
                                      model.provider,
                                      model.id,
                                      model.name,
                                    );
                                  }}
                                >
                                  <ModelSelectorLogo
                                    provider={model.provider}
                                  />
                                  <ModelSelectorName>
                                    {model.name}
                                  </ModelSelectorName>
                                </ModelSelectorItem>
                              ))}
                          </ModelSelectorGroup>
                        ),
                      )}
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
              )}
            </PromptInputTools>

            <div className="flex items-center gap-2" data-onboarding-id="chat-input-submit">
              <ContextUsageBadge />
              <PromptInputSubmit
                disabled={!inputValue.trim() && attachedFiles.length === 0 && imageFiles.length === 0}
                status={isStreaming ? "streaming" : "ready"}
                onStop={onAbort}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
