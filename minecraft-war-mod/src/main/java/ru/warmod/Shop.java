package ru.warmod;

import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.entity.Boat;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Mule;
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
            new Item("jeep", "Джип с пулемётом (быстрый разведчик)", 350, Rank.SERGEANT),
            new Item("apc", "БТР (тяжёлый мул с грузовым отсеком)", 450, Rank.SERGEANT),
            new Item("tank", "Танк (бронированный, орудие)", 600, Rank.SERGEANT),
            new Item("gunboat", "Бронекатер с орудием (ставь на воду)", 500, Rank.SERGEANT),
            new Item("glider", "Реактивный ранец (элитры + ракеты)", 400, Rank.OFFICER));

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
            case "tank", "jeep", "apc", "gunboat" -> spawnVehicle(target, country, item.id);
            case "glider" -> {
                give(target, named(Material.ELYTRA, "&7Реактивный ранец " + country.name));
                give(target, new ItemStack(Material.FIREWORK_ROCKET, 16));
            }
            default -> throw new IllegalArgumentException(item.id);
        }
    }

    private void spawnVehicle(Player owner, Country country, String type) {
        Location loc = owner.getLocation();
        String label = switch (type) {
            case "tank" -> "Танк";
            case "jeep" -> "Джип";
            case "apc" -> "БТР";
            default -> "Бронекатер";
        };
        Entity ent;
        switch (type) {
            case "gunboat" -> ent = loc.getWorld().spawn(loc, Boat.class);
            case "apc" -> {
                Mule mule = loc.getWorld().spawn(loc, Mule.class);
                mule.setTamed(true);
                mule.setOwner(owner);
                mule.getInventory().setSaddle(new ItemStack(Material.SADDLE));
                mule.setCarryingChest(true);
                stats(mule, 100, 0.25);
                ent = mule;
            }
            default -> {
                Horse h = loc.getWorld().spawn(loc, Horse.class);
                h.setAdult();
                h.setTamed(true);
                h.setOwner(owner);
                h.getInventory().setSaddle(new ItemStack(Material.SADDLE));
                if (type.equals("tank")) {
                    h.getInventory().setArmor(new ItemStack(Material.DIAMOND_HORSE_ARMOR));
                    stats(h, 120, 0.28);
                } else {
                    stats(h, 40, 0.38);
                }
                ent = h;
            }
        }
        ent.setCustomName(Msg.c(Msg.code(country.color) + label + " " + country.name));
        ent.setCustomNameVisible(true);
        ent.getPersistentDataContainer().set(plugin.keyTank, PersistentDataType.STRING, country.key());
        ent.getPersistentDataContainer().set(plugin.keyVehicle, PersistentDataType.STRING, type);

        if (type.equals("tank") || type.equals("gunboat")) {
            ItemStack cannon = named(Material.BLAZE_ROD, "&6Орудие");
            ItemMeta meta = cannon.getItemMeta();
            meta.setLore(List.of(Msg.c("&7Сядь на технику и нажми ПКМ - выстрел."), Msg.c("&7Перезарядка 3 секунды.")));
            meta.getPersistentDataContainer().set(plugin.keyCannon, PersistentDataType.BYTE, (byte) 1);
            cannon.setItemMeta(meta);
            give(owner, cannon);
        } else if (type.equals("jeep")) {
            ItemStack mg = named(Material.IRON_SHOVEL, "&6Пулемёт");
            ItemMeta meta = mg.getItemMeta();
            meta.setLore(List.of(Msg.c("&7Сядь в джип и зажимай ПКМ - очередь.")));
            meta.getPersistentDataContainer().set(plugin.keyMg, PersistentDataType.BYTE, (byte) 1);
            mg.setItemMeta(meta);
            give(owner, mg);
        }
    }

    private void stats(LivingEntity e, double hp, double speed) {
        AttributeInstance max = e.getAttribute(Attribute.GENERIC_MAX_HEALTH);
        if (max != null) {
            max.setBaseValue(hp);
            e.setHealth(hp);
        }
        AttributeInstance sp = e.getAttribute(Attribute.GENERIC_MOVEMENT_SPEED);
        if (sp != null) sp.setBaseValue(speed);
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
