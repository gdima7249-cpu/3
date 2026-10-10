package ru.warmod.core;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/** Всё состояние мира войны без привязки к Minecraft: страны, кошельки, правила. */
public final class WarState {
    public record Result(boolean ok, String message) {
        public static Result ok(String m) { return new Result(true, m); }
        public static Result fail(String m) { return new Result(false, m); }
    }

    /** Итог захвата страны: бывшие бойцы получают выбор, служить ли победителю. */
    public record Conquest(List<UUID> formerMembers, long spoils) {
    }

    private static final Pattern NAME = Pattern.compile("[\\p{L}\\p{N}_ ]{3,16}");

    public Map<String, Country> countries = new LinkedHashMap<>();
    /** Внутриигровые деньги ($). Не пропадают при смерти - копятся и дают быстрый старт после неё. */
    public Map<UUID, Long> wallets = new HashMap<>();
    /** Сколько ИИ-стран должно существовать (режим соло). 0 - не поддерживать. */
    public int aiTarget;

    public transient Rules rules = new Rules();
    private transient Map<UUID, String> playerCountry = new HashMap<>();
    private transient Deque<Integer> onlineSamples = new ArrayDeque<>();

    public WarState() {
    }

    public static String key(String name) {
        return name.trim().toLowerCase(Locale.ROOT);
    }

    /** Пересобрать индексы после загрузки с диска. */
    public void reindex() {
        playerCountry = new HashMap<>();
        for (Country c : countries.values()) {
            for (UUID id : c.members.keySet()) playerCountry.put(id, c.key());
        }
    }

    // ---------- поиск ----------

    public Country byName(String name) {
        return name == null ? null : countries.get(key(name));
    }

    public Country countryOf(UUID player) {
        String k = playerCountry.get(player);
        return k == null ? null : countries.get(k);
    }

    public Member memberOf(UUID player) {
        Country c = countryOf(player);
        return c == null ? null : c.member(player);
    }

    public List<Country> humanCountries() {
        List<Country> out = new ArrayList<>();
        for (Country c : countries.values()) if (!c.ai) out.add(c);
        return out;
    }

    public List<Country> aiCountries() {
        List<Country> out = new ArrayList<>();
        for (Country c : countries.values()) if (c.ai) out.add(c);
        return out;
    }

    // ---------- деньги ----------

    public long balance(UUID id) {
        return wallets.getOrDefault(id, rules.startBalance);
    }

    public void ensureWallet(UUID id) {
        wallets.putIfAbsent(id, rules.startBalance);
    }

    public void give(UUID id, long amount) {
        wallets.put(id, balance(id) + amount);
    }

    public boolean take(UUID id, long amount) {
        long b = balance(id);
        if (amount < 0 || b < amount) return false;
        wallets.put(id, b - amount);
        return true;
    }

    // ---------- лимиты и цена входа ----------

    public void recordOnline(int online) {
        onlineSamples.addLast(online);
        while (onlineSamples.size() > 60) onlineSamples.removeFirst();
    }

    public double averageOnline(int currentOnline) {
        if (onlineSamples.isEmpty()) return currentOnline;
        double sum = 0;
        for (int v : onlineSamples) sum += v;
        return Math.max(sum / onlineSamples.size(), currentOnline);
    }

    /** Лимит бойцов в стране: средний онлайн сервера x множитель (50 онлайн -> 100 мест). */
    public int memberLimit(int currentOnline) {
        return Math.max(rules.minLimit, (int) Math.ceil(averageOnline(currentOnline) * rules.limitMultiplier));
    }

    public double averageSize() {
        int total = 0, n = 0;
        for (Country c : countries.values()) {
            if (c.ai || c.size() == 0) continue;
            total += c.size();
            n++;
        }
        return n == 0 ? 0 : (double) total / n;
    }

    /**
     * Цена вступления. Больше средней страны - платишь (большие страны не нужны, маленьким нужны люди),
     * меньше средней - тебе платят бонус. Отрицательное число = бонус.
     */
    public long joinPrice(Country c) {
        double avg = averageSize();
        if (avg <= 0 || humanCountries().size() < 2) return 0;
        double ratio = c.size() / avg;
        long p = Math.round(rules.joinBase * (ratio - 1.0));
        return Math.max(-rules.maxJoinBonus, Math.min(rules.maxJoinFee, p));
    }

    // ---------- создание, вступление, выход ----------

    public static boolean validName(String n) {
        return n != null && NAME.matcher(n.trim()).matches();
    }

    public Result create(UUID id, String playerName, String name, String color, String world,
                         int x, int y, int z, boolean free, long shieldMs, long now) {
        if (countryOf(id) != null) return Result.fail("Ты уже состоишь в стране. Сначала выйди: /war leave");
        if (!validName(name)) return Result.fail("Название: 3-16 символов, буквы/цифры/пробел/_");
        if (byName(name) != null) return Result.fail("Страна с таким названием уже есть.");
        if (!free && !take(id, rules.createCost)) {
            return Result.fail("Создание страны стоит " + rules.createCost + "$ (у тебя " + balance(id) + "$).");
        }
        Country c = new Country();
        c.name = name.trim();
        c.color = color == null ? "RED" : color.toUpperCase(Locale.ROOT);
        c.leader = id;
        c.world = world;
        c.x = x; c.y = y; c.z = z;
        c.createdAt = now;
        c.shieldUntil = now + shieldMs;
        Member m = new Member(id, playerName, Rank.GENERAL, now);
        c.members.put(id, m);
        countries.put(c.key(), c);
        playerCountry.put(id, c.key());
        return Result.ok("Страна " + c.name + " основана! Ты - Генерал. Построй крепость вокруг флага.");
    }

