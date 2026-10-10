package ru.warmod;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Mob;
import org.bukkit.entity.Player;
import org.bukkit.inventory.EntityEquipment;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataType;
import ru.warmod.core.Country;
import ru.warmod.core.Rank;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.UUID;

/**
 * Страны под управлением ИИ: у каждой флаг, крепость и гарнизон из рядовых/сержантов/офицеров/генерала.
 * Они растут со временем, ходят в налёты на людей и воюют друг с другом.
 */
public final class AiManager {
    private static final String[] NAMES = {"Нордланд", "Вестария", "Остерия", "Сюдгард", "Кронберг", "Ардения",
            "Лотария", "Железная Орда", "Красный Союз", "Орден Пепла", "Республика Заря", "Империя Вайс",
            "Тёмная Лига", "Штормград", "Волчья Марка"};
    private static final String[] COLORS = {"GREEN", "PURPLE", "ORANGE", "CYAN", "YELLOW", "BLACK", "BROWN",
            "PINK", "LIME", "GRAY", "MAGENTA", "LIGHT_BLUE"};

    private static final class Raid {
        final List<UUID> soldiers = new ArrayList<>();
        long expires;
        String targetKey;
    }

    private final WarMod plugin;
    private final Random random = new Random();
    private final List<Raid> raids = new ArrayList<>();
    private int growthTicks;

    public AiManager(WarMod plugin) {
        this.plugin = plugin;
    }

    public void start() {
        var sch = Bukkit.getScheduler();
        sch.runTaskTimer(plugin, this::garrisonTick, 100L, 100L);
        sch.runTaskTimer(plugin, this::raidMoveTick, 60L, 60L);
        sch.runTaskTimer(plugin, this::growthTick, 1200L, 1200L);
        long raidEvery = plugin.getConfig().getLong("ai.raid-interval-seconds", 420) * 20L;
        sch.runTaskTimer(plugin, this::raidLaunchTick, raidEvery, raidEvery);
        long warEvery = plugin.getConfig().getLong("ai.war-interval-seconds", 600) * 20L;
        sch.runTaskTimer(plugin, this::aiWarTick, warEvery, warEvery);
    }

    public void shutdown() {
        for (Raid r : raids) disband(r);
        raids.clear();
    }

    // ---------- создание ИИ-стран ----------

    /** Поддерживать нужное число ИИ-стран вокруг игрока. */
    public int refill(Player anchor) {
        int made = 0;
        while (plugin.state.aiCountries().size() < plugin.state.aiTarget && made < 20) {
            if (spawnCountry(anchor.getLocation()) == null) break;
            made++;
        }
        return made;
    }

    public Country spawnCountry(Location center) {
        World w = center.getWorld();
        int min = plugin.getConfig().getInt("ai.min-distance", 90);
        int max = plugin.getConfig().getInt("ai.max-distance", 220);
        Location pick = null;
        for (int tries = 0; tries < 20 && pick == null; tries++) {
            double ang = random.nextDouble() * Math.PI * 2;
            double dist = min + random.nextDouble() * Math.max(1, max - min);
            int x = (int) (center.getX() + Math.cos(ang) * dist);
            int z = (int) (center.getZ() + Math.sin(ang) * dist);
            int y = w.getHighestBlockYAt(x, z) + 1;
            Material below = w.getBlockAt(x, y - 1, z).getType();
            if (below == Material.WATER || below == Material.LAVA || below.name().endsWith("LEAVES")) continue;
            boolean crowded = false;
            for (Country c : plugin.state.countries.values()) {
                if (c.world.equals(w.getName()) && Math.hypot(c.x - x, c.z - z) < 70) crowded = true;
            }
            if (!crowded) pick = new Location(w, x, y, z);
        }
        if (pick == null) return null;

        String name = freeName();
        int strength = 1 + random.nextInt(3);
        Country c = plugin.state.createAi(name, COLORS[random.nextInt(COLORS.length)], w.getName(),
                pick.getBlockX(), pick.getBlockY(), pick.getBlockZ(), strength, 5 * 60_000L, plugin.now());
        plugin.flags.buildFort(c);
        return c;
    }

    private String freeName() {
        List<String> pool = new ArrayList<>(List.of(NAMES));
        Collections.shuffle(pool, random);
        for (String n : pool) if (plugin.state.byName(n) == null) return n;
        return "Страна " + (1000 + random.nextInt(9000));
    }

    // ---------- солдаты ----------

    private static Rank rankForSlot(int index, int strength) {
        if (index == 0 && strength >= 5) return Rank.GENERAL;
        if (index <= 1 && strength >= 3) return Rank.OFFICER;
        return index % 2 == 0 ? Rank.SERGEANT : Rank.PRIVATE;
    }

