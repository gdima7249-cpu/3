export class TelegramApi {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}/`;
  }

  async call(method, params = {}) {
    const isForm = params instanceof FormData;
    const res = await fetch(this.base + method, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? params : JSON.stringify(params),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 70_000 : isForm ? 60_000 : 15_000),
    });
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.description}`);
      err.code = data.error_code;
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }

  /** Отправка, которая не бросает исключений. */
  async send(chatId, text, extra = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
      } catch (e) {
        if (e.code === 429 && e.retryAfter && attempt === 0) {
          await new Promise((r) => setTimeout(r, e.retryAfter * 1000));
          continue;
        }
        console.warn(`[tg] не удалось отправить ${chatId}: ${e.message}`);
        return null;
      }
    }
    return null;
  }

  /** Фото или файл из памяти: kind = 'photo' | 'document'. */
  async sendFile(chatId, kind, buffer, filename, { caption, mime, ...extra } = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    form.append(kind, new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
    try {
      return await this.call(kind === 'photo' ? 'sendPhoto' : 'sendDocument', form);
    } catch (e) {
      console.warn(`[tg] не удалось отправить файл ${chatId}: ${e.message}`);
      return null;
    }
  }

  async edit(chatId, messageId, text, extra = {}) {
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    } catch (e) {
      if (!/message is not modified/.test(e.message)) await this.send(chatId, text, extra);
    }
  }

  async poll(handler, { signal } = {}) {
    let offset = 0;
    await this.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    while (!signal?.aborted) {
      try {
        const updates = await this.call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await handler(u);
          } catch (e) {
            console.error('[bot] ошибка обработки апдейта', e);
          }
        }
      } catch (e) {
        if (e.code === 409) console.error('[bot] 409: этот токен уже опрашивает другой процесс. Остановите его.');
        else console.warn('[bot] polling:', e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
