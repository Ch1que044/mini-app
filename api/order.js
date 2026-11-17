const crypto = require('node:crypto');

const CATALOG = {
  1: { name: 'Икра красная лососевая', unit: 'кг', price: 5200, min: 5, step: 1 },
  2: { name: 'Икра горбуши', unit: 'кг', price: 4600, min: 5, step: 1 },
  3: { name: 'Икра осетровая', unit: 'кг', price: null, min: 1, step: 0.5 },
  4: { name: 'Сёмга охлаждённая', unit: 'кг', price: 1190, min: 10, step: 5 },
  5: { name: 'Форель слабосолёная', unit: 'кг', price: 1450, min: 6, step: 2 },
  6: { name: 'Кета свежемороженая', unit: 'кг', price: 640, min: 10, step: 5 },
  7: { name: 'Осётр охлаждённый', unit: 'кг', price: 2400, min: 6, step: 2 },
  8: { name: 'Судак, филе', unit: 'кг', price: 780, min: 10, step: 5 },
  9: { name: 'Креветки 50/70', unit: 'кг', price: 890, min: 10, step: 5 },
  10: { name: 'Мидии в раковине', unit: 'кг', price: 520, min: 10, step: 5 },
};

function safeEqualHex(actual, expected) {
  if (!/^[a-f\d]{64}$/i.test(actual || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) return false;
  params.delete('hash');
  const checkString = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (!safeEqualHex(receivedHash, expectedHash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) >= 86400) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

function clean(value, max = 300) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function formatOrder(body, telegramUser) {
  const name = clean(body.name, 100);
  const phone = clean(body.phone, 40);
  if (name.length < 2 || phone.length < 7) throw new Error('Укажите имя и телефон для связи.');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 25) throw new Error('В заказе нет товаров или слишком много позиций.');

  let total = 0;
  const lines = body.items.map((item) => {
    const id = Number(item.id);
    const product = CATALOG[id];
    const quantity = Number(item.quantity);
    if (!product || !Number.isFinite(quantity) || quantity < product.min || quantity > 10000) throw new Error('Проверьте состав и количество заказа.');
    const increments = (quantity - product.min) / product.step;
    if (Math.abs(increments - Math.round(increments)) > 1e-7) throw new Error('Количество не соответствует шагу заказа.');
    if (product.price) total += product.price * quantity;
    return `• ${product.name}: ${quantity} ${product.unit}${product.price ? ` — ${(product.price * quantity).toLocaleString('ru-RU')} ₽` : ' — цена по запросу'}`;
  });

  const rows = [
    'НОВЫЙ ЗАКАЗ · НИВА',
    '',
    ...lines,
    '',
    `Предварительная сумма: ${total ? `${total.toLocaleString('ru-RU')} ₽${body.items.some((item) => !CATALOG[Number(item.id)]?.price) ? ' + товар по запросу' : ''}` : 'цена по запросу'}`,
    '',
    `Имя: ${name}`,
    `Телефон: ${phone}`,
    `Компания: ${clean(body.company, 120) || '—'}`,
    `Город: ${clean(body.city, 100) || '—'}`,
    `Комментарий: ${clean(body.comment, 800) || '—'}`,
  ];
  if (telegramUser?.id) {
    const user = telegramUser;
    rows.push(`Telegram клиента: ${clean(user.first_name, 80)}${user.username ? ` (@${clean(user.username, 80)})` : ''} · ID ${Number(user.id) || ''}`);
  }
  rows.push('', `Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`);
  return rows.join('\n').slice(0, 3900);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Разрешена только отправка заказа.' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!botToken || !ownerChatId) return res.status(503).json({ error: 'Отправка заказов ещё не настроена.' });
  const telegramUser = verifyTelegramInitData(req.headers['x-telegram-init-data'], botToken);
  if (!telegramUser) {
    return res.status(401).json({ error: 'Откройте каталог через Telegram-бота и отправьте заказ ещё раз.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const text = formatOrder(body || {}, telegramUser);
    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: ownerChatId, text, disable_web_page_preview: true }),
    });
    const result = await telegramResponse.json();
    if (!telegramResponse.ok || !result.ok) {
      console.error('Telegram sendMessage failed:', result.description || telegramResponse.status);
      return res.status(502).json({ error: 'Бот не смог передать заказ. Попробуйте ещё раз или позвоните менеджеру.' });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось обработать заказ.' });
  }
};
