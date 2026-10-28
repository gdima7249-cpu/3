// Страница товара в том виде, в каком её описывает price_watcher: JSON-LD + <noframes data-apiary="patch">.
export const WARE = 'AbCdEfGhIjKlMnOpQrStUv';

export function productHtml({ price = 1087, oldPrice = 1300, ldPrice = 1099, sku = '123', ware = WARE, seller = 'Цифра Плюс', availability = 'https://schema.org/InStock', extraOffers = {}, escapePatch = false, promoText = '', promoData = null } = {}) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Карта оплаты Steam 1000 руб',
    sku,
    url: `https://market.yandex.ru/card/karta-steam/${sku}`,
    offers: { '@type': 'Offer', price: String(ldPrice), priceCurrency: 'RUR', availability, seller: { '@type': 'Organization', name: seller } },
  };
  const patch = JSON.stringify({ widgets: {}, collections: { offerAnalytics: { [ware]: { oskuId: sku, price, oldPrice, shopName: seller }, ...extraOffers }, ...(promoData ? { promo: promoData } : {}) } });
  const body = escapePatch ? patch.replace(/"/g, '&quot;') : patch;
  return `<!doctype html><html><head><title>Карта оплаты Steam 1000 руб — купить на Яндекс Маркете</title>
<link rel="canonical" href="https://market.yandex.ru/card/karta-steam/${sku}">
<script type="application/ld+json">${JSON.stringify(ld)}</script></head>
<body><h1>Карта оплаты Steam</h1><span>${price} ₽</span>${promoText ? `<div class="promo-badge">${promoText}</div>` : ''}<noframes data-apiary="patch">${body}</noframes></body></html>`;
}

export const captchaHtml = `<!doctype html><html><head><title>Ой!</title></head><body>
<div class="CheckboxCaptcha">Подтвердите, что запросы отправляли вы, а не робот</div>
<form method="get" action="/pass"><input type="hidden" name="retpath" value="/card/karta-steam/123"><input id="js-button" class="CheckboxCaptcha-Button" type="submit" value="Я не робот"></form>
</body></html>`;
