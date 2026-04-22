import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";

describe("tool call locale resources", () => {
  it("keeps the Chinese tool-call labels localized instead of falling back to English", () => {
    expect(zhCN.chat.toolCall.search.grep).toBe("文本搜索");
    expect(zhCN.chat.toolCall.search.glob).toBe("文件匹配");
    expect(zhCN.chat.toolCall.search.find).toBe("查找");
    expect(zhCN.chat.toolCall.todo.title).toBe("待办");
    expect(zhCN.chat.toolCall.read.title).toBe("读取");
    expect(zhCN.chat.toolCall.write.title).toBe("写入");
    expect(zhCN.chat.toolCall.edit.title).toBe("编辑");
    expect(zhCN.chat.toolCall.skill.title).toBe("技能");
    expect(zhCN.chat.toolCall.roleSkill.title).toBe("角色技能");
    expect(zhCN.chat.toolCall.task.title).toBe("子助手");
    expect(zhCN.chat.toolCall.roleLoad.title).toBe("加载角色");
    expect(zhCN.chat.toolCall.roleLoad.instructionsReady).toBe("角色说明已就绪");
    expect(zhCN.chat.toolCall.roleLoad.instructionsAndSkills).toBe("角色说明与 {{count}} 个角色技能已就绪");
  });

  it("still keeps the English tool-call labels in English", () => {
    expect(en.chat.toolCall.search.grep).toBe("Grep");
    expect(en.chat.toolCall.todo.title).toBe("Todo");
    expect(en.chat.toolCall.read.title).toBe("Read");
    expect(en.chat.toolCall.skill.title).toBe("Skill");
    expect(en.chat.toolCall.roleLoad.title).toBe("Role Load");
  });
});
