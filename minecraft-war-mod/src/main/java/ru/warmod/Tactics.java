package ru.warmod;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Particle;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.entity.TNTPrimed;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.MapMeta;
import org.bukkit.map.MapRenderer;
import org.bukkit.map.MapView;
import org.bukkit.persistence.PersistentDataType;
import ru.warmod.core.Country;
import ru.warmod.core.Member;
import ru.warmod.core.Rank;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;

/**
 * Тактика: командир отмечает на карте маршрут, выбирает режим (выдвижение / атака / оборона)
 * и отправляет его бойцам или отрядам. Бойцы видят точку лучом, стрелкой и компасом.
 */
public final class Tactics {
    public enum Mode {
        MOVE("Выдвижение", "MOVE"), ATTACK("Атака", "ATTACK"), DEFEND("Оборона", "DEFEND");

        public final String title, latin;

        Mode(String title, String latin) {
            this.title = title;
            this.latin = latin;
        }

        public Mode next() {
            return values()[(ordinal() + 1) % values().length];
        }
    }

    public static final class Plan {
        public Mode mode = Mode.MOVE;
        public final List<Location> points = new ArrayList<>();
        /** Кому уходит приказ: "all", имя отряда или ник бойца. */
        public String target = "all";
    }

    public static final class Squad {
        public final String name;
        public final UUID owner;
        public final Set<UUID> members = new LinkedHashSet<>();

        Squad(String name, UUID owner) {
            this.name = name;
            this.owner = owner;
        }
    }

    private static final class Active {
        Mode mode;
        List<Location> points;
        int index;
        String issuer;
        UUID issuerId;
    }

    public static final int MAX_POINTS = 8;
    private static final String[] ARROWS = {"↑", "↗", "→", "↘", "↓", "↙", "←", "↖"};

    private final WarMod plugin;
    private final Map<UUID, Plan> plans = new HashMap<>();
    /** ключ страны -> (имя отряда в нижнем регистре -> отряд) */
    private final Map<String, Map<String, Squad>> squads = new HashMap<>();
    private final Map<UUID, Active> active = new HashMap<>();
    private final Random random = new Random();
    private int ticks;

    public Tactics(WarMod plugin) {
        this.plugin = plugin;
    }

    public Plan plan(UUID id) {
        return plans.computeIfAbsent(id, k -> new Plan());
    }

    public String orderOf(UUID id) {
        Active a = active.get(id);
        if (a == null) return null;
        return a.mode.title + ": точка " + Math.min(a.index + 1, a.points.size()) + "/" + a.points.size() + " (от " + a.issuer + ")";
    }

    // ---------- карта командира ----------

    public boolean canUseMap(Player p) {
        Member m = plugin.state.memberOf(p.getUniqueId());
        return m != null && m.rank.canAssignTasks();
    }

    public ItemStack createMap(Player p) {
        MapView view = Bukkit.createMap(p.getWorld());
        view.setScale(MapView.Scale.NORMAL);
        view.setCenterX(p.getLocation().getBlockX());
        view.setCenterZ(p.getLocation().getBlockZ());
        view.setTrackingPosition(false);
        view.addRenderer(new TacticalRenderer(plugin));
        ItemStack it = new ItemStack(Material.FILLED_MAP);
        MapMeta mm = (MapMeta) it.getItemMeta();
        mm.setMapView(view);
        mm.setDisplayName(Msg.c("&6Тактическая карта"));
        mm.setLore(List.of(
                Msg.c("&7ПКМ по земле - добавить точку маршрута"),
                Msg.c("&7ЛКМ - режим: выдвижение / атака / оборона"),
                Msg.c("&7ПКМ в воздух - отправить приказ"),
                Msg.c("&7Shift+ПКМ - центрировать карту на себе")));
        mm.getPersistentDataContainer().set(plugin.keyMap, PersistentDataType.BYTE, (byte) 1);
        it.setItemMeta(mm);
        return it;
    }

    public boolean isMap(ItemStack it) {
        return it != null && it.getType() == Material.FILLED_MAP && it.hasItemMeta()
                && it.getItemMeta().getPersistentDataContainer().has(plugin.keyMap, PersistentDataType.BYTE);
    }

    /** После перезапуска сервера отрисовщики карт теряются - вернуть их. */
    public void ensureRenderer(ItemStack it) {
        if (!isMap(it)) return;
        MapView view = ((MapMeta) it.getItemMeta()).getMapView();
        if (view == null) return;
        for (MapRenderer r : view.getRenderers()) if (r instanceof TacticalRenderer) return;
        view.addRenderer(new TacticalRenderer(plugin));
    }

    public void ensureRenderers(Player p) {
        for (ItemStack it : p.getInventory().getContents()) ensureRenderer(it);
    }

