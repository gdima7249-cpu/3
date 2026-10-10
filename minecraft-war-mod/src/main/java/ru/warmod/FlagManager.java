package ru.warmod;

import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.boss.BarColor;
import org.bukkit.boss.BarStyle;
import org.bukkit.boss.BossBar;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.persistence.PersistentDataType;
import ru.warmod.core.Country;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Флаги стран: постановка баннера, защита территории и захват флага удержанием. */
public final class FlagManager {
    private final WarMod plugin;
    private final Map<String, Integer> progress = new HashMap<>();
    private final Map<String, BossBar> bars = new HashMap<>();

    public FlagManager(WarMod plugin) {
        this.plugin = plugin;
    }

    // ---------- визуал ----------

    public static Material banner(String color) {
        Material m = Material.matchMaterial(color + "_BANNER");
        return m == null ? Material.RED_BANNER : m;
    }

    public void placeFlag(Country c) {
        World w = Bukkit.getWorld(c.world);
        if (w == null) return;
        w.getBlockAt(c.x, c.y - 1, c.z).setType(Material.GOLD_BLOCK);
        w.getBlockAt(c.x, c.y, c.z).setType(banner(c.color));
    }

    /** Простая крепость для ИИ-стран: каменный двор со стеной и четырьмя проходами. */
    public void buildFort(Country c) {
        World w = Bukkit.getWorld(c.world);
        if (w == null) return;
        int r = 6;
        for (int dx = -r; dx <= r; dx++) {
            for (int dz = -r; dz <= r; dz++) {
                boolean edge = Math.max(Math.abs(dx), Math.abs(dz)) == r;
                w.getBlockAt(c.x + dx, c.y - 1, c.z + dz).setType(Material.STONE_BRICKS);
                for (int h = 0; h <= 3; h++) {
                    boolean wall = edge && dx != 0 && dz != 0 && h <= 2;
                    w.getBlockAt(c.x + dx, c.y + h, c.z + dz).setType(wall ? Material.STONE_BRICKS : Material.AIR);
                }
            }
        }
        placeFlag(c);
    }

    public void restoreVisuals(Country c) {
        World w = Bukkit.getWorld(c.world);
        if (w == null || !w.isChunkLoaded(c.x >> 4, c.z >> 4)) return;
        if (!w.getBlockAt(c.x, c.y, c.z).getType().name().endsWith("_BANNER")) placeFlag(c);
    }

    public void removeVisuals(Country c) {
        World w = Bukkit.getWorld(c.world);
        if (w != null) {
            w.getBlockAt(c.x, c.y, c.z).setType(Material.AIR);
            w.getBlockAt(c.x, c.y - 1, c.z).setType(Material.STONE);
        }
        BossBar b = bars.remove(c.key());
        if (b != null) b.removeAll();
        progress.remove(c.key());
    }

    public void shutdown() {
        for (BossBar b : bars.values()) b.removeAll();
        bars.clear();
    }

    // ---------- территория ----------

    public boolean isFlagBlock(Block b) {
        for (Country c : plugin.state.countries.values()) {
            if (!b.getWorld().getName().equals(c.world)) continue;
            if (b.getX() == c.x && b.getZ() == c.z && (b.getY() == c.y || b.getY() == c.y - 1)) return true;
        }
        return false;
    }

    /** Страна, на чьей территории стоит точка (ближайший флаг в радиусе). */
    public Country zoneAt(Location l) {
        if (l.getWorld() == null) return null;
        int radius = plugin.getConfig().getInt("war.claim-radius", 40);
        Country best = null;
        double bestD = Double.MAX_VALUE;
        for (Country c : plugin.state.countries.values()) {
            if (!l.getWorld().getName().equals(c.world)) continue;
            double dx = l.getX() - c.x, dz = l.getZ() - c.z;
            double d = Math.sqrt(dx * dx + dz * dz);
            if (d <= radius && d < bestD) {
                best = c;
                bestD = d;
            }
        }
        return best;
    }

    // ---------- захват ----------

    public void tick() {
        double radius = plugin.getConfig().getDouble("war.capture-radius", 4);
        int need = plugin.getConfig().getInt("war.capture-seconds", 60);
        long now = plugin.now();
        for (Country c : new ArrayList<>(plugin.state.countries.values())) {
            World w = Bukkit.getWorld(c.world);
            if (w == null || !w.isChunkLoaded(c.x >> 4, c.z >> 4)) continue;
            Location flag = new Location(w, c.x + 0.5, c.y, c.z + 0.5);

            Map<String, Integer> counts = new HashMap<>();
            List<Player> nearby = new ArrayList<>();
            for (Entity e : w.getNearbyEntities(flag, radius, radius + 2, radius)) {
                if (e instanceof Player p) {
                    if (p.isDead() || p.getGameMode() == GameMode.SPECTATOR) continue;
                    nearby.add(p);
                    Country pc = plugin.state.countryOf(p.getUniqueId());
                    if (pc != null) counts.merge(pc.key(), 1, Integer::sum);
                } else if (e instanceof LivingEntity le && !le.isDead()) {
                    String key = le.getPersistentDataContainer().get(plugin.keyCountry, PersistentDataType.STRING);
                    if (key != null && plugin.state.countries.containsKey(key)) counts.merge(key, 1, Integer::sum);
                }
            }
            int defenders = counts.getOrDefault(c.key(), 0);
            String attackerKey = null;
            int attackers = 0;
            for (Map.Entry<String, Integer> en : counts.entrySet()) {
                if (!en.getKey().equals(c.key()) && en.getValue() > attackers) {
                    attackers = en.getValue();
                    attackerKey = en.getKey();
                }
            }

            int p = progress.getOrDefault(c.key(), 0);
            boolean shielded = now < c.shieldUntil;
            if (attackers > 0 && defenders == 0 && !shielded) {
                p += Math.min(attackers, 3);
            } else if (p > 0) {
                p = Math.max(0, p - 2);
            }
            if (p <= 0) {
                progress.remove(c.key());
                BossBar old = bars.remove(c.key());
                if (old != null) old.removeAll();
                if (attackers > 0 && shielded) {
                    for (Player pl : nearby) pl.sendActionBar(Msg.c("&eСтрана " + c.name + " под защитой новичка ещё "
                            + Math.max(1, (c.shieldUntil - now) / 60000) + " мин."));
                }
                continue;
            }
            progress.put(c.key(), p);
            BossBar bar = bars.computeIfAbsent(c.key(), k -> Bukkit.createBossBar("", BarColor.RED, BarStyle.SEGMENTED_10));
            bar.setTitle(Msg.c("&cЗахват флага: " + c.name + (defenders > 0 ? " &7(защитники держат)" : "")));
            bar.setProgress(Math.min(1.0, p / (double) need));
            bar.removeAll();
            for (Player pl : nearby) bar.addPlayer(pl);

            if (p >= need && attackerKey != null) {
                Country winner = plugin.state.countries.get(attackerKey);
                progress.remove(c.key());
                BossBar done = bars.remove(c.key());
                if (done != null) done.removeAll();
                if (winner != null) {
                    List<Player> heroes = new ArrayList<>();
                    for (Player pl : nearby) if (winner.members.containsKey(pl.getUniqueId())) heroes.add(pl);
                    plugin.conquer(winner, c, heroes);
                }
            }
        }
    }
}
