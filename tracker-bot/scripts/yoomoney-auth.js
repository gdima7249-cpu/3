// Получение OAuth-токена ЮMoney для проверки оплат. Запуск: npm run yoomoney
// Токену нужны права account-info и operation-history (только чтение, переводить деньги он не может).
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ENV_FILE } from '../src/config.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();

console.log(`
=== Подключение ЮMoney ===

Шаг 1. Зарегистрируйте приложение: https://yoomoney.ru/myservices/new
  • Название — любое (например, SkinWatch)
  • Адрес сайта — https://t.me
  • Redirect URI — https://t.me
  • Галочку «Проверять подлинность приложения (OAuth2 client_secret)» НЕ ставьте
После сохранения скопируйте client_id.
`);

const clientId = await ask('client_id: ');
const redirectUri = (await ask('Redirect URI [https://t.me]: ')) || 'https://t.me';

const res = await fetch('https://yoomoney.ru/oauth/authorize', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'account-info operation-history' }),
  redirect: 'manual',
}).catch(() => null);
const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'account-info operation-history' });
const loc = res?.headers.get('location');
const authUrl = loc ? new URL(loc, 'https://yoomoney.ru').href : `https://yoomoney.ru/oauth/authorize?${params}`;
console.log(`
Шаг 2. Откройте ссылку в браузере, войдите в ЮMoney и нажмите «Разрешить»:

${authUrl}

После этого браузер откроет страницу вида ${redirectUri}?code=XXXX — скопируйте адрес целиком.
`);

const back = await ask('Вставьте адрес страницы (или только code): ');
let code = back;
try {
  code = new URL(back).searchParams.get('code') || back;
} catch {}
if (!code) {
  console.error('Код не найден. Запустите скрипт заново.');
  process.exit(1);
}

const tokRes = await fetch('https://yoomoney.ru/oauth/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: clientId, grant_type: 'authorization_code', redirect_uri: redirectUri }),
});
const tok = await tokRes.json().catch(() => ({}));
if (!tok.access_token) {
  console.error('ЮMoney не выдал токен:', JSON.stringify(tok), '\nКод действует несколько минут — попробуйте ещё раз.');
  process.exit(1);
}

const info = await fetch('https://yoomoney.ru/api/account-info', {
  method: 'POST',
  headers: { authorization: `Bearer ${tok.access_token}` },
}).then((r) => r.json());
console.log(`\n✅ Готово. Кошелёк: ${info.account}, статус: ${info.account_status}`);
if (info.account_status === 'anonymous') console.log('⚠️  Кошелёк анонимный — для приёма оплат пройдите идентификацию в ЮMoney.');

let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
const set = (key, val) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, `${key}=${val}`) : `${env.replace(/\s*$/, '\n')}${key}=${val}\n`;
};
set('YOOMONEY_WALLET', info.account);
set('YOOMONEY_TOKEN', tok.access_token);
writeFileSync(ENV_FILE, env);
console.log('Записал YOOMONEY_WALLET и YOOMONEY_TOKEN в .env. Перезапустите бота: npm start');
console.log('Токен никому не показывайте — он даёт доступ к истории операций кошелька.');
rl.close();