    public Mob spawnSoldier(Country c, Rank rank, Location loc, String raidTarget) {
        boolean ranged = rank == Rank.OFFICER || (rank == Rank.PRIVATE && random.nextBoolean());
        EntityType type = ranged ? EntityType.PILLAGER : EntityType.VINDICATOR;
        Mob m = (Mob) loc.getWorld().spawnEntity(loc, type);
        m.setCustomName(Msg.c(Msg.code(c.color) + "[" + c.name + "] &f" + rank.title));
        m.setCustomNameVisible(true);
        m.setRemoveWhenFarAway(raidTarget != null);
        m.getPersistentDataContainer().set(plugin.keyCountry, PersistentDataType.STRING, c.key());
        m.getPersistentDataContainer().set(plugin.keyRank, PersistentDataType.STRING, rank.name());
        if (raidTarget != null) {
            m.getPersistentDataContainer().set(plugin.keyRaid, PersistentDataType.STRING, raidTarget);
            m.setPersistent(false);
        }

        double hp = switch (rank) {
            case PRIVATE -> 24;
            case SERGEANT -> 34;
            case OFFICER -> 50;
            case GENERAL -> 120;
        };
        AttributeInstance max = m.getAttribute(Attribute.GENERIC_MAX_HEALTH);
        if (max != null) {
            max.setBaseValue(hp);
            m.setHealth(hp);
        }

        EntityEquipment eq = m.getEquipment();
        Material weapon = ranged ? Material.CROSSBOW : switch (rank) {
            case GENERAL -> Material.NETHERITE_AXE;
            case SERGEANT -> Material.IRON_AXE;
            default -> Material.STONE_AXE;
        };
        eq.setItemInMainHand(new ItemStack(weapon));
        Material[] set = switch (rank) {
            case GENERAL -> new Material[]{Material.NETHERITE_HELMET, Material.NETHERITE_CHESTPLATE, Material.NETHERITE_LEGGINGS, Material.NETHERITE_BOOTS};
            case OFFICER -> new Material[]{Material.DIAMOND_HELMET, Material.IRON_CHESTPLATE, Material.IRON_LEGGINGS, Material.IRON_BOOTS};
            case SERGEANT -> new Material[]{Material.IRON_HELMET, Material.IRON_CHESTPLATE, Material.CHAINMAIL_LEGGINGS, Material.CHAINMAIL_BOOTS};
            default -> new Material[]{Material.LEATHER_HELMET, Material.CHAINMAIL_CHESTPLATE, Material.LEATHER_LEGGINGS, Material.LEATHER_BOOTS};
        };
        eq.setHelmet(new ItemStack(set[0]));
        eq.setChestplate(new ItemStack(set[1]));
        eq.setLeggings(new ItemStack(set[2]));
        eq.setBoots(new ItemStack(set[3]));
        eq.setItemInMainHandDropChance(0f);
        eq.setHelmetDropChance(0f);
        eq.setChestplateDropChance(0f);
        eq.setLeggingsDropChance(0f);
        eq.setBootsDropChance(0f);
        return m;
    }

    private List<LivingEntity> soldiersNear(String countryKey, Location center, double radius, boolean raiders) {
        List<LivingEntity> out = new ArrayList<>();
        for (Entity e : center.getWorld().getNearbyEntities(center, radius, 30, radius)) {
            if (!(e instanceof LivingEntity le) || e instanceof Player) continue;
            var pdc = le.getPersistentDataContainer();
            if (!countryKey.equals(pdc.get(plugin.keyCountry, PersistentDataType.STRING))) continue;
            if (raiders == pdc.has(plugin.keyRaid, PersistentDataType.STRING)) out.add(le);
        }
        return out;
    }

    public void removeSoldiers(String countryKey, Location flag) {
        if (flag == null) return;
        for (Entity e : flag.getWorld().getNearbyEntities(flag, 60, 40, 60)) {
            if (e instanceof Player) continue;
            if (countryKey.equals(e.getPersistentDataContainer().get(plugin.keyCountry, PersistentDataType.STRING))) e.remove();
        }
    }

    /** Подкрепление гарнизонов: только рядом с игроками, чтобы не грузить сервер. */
    private void garrisonTick() {
        for (Country c : new ArrayList<>(plugin.state.aiCountries())) {
            World w = Bukkit.getWorld(c.world);
            if (w == null || !w.isChunkLoaded(c.x >> 4, c.z >> 4)) continue;
            Location flag = new Location(w, c.x + 0.5, c.y, c.z + 0.5);
            boolean watched = false;
            for (Player p : w.getPlayers()) {
                if (p.getLocation().distanceSquared(flag) < 96 * 96) {
                    watched = true;
                    break;
                }
            }
            if (!watched) continue;
            int wanted = Math.min(12, 2 + c.strength / 2);
            List<LivingEntity> have = soldiersNear(c.key(), flag, 14, false);
            for (int i = have.size(); i < wanted; i++) {
                int x = c.x + random.nextInt(9) - 4, z = c.z + random.nextInt(9) - 4;
                Location at = new Location(w, x + 0.5, c.y, z + 0.5);
                spawnSoldier(c, rankForSlot(i, c.strength), at, null);
            }
        }
    }

