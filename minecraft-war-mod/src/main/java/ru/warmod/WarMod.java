package ru.warmod;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import ru.warmod.core.Country;
import ru.warmod.core.Member;
import ru.warmod.core.Rank;
import ru.warmod.core.Rules;
import ru.warmod.core.WarState;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class WarMod extends JavaPlugin {
    public WarState state;
    public Rules rules;
    public Storage storage;
    public FlagManager flags;
    public TaskManager tasks;
    public Shop shop;
    public AiManager ai;
    public WebServer web;

    public NamespacedKey keyCountry, keyRank, keyTank, keyMedkit, keyCannon, keyRaid;

    /** Предложения бойцам побеждённой страны: игрок -> ключ страны-победителя. */
    public final Map<UUID, String> offers = new HashMap<>();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        keyCountry = new NamespacedKey(this, "country");
        keyRank = new NamespacedKey(this, "rank");
        keyTank = new NamespacedKey(this, "tank");
        keyMedkit = new NamespacedKey(this, "medkit");
        keyCannon = new NamespacedKey(this, "cannon");
        keyRaid = new NamespacedKey(this, "raid");

        rules = loadRules();
        storage = new Storage(getDataFolder().toPath());
        state = storage.load(rules);

        flags = new FlagManager(this);
        tasks = new TaskManager(this);
        shop = new Shop(this);
        ai = new AiManager(this);

        GameListener listener = new GameListener(this);
        getServer().getPluginManager().registerEvents(listener, this);
        getServer().getPluginManager().registerEvents(new CountryMenu.Listener(this), this);

        WarCommand cmd = new WarCommand(this);
        getCommand("war").setExecutor(cmd);
        getCommand("war").setTabCompleter(cmd);

        var sch = getServer().getScheduler();
        sch.runTaskTimer(this, flags::tick, 40L, 20L);
        sch.runTaskTimer(this, () -> state.recordOnline(Bukkit.getOnlinePlayers().size()), 100L, 1200L);
        sch.runTaskTimer(this, this::autosave, 6000L, 6000L);
        if (getConfig().getBoolean("ai.enabled", true)) ai.start();

        if (getConfig().getBoolean("web.enabled", false)) {
            web = new WebServer(this, getConfig().getInt("web.port", 8765));
            web.start();
        }
        for (Country c : state.countries.values()) flags.restoreVisuals(c);
        getLogger().info("WarMod включён. Стран: " + state.countries.size());
    }

    @Override
    public void onDisable() {
        if (web != null) web.stop();
        if (ai != null) ai.shutdown();
        if (flags != null) flags.shutdown();
        autosave();
    }

    public void autosave() {
        try {
            storage.save(state);
        } catch (IOException e) {
            getLogger().severe("Не удалось сохранить данные: " + e.getMessage());
        }
    }

    public Rules loadRules() {
        FileConfiguration c = getConfig();
        Rules r = new Rules();
        r.startBalance = c.getLong("economy.start-balance", r.startBalance);
        r.createCost = c.getLong("economy.create-cost", r.createCost);
        r.joinBase = c.getLong("economy.join-base", r.joinBase);
        r.maxJoinFee = c.getLong("economy.max-join-fee", r.maxJoinFee);
        r.maxJoinBonus = c.getLong("economy.max-join-bonus", r.maxJoinBonus);
        r.compensationPerRefusal = c.getLong("economy.compensation-per-refusal", r.compensationPerRefusal);
        r.killReward = c.getLong("economy.kill-reward", r.killReward);
        r.minLimit = c.getInt("limits.min-members", r.minLimit);
        r.limitMultiplier = c.getDouble("limits.online-multiplier", r.limitMultiplier);
        r.sergeantMerit = c.getInt("ranks.sergeant-merit", r.sergeantMerit);
        r.officerMerit = c.getInt("ranks.officer-merit", r.officerMerit);
        r.leaderDeathLosesCountry = c.getBoolean("ranks.leader-death-loses-country", true);
        Rank demoted = Rank.parse(c.getString("ranks.leader-demoted-to", "SERGEANT"));
        r.leaderDemotedTo = demoted == null ? Rank.SERGEANT : demoted;
        r.conquestPoints = c.getInt("score.conquest", r.conquestPoints);
        r.killPoints = c.getInt("score.kill", r.killPoints);
        r.taskPoints = c.getInt("score.task", r.taskPoints);
        return r;
    }

    public void reload() {
        reloadConfig();
        rules = loadRules();
        state.rules = rules;
    }

    public long now() {
        return System.currentTimeMillis();
    }

    // ---------- сообщения ----------

    public void tell(Player p, String msg) {
        p.sendMessage(Msg.c(Msg.PREFIX + msg));
    }

    public void tellCountry(Country c, String msg) {
        for (UUID id : c.members.keySet()) {
            Player p = Bukkit.getPlayer(id);
            if (p != null) tell(p, msg);
        }
    }

    public void broadcast(String msg) {
        Bukkit.broadcastMessage(Msg.c(Msg.PREFIX + msg));
    }

    /** Имя в списке игроков: [Страна] ник. */
    public void refresh(Player p) {
        Country c = state.countryOf(p.getUniqueId());
        if (c == null) {
            p.setPlayerListName(p.getName());
        } else {
            Member m = c.member(p.getUniqueId());
            p.setPlayerListName(Msg.c(Msg.code(c.color) + "[" + c.name + "] &f" + p.getName() + " &7" + m.rank.title));
        }
    }

    public void refreshAll() {
        for (Player p : Bukkit.getOnlinePlayers()) refresh(p);
    }

    public Location capital(Country c) {
        World w = Bukkit.getWorld(c.world);
        return w == null ? null : new Location(w, c.x + 0.5, c.y, c.z + 0.5);
    }

    // ---------- захват стран ----------

    /** Страна loser захвачена страной winner; heroes - бойцы победителя у флага. */
    public void conquer(Country winner, Country loser, List<Player> heroes) {
        Location flag = capital(loser);
        String loserKey = loser.key();
        WarState.Conquest cq = state.conquest(winner, loser, now());
        flags.removeVisuals(loser);
        ai.removeSoldiers(loserKey, flag);

        broadcast("&c" + winner.name + " &fзахватила страну &c" + loser.name + "&f! Трофеи: &6" + cq.spoils() + "$");
        for (Player h : heroes) {
            state.give(h.getUniqueId(), 100);
            Rank up = state.addMerit(h.getUniqueId(), 100);
            tell(h, "Награда за захват: &6+100$&f, заслуги +100.");
            if (up != null) tell(h, "Ты повышен до звания: &b" + up.title + "&f!");
            refresh(h);
        }
        List<UUID> former = cq.formerMembers();
        if (former.isEmpty() || winner.ai) {
            for (UUID id : former) {
                Player p = Bukkit.getPlayer(id);
                if (p != null) {
                    tell(p, "Твоя страна захвачена. Выбери новую: /war menu");
                    refresh(p);
                }
            }
            return;
        }
        int seconds = getConfig().getInt("war.offer-seconds", 60);
        String winnerKey = winner.key();
        for (UUID id : former) {
            offers.put(id, winnerKey);
            Player p = Bukkit.getPlayer(id);
            if (p != null) {
                refresh(p);
                tell(p, "Твоя страна пала. Победитель &c" + winner.name + "&f предлагает службу рядовым: &a/war accept &f(" + seconds + " сек).");
                tell(p, "Откажешься - победитель получит компенсацию " + rules.compensationPerRefusal + "$, а ты останешься без страны.");
            }
        }
        getServer().getScheduler().runTaskLater(this, () -> {
            int refused = 0;
            for (UUID id : former) {
                if (winnerKey.equals(offers.remove(id))) refused++;
            }
            Country w = state.byName(winner.name);
            if (w != null && refused > 0) {
                long sum = state.payCompensation(w, refused);
                tellCountry(w, "Компенсация за отказавшихся служить (" + refused + "): &6+" + sum + "$ &fв казну.");
            }
        }, seconds * 20L);
    }

    public Set<UUID> onlineMembers(Country c) {
        Set<UUID> out = new HashSet<>();
        for (UUID id : c.members.keySet()) if (Bukkit.getPlayer(id) != null) out.add(id);
        return out;
    }

    public List<Player> onlinePlayers(Country c) {
        List<Player> out = new ArrayList<>();
        for (UUID id : c.members.keySet()) {
            Player p = Bukkit.getPlayer(id);
            if (p != null) out.add(p);
        }
        return out;
    }
}
