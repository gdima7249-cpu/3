// Тарифы: Бесплатный, ПРО, УЛЬТРА. Все лимиты берутся из config (а значит из .env).
export const TIERS = ['free', 'pro', 'ultra'];
export const TIER_TITLE = { free: 'Бесплатный', pro: 'ПРО', ultra: 'УЛЬТРА' };
export const TIER_ICON = { free: '🆓', pro: '⭐', ultra: '💎' };
export const PAID = ['pro', 'ultra'];

export const rank = (tier) => TIERS.indexOf(tier);
export const atLeast = (tier, need) => rank(tier) >= rank(need);
const lim = (n) => (n > 0 ? n : Infinity); // 0 — без ограничения

/** Тариф пользователя сейчас. В режиме FREE_FOR_ALL («всё открыто, без оплаты») у всех лимиты УЛЬТРА. */
export function tierOf(u, config, now = Date.now()) {
  if (config.freeForAll) return 'ultra';
  if (!u?.premium_until || u.premium_until <= now) return 'free';
  return u.tier === 'ultra' ? 'ultra' : 'pro';
}

export function limitsOf(tier, config) {
  return {
    free: {
      alerts: lim(config.freeAlerts),
      alertIntervalMin: config.freeAlertIntervalMin,
      wishlist: lim(config.freeWishlistLimit),
      gamesIntervalMin: config.freeGamesIntervalMin,
      invTtlH: config.freeInvTtlH,
    },
    pro: {
      alerts: lim(config.proAlerts),
      alertIntervalMin: config.proAlertIntervalMin,
      wishlist: lim(config.proWishlistLimit),
      gamesIntervalMin: 0,
      invTtlH: config.proInvTtlH,
    },
    ultra: {
      alerts: lim(config.ultraAlerts),
      alertIntervalMin: 0,
      wishlist: lim(config.ultraWishlistLimit),
      gamesIntervalMin: 0,
      invTtlH: config.ultraInvTtlH,
    },
  }[tier];
}

export const priceRub = (tier, config) => (tier === 'ultra' ? config.ultraPriceRub : config.proPriceRub);
export const priceStars = (tier, config) => (tier === 'ultra' ? config.ultraStars : config.proStars);

/** «каждые 5 мин» / «раз в час» */
export function every(min) {
  if (!min) return 'сразу';
  if (min % 60 === 0) return min === 60 ? 'раз в час' : `раз в ${min / 60} ч`;
  return `каждые ${min} мин`;
}
export const count = (n) => (n === Infinity ? 'без ограничений' : `до ${n}`);