    // ---------- рост силы ----------

    private void growthTick() {
        growthTicks++;
        int every = plugin.getConfig().getInt("ai.growth-minutes", 5);
        int cap = plugin.getConfig().getInt("ai.max-strength", 20);
        for (Country c : plugin.state.aiCountries()) {
            c.treasury += 20L * c.strength;
            if (growthTicks % Math.max(1, every) == 0 && c.strength < cap) c.strength++;
        }
        if (plugin.state.aiTarget > 0) {
            for (Player p : Bukkit.getOnlinePlayers()) {
                if (plugin.state.countryOf(p.getUniqueId()) != null) {
                    refill(p);
                    break;
                }
            }
        }
    }

    // ---------- налёты на людей ----------

    private void raidLaunchTick() {
        List<Country> targets = new ArrayList<>();
        for (Country c : plugin.state.humanCountries()) {
            if (!plugin.onlineMembers(c).isEmpty() && plugin.now() >= c.shieldUntil) targets.add(c);
        }
        List<Country> attackers = plugin.state.aiCountries();
        if (targets.isEmpty() || attackers.isEmpty()) return;
        Country target = targets.get(random.nextInt(targets.size()));
        Country attacker = attackers.get(random.nextInt(attackers.size()));
        if (attacker.strength < 2) return;

        World w = Bukkit.getWorld(target.world);
        if (w == null) return;
        double ang = random.nextDouble() * Math.PI * 2;
        int x = (int) (target.x + Math.cos(ang) * 30), z = (int) (target.z + Math.sin(ang) * 30);
        int y = w.getHighestBlockYAt(x, z) + 1;

        Raid raid = new Raid();
        raid.targetKey = target.key();
        raid.expires = plugin.now() + plugin.getConfig().getLong("ai.raid-lifetime-seconds", 300) * 1000L;
        int size = Math.min(10, 2 + attacker.strength / 3);
        for (int i = 0; i < size; i++) {
            Location at = new Location(w, x + random.nextInt(5) - 2 + 0.5, y, z + random.nextInt(5) - 2 + 0.5);
            Mob m = spawnSoldier(attacker, rankForSlot(i, attacker.strength), at, target.key());
            raid.soldiers.add(m.getUniqueId());
        }
        raids.add(raid);
        plugin.broadcast("&c" + attacker.name + " &fначала наступление на &e" + target.name + "&f! К оружию!");
    }

    private void raidMoveTick() {
        long now = plugin.now();
        raids.removeIf(r -> {
            boolean over = now > r.expires || r.soldiers.stream().noneMatch(id -> {
                Entity e = Bukkit.getEntity(id);
                return e != null && !e.isDead();
            });
            if (over) disband(r);
            return over;
        });
        for (Raid r : raids) {
            Country target = plugin.state.countries.get(r.targetKey);
            Location flag = target == null ? null : plugin.capital(target);
            if (flag == null) continue;
            for (UUID id : r.soldiers) {
                if (Bukkit.getEntity(id) instanceof Mob m && !m.isDead() && m.getTarget() == null) {
                    m.getPathfinder().moveTo(flag);
                }
            }
        }
    }

    private void disband(Raid r) {
        for (UUID id : r.soldiers) {
            Entity e = Bukkit.getEntity(id);
            if (e != null && !e.isDead()) e.remove();
        }
    }

    // ---------- войны ИИ между собой ----------

    private void aiWarTick() {
        List<Country> ais = new ArrayList<>(plugin.state.aiCountries());
        if (ais.size() < 2) return;
        Country a = ais.get(random.nextInt(ais.size()));
        Country d = ais.get(random.nextInt(ais.size()));
        if (a == d || plugin.now() < d.shieldUntil) return;
        double chance = a.strength / (double) (a.strength + d.strength);
        if (random.nextDouble() > chance) {
            plugin.broadcast("&7" + a.name + " атаковала " + d.name + ", но была отбита.");
            return;
        }
        Location flag = plugin.capital(d);
        String key = d.key();
        plugin.state.conquest(a, d, plugin.now());
        plugin.flags.removeVisuals(d);
        removeSoldiers(key, flag);
        plugin.broadcast("&c" + a.name + " &fзахватила страну &c" + d.name + "&f! Сила победителя растёт.");
    }
}
