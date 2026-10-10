package ru.warmod;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;
import ru.warmod.core.Country;
import ru.warmod.core.Member;
import ru.warmod.core.Rank;
import ru.warmod.core.Task;
import ru.warmod.core.WarState;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import java.util.UUID;

public final class WarCommand implements CommandExecutor, TabCompleter {
    private static final List<String> SUBS = List.of("help", "menu", "list", "info", "create", "join", "leave", "accept",
            "balance", "pay", "deposit", "withdraw", "members", "promote", "demote", "fire", "shop", "buy", "kit",
            "task", "assign", "confirm", "setcapital", "solo", "top", "admin");

    private final WarMod plugin;
    private final Random random = new Random();

    public WarCommand(WarMod plugin) {
        this.plugin = plugin;
    }

    private WarState st() {
        return plugin.state;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String sub = args.length == 0 ? "help" : args[0].toLowerCase(Locale.ROOT);
        if (!(sender instanceof Player p)) {
            if (sub.equals("admin")) return admin(sender, args);
            sender.sendMessage("Команды доступны игрокам. Из консоли: /war admin ...");
            return true;
        }
        switch (sub) {
            case "help" -> help(p);
            case "menu" -> CountryMenu.open(plugin, p);
            case "list" -> list(p);
            case "info" -> info(p, args);
            case "create" -> create(p, args);
            case "join" -> join(p, args);
            case "leave" -> leave(p);
            case "accept" -> accept(p);
            case "balance", "bal" -> plugin.tell(p, "Твои деньги: &6" + st().balance(p.getUniqueId()) + "$");
            case "pay" -> pay(p, args);
            case "deposit" -> money(p, args, true);
            case "withdraw" -> money(p, args, false);
            case "members" -> members(p);
            case "promote", "demote", "fire" -> rankAction(p, sub, args);
            case "shop" -> shopList(p);
            case "buy" -> buy(p, args);
            case "kit" -> kit(p, args);
            case "task" -> task(p, args);
            case "assign" -> assign(p, args);
            case "confirm" -> confirm(p, args);
            case "setcapital" -> setCapital(p);
            case "solo" -> solo(p, args);
            case "top" -> top(p, args);
            case "admin" -> admin(p, args);
            default -> plugin.tell(p, "Неизвестная команда. &e/war help");
        }
        return true;
    }

    // ---------- помощь, списки ----------

    private void help(Player p) {
        String[] lines = {
                "&6=== Война стран ===",
                "&e/war menu &7- выбрать страну", "&e/war create <название> [цвет] &7- основать страну",
                "&e/war solo <название> [число ИИ] &7- играть против ИИ", "&e/war join <страна> &7| &e/war leave",
                "&e/war info [страна] &7| &e/war list &7| &e/war members", "&e/war task &7| &e/war task new &7- задания",
                "&e/war shop &7| &e/war buy <товар> &7- снаряжение за свои $",
                "&e/war kit <боец> <товар> &7- вооружить бойца из казны (офицер+)",
                "&e/war promote|demote|fire <боец> &7- ранги", "&e/war assign <боец> <награда> <текст> &7- приказ (сержант+)",
                "&e/war confirm <боец> &7- подтвердить выполнение приказа",
                "&e/war deposit|withdraw <сумма> &7- казна", "&e/war pay <игрок> <сумма> &7| &e/war balance",
                "&e/war setcapital &7- перенести флаг (правитель)", "&e/war top [month|year|all] &7- страна месяца/года",
                "&7Ранги: Рядовой -> Сержант (техника, командование) -> Офицер (операции) -> Генерал (увольнение)."};
        for (String l : lines) p.sendMessage(Msg.c(l));
    }

    private void list(Player p) {
        int limit = st().memberLimit(Bukkit.getOnlinePlayers().size());
        plugin.tell(p, "Страны (лимит бойцов " + limit + "):");
        for (Country c : st().countries.values()) {
            long price = st().joinPrice(c);
            String fee = c.ai ? "&8ИИ, сила " + c.strength
                    : price > 0 ? "&cвход " + price + "$" : price < 0 ? "&aбонус " + (-price) + "$" : "&fвход бесплатно";
            p.sendMessage(Msg.c(" " + Msg.code(c.color) + c.name + " &7- " + c.size() + " бойцов, " + fee));
        }
    }

