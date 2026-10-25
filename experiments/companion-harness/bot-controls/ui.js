const $ = id => document.getElementById(id);
let botId, before, previewId, persona, dirty = false, messageRequest = 0;
async function api(path, input) {
  const r = await fetch('/api/bot-controls/' + path, input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {});
  const value = await r.json(); if (!r.ok) throw new Error(value.error ?? '操作失败'); return value;
}
const show = text => { $('status').textContent = text; };
const guard = fn => async () => { try { await fn(); } catch (e) { show(e.message); } };
async function loadMessages(older = false) {
  if (!botId) return;
  const selected = botId, request = ++messageRequest;
  const result = await api('messages?bot=' + encodeURIComponent(selected) + (older && before ? '&before=' + encodeURIComponent(before) : ''));
  if (selected !== botId || request !== messageRequest) return;
  if (!older) $('messages').replaceChildren();
  for (const item of result.items) {
    const row = document.createElement('label'); row.className = 'message';
    const check = document.createElement('input'); check.type = 'checkbox'; check.value = item.id; check.disabled = item.disabled;
    check.onchange = () => { $('delete-selected').disabled = !$('messages').querySelector('input:checked'); };
    const content = document.createElement('div'); const time = document.createElement('time'); time.textContent = new Date(item.at).toLocaleString();
    const body = document.createElement('p'); body.textContent = item.body;
    content.append(time, body); row.append(check, content); $('messages').append(row);
  }
  before = result.before; $('older').hidden = !before; $('delete-selected').disabled = !$('messages').querySelector('input:checked');
  show($('messages').children.length ? '' : '暂无聊天记录');
}
$('bot').onchange = guard(async () => {
  if (dirty && !confirm('有未保存的人设修改，确定切换 bot 吗？')) { $('bot').value = botId; return; }
  botId = $('bot').value; persona = undefined; dirty = false; before = undefined;
  $('messages').replaceChildren(); $('older').hidden = true; $('delete-selected').disabled = true;
  for (const id of ['prefix','soul','suffix']) { $(id).value = ''; $(id).disabled = true; }
  $('save-persona').disabled = true; await loadMessages();
});
$('refresh').onclick = guard(() => loadMessages());
$('older').onclick = guard(() => loadMessages(true));
$('select-page').onclick = () => {
  const checks = [...$('messages').querySelectorAll('input:not(:disabled)')];
  checks.forEach((c, i) => { c.checked = i < 100; });
  $('delete-selected').disabled = !checks.length;
  if (checks.length > 100) show('每批最多100条，已选择最近100条');
};
async function preview(action) {
  const ids = [...$('messages').querySelectorAll('input:checked')].map(c => c.value);
  const selected = botId;
  const p = await api('preview', { botId: selected, action, ids });
  if (selected !== botId) return;
  previewId = p.id;
  $('confirmation').textContent = `「${p.botName}」将${action === 'all' ? '清空此 bot 的聊天' : '删除选中的消息'}，本批 ${p.count} 条${p.more ? '，后续批次会继续清理' : ''}。${p.affectedChats > 1 ? `这些消息共在 ${p.affectedChats} 个会话中引用，引用处正文也会清除。` : ''}${p.note}`;
  $('confirm-dialog').showModal();
}
$('delete-selected').onclick = guard(() => preview('selected'));
$('clear').onclick = guard(() => preview('all'));
$('cancel').onclick = () => $('confirm-dialog').close();
$('confirm').onclick = guard(async () => {
  $('confirm').disabled = true;
  try { const p = await api('confirm', { id: previewId }); $('confirm-dialog').close(); await loadMessages(); show(`已清除 ${p.count} 条消息${p.more ? '，仍有较早内容，可再次清空' : ''}`); }
  finally { $('confirm').disabled = false; }
});
$('chat-tab').onclick = () => { $('chat').hidden = false; $('persona').hidden = true; $('chat-tab').setAttribute('aria-pressed','true'); $('persona-tab').setAttribute('aria-pressed','false'); };
$('persona-tab').onclick = () => { $('chat').hidden = true; $('persona').hidden = false; $('chat-tab').setAttribute('aria-pressed','false'); $('persona-tab').setAttribute('aria-pressed','true'); };
function displayPersona(p) {
  persona = p; dirty = false;
  for (const id of ['prefix','soul','suffix']) { $(id).value = p[id]; $(id).disabled = false; }
  $('soul').maxLength = p.soulLimit; $('soul-limit').textContent = `上限 ${p.soulLimit} 字符`;
  $('prefix').maxLength = $('suffix').maxLength = 16000; $('save-persona').disabled = false;
}
async function personaOperation(task) {
  $('bot').disabled = $('load-persona').disabled = $('save-persona').disabled = true;
  for (const id of ['prefix','soul','suffix']) $(id).disabled = true;
  try { await task(); } finally {
    $('bot').disabled = $('load-persona').disabled = false;
    $('save-persona').disabled = !persona;
    for (const id of ['prefix','soul','suffix']) $(id).disabled = !persona;
  }
}
for (const id of ['prefix','soul','suffix']) $(id).oninput = () => { dirty = true; };
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
$('load-persona').onclick = guard(async () => {
  if (dirty && !confirm('重新载入会丢弃尚未保存的修改，继续吗？')) return;
  if (!botId) return;
  await personaOperation(async () => {
    displayPersona(await api('persona?bot=' + encodeURIComponent(botId))); show('已载入；尚未修改或应用');
  });
});
$('save-persona').onclick = guard(async () => {
  if (!persona) return;
  await personaOperation(async () => {
    const p = await api('persona', { botId, revision: persona.revision, soul: $('soul').value, prefix: $('prefix').value, suffix: $('suffix').value });
    displayPersona(p); show('已保存并应用，下一次回复使用新配置');
  });
});
await guard(async () => {
  const { bots } = await api('bots');
  for (const b of bots) { const option = document.createElement('option'); option.value = b.id; option.textContent = b.name; $('bot').append(option); }
  botId = bots[0]?.id;
  if (!botId) { show('当前没有可管理的 bot'); return; }
  await loadMessages();
})();
