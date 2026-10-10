package ru.warmod;

import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.entity.EntityType;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.entity.Horse;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import ru.warmod.core.Country;
import ru.warmod.core.Rank;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Оружейная армии: снаряжение за личные $ или из казны (офицеры и генералы вооружают новобранцев). */
public final class Shop {
    public record Item(String id, String title, long price, Rank minRank) {
    }

    public static final List<Item> ITEMS = List.of(
            new Item("food", "Паёк (16 хлеба + 8 мяса)", 15, Rank.PRIVATE),
            new Item("sword", "Железный меч", 30, Rank.PRIVATE),
            new Item("bow", "Лук + 32 стрелы", 40, Rank.PRIVATE),
            new Item("shield", "Щит", 25, Rank.PRIVATE),
            new Item("armor_light", "Лёгкая броня (кольчуга)", 60, Rank.PRIVATE),
            new Item("medkit", "Аптечки x3", 30, Rank.PRIVATE),
            new Item("crossbow", "Арбалет + 16 стрел", 70, Rank.PRIVATE),
            new Item("armor_iron", "Железная броня", 140, Rank.PRIVATE),
            new Item("armor_heavy", "Тяжёлая броня (алмаз)", 450, Rank.SERGEANT),
            new Item("tank", "Танк (бронированный конь + орудие)", 600, Rank.SERGEANT));

    private final WarMod plugin;

    public Shop(WarMod plugin) {
        this.plugin = plugin;
    }

    public static Item find(String id) {
        for (Item i : ITEMS) if (i.id.equalsIgnoreCase(id)) return i;
        return null;
    }

    /** Выдать товар бойцу. Деньги списывать вызывающему коду. */
    public void deliver(Player target, Country country, Item item) {
        switch (item.id) {
            case "food" -> {
                give(target, new ItemStack(Material.BREAD, 16));
                give(target, new ItemStack(Material.COOKED_BEEF, 8));
            }
            case "sword" -> give(target, named(Material.IRON_SWORD, "&7Меч " + country.name));
            case "bow" -> {
                give(target, named(Material.BOW, "&7Лук " + country.name));
                give(target, new ItemStack(Material.ARROW, 32));
            }
            case "shield" -> give(target, named(Material.SHIELD, "&7Щит " + country.name));
            case "armor_light" -> armor(target, Material.CHAINMAIL_HELMET, Material.CHAINMAIL_CHESTPLATE,
                    Material.CHAINMAIL_LEGGINGS, Material.CHAINMAIL_BOOTS);
            case "armor_iron" -> armor(target, Material.IRON_HELMET, Material.IRON_CHESTPLATE,
                    Material.IRON_LEGGINGS, Material.IRON_BOOTS);
            case "armor_heavy" -> armor(target, Material.DIAMOND_HELMET, Material.DIAMOND_CHESTPLATE,
                    Material.DIAMOND_LEGGINGS, Material.DIAMOND_BOOTS);
            case "crossbow" -> {
                give(target, named(Material.CROSSBOW, "&7Арбалет " + country.name));
                give(target, new ItemStack(Material.ARROW, 16));
            }
            case "medkit" -> {
                ItemStack kit = named(Material.PAPER, "&c+ Аптечка");
                kit.setAmount(3);
                ItemMeta meta = kit.getItemMeta();
                meta.setLore(List.of(Msg.c("&7ПКМ по раненому бойцу - лечит."), Msg.c("&7Медик получает $ за помощь.")));
                meta.getPersistentDataContainer().set(plugin.keyMedkit, PersistentDataType.BYTE, (byte) 1);
                kit.setItemMeta(meta);
                give(target, kit);
            }
            case "tank" -> spawnTank(target, country);
            default -> throw new IllegalArgumentException(item.id);
        }
    }

    private void spawnTank(Player owner, Country country) {
        Location loc = owner.getLocation();
        Horse h = (Horse) loc.getWorld().spawnEntity(loc, EntityType.HORSE);
        h.setCustomName(Msg.c(Msg.code(country.color) + "Танк " + country.name));
        h.setCustomNameVisible(true);
        h.setAdult();
        h.setTamed(true);
        h.setOwner(owner);
        h.getInventory().setSaddle(new ItemStack(Material.SADDLE));
        h.getInventory().setArmor(new ItemStack(Material.DIAMOND_HORSE_ARMOR));
        AttributeInstance hp = h.getAttribute(Attribute.GENERIC_MAX_HEALTH);
        if (hp != null) {
            hp.setBaseValue(120);
            h.setHealth(120);
        }
        AttributeInstance speed = h.getAttribute(Attribute.GENERIC_MOVEMENT_SPEED);
        if (speed != null) speed.setBaseValue(0.28);
        h.getPersistentDataContainer().set(plugin.keyTank, PersistentDataType.STRING, country.key());

        ItemStack cannon = named(Material.BLAZE_ROD, "&6Орудие танка");
        ItemMeta meta = cannon.getItemMeta();
        meta.setLore(List.of(Msg.c("&7Сядь на танк и нажми ПКМ - выстрел."), Msg.c("&7Перезарядка 3 секунды.")));
        meta.getPersistentDataContainer().set(plugin.keyCannon, PersistentDataType.BYTE, (byte) 1);
        cannon.setItemMeta(meta);
        give(owner, cannon);
    }

    private void armor(Player p, Material helmet, Material chest, Material legs, Material boots) {
        give(p, new ItemStack(helmet));
        give(p, new ItemStack(chest));
        give(p, new ItemStack(legs));
        give(p, new ItemStack(boots));
    }

    private ItemStack named(Material m, String name) {
        ItemStack it = new ItemStack(m);
        ItemMeta meta = it.getItemMeta();
        meta.setDisplayName(Msg.c(name));
        it.setItemMeta(meta);
        return it;
    }

    private void give(Player p, ItemStack it) {
        Map<Integer, ItemStack> left = new HashMap<>(p.getInventory().addItem(it));
        for (ItemStack rest : left.values()) p.getWorld().dropItemNaturally(p.getLocation(), rest);
    }
}
