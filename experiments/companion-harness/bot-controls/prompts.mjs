import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlError } from './service.mjs';

export function createPersonaControls(core, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const botFor = id => {
    const bot = core.registry.get(id); if (!bot) throw new ControlError('找不到这个 bot', 404); return bot;
  };
  const settingsPath = id => join(directory, id + '.json');
  const settings = id => { botFor(id); return existsSync(settingsPath(id))
    ? JSON.parse(readFileSync(settingsPath(id), 'utf8')) : { revision: 'initial', prefix: '', suffix: '' }; };
  const revision = (id, head) => {
    const soul = join(core.registry.memoryDirFor(id), 'SOUL.md');
    return [head, statSync(soul, { bigint: true }).mtimeNs.toString(), settings(id).revision].join(':');
  };
  return {
    settings,
    expand(id, value) {
      const bot = botFor(id); const dm = core.channels.getOrCreateDm(id);
      const user = core.channels.humanNickname(dm.id) ?? core.channels.humanIdentity().displayName ?? '用户';
      // One pass, with literal replacement values: names may themselves contain
      // dollar signs or braces and must not become another macro/template pass.
      return value.replace(/\{\{(char|user)\}\}/g, (_macro, name) => name === 'char' ? bot.displayName : user);
    },
    load(id) {
      const bot = botFor(id); const file = core.memory.readAccepted(id, 'SOUL.md');
      if (!file || file.binary) throw new ControlError('人设文件不可编辑', 409);
      const config = settings(id);
      return { botId: id, soul: file.body, prefix: config.prefix, suffix: config.suffix,
        revision: revision(id, file.head), soulLimit: bot.standingLimits?.soul ?? 5000 };
    },
    save(input) {
      const { botId, soul, prefix, suffix } = input; const bot = botFor(botId);
      if (core.runtime.turnRunning?.(botId) || core.runtime.hasPendingInbox?.(botId))
        throw new ControlError('这个 bot 正在回复，请结束当前回复后保存', 409);
      if ([soul, prefix, suffix].some(value => typeof value !== 'string')
        || soul.length > (bot.standingLimits?.soul ?? 5000) || prefix.length > 16000 || suffix.length > 16000)
        throw new ControlError('内容超出人设或提示词长度限制', 400);
      const file = core.memory.readAccepted(botId, 'SOUL.md');
      if (!file || input.revision !== revision(botId, file.head)) throw new ControlError('文件已被其他窗口或编辑器修改，请刷新后再保存', 409);
      const next = { revision: randomUUID(), prefix, suffix };
      const temporary = settingsPath(botId) + '.tmp';
      // Native save supplies Git history/CAS. The separate prompt JSON contains
      // only human-owned preset configuration, never dialogue or long-term memory.
      let soulSaved = false;
      try {
        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        if (soul !== file.body) {
          core.memory.saveHuman({ botSlug: botId, path: 'SOUL.md', body: soul,
            expectedHead: file.head, editId: randomUUID() });
          soulSaved = true;
        }
        renameSync(temporary, settingsPath(botId));
      } catch {
        throw new ControlError(soulSaved ? '人设已保存，但前后置提示保存失败；请重新载入核对' : '未完成保存；请检查人设文件是否有尚未提交的外部修改，再重新载入', 409);
      } finally { rmSync(temporary, { force: true }); }
      try {
        for (const owner of core.ownership.rootsFor(botId, 'orchestrator'))
          core.memory.refreshPersonaAfterCompaction(botId, owner.sessionId);
      } catch { throw new ControlError('配置已保存，但当前会话人设刷新失败；请稍后重新载入并保存', 409); }
      return this.load(botId);
    },
  };
}

/** Main prompt is system text before character material. Post-history text is
 * a native runtime-context contribution after admitted messages, not a footer
 * in SOUL.md or an unlogged provider mutation. */
export function addMainPrompt(assembly, text) {
  return text ? { ...assembly, sections: [{ name: 'bot-controls:main-prompt', text, interpolate: false }, ...assembly.sections] } : assembly;
}
export function expandPersonaPrompt(assembly, expand) {
  return { ...assembly, sections: assembly.sections.map(section => section.name === 'botharness:persona'
    ? { ...section, text: expand(section.text), interpolate: false } : section) };
}
export function postHistoryText(text, revision, turn = 0, step = 0) {
  if (!text) return '';
  return `[当前角色后置提示；配置 ${revision}；回合 ${turn}，步骤 ${step}。同名提示以本次为准，不作为用户经历或长期记忆。]\n${text}`;
}