    private void info(Player p, String[] args) {
        Country c = args.length > 1 ? st().byName(join(args, 1)) : st().countryOf(p.getUniqueId());
        if (c == null) {
            plugin.tell(p, "Страна не найдена.");
            return;
        }
        long now = plugin.now();
        p.sendMessage(Msg.c("&6=== " + Msg.code(c.color) + c.name + (c.ai ? " &7(ИИ)" : "") + " &6==="));
        p.sendMessage(Msg.c("&7Правитель: &f" + (c.leaderMember() == null ? "-" : c.leaderMember().name)));
        p.sendMessage(Msg.c("&7Бойцов: &f" + c.size() + "&7, казна: &6" + c.treasury + "$&7, захватов: &f" + c.conquests));
        p.sendMessage(Msg.c("&7Столица: &f" + c.x + " " + c.y + " " + c.z + " (" + c.world + ")"));
        if (c.ai) p.sendMessage(Msg.c("&7Сила: &f" + c.strength));
        if (now < c.shieldUntil) p.sendMessage(Msg.c("&eЗащита от захвата ещё " + Math.max(1, (c.shieldUntil - now) / 60000) + " мин."));
        p.sendMessage(Msg.c("&7Очки: месяц &f" + c.scoreOf(Country.monthKey(now)) + "&7, год &f" + c.scoreOf(Country.yearKey(now))
                + "&7, всего &f" + c.scoreOf("all")));
    }

    private void members(Player p) {
        Country c = st().countryOf(p.getUniqueId());
        if (c == null) {
            plugin.tell(p, "Ты не в стране.");
            return;
        }
        List<Member> ms = new ArrayList<>(c.members.values());
        ms.sort((a, b) -> b.rank.level != a.rank.level ? b.rank.level - a.rank.level : b.merit - a.merit);
        p.sendMessage(Msg.c("&6Армия " + c.name + " (" + ms.size() + "):"));
        for (Member m : ms) {
            boolean on = Bukkit.getPlayer(m.id) != null;
            p.sendMessage(Msg.c(" " + (on ? "&a" : "&7") + m.name + " &7- " + m.rank.title + ", заслуги " + m.merit
                    + ", убийств " + m.kills));
        }
    }

    private void top(CommandSender p, String[] args) {
        String mode = args.length > 1 ? args[1].toLowerCase(Locale.ROOT) : "month";
        long now = plugin.now();
        String key = switch (mode) {
            case "year", "год" -> Country.yearKey(now);
            case "all", "всё", "все" -> "all";
            default -> Country.monthKey(now);
        };
        List<Country> rank = st().ranking(key);
        p.sendMessage(Msg.c("&6Рейтинг стран (" + key + "):"));
        if (rank.isEmpty()) p.sendMessage(Msg.c("&7Пока никто не набрал очков."));
        int i = 1;
        for (Country c : rank) {
            if (i > 10) break;
            p.sendMessage(Msg.c(" &e" + i++ + ". " + Msg.code(c.color) + c.name + " &7- " + c.scoreOf(key) + " очков, правитель "
                    + (c.leaderMember() == null ? "-" : c.leaderMember().name)));
        }
    }

    // ---------- страны ----------

    private void create(Player p, String[] args) {
        if (args.length < 2) {
            plugin.tell(p, "Использование: /war create <название> [цвет]");
            return;
        }
        String color = null;
        int end = args.length;
        String last = args[args.length - 1].toUpperCase(Locale.ROOT);
        if (args.length > 2 && Msg.COLORS.contains(last)) {
            color = last;
            end--;
        }
        if (color == null) color = Msg.COLORS.get(random.nextInt(Msg.COLORS.size()));
        String name = String.join(" ", Arrays.copyOfRange(args, 1, end));
        Location l = p.getLocation();
        if (tooClose(l)) {
            plugin.tell(p, "Слишком близко к чужой столице. Отойди от других стран.");
            return;
        }
        boolean free = p.hasPermission("warmod.create.free");
        long shield = plugin.getConfig().getLong("war.shield-minutes", 30) * 60_000L;
        WarState.Result r = st().create(p.getUniqueId(), p.getName(), name, color, l.getWorld().getName(),
                l.getBlockX(), l.getBlockY(), l.getBlockZ(), free, shield, plugin.now());
        plugin.tell(p, (r.ok() ? "&a" : "&c") + r.message());
        if (r.ok()) {
            plugin.flags.placeFlag(st().byName(name));
            plugin.refresh(p);
            plugin.broadcast("Основана новая страна: " + Msg.code(color) + name.trim() + "&f! Правитель - &e" + p.getName());
        }
    }