    public void recenter(Player p, ItemStack it) {
        MapView view = ((MapMeta) it.getItemMeta()).getMapView();
        if (view == null) return;
        view.setCenterX(p.getLocation().getBlockX());
        view.setCenterZ(p.getLocation().getBlockZ());
        plugin.tell(p, "Карта центрирована на тебе.");
    }

    // ---------- маршрут ----------

    public boolean addPoint(Player p, Location l) {
        Plan plan = plan(p.getUniqueId());
        if (plan.points.size() >= MAX_POINTS) {
            plugin.tell(p, "&cМаксимум " + MAX_POINTS + " точек. /war order undo | clear");
            return false;
        }
        plan.points.add(l.clone());
        plugin.tell(p, "Точка " + plan.points.size() + ": " + l.getBlockX() + " " + l.getBlockY() + " " + l.getBlockZ()
                + " &7(режим: " + plan.mode.title + ")");
        return true;
    }

    public void cycleMode(Player p) {
        Plan plan = plan(p.getUniqueId());
        plan.mode = plan.mode.next();
        p.sendActionBar(Msg.c("&6Режим приказа: &e" + plan.mode.title));
    }

    // ---------- squads ----------

    private Map<String, Squad> squadsOf(Country c) {
        return squads.computeIfAbsent(c.key(), k -> new LinkedHashMap<>());
    }

    public Squad squad(Country c, String name) {
        return squadsOf(c).get(name.toLowerCase(Locale.ROOT));
    }

    public Squad createSquad(Country c, String name, UUID owner) {
        if (squad(c, name) != null) return null;
        Squad s = new Squad(name, owner);
        squadsOf(c).put(name.toLowerCase(Locale.ROOT), s);
        return s;
    }

    public void disbandSquad(Country c, String name) {
        squadsOf(c).remove(name.toLowerCase(Locale.ROOT));
    }

    public List<Squad> squadList(Country c) {
        return new ArrayList<>(squadsOf(c).values());
    }

    // ---------- приказы ----------

    /** Кого может вести этот командир по строке цели; возвращает только тех, кто ниже званием. */
    public List<Player> targets(Player issuer, Country c, String target) {
        Rank mine = c.member(issuer.getUniqueId()).rank;
        List<Player> out = new ArrayList<>();
        if (target == null || target.equalsIgnoreCase("all")) {
            for (Player p : plugin.onlinePlayers(c)) out.add(p);
        } else if (squad(c, target) != null) {
            for (UUID id : squad(c, target).members) {
                Player p = Bukkit.getPlayer(id);
                if (p != null) out.add(p);
            }
        } else {
            Player p = Bukkit.getPlayerExact(target);
            if (p != null && c.members.containsKey(p.getUniqueId())) out.add(p);
        }
        out.removeIf(p -> p.getUniqueId().equals(issuer.getUniqueId())
                || !mine.canCommand(c.member(p.getUniqueId()).rank));
        return out;
    }

    public void send(Player issuer) {
        Country c = plugin.state.countryOf(issuer.getUniqueId());
        if (c == null || !canUseMap(issuer)) {
            plugin.tell(issuer, "&cПриказы отдают сержанты и выше.");
            return;
        }
        Plan plan = plan(issuer.getUniqueId());
        if (plan.points.isEmpty()) {
            plugin.tell(issuer, "&cНа карте нет точек. ПКМ по земле картой или /war order add.");
            return;
        }
        Rank rank = c.member(issuer.getUniqueId()).rank;
        if (plan.mode == Mode.ATTACK && !rank.atLeast(Rank.OFFICER)) {
            plugin.tell(issuer, "&cОперации по атаке ведут офицеры и генералы. Сержант может отдать выдвижение и оборону.");
            return;
        }
        List<Player> list = targets(issuer, c, plan.target);
        if (list.isEmpty()) {
            plugin.tell(issuer, "&cНекому отдавать приказ: цель '" + plan.target + "' пуста или не ниже тебя званием.");
            return;
        }
        for (Player t : list) {
            Active a = new Active();
            a.mode = plan.mode;
            a.points = new ArrayList<>();
            for (Location l : plan.points) a.points.add(l.clone());
            a.issuer = issuer.getName();
            a.issuerId = issuer.getUniqueId();
            active.put(t.getUniqueId(), a);
            plugin.tell(t, "&cПРИКАЗ от " + rank.title + " " + issuer.getName() + ": &e" + plan.mode.title
                    + " &7(точек: " + plan.points.size() + "). Следуй за лучом и стрелкой.");
        }
        plugin.tell(issuer, "Приказ (" + plan.mode.title + ") отправлен бойцам: " + list.size() + ".");
    }

