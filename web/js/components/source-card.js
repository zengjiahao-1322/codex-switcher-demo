import { accessTag, tag } from '../ui.js';
import { accountPlan, accountRemaining, accountWindow, ago, membership, membershipExpired, windowName } from '../views/accounts.js';
const hue = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function sourceCard(o, { checked, using = null, model, blocked = '', onPick }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'source-card';
  card.setAttribute('role', 'radio');
  card.setAttribute('aria-checked', String(checked));
  card.dataset.source = o.value;
  card.disabled = Boolean(blocked);
  // 首字母图标 + 名称行（名称与标签）+ 说明行 + 行尾额度。
  const avatar = document.createElement('span'),
    body = document.createElement('span'),
    head = document.createElement('span'),
    name = document.createElement('span'),
    detail = document.createElement('small');
  avatar.className = 'avatar' + (o.provider ? ' api' : '');
  avatar.style.setProperty('--hue', hue(o.name));
  avatar.textContent = o.name.trim().charAt(0).toUpperCase();
  body.className = 'body';
  head.className = 'head';
  name.className = 'name';
  name.textContent = o.name;
  head.append(name);
  card.append(avatar, body);
  const a = o.account,
    p = o.provider;
  if (a) {
    if (using) head.append(using);
    if (membershipExpired(a)) head.append(tag('会员已到期', 'changed'));
    detail.textContent = [
      (a.label === a.email ? 'ChatGPT ' : a.email + ' · ') + accountPlan(a),
      membership(a),
      a.quota?.checkedAt && ago(a.quota.checkedAt) + '读取',
    ]
      .filter(Boolean)
      .join(' · ');
    // 行尾显示上次读到的最紧额度窗口；超过 10 分钟的读数变淡，提示可能已变化。
    const known = accountWindow(a, undefined, Infinity);
    if (known !== null) {
      const side = document.createElement('span'),
        value = document.createElement('b'),
        bar = document.createElement('progress');
      side.className =
        'side' +
        (known.remainingPercent > 20 ? '' : ' low') +
        (accountRemaining(a) === null ? ' stale' : '');
      side.title =
        windowName(known) +
        '额度是目前剩余最少的窗口，读取于 ' +
        new Date(a.quota.checkedAt).toLocaleString('zh-CN');
      value.textContent = windowName(known) + ' ' + Math.round(known.remainingPercent) + '%';
      bar.max = 100;
      bar.value = known.remainingPercent;
      side.append(value, bar);
      card.append(side);
    }
  } else if (p) {
    head.append(accessTag(p));
    if (!p.hasKey && !p.local) head.append(tag('缺少密钥', 'changed'));
    if (using) head.append(using);
    detail.textContent = blocked || p.baseUrl.replace(/^https?:\/\//, '') + ' · ' + model;
  } else detail.textContent = '还没有保存的账号，选中后可添加';
  body.append(head, detail);
  card.onclick = onPick;
  return card;
}