    private boolean tooClose(Location l) {
        int min = plugin.getConfig().getInt("war.claim-radius", 40) * 2;
        for (Country c : st().countries.values()) {
            if (c.world.equals(l.getWorld().getName()) && Math.hypot(c.x - l.getX(), c.z - l.getZ()) < min) return true;
        }
        return false;
    }

    private void join(Player p, String[] args) {
        if (args.length < 2) {
            CountryMenu.open(plugin, p);
            return;
        }
        Country c = st().byName(join(args, 1));
        WarState.Result r = st().join(p.getUniqueId(), p.getName(), c, Bukkit.getOnlinePlayers().size(), plugin.now());
        plugin.tell(p, (r.ok() ? "&a" : "&c") + r.message());
        if (r.ok()) {
            plugin.refresh(p);
            plugin.tellCountry(c, p.getName() + " вступил в армию.");
        }
    }

    private void leave(Player p) {
        Country prev = st().countryOf(p.getUniqueId());
        WarState.Result r = st().leave(p.getUniqueId());
        plugin.tell(p, (r.ok() ? "&a" : "&c") + r.message());
        if (!r.ok()) return;
        plugin.tasks.clear(p.getUniqueId());
        if (prev != null && st().byName(prev.name) == null) plugin.flags.removeVisuals(prev);
        plugin.refreshAll();
    }

    private void accept(Player p) {
        String key = plugin.offers.remove(p.getUniqueId());
        if (key == null) {
            plugin.tell(p, "У тебя нет предложений службы.");
            return;
        }
        Country winner = st().countries.get(key);
        if (winner == null || st().countryOf(p.getUniqueId()) != null) {
            plugin.tell(p, "Предложение уже недействительно.");
            return;
        }
        st().addMember(winner, p.getUniqueId(), p.getName(), Rank.PRIVATE, plugin.now());
        plugin.refresh(p);
        plugin.tell(p, "Ты принят в армию &e" + winner.name + "&f рядовым. Накопления остаются с тобой.");
        plugin.tellCountry(winner, p.getName() + " перешёл на нашу сторону.");
    }

    private void setCapital(Player p) {
        Country c = st().countryOf(p.getUniqueId());
        if (c == null || !p.getUniqueId().equals(c.leader)) {
            plugin.tell(p, "Только правитель переносит столицу.");
            return;
        }
        long cost = 200;
        if (c.treasury < cost) {
            plugin.tell(p, "Перенос флага стоит " + cost + "$ из казны.");
            return;
        }
        Location l = p.getLocation();
        for (Country o : st().countries.values()) {
            if (o != c && o.world.equals(l.getWorld().getName())
                    && Math.hypot(o.x - l.getX(), o.z - l.getZ()) < plugin.getConfig().getInt("war.claim-radius", 40) * 2) {
                plugin.tell(p, "Слишком близко к чужой столице.");
                return;
            }
        }
        c.treasury -= cost;
        plugin.flags.removeVisuals(c);
        c.world = l.getWorld().getName();
        c.x = l.getBlockX();
        c.y = l.getBlockY();
        c.z = l.getBlockZ();
        plugin.flags.placeFlag(c);
        plugin.tellCountry(c, "Столица перенесена на " + c.x + " " + c.y + " " + c.z + ".");
    }

    // ---------- деньги ----------

    private void pay(Player p, String[] args) {
        if (args.length < 3) {
            plugin.tell(p, "Использование: /war pay <игрок> <сумма>");
            return;
        }
        Player t = Bukkit.getPlayerExact(args[1]);
        Long amount = parse(args[2]);
        if (t == null || amount == null || amount <= 0 || t.equals(p)) {
            plugin.tell(p, "&cИгрок не найден или неверная сумма.");
            return;
        }
        if (!st().take(p.getUniqueId(), amount)) {
            plugin.tell(p, "&cНедостаточно денег.");
            return;
        }
        st().give(t.getUniqueId(), amount);
        plugin.tell(p, "Переведено " + amount + "$ игроку " + t.getName() + ".");
        plugin.tell(t, p.getName() + " перевёл тебе &6" + amount + "$");
    }

    private void money(Player p, String[] args, boolean deposit) {
        Long amount = args.length > 1 ? parse(args[1]) : null;
        if (amount == null) {
            plugin.tell(p, "Использование: /war " + (deposit ? "deposit" : "withdraw") + " <сумма>");
            return;
        }
        WarState.Result r = deposit ? st().deposit(p.getUniqueId(), amount) : st().withdraw(p.getUniqueId(), amount);
        plugin.tell(p, (r.ok() ? "&a" : "&c") + r.message());
    }

