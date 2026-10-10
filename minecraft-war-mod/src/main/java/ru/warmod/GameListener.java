package ru.warmod;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Sound;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Fireball;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Monster;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.EntityMountEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.util.Vector;
import ru.warmod.core.Country;
import ru.warmod.core.Member;
import ru.warmod.core.Rank;
import ru.warmod.core.Task;
import ru.warmod.core.WarState;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class GameListener implements Listener {
    private final WarMod plugin;
    private final Map<UUID, Long> cannonCooldown = new HashMap<>();

    public GameListener(WarMod plugin) {
        this.plugin = plugin;
    }

    private WarState st() {
        return plugin.state;
    }

    // ---------- вход, респаун ----------

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        Player p = e.getPlayer();
        UUID id = p.getUniqueId();
        st().ensureWallet(id);
        Member m = st().memberOf(id);
        if (m != null) m.name = p.getName();
        plugin.refresh(p);
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            if (!p.isOnline()) return;
            Country c = st().countryOf(id);
            if (plugin.offers.containsKey(id)) {
                plugin.tell(p, "Тебе предложили службу победителю: &a/war accept");
            } else if (c == null) {
                plugin.tell(p, "Добро пожаловать на войну! Выбери страну или создай свою. Деньги: &6" + st().balance(id) + "$");
                CountryMenu.open(plugin, p);
            } else {
                plugin.tell(p, "Ты - &b" + st().memberOf(id).rank.title + " &fстраны &e" + c.name + "&f. Деньги: &6"
                        + st().balance(id) + "$&f. Задание: &e/war task");
            }
        }, 40L);
    }

    @EventHandler
    public void onRespawn(PlayerRespawnEvent e) {
        Country c = st().countryOf(e.getPlayer().getUniqueId());
        if (c == null || e.isBedSpawn() || e.isAnchorSpawn()) return;
        Location cap = plugin.capital(c);
        if (cap != null) e.setRespawnLocation(cap.add(0, 1, 2));
    }

    // ---------- смерть и награды ----------

    @EventHandler
    public void onPlayerDeath(PlayerDeathEvent e) {
        Player v = e.getEntity();
        UUID vid = v.getUniqueId();
        Country vc = st().countryOf(vid);
        if (vc != null) vc.member(vid).deaths++;

        Player k = v.getKiller();
        Country kc = k == null ? null : st().countryOf(k.getUniqueId());
        if (k != null && k != v && kc != null && vc != null && kc != vc) {
            st().give(k.getUniqueId(), plugin.rules.killReward);
            kc.member(k.getUniqueId()).kills++;
            kc.addScore(plugin.rules.killPoints, plugin.now());
            Rank up = st().addMerit(k.getUniqueId(), plugin.rules.killMerit);
            plugin.tell(k, "Враг повержен: &6+" + plugin.rules.killReward + "$");
            if (up != null) {
                plugin.tell(k, "Ты повышен до звания: &b" + up.title + "&f!");
                plugin.refresh(k);
            }
            plugin.tasks.progress(k, Task.Type.KILL_ENEMY, 1);
        }

        WarState.Result r = st().leaderDied(vid);
        if (r.ok()) {
            plugin.broadcast("&c" + r.message());
            plugin.refreshAll();
        }
        Bukkit.getScheduler().runTaskLater(plugin, () -> plugin.tell(v,
                "Ты пал, но накопления сохранены: &6" + st().balance(vid) + "$&f. Вложи их в снаряжение."), 20L);
    }

    @EventHandler
    public void onMobDeath(EntityDeathEvent e) {
        LivingEntity le = e.getEntity();
        if (le instanceof Player) return;
        Player k = le.getKiller();
        if (k == null) return;
        String country = le.getPersistentDataContainer().get(plugin.keyCountry, PersistentDataType.STRING);
        if (country != null) {
            String rn = le.getPersistentDataContainer().get(plugin.keyRank, PersistentDataType.STRING);
            Rank rank = rn == null ? Rank.PRIVATE : Rank.valueOf(rn);
            long reward = 10 + 20L * rank.level;
            st().give(k.getUniqueId(), reward);
            Rank up = st().addMerit(k.getUniqueId(), 2 + 3 * rank.level);
            Country kc = st().countryOf(k.getUniqueId());
            if (kc != null) kc.addScore(plugin.rules.killPoints, plugin.now());
            e.getDrops().clear();
            e.setDroppedExp(5 + 10 * rank.level);
            plugin.tell(k, "Вражеский " + rank.title.toLowerCase() + " уничтожен: &6+" + reward + "$");
            if (up != null) {
                plugin.tell(k, "Ты повышен до звания: &b" + up.title + "&f!");
                plugin.refresh(k);
            }
            plugin.tasks.progress(k, Task.Type.KILL_ENEMY, 1);
        } else if (le instanceof Monster) {
            plugin.tasks.progress(k, Task.Type.KILL_MOBS, 1);
        }
    }

    // ---------- бой ----------

    @EventHandler(ignoreCancelled = true)
    public void onDamage(EntityDamageByEntityEvent e) {
        if (!(e.getEntity() instanceof Player victim)) return;
        Player attacker = null;
        if (e.getDamager() instanceof Player p) attacker = p;
        else if (e.getDamager() instanceof Projectile pr && pr.getShooter() instanceof Player sp) attacker = sp;
        if (attacker == null || attacker.equals(victim)) return;
        if (plugin.getConfig().getBoolean("war.friendly-fire", false)) return;
        Country a = st().countryOf(attacker.getUniqueId());
        if (a != null && a == st().countryOf(victim.getUniqueId())) {
            e.setCancelled(true);
            attacker.sendActionBar(Msg.c("&aОгонь по своим запрещён"));
        }
    }

    // ---------- территория ----------

    private boolean denyBuild(Player p, org.bukkit.block.Block b) {
        if (p.hasPermission("warmod.admin")) return false;
        if (plugin.flags.isFlagBlock(b)) {
            plugin.tell(p, "Флаг нельзя сломать - его можно только захватить, удерживая рядом.");
            return true;
        }
        Country zone = plugin.flags.zoneAt(b.getLocation());
        if (zone != null && !zone.ai && zone != st().countryOf(p.getUniqueId())) {
            plugin.tell(p, "Это территория страны &e" + zone.name + "&f. Чтобы взять её - захвати флаг.");
            return true;
        }
        return false;
    }

    @EventHandler(ignoreCancelled = true)
    public void onBreak(BlockBreakEvent e) {
        if (denyBuild(e.getPlayer(), e.getBlock())) {
            e.setCancelled(true);
            return;
        }
        String n = e.getBlock().getType().name();
        if (n.endsWith("_ORE") || n.equals("ANCIENT_DEBRIS")) plugin.tasks.progress(e.getPlayer(), Task.Type.MINE_ORE, 1);
    }

    @EventHandler(ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent e) {
        if (denyBuild(e.getPlayer(), e.getBlockPlaced())) e.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onExplode(EntityExplodeEvent e) {
        e.blockList().removeIf(plugin.flags::isFlagBlock);
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onBlockExplode(BlockExplodeEvent e) {
        e.blockList().removeIf(plugin.flags::isFlagBlock);
    }

    // ---------- техника ----------

    @EventHandler(ignoreCancelled = true)
    public void onMount(EntityMountEvent e) {
        if (!(e.getEntity() instanceof Player p)) return;
        String tank = e.getMount().getPersistentDataContainer().get(plugin.keyTank, PersistentDataType.STRING);
        if (tank == null) return;
        Country c = st().countryOf(p.getUniqueId());
        if (c == null || !c.key().equals(tank)) {
            e.setCancelled(true);
            plugin.tell(p, "Это танк чужой страны.");
            return;
        }
        Member m = c.member(p.getUniqueId());
        if (!m.rank.canUseTechnique()) {
            e.setCancelled(true);
            plugin.tell(p, "Рядовым танк не доверяют. Нужно звание сержанта (заслуги " + m.merit + "/" + plugin.rules.sergeantMerit + ").");
        }
    }

    @EventHandler
    public void onCannon(PlayerInteractEvent e) {
        if (e.getHand() != EquipmentSlot.HAND) return;
        if (e.getAction() != Action.RIGHT_CLICK_AIR && e.getAction() != Action.RIGHT_CLICK_BLOCK) return;
        ItemStack it = e.getItem();
        if (it == null || !it.hasItemMeta()
                || !it.getItemMeta().getPersistentDataContainer().has(plugin.keyCannon, PersistentDataType.BYTE)) return;
        e.setCancelled(true);
        Player p = e.getPlayer();
        Entity veh = p.getVehicle();
        if (veh == null || !veh.getPersistentDataContainer().has(plugin.keyTank, PersistentDataType.STRING)) {
            plugin.tell(p, "Орудие стреляет только с танка.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now - cannonCooldown.getOrDefault(p.getUniqueId(), 0L) < 3000) {
            p.sendActionBar(Msg.c("&7Перезарядка..."));
            return;
        }
        cannonCooldown.put(p.getUniqueId(), now);
        Location eye = p.getEyeLocation();
        Vector dir = eye.getDirection();
        Fireball shell = p.getWorld().spawn(eye.add(dir.clone().multiply(2.5)), Fireball.class);
        shell.setShooter(p);
        shell.setDirection(dir);
        shell.setYield(2.5f);
        shell.setIsIncendiary(false);
        p.getWorld().playSound(p.getLocation(), Sound.ENTITY_GENERIC_EXPLODE, 1f, 1.5f);
    }

    // ---------- госпиталь ----------

    @EventHandler
    public void onMedkit(PlayerInteractEntityEvent e) {
        if (e.getHand() != EquipmentSlot.HAND || !(e.getRightClicked() instanceof Player patient)) return;
        Player medic = e.getPlayer();
        ItemStack it = medic.getInventory().getItemInMainHand();
        if (it.getType().isAir() || !it.hasItemMeta()
                || !it.getItemMeta().getPersistentDataContainer().has(plugin.keyMedkit, PersistentDataType.BYTE)) return;
        e.setCancelled(true);
        Country mc = st().countryOf(medic.getUniqueId());
        if (mc == null || mc != st().countryOf(patient.getUniqueId())) {
            plugin.tell(medic, "Лечить можно только бойцов своей страны.");
            return;
        }
        AttributeInstance max = patient.getAttribute(Attribute.GENERIC_MAX_HEALTH);
        double cap = max == null ? 20 : max.getValue();
        if (patient.getHealth() >= cap) {
            plugin.tell(medic, patient.getName() + " не ранен.");
            return;
        }
        patient.setHealth(Math.min(cap, patient.getHealth() + 8));
        it.setAmount(it.getAmount() - 1);
        long reward = plugin.getConfig().getLong("economy.medic-reward", 15);
        st().give(medic.getUniqueId(), reward);
        Rank up = st().addMerit(medic.getUniqueId(), 3);
        plugin.tell(medic, "Ты вылечил " + patient.getName() + ": &6+" + reward + "$");
        plugin.tell(patient, medic.getName() + " вылечил тебя.");
        if (up != null) {
            plugin.tell(medic, "Ты повышен до звания: &b" + up.title + "&f!");
            plugin.refresh(medic);
        }
        plugin.tasks.progress(medic, Task.Type.HEAL, 1);
    }
}
