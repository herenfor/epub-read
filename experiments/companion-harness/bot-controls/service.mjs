import { randomUUID } from 'node:crypto';

export class ControlError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Uses native reviewed deletion; never edits SQLite, SOUL or long-term memory. */
export function createConversationControls(core) {
  const previews = new Map();
  const requireBot = id => {
    const bot = core.registry.get(id);
    if (!bot) throw new ControlError('找不到这个 bot，请刷新页面', 404);
    return { bot, channel: core.channels.getOrCreateDm(id) };
  };
  const requireIdle = id => {
    if (core.runtime.turnRunning?.(id) || core.runtime.hasPendingInbox?.(id))
      throw new ControlError('这个 bot 仍在回复，请结束当前回复后再删除', 409);
  };
  const prune = () => { for (const [id, p] of previews) if (p.expires < Date.now()) previews.delete(id); };
  return {
    bots: () => core.registry.list().map(bot => ({ id: bot.slug, name: bot.displayName })),
    messages(id, before) {
      const { channel } = requireBot(id);
      const result = core.contentPurge.sources(channel.id, before);
      return { items: result.sources.filter(row => !row.purgedAt).map(row => ({ id: row.sourceEventId,
        at: row.at, body: row.body, disabled: Boolean(row.refusal) })), before: result.before };
    },
    preview({ botId, action, ids }) {
      prune(); requireIdle(botId);
      const { bot, channel } = requireBot(botId);
      if (!['selected', 'all'].includes(action)) throw new ControlError('请选择删除方式');
      if (action === 'selected' && (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')))
        throw new ControlError('每次请选择1至100条消息');
      const scope = { before: new Date().toISOString(), channelIds: [channel.id] };
      const native = action === 'selected' ? core.contentPurge.preview(channel.id, ids) : core.contentPurge.textPreview(scope);
      if (action === 'all' && native.kept?.some(item => item.messages)) throw new ControlError('仍有正在处理或共享的消息，暂不能清空', 409);
      const id = randomUUID();
      previews.set(id, { botId, action, ids, channel: channel.id, scope, native, expires: Date.now() + 240000 });
      return { id, botId, botName: bot.displayName, count: action === 'selected' ? native.sourceEventIds.length : native.messages,
        more: action === 'all' && native.more === true,
        affectedChats: action === 'selected' ? new Set(native.placements.map(p => p.channelId)).size : 1,
        note: '只清除聊天正文和关联附件，不修改人设、长期记忆或撤销已经执行的操作；已进入模型会话的上下文也可能保留。' };
    },
    confirm({ id }) {
      prune(); const p = previews.get(id);
      if (!p) throw new ControlError('预览已失效，请重新选择', 409);
      requireBot(p.botId); requireIdle(p.botId); previews.delete(id);
      let count = 0;
      if (p.action === 'selected') count = core.contentPurge.confirm(p.channel, p.ids, p.native.token).accepted;
      else {
        let native = p.native;
        // Same cutoff/channel throughout: never adopt new messages while
        // processing native batches. Stop visibly if anything is retained.
        for (let batch = 0; batch < 100; batch++) {
          const result = core.contentPurge.textConfirm(p.scope, native.token); count += result.messages;
          if (!native.more) { core.live.publishContentPurged(); return { count }; }
          native = core.contentPurge.textPreview(p.scope);
          if (native.kept?.some(item => item.messages)) throw new ControlError('已清理部分消息，剩余消息正在处理，请稍后重试', 409);
        }
        core.live.publishContentPurged();
        return { count, more: true };
      }
      core.live.publishContentPurged();
      return { count };
    },
  };
}
