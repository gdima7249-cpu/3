package ru.warmod;

import org.bukkit.entity.Player;
import ru.warmod.core.Country;
import ru.warmod.core.Member;
import ru.warmod.core.Rank;
import ru.warmod.core.Task;

import java.util.HashMap;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

/** Задания солдатам: автоматические от штаба и приказы командиров. */
public final class TaskManager {
    private final WarMod plugin;
    private final Map<UUID, Task> active = new HashMap<>();
    private final Random random = new Random();

    public TaskManager(WarMod plugin) {
        this.plugin = plugin;
    }

    public Task get(UUID id) {
        return active.get(id);
    }

    public void clear(UUID id) {
        active.remove(id);
    }

    public Task issue(Player p) {
        Member m = plugin.state.memberOf(p.getUniqueId());
        if (m == null) return null;
        Task t = Task.generate(m.rank, random);
        active.put(p.getUniqueId(), t);
        return t;
    }

    public void assign(UUID target, Task t) {
        active.put(target, t);
    }

    public String describe(Task t) {
        if (t.type == Task.Type.CUSTOM) {
            return "&e" + t.description + " &7(от " + t.assignedBy + ", награда " + t.reward + "$)";
        }
        return "&e" + t.description + " &7[" + t.progress + "/" + t.target + "] награда " + t.reward + "$";
    }

    /** Продвинуть автозадание нужного типа; по выполнении выплатить награду. */
    public void progress(Player p, Task.Type type, int amount) {
        Task t = active.get(p.getUniqueId());
        if (t == null || t.type != type) return;
        t.progress += amount;
        if (!t.done()) {
            p.sendActionBar(Msg.c("&eЗадание: " + t.progress + "/" + t.target));
            return;
        }
        active.remove(p.getUniqueId());
        finish(p, t, false);
    }

    /** Командир подтверждает выполнение приказа; награда из казны, если там есть деньги. */
    public boolean confirm(Player commander, Player target) {
        Task t = active.get(target.getUniqueId());
        if (t == null || t.type != Task.Type.CUSTOM) return false;
        Country c = plugin.state.countryOf(target.getUniqueId());
        if (c != null && c.treasury >= t.reward) c.treasury -= t.reward;
        else t.reward = 0;
        active.remove(target.getUniqueId());
        finish(target, t, true);
        return true;
    }

    private void finish(Player p, Task t, boolean ordered) {
        plugin.state.give(p.getUniqueId(), t.reward);
        Rank up = plugin.state.addMerit(p.getUniqueId(), 15 + 5 * (t.type == Task.Type.CUSTOM ? 1 : 0));
        Country c = plugin.state.countryOf(p.getUniqueId());
        if (c != null) c.addScore(plugin.rules.taskPoints, plugin.now());
        plugin.tell(p, "&aЗадание выполнено! &6+" + t.reward + "$");
        if (up != null) {
            plugin.tell(p, "Ты повышен до звания: &b" + up.title + "&f!");
            plugin.refresh(p);
        }
    }
}
