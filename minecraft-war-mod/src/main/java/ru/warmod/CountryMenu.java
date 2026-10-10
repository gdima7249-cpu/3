package ru.warmod;

import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import ru.warmod.core.Country;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Меню выбора страны: сначала малые - им нужны люди (за вступление в большие нужно платить). */
public final class CountryMenu implements InventoryHolder {
    static final int CREATE_SLOT = 48, SOLO_SLOT = 50;

    private final Map<Integer, String> slots = new HashMap<>();
    private Inventory inv;

    public static void open(WarMod plugin, Player p) {
        CountryMenu menu = new CountryMenu();
        menu.inv = Bukkit.createInventory(menu, 54, Msg.c("&6Выбери страну"));
        int online = Bukkit.getOnlinePlayers().size();
        int limit = plugin.state.memberLimit(online);

        List<Country> list = new ArrayList<>(plugin.state.humanCountries());
        list.sort(Comparator.comparingInt(Country::size));
        int slot = 0;
        for (Country c : list) {
            if (slot >= 45) break;
            long price = plugin.state.joinPrice(c);
            ItemStack it = new ItemStack(FlagManager.banner(c.color));
            ItemMeta meta = it.getItemMeta();
            meta.setDisplayName(Msg.c(Msg.code(c.color) + c.name));
            List<String> lore = new ArrayList<>();
            lore.add(Msg.c("&7Правитель: &f" + (c.leaderMember() == null ? "-" : c.leaderMember().name)));
            lore.add(Msg.c("&7Бойцов: &f" + c.size() + "/" + limit));
            lore.add(Msg.c("&7Казна: &6" + c.treasury + "$"));
            lore.add(Msg.c(price > 0 ? "&cВход платный: " + price + "$ (страна крупная)"
                    : price < 0 ? "&aТебе заплатят за вступление: +" + (-price) + "$" : "&fВход бесплатный"));
            lore.add(Msg.c("&eНажми, чтобы вступить рядовым"));
            meta.setLore(lore);
            it.setItemMeta(meta);
            menu.inv.setItem(slot, it);
            menu.slots.put(slot, c.name);
            slot++;
        }
        menu.inv.setItem(CREATE_SLOT, button(Material.EMERALD, "&aСоздать свою страну",
                "&7Стоит " + plugin.rules.createCost + "$ (бесплатно с правом донатера).",
                "&7Команда: &f/war create <название> [цвет]"));
        menu.inv.setItem(SOLO_SLOT, button(Material.DIAMOND_SWORD, "&bИграть соло против ИИ",
                "&7Своя страна и вражеские ИИ-страны вокруг.", "&7Команда: &f/war solo <название> [число ИИ]"));
        p.openInventory(menu.inv);
    }

    private static ItemStack button(Material m, String name, String... lore) {
        ItemStack it = new ItemStack(m);
        ItemMeta meta = it.getItemMeta();
        meta.setDisplayName(Msg.c(name));
        List<String> l = new ArrayList<>();
        for (String s : lore) l.add(Msg.c(s));
        meta.setLore(l);
        it.setItemMeta(meta);
        return it;
    }

    @Override
    public Inventory getInventory() {
        return inv;
    }

    public static final class Listener implements org.bukkit.event.Listener {
        private final WarMod plugin;

        public Listener(WarMod plugin) {
            this.plugin = plugin;
        }

        @EventHandler
        public void onClick(InventoryClickEvent e) {
            if (!(e.getInventory().getHolder() instanceof CountryMenu menu)) return;
            e.setCancelled(true);
            if (!(e.getWhoClicked() instanceof Player p) || e.getClickedInventory() != e.getInventory()) return;
            int slot = e.getSlot();
            if (slot == CREATE_SLOT) {
                p.closeInventory();
                plugin.tell(p, "Создай страну командой: &e/war create <название> [цвет]");
            } else if (slot == SOLO_SLOT) {
                p.closeInventory();
                plugin.tell(p, "Соло против ИИ: &e/war solo <название> [число ИИ-стран]");
            } else if (menu.slots.containsKey(slot)) {
                p.closeInventory();
                p.performCommand("war join " + menu.slots.get(slot));
            }
        }
    }
}