    // ---------- звания ----------

    private UUID findMember(Country c, String name) {
        for (Member m : c.members.values()) if (m.name.equalsIgnoreCase(name)) return m.id;
        return null;
    }

    private void rankAction(Player p, String action, String[] args) {
        Country c = st().countryOf(p.getUniqueId());
        if (c == null || args.length < 2) {
            plugin.tell(p, "Использование: /war " + action + " <боец своей страны>");
            return;
        }
        UUID target = findMember(c, args[1]);
        if (target == null) {
            plugin.tell(p, "&cТакого бойца нет в твоей армии.");
            return;
        }
        WarState.Result r = switch (action) {
            case "promote" -> st().promote(p.getUniqueId(), target);
            case "demote" -> st().demote(p.getUniqueId(), target);
            default -> st().fire(p.getUniqueId(), target);
        };
        plugin.tell(p, (r.ok() ? "&a" : "&c") + r.message());
        if (!r.ok()) return;
        Player tp = Bukkit.getPlayer(target);
        if (tp != null) {
            plugin.refresh(tp);
            if (action.equals("fire")) {
                plugin.tasks.clear(target);
                plugin.tell(tp, "Тебя уволили из армии. Выбери новую страну: /war menu");
            } else {
                plugin.tell(tp, r.message());
            }
        }
    }

    // ---------- магазин ----------

    private void shopList(Player p) {
        Member m = st().memberOf(p.getUniqueId());
        p.sendMessage(Msg.c("&6Оружейная (твои деньги: " + st().balance(p.getUniqueId()) + "$):"));
        for (Shop.Item it : Shop.ITEMS) {
            boolean ok = m != null && m.rank.atLeast(it.minRank());
            p.sendMessage(Msg.c(" " + (ok ? "&e" : "&8") + it.id() + " &7- " + it.title() + ", &6" + it.price() + "$"
                    + (it.minRank() == Rank.PRIVATE ? "" : " &c[от звания: " + it.minRank().title + "]")));
        }
    }

    private void buy(Player p, String[] args) {
        Country c = st().countryOf(p.getUniqueId());
        Shop.Item item = args.length > 1 ? Shop.find(args[1]) : null;
        if (c == null || item == null) {
            plugin.tell(p, "Использование: /war buy <товар> (список: /war shop). Нужна страна.");
            return;
        }
        if (!c.member(p.getUniqueId()).rank.atLeast(item.minRank())) {
            plugin.tell(p, "&cЭто доверяют только званию " + item.minRank().title + " и выше.");
            return;
        }
        if (!st().take(p.getUniqueId(), item.price())) {
            plugin.tell(p, "&cНужно " + item.price() + "$.");
            return;
        }
        plugin.shop.deliver(p, c, item);
        plugin.tell(p, "Куплено: " + item.title() + " (-" + item.price() + "$)");
    }

    private void kit(Player p, String[] args) {
        Country c = st().countryOf(p.getUniqueId());
        if (c == null || args.length < 3) {
            plugin.tell(p, "Использование: /war kit <боец> <товар>");
            return;
        }
        Member me = c.member(p.getUniqueId());
        if (!me.rank.canEquipTroops()) {
            plugin.tell(p, "&cВооружать войска из казны могут офицеры и генералы.");
            return;
        }
        Player t = Bukkit.getPlayerExact(args[1]);
        Shop.Item item = Shop.find(args[2]);
        if (t == null || item == null || st().countryOf(t.getUniqueId()) != c) {
            plugin.tell(p, "&cБоец не в сети / не из твоей страны, или неизвестный товар.");
            return;
        }
        if (!c.member(t.getUniqueId()).rank.atLeast(item.minRank())) {
            plugin.tell(p, "&cБоец ещё не дорос до звания " + item.minRank().title + ".");
            return;
        }
        if (c.treasury < item.price()) {
            plugin.tell(p, "&cВ казне не хватает денег (" + c.treasury + "/" + item.price() + "$).");
            return;
        }
        c.treasury -= item.price();
        plugin.shop.deliver(t, c, item);
        plugin.tell(p, "Из казны выдано " + t.getName() + ": " + item.title() + " (-" + item.price() + "$)");
        plugin.tell(t, p.getName() + " выдал тебе " + item.title() + " из казны.");
    }

    // ---------- задания ----------

