// Native DSH browser-module format; uses the host's shared React and slot API.
// No private persona/chat data is fetched until the human opens the editor.
window.__ModuleLoader__.load({
  id: 'epub-local-bot-controls',
  factory(require) {
    const { createElement: h } = require('react');
    function SettingsEntry() {
      return h('section', { style: { padding: '16px', lineHeight: 1.7 } },
        h('h2', null, '人设与聊天'),
        h('p', null, '编辑各 bot 的人物设定、前置和后置提示词，或删除聊天记录。'),
        h('a', { href: '/bot-controls', target: '_blank', rel: 'noopener',
          style: { display: 'inline-block', padding: '8px 14px', border: '1px solid currentColor', borderRadius: '8px', color: 'inherit' } },
        '打开 Bot 设置'),
        h('p', null, '在新标签页打开，保留当前聊天页面。删除聊天不会修改长期记忆。'));
    }
    return {
      name: 'epub-local-bot-controls',
      inject: ['slots'],
      apply(ctx) {
        // Tobs' settings and the ordinary DSH settings are separate shells.
        // Register through their declared slots, including late activation.
        for (const [name, order] of [['botharness.settings.section', 12], ['settings.section', 26]]) {
          ctx.slots.inject(name, () => ctx.slots.register({
            name, id: 'local-bot-controls', order, label: () => '人设与聊天',
          }, SettingsEntry));
        }
      },
    };
  },
});