    public void cancel(Player issuer, String target) {
        Country c = plugin.state.countryOf(issuer.getUniqueId());
        if (c == null) return;
        int n = 0;
        for (Player t : targets(issuer, c, target)) {
            if (active.remove(t.getUniqueId()) != null) {
                n++;
                plugin.tell(t, "Приказ отменён командиром.");
            }
        }
        plugin.tell(issuer, "Отменено приказов: " + n);
    }

    public void cancelOwn(Player soldier) {
        active.remove(soldier.getUniqueId());
    }

    // ---------- артиллерия ----------

    public static final long ARTILLERY_COST = 300;

    /** Огневой налёт по последней точке маршрута. Заказывают офицеры и генералы за счёт казны. */
    public void artillery(Player p) {
        Country c = plugin.state.countryOf(p.getUniqueId());
        if (c == null || !c.member(p.getUniqueId()).rank.canEquipTroops()) {
            plugin.tell(p, "&cАртиллерию вызывают офицеры и генералы.");
            return;
        }
        Plan plan = plan(p.getUniqueId());
        if (plan.points.isEmpty()) {
            plugin.tell(p, "&cОтметь цель на карте: последняя точка маршрута станет целью.");
            return;
        }
        Location target = plan.points.get(plan.points.size() - 1);
        Country zone = plugin.flags.zoneAt(target);
        if (zone == c) {
            plugin.tell(p, "&cНельзя бить по своей территории.");
            return;
        }
        if (c.treasury < ARTILLERY_COST) {
            plugin.tell(p, "&cОгневой налёт стоит " + ARTILLERY_COST + "$ из казны (там " + c.treasury + "$).");
            return;
        }
        c.treasury -= ARTILLERY_COST;
        World w = target.getWorld();
        plugin.tellCountry(c, "&6Артиллерия: огонь по " + target.getBlockX() + " " + target.getBlockZ() + " через 5 секунд! Не подходите!");
        for (int i = 0; i < 8; i++) {
            Bukkit.getScheduler().runTaskLater(plugin, () -> {
                double dx = random.nextGaussian() * 3, dz = random.nextGaussian() * 3;
                Location at = target.clone().add(dx, 0, dz);
                at.setY(w.getHighestBlockYAt(at) + 40);
                TNTPrimed tnt = w.spawn(at, TNTPrimed.class);
                tnt.setFuseTicks(60);
                tnt.setYield(3.5f);
                tnt.setSource(p);
            }, 100L + i * 15L);
        }
    }

    // ---------- ход выполнения ----------

    public void tick() {
        ticks++;
        for (Map.Entry<UUID, Active> en : new ArrayList<>(active.entrySet())) {
            Player p = Bukkit.getPlayer(en.getKey());
            Active a = en.getValue();
            Country c = p == null ? null : plugin.state.countryOf(p.getUniqueId());
            if (p == null || c == null) {
                if (p != null) active.remove(en.getKey());
                continue;
            }
            Location wp = a.points.get(Math.min(a.index, a.points.size() - 1));
            if (!wp.getWorld().equals(p.getWorld())) continue;
            double dx = wp.getX() - p.getLocation().getX(), dz = wp.getZ() - p.getLocation().getZ();
            double dist = Math.sqrt(dx * dx + dz * dz);
            p.setCompassTarget(wp);

            if (dist < 6 && a.index < a.points.size()) {
                a.index++;
                if (a.index < a.points.size()) {
                    plugin.tell(p, "Точка достигнута. Следующая: " + (a.index + 1) + "/" + a.points.size());
                    continue;
                }
                if (a.mode == Mode.DEFEND) {
                    plugin.tell(p, "Рубеж занят - держи оборону. Приказ снимет командир.");
                    a.index = a.points.size() - 1;
                    continue;
                }
                finish(p, c, a);
                continue;
            }

            float yaw = p.getLocation().getYaw();
            double bearing = Math.toDegrees(Math.atan2(-dx, dz));
            double rel = ((bearing - yaw) % 360 + 540) % 360 - 180;
            String arrow = ARROWS[((int) Math.round(rel / 45.0) + 8) % 8];
            p.sendActionBar(Msg.c("&6" + a.mode.title + " &f" + arrow + " &e" + (int) dist + " м &7(точка "
                    + (a.index + 1) + "/" + a.points.size() + ")"));
            if (ticks % 2 == 0) beam(p, wp);
        }
    }

    private void beam(Player p, Location wp) {
        for (int i = 0; i < 12; i++) {
            p.spawnParticle(Particle.END_ROD, wp.getX(), wp.getY() + i, wp.getZ(), 1, 0, 0, 0, 0);
        }
    }