    private void task(Player p, String[] args) {
        Member m = st().memberOf(p.getUniqueId());
        if (m == null) {
            plugin.tell(p, "Сначала вступи в страну: /war menu");
            return;
        }
        String arg = args.length > 1 ? args[1].toLowerCase(Locale.ROOT) : "";
        if (arg.equals("cancel")) {
            plugin.tasks.clear(p.getUniqueId());
            plugin.tell(p, "Задание отменено.");
            return;
        }
        Task t = plugin.tasks.get(p.getUniqueId());
        if (arg.equals("new") || t == null) {
            if (t != null && t.type == Task.Type.CUSTOM) {
                plugin.tell(p, "Сначала выполни приказ командира: " + plugin.tasks.describe(t));
                return;
            }
            t = plugin.tasks.issue(p);
            plugin.tell(p, "Новое задание: " + plugin.tasks.describe(t));
            if (!m.rank.mustFight()) plugin.tell(p, "&7Офицерам необязательно воевать лично - можно раздавать приказы: /war assign");
            return;
        }
        plugin.tell(p, "Текущее задание: " + plugin.tasks.describe(t));
    }

    private void assign(Player p, String[] args) {
        Country c = st().countryOf(p.getUniqueId());
        if (c == null || args.length < 4) {
            plugin.tell(p, "Использование: /war assign <боец> <награда из казны> <текст приказа>");
            return;
        }
        Member me = c.member(p.getUniqueId());
        Player t = Bukkit.getPlayerExact(args[1]);
        Long reward = parse(args[2]);
        if (t == null || st().countryOf(t.getUniqueId()) != c || reward == null || reward < 0) {
            plugin.tell(p, "&cБоец не в сети / не из твоей страны, или неверная награда.");
            return;
        }
        if (!me.rank.canAssignTasks() || !me.rank.canCommand(c.member(t.getUniqueId()).rank)) {
            plugin.tell(p, "&cПриказывать можно только тем, кто ниже тебя званием (от сержанта).");
            return;
        }
        if (reward > c.treasury) {
            plugin.tell(p, "&cВ казне нет такой суммы (" + c.treasury + "$).");
            return;
        }
        String text = String.join(" ", Arrays.copyOfRange(args, 3, args.length));
        plugin.tasks.assign(t.getUniqueId(), Task.custom(p.getName(), reward, text));
        plugin.tell(p, "Приказ отдан " + t.getName() + ". Подтверди выполнение: /war confirm " + t.getName());
        plugin.tell(t, "&cПриказ от " + me.rank.title + " " + p.getName() + ": &e" + text + " &7(награда " + reward + "$)");
    }

    private void confirm(Player p, String[] args) {
        Country c = st().countryOf(p.getUniqueId());
        Player t = args.length > 1 ? Bukkit.getPlayerExact(args[1]) : null;
        if (c == null || t == null || st().countryOf(t.getUniqueId()) != c) {
            plugin.tell(p, "Использование: /war confirm <боец>");
            return;
        }
        if (!c.member(p.getUniqueId()).rank.canCommand(c.member(t.getUniqueId()).rank)) {
            plugin.tell(p, "&cПодтверждать может только вышестоящий.");
            return;
        }
        plugin.tell(p, plugin.tasks.confirm(p, t) ? "Приказ засчитан, награда выплачена." : "&cУ бойца нет твоего приказа.");
    }

    // ---------- соло против ИИ ----------

    private void solo(Player p, String[] args) {
        if (!plugin.getConfig().getBoolean("ai.enabled", true)) {
            plugin.tell(p, "&cРежим ИИ отключён в config.yml.");
            return;
        }
        if (st().countryOf(p.getUniqueId()) != null) {
            plugin.tell(p, "&cСначала выйди из своей страны: /war leave");
            return;
        }
        if (args.length < 2) {
            plugin.tell(p, "Использование: /war solo <название страны> [число ИИ-стран 1-8]");
            return;
        }
        int count = 3;
        int end = args.length;
        Long maybe = parse(args[args.length - 1]);
        if (args.length > 2 && maybe != null) {
            count = (int) Math.max(1, Math.min(8, maybe));
            end--;
        }
        String name = String.join(" ", Arrays.copyOfRange(args, 1, end));
        Location l = p.getLocation();
        if (tooClose(l)) {
            plugin.tell(p, "&cСлишком близко к чужой столице - отойди дальше.");
            return;
        }
        WarState.Result r = st().create(p.getUniqueId(), p.getName(), name, "BLUE", l.getWorld().getName(),
                l.getBlockX(), l.getBlockY(), l.getBlockZ(), true, 10 * 60_000L, plugin.now());
        if (!r.ok()) {
            plugin.tell(p, "&c" + r.message());
            return;
        }
        plugin.flags.placeFlag(st().byName(name));
        st().give(p.getUniqueId(), 300);
        st().aiTarget = Math.max(st().aiTarget, count);
        int made = plugin.ai.refill(p);
        plugin.refresh(p);
        plugin.tell(p, "&aСоло-война началась! Страна &e" + name.trim() + "&a основана, +300$ на старт. Появилось ИИ-стран: " + made + ".");
        plugin.tell(p, "Найди вражеские флаги (/war list, /war info <страна>), перебей гарнизон и удержи флаг. Ждите налётов!");
    }