    public Country createAi(String name, String color, String world, int x, int y, int z, int strength, long shieldMs, long now) {
        Country c = new Country();
        c.name = name;
        c.color = color;
        c.ai = true;
        c.strength = strength;
        c.world = world;
        c.x = x; c.y = y; c.z = z;
        c.createdAt = now;
        c.shieldUntil = now + shieldMs;
        c.treasury = 200L * strength;
        countries.put(c.key(), c);
        return c;
    }

    public Result join(UUID id, String playerName, Country c, int currentOnline, long now) {
        if (c == null) return Result.fail("Такой страны нет.");
        if (c.ai) return Result.fail("Это страна ИИ - к ней нельзя присоединиться, её можно только захватить.");
        if (countryOf(id) != null) return Result.fail("Ты уже состоишь в стране. Сначала выйди: /war leave");
        int limit = memberLimit(currentOnline);
        if (c.size() >= limit) return Result.fail("Страна заполнена (" + c.size() + "/" + limit + ").");
        long price = joinPrice(c);
        if (price > 0) {
            if (!take(id, price)) return Result.fail("Вход в крупную страну стоит " + price + "$ (у тебя " + balance(id) + "$).");
            c.treasury += price;
        } else if (price < 0) {
            give(id, -price);
        }
        addMember(c, id, playerName, Rank.PRIVATE, now);
        String extra = price > 0 ? " Ты заплатил " + price + "$ в казну." : price < 0 ? " Бонус за вступление в малую страну: +" + (-price) + "$." : "";
        return Result.ok("Ты вступил в " + c.name + " рядовым." + extra);
    }

    /** Добавить бойца без проверок (захват страны, администратор). */
    public void addMember(Country c, UUID id, String name, Rank rank, long now) {
        c.members.put(id, new Member(id, name, rank, now));
        playerCountry.put(id, c.key());
    }

    /** Выход из страны. Лидер передаёт власть преемнику; если бойцов нет - страна распускается. */
    public Result leave(UUID id) {
        Country c = countryOf(id);
        if (c == null) return Result.fail("Ты не состоишь в стране.");
        c.members.remove(id);
        playerCountry.remove(id);
        if (c.members.isEmpty()) {
            countries.remove(c.key());
            return Result.ok("Ты покинул страну " + c.name + ". Страна распущена.");
        }
        if (id.equals(c.leader)) {
            UUID heir = pickHeir(c, id);
            c.leader = heir;
            c.members.get(heir).rank = Rank.GENERAL;
            return Result.ok("Ты покинул страну " + c.name + ". Власть перешла к " + c.members.get(heir).name + ".");
        }
        return Result.ok("Ты покинул страну " + c.name + ".");
    }

    private UUID pickHeir(Country c, UUID except) {
        return c.members.values().stream()
                .filter(m -> !m.id.equals(except))
                .max(Comparator.comparingInt((Member m) -> m.rank.level)
                        .thenComparingInt(m -> m.merit)
                        .thenComparingLong(m -> -m.joinedAt))
                .map(m -> m.id).orElse(null);
    }

    /** Лидер погиб: государство больше не его. Возвращает true, если власть перешла к другому. */
    public Result leaderDied(UUID id) {
        Country c = countryOf(id);
        if (c == null || c.ai || !id.equals(c.leader) || !rules.leaderDeathLosesCountry) return Result.fail("");
        UUID heir = pickHeir(c, id);
        if (heir == null) return Result.fail("Некому передать власть.");
        c.leader = heir;
        c.members.get(heir).rank = Rank.GENERAL;
        c.members.get(id).rank = rules.leaderDemotedTo;
        return Result.ok(c.members.get(id).name + " пал в бою - страна " + c.name + " больше ему не принадлежит. Новый правитель: "
                + c.members.get(heir).name + "!");
    }

    // ---------- звания ----------

    public Result promote(UUID actor, UUID target) {
        Country c = countryOf(actor);
        if (c == null || c != countryOf(target)) return Result.fail("Игрок не в вашей стране.");
        Member a = c.member(actor), t = c.member(target);
        if (actor.equals(target)) return Result.fail("Себя повысить нельзя.");
        if (!a.rank.atLeast(Rank.OFFICER)) return Result.fail("Повышать могут офицеры и генералы.");
        Rank to = t.rank.next();
        if (to == t.rank) return Result.fail("Это уже высшее звание.");
        boolean isLeader = actor.equals(c.leader);
        if (to == Rank.GENERAL && !isLeader) return Result.fail("Генералов назначает только правитель.");
        if (to.level >= a.rank.level && !isLeader) return Result.fail("Нельзя повысить до своего звания или выше.");
        if (to == Rank.OFFICER && t.merit < rules.officerMerit && !isLeader) {
            return Result.fail("Для офицера нужно " + rules.officerMerit + " заслуг (у бойца " + t.merit + ").");
        }
        if (to == Rank.SERGEANT && t.merit < rules.sergeantMerit && !isLeader) {
            return Result.fail("Для сержанта нужно " + rules.sergeantMerit + " заслуг (у бойца " + t.merit + ").");
        }
        t.rank = to;
        return Result.ok(t.name + " повышен до звания: " + to.title + ".");
    }