    private void finish(Player p, Country c, Active a) {
        active.remove(p.getUniqueId());
        long reward = Math.min(25, c.treasury);
        c.treasury -= reward;
        plugin.state.give(p.getUniqueId(), reward);
        Rank up = plugin.state.addMerit(p.getUniqueId(), 8);
        plugin.tell(p, "&aПриказ выполнен: " + a.mode.title + ". &6+" + reward + "$ &7(из казны)");
        Player issuer = Bukkit.getPlayer(a.issuerId);
        if (issuer != null) plugin.tell(issuer, p.getName() + " выполнил приказ (" + a.mode.title + ").");
        if (up != null) {
            plugin.tell(p, "Ты повышен до звания: &b" + up.title + "&f!");
            plugin.refresh(p);
        }
    }

    // ---------- сохранение ----------

    /** Плоские данные для JSON: отряды, маршруты командиров и действующие приказы. */
    public static final class Data {
        public Map<String, List<SquadDto>> squads = new HashMap<>();
        public Map<UUID, PlanDto> plans = new HashMap<>();
        public Map<UUID, ActiveDto> active = new HashMap<>();
    }

    public static final class SquadDto {
        public String name;
        public UUID owner;
        public List<UUID> members = new ArrayList<>();
    }

    public static final class PointDto {
        public String world;
        public double x, y, z;
    }

    public static final class PlanDto {
        public String mode, target;
        public List<PointDto> points = new ArrayList<>();
    }

    public static final class ActiveDto {
        public String mode, issuer;
        public UUID issuerId;
        public int index;
        public List<PointDto> points = new ArrayList<>();
    }

    private static PointDto dto(Location l) {
        PointDto d = new PointDto();
        d.world = l.getWorld().getName();
        d.x = l.getX();
        d.y = l.getY();
        d.z = l.getZ();
        return d;
    }

    private static List<Location> locations(List<PointDto> list) {
        List<Location> out = new ArrayList<>();
        for (PointDto d : list) {
            World w = Bukkit.getWorld(d.world);
            if (w != null) out.add(new Location(w, d.x, d.y, d.z));
        }
        return out;
    }

    private static Mode mode(String s) {
        try {
            return Mode.valueOf(s);
        } catch (Exception e) {
            return Mode.MOVE;
        }
    }

    public Data export() {
        Data d = new Data();
        for (Map.Entry<String, Map<String, Squad>> en : squads.entrySet()) {
            List<SquadDto> list = new ArrayList<>();
            for (Squad sq : en.getValue().values()) {
                SquadDto sd = new SquadDto();
                sd.name = sq.name;
                sd.owner = sq.owner;
                sd.members.addAll(sq.members);
                list.add(sd);
            }
            d.squads.put(en.getKey(), list);
        }
        for (Map.Entry<UUID, Plan> en : plans.entrySet()) {
            PlanDto pd = new PlanDto();
            pd.mode = en.getValue().mode.name();
            pd.target = en.getValue().target;
            for (Location l : en.getValue().points) pd.points.add(dto(l));
            d.plans.put(en.getKey(), pd);
        }
        for (Map.Entry<UUID, Active> en : active.entrySet()) {
            Active a = en.getValue();
            ActiveDto ad = new ActiveDto();
            ad.mode = a.mode.name();
            ad.issuer = a.issuer;
            ad.issuerId = a.issuerId;
            ad.index = a.index;
            for (Location l : a.points) ad.points.add(dto(l));
            d.active.put(en.getKey(), ad);
        }
        return d;
    }

    public void load(Data d) {
        if (d == null) return;
        squads.clear();
        plans.clear();
        active.clear();
        if (d.squads != null) {
            for (Map.Entry<String, List<SquadDto>> en : d.squads.entrySet()) {
                Map<String, Squad> m = new LinkedHashMap<>();
                for (SquadDto sd : en.getValue()) {
                    Squad sq = new Squad(sd.name, sd.owner);
                    sq.members.addAll(sd.members);
                    m.put(sd.name.toLowerCase(Locale.ROOT), sq);
                }
                squads.put(en.getKey(), m);
            }
        }
        if (d.plans != null) {
            for (Map.Entry<UUID, PlanDto> en : d.plans.entrySet()) {
                Plan p = new Plan();
                p.mode = mode(en.getValue().mode);
                p.target = en.getValue().target == null ? "all" : en.getValue().target;
                p.points.addAll(locations(en.getValue().points));
                plans.put(en.getKey(), p);
            }
        }
        if (d.active != null) {
            for (Map.Entry<UUID, ActiveDto> en : d.active.entrySet()) {
                Active a = new Active();
                a.mode = mode(en.getValue().mode);
                a.issuer = en.getValue().issuer;
                a.issuerId = en.getValue().issuerId;
                a.points = locations(en.getValue().points);
                a.index = Math.max(0, Math.min(en.getValue().index, Math.max(0, a.points.size() - 1)));
                if (!a.points.isEmpty()) active.put(en.getKey(), a);
            }
        }
    }
}