    // ---------- админ ----------

    private boolean admin(CommandSender s, String[] args) {
        if (!s.hasPermission("warmod.admin")) {
            s.sendMessage(Msg.c("&cНет прав."));
            return true;
        }
        String sub = args.length > 1 ? args[1].toLowerCase(Locale.ROOT) : "";
        switch (sub) {
            case "reload" -> {
                plugin.reload();
                s.sendMessage("Настройки перезагружены.");
            }
            case "save" -> {
                plugin.autosave();
                s.sendMessage("Сохранено.");
            }
            case "give" -> {
                Player t = args.length > 3 ? Bukkit.getPlayerExact(args[2]) : null;
                Long n = args.length > 3 ? parse(args[3]) : null;
                if (t == null || n == null) {
                    s.sendMessage("/war admin give <игрок> <сумма>");
                } else {
                    st().give(t.getUniqueId(), n);
                    s.sendMessage("Выдано " + n + "$ игроку " + t.getName());
                }
            }
            case "disband" -> {
                Country c = args.length > 2 ? st().byName(join(args, 2)) : null;
                if (c == null) {
                    s.sendMessage("/war admin disband <страна>");
                } else {
                    plugin.ai.removeSoldiers(c.key(), plugin.capital(c));
                    plugin.flags.removeVisuals(c);
                    st().dissolve(c);
                    plugin.refreshAll();
                    s.sendMessage("Страна распущена.");
                }
            }
            case "ai" -> {
                Long n = args.length > 2 ? parse(args[2]) : null;
                if (n == null) {
                    s.sendMessage("/war admin ai <число стран ИИ> (со своей позиции)");
                } else if (s instanceof Player p) {
                    st().aiTarget = (int) Math.max(0, Math.min(15, n));
                    s.sendMessage("Создано ИИ-стран: " + plugin.ai.refill(p));
                } else {
                    st().aiTarget = (int) Math.max(0, Math.min(15, n));
                }
            }
            default -> s.sendMessage("/war admin reload|save|give|disband|ai");
        }
        return true;
    }

    // ---------- утилиты ----------

    private static String join(String[] a, int from) {
        return String.join(" ", Arrays.copyOfRange(a, from, a.length));
    }

    private static Long parse(String s) {
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command cmd, String alias, String[] args) {
        List<String> out = new ArrayList<>();
        if (args.length == 1) {
            for (String s : SUBS) if (s.startsWith(args[0].toLowerCase(Locale.ROOT))) out.add(s);
            return out;
        }
        String sub = args[0].toLowerCase(Locale.ROOT);
        String cur = args[args.length - 1].toLowerCase(Locale.ROOT);
        if (args.length == 2) {
            switch (sub) {
                case "join", "info" -> st().countries.values().forEach(c -> out.add(c.name));
                case "promote", "demote", "fire", "assign", "confirm", "kit" -> {
                    Country c = sender instanceof Player p ? st().countryOf(p.getUniqueId()) : null;
                    if (c != null) c.members.values().forEach(m -> out.add(m.name));
                }
                case "buy" -> Shop.ITEMS.forEach(i -> out.add(i.id()));
                case "top" -> out.addAll(List.of("month", "year", "all"));
                case "task" -> out.addAll(List.of("new", "cancel"));
                case "pay" -> Bukkit.getOnlinePlayers().forEach(pl -> out.add(pl.getName()));
                case "admin" -> out.addAll(List.of("reload", "save", "give", "disband", "ai"));
                default -> { }
            }
        } else if (args.length == 3 && sub.equals("kit")) {
            Shop.ITEMS.forEach(i -> out.add(i.id()));
        } else if (sub.equals("create")) {
            out.addAll(Msg.COLORS);
        }
        out.removeIf(s -> !s.toLowerCase(Locale.ROOT).startsWith(cur));
        return out;
    }
}