    public Result demote(UUID actor, UUID target) {
        Country c = countryOf(actor);
        if (c == null || c != countryOf(target)) return Result.fail("Игрок не в вашей стране.");
        Member a = c.member(actor), t = c.member(target);
        if (target.equals(c.leader)) return Result.fail("Правителя понизить нельзя.");
        boolean isLeader = actor.equals(c.leader);
        if (!a.rank.atLeast(Rank.OFFICER) || (a.rank.level <= t.rank.level && !isLeader)) {
            return Result.fail("Понижать можно только тех, кто ниже тебя (нужен чин офицера или выше).");
        }
        if (t.rank == Rank.PRIVATE) return Result.fail("Это низшее звание.");
        t.rank = t.rank.prev();
        return Result.ok(t.name + " понижен до звания: " + t.rank.title + ".");
    }

    public Result fire(UUID actor, UUID target) {
        Country c = countryOf(actor);
        if (c == null || c != countryOf(target)) return Result.fail("Игрок не в вашей стране.");
        Member a = c.member(actor), t = c.member(target);
        if (actor.equals(target)) return Result.fail("Чтобы уйти самому, используй /war leave.");
        if (target.equals(c.leader)) return Result.fail("Правителя уволить нельзя.");
        boolean ok = a.rank == Rank.GENERAL || (a.rank == Rank.OFFICER && t.rank == Rank.PRIVATE);
        if (!ok) return Result.fail("Генерал увольняет любого, офицер - только рядовых.");
        c.members.remove(target);
        playerCountry.remove(target);
        return Result.ok(t.name + " уволен из армии.");
    }

    /** Заслуги; рядовой автоматически становится сержантом. Возвращает новое звание или null. */
    public Rank addMerit(UUID id, int amount) {
        Member m = memberOf(id);
        if (m == null || amount <= 0) return null;
        m.merit += amount;
        if (m.rank == Rank.PRIVATE && m.merit >= rules.sergeantMerit) {
            m.rank = Rank.SERGEANT;
            return m.rank;
        }
        return null;
    }

    // ---------- казна ----------

    public Result deposit(UUID id, long amount) {
        Country c = countryOf(id);
        if (c == null) return Result.fail("Ты не в стране.");
        if (amount <= 0 || !take(id, amount)) return Result.fail("Недостаточно денег.");
        c.treasury += amount;
        return Result.ok("В казну внесено " + amount + "$. Теперь там " + c.treasury + "$.");
    }

    public Result withdraw(UUID id, long amount) {
        Country c = countryOf(id);
        if (c == null) return Result.fail("Ты не в стране.");
        if (c.member(id).rank != Rank.GENERAL) return Result.fail("Казной распоряжаются только генералы.");
        if (amount <= 0 || amount > c.treasury) return Result.fail("В казне нет столько денег.");
        c.treasury -= amount;
        give(id, amount);
        return Result.ok("Из казны снято " + amount + "$.");
    }

    // ---------- захват страны ----------

    /**
     * Страна захвачена: исчезает с карты, казна достаётся победителю.
     * Бывшие бойцы остаются без страны - им предложат служить победителю, а отказавшиеся принесут компенсацию.
     */
    public Conquest conquest(Country winner, Country loser, long now) {
        List<UUID> former = new ArrayList<>(loser.members.keySet());
        for (UUID id : former) playerCountry.remove(id);
        countries.remove(loser.key());
        long spoils = loser.treasury + (loser.ai ? 300L * loser.strength : 0);
        winner.treasury += spoils;
        winner.conquests++;
        winner.addScore(rules.conquestPoints, now);
        if (winner.ai) winner.strength += Math.max(1, loser.strength / 2);
        return new Conquest(former, spoils);
    }

    /** Роспуск страны администратором: бойцы остаются без страны. */
    public void dissolve(Country c) {
        for (UUID id : c.members.keySet()) playerCountry.remove(id);
        countries.remove(c.key());
    }

    public long payCompensation(Country winner, int refusals) {
        long sum = rules.compensationPerRefusal * refusals;
        winner.treasury += sum;
        return sum;
    }

    // ---------- рейтинг ----------

    /** Рейтинг стран-людей по ключу периода: "all", "y:2026", "m:2026-10". */
    public List<Country> ranking(String period) {
        List<Country> list = new ArrayList<>(humanCountries());
        list.sort(Comparator.comparingLong((Country c) -> c.scoreOf(period)).reversed());
        list.removeIf(c -> c.scoreOf(period) <= 0);
        return list;
    }
}
