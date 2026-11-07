// Закрытый чат УЛЬТРА. Вход — по ссылке с заявкой: бот одобряет заявку, только если у человека активен УЛЬТРА.
// Когда подписка заканчивается, бот убирает человека из чата (без вечного бана — продлит подписку и вернётся).
// Нужно: группа (супергруппа), бот в ней администратор с правами «Пригласительные ссылки» и «Блокировка участников»,
// её id в ULTRA_CHAT_ID (например, -1001234567890).
import { esc } from '../telegram.js';

export function createUltraChat(ctx) {
  const { tg, db, config, kb } = ctx;
  const chatId = config.ultraChatId;
  const q = {
    getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
    setKv: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    setJoined: db.prepare('UPDATE users SET ultra_chat = ? WHERE id = ?'),
    joined: db.prepare('SELECT * FROM users WHERE ultra_chat = 1'),
  };
  const enabled = Boolean(chatId) && !config.freeForAll;

  async function inviteLink() {
    const key = `ultra_invite:${chatId}`;
    let link = q.getKv.get(key)?.value;
    if (!link) {
      const r = await tg.call('createChatInviteLink', { chat_id: chatId, name: 'SkinWatch УЛЬТРА', creates_join_request: true });
      link = r.invite_link;
      q.setKv.run(key, link);
    }
    return link;
  }

  async function offer(to, u) {
    if (!enabled) return tg.send(to, 'Закрытый чат пока не открыт.');
    if (ctx.tier(u) !== 'ultra') return tg.send(to, '💬 Закрытый чат — для тарифа 💎 УЛЬТРА.', kb([[{ text: '⭐ Тарифы', callback_data: 'premium' }]]));
    let link;
    try {
      link = await inviteLink();
    } catch (e) {
      await ctx.notifyAdmins(`⚠️ Чат УЛЬТРА: не удалось создать ссылку — ${esc(e.message)}. Проверьте, что бот администратор группы ${esc(chatId)} с правом приглашать.`);
      return tg.send(to, 'Не получилось открыть вход в чат — администратор уже знает. Попробуйте позже.');
    }
    return tg.send(to, '💬 <b>Чат УЛЬТРА</b>\n\nНажмите кнопку и отправьте заявку на вступление — бот одобрит её сразу.', kb([[{ text: '💬 Вступить в чат', url: link }]]));
  }

  async function onJoinRequest(req) {
    if (!enabled || String(req.chat.id) !== String(chatId)) return;
    const u = ctx.getUser(req.from.id);
    const dm = req.user_chat_id || req.from.id; // боту можно написать подавшему заявку, даже если он не запускал бота
    if (u && ctx.tier(u) === 'ultra') {
      await tg.call('approveChatJoinRequest', { chat_id: req.chat.id, user_id: req.from.id });
      q.setJoined.run(1, u.id);
      return;
    }
    await tg.call('declineChatJoinRequest', { chat_id: req.chat.id, user_id: req.from.id }).catch(() => {});
    await tg.send(dm, '💬 Этот чат — только для тарифа 💎 УЛЬТРА. Подробнее: /premium');
  }

  /** Убрать из чата тех, у кого УЛЬТРА закончился. */
  async function sweep() {
    if (!enabled) return 0;
    let removed = 0;
    for (const u of q.joined.all()) {
      if (ctx.tier(u) === 'ultra') continue;
      try {
        await tg.call('banChatMember', { chat_id: chatId, user_id: u.id });
        await tg.call('unbanChatMember', { chat_id: chatId, user_id: u.id, only_if_banned: true });
      } catch (e) {
        // Уже вышел сам — тоже хорошо. Иначе (нет прав) попробуем в следующий раз.
        if (!/not found|not a member|PARTICIPANT_ID_INVALID|USER_NOT_PARTICIPANT/i.test(e.message)) {
          console.warn('[ultra chat]', u.id, e.message);
          continue;
        }
      }
      q.setJoined.run(0, u.id);
      removed++;
      await tg.send(u.id, 'Подписка 💎 УЛЬТРА закончилась, поэтому доступ к закрытому чату закрыт. Продлите — и вход снова откроется: /premium');
    }
    return removed;
  }

  return { enabled, offer, onJoinRequest, sweep };
}
